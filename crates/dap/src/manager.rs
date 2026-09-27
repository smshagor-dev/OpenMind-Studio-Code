//! One debug run at a time: starts the debug adapter (a child process in a job object, so it and
//! the program it starts die together), connects, drives the DAP start-up sequence, keeps the
//! run's state from the adapter's events, and offers the controls the UI needs (continue, step,
//! pause, breakpoints, reading the paused program, stop).

use std::collections::HashMap;
use std::io::{BufRead, BufReader};
use std::net::{Ipv4Addr, SocketAddr, TcpStream};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::mpsc::{self, Sender};
use std::sync::{Arc, Mutex, MutexGuard, Weak};
use std::thread;
use std::time::Duration;

use openmind_lsp::process::{pump_lines, spawn, ServerProcess};
use openmind_lsp::LogLevel;
use serde::Serialize;
use serde_json::{json, Value};

use crate::adapter::{adapter_spawn, transport, Interpreter, Transport};
use crate::error::DapError;
use crate::protocol::{
    disconnect_arguments, initialize_arguments, is_allowed_ui_request, parse_stopped,
    set_breakpoints_arguments, thread_arguments, Capabilities, Control, SourceBreakpoint, Stopped,
};
use crate::session::{Session, SessionEvents};
use crate::target::{LaunchConfig, Target};

const STEP_TIMEOUT: Duration = Duration::from_secs(60);
const READ_TIMEOUT: Duration = Duration::from_secs(20);
const PORT_TIMEOUT: Duration = Duration::from_secs(20);
const GRACE: Duration = Duration::from_millis(1500);

/// Where a run is.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(tag = "state", rename_all = "camelCase")]
pub enum RunState {
    Starting,
    Running,
    Stopped { stopped: Stopped },
    Terminated { error: Option<String> },
}

impl RunState {
    pub fn is_active(&self) -> bool {
        !matches!(self, RunState::Terminated { .. })
    }
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RunSnapshot {
    pub run_id: u64,
    pub config_name: String,
    pub target: Target,
    #[serde(flatten)]
    pub state: RunState,
    pub program: String,
    pub pid: Option<u32>,
    /// What the adapter can do (conditions, logpoints, loaded sources, modules).
    pub capabilities: Capabilities,
}

/// What the manager reports to the app around it.
pub trait DapEvents: Send + Sync + 'static {
    /// A DAP event worth showing (`output`, `stopped`, `continued`, `thread`, `breakpoint`,
    /// `terminated`, `exited`); noisy ones (`loadedSource`, `module`, telemetry) are dropped.
    fn event(&self, name: &str, body: &Value);
    fn state(&self, snapshot: &RunSnapshot);
    fn log(&self, level: LogLevel, text: &str);
}

/// Everything needed to start a run.
pub struct StartRequest {
    pub config: LaunchConfig,
    pub interpreter: Interpreter,
    pub adapter_dir: PathBuf,
    pub adapter_cwd: PathBuf,
    pub path_prepend: Vec<PathBuf>,
    pub vars: Vec<(String, String)>,
    /// File -> its breakpoints.
    pub breakpoints: HashMap<String, Vec<SourceBreakpoint>>,
}

struct Entry {
    session: Arc<Session>,
    /// Whether this session receives the breakpoints (js-debug's launcher session doesn't; its children do).
    owns_breakpoints: bool,
    initialized: Mutex<Option<Sender<()>>>,
}

struct Run {
    id: u64,
    config: LaunchConfig,
    interpreter: Interpreter,
    port: Mutex<Option<u16>>,
    process: Mutex<Option<ServerProcess>>,
    pid: Option<u32>,
    sessions: Mutex<Vec<Arc<Entry>>>,
    focus: Mutex<usize>,
    state: Mutex<RunState>,
    breakpoints: Mutex<HashMap<String, Vec<SourceBreakpoint>>>,
    capabilities: Mutex<Capabilities>,
    stopping: AtomicBool,
    finished: AtomicBool,
    events: Arc<dyn DapEvents>,
}

#[doc(hidden)]
pub struct Inner {
    run: Mutex<Option<Arc<Run>>>,
    events: Arc<dyn DapEvents>,
    next_id: AtomicU64,
}

/// The run manager. Cheap to clone: every clone is the same manager.
#[derive(Clone)]
pub struct DapManager {
    inner: Arc<Inner>,
}

impl std::ops::Deref for DapManager {
    type Target = Inner;

    fn deref(&self) -> &Inner {
        &self.inner
    }
}

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

impl Run {
    fn snapshot(&self) -> RunSnapshot {
        RunSnapshot {
            run_id: self.id,
            config_name: self.config.name.clone(),
            target: self.config.target,
            state: lock(&self.state).clone(),
            program: self.config.program.clone(),
            pid: self.pid,
            capabilities: lock(&self.capabilities).clone(),
        }
    }

    fn set_state(&self, state: RunState) {
        *lock(&self.state) = state;
        self.events.state(&self.snapshot());
    }

    /// The session controls and reads go to: the last one that stopped, else the newest alive.
    fn focused(&self) -> Option<Arc<Entry>> {
        let sessions = lock(&self.sessions);
        let focus = *lock(&self.focus);
        if let Some(entry) = sessions.get(focus).filter(|e| e.session.is_alive()) {
            return Some(Arc::clone(entry));
        }
        sessions
            .iter()
            .rev()
            .find(|e| e.session.is_alive())
            .cloned()
    }

    /// Ends the run (once): the state becomes Terminated and the adapter process tree is killed.
    fn finish(&self, error: Option<String>) {
        if self.finished.swap(true, Ordering::SeqCst) {
            return;
        }
        if let Some(problem) = &error {
            self.events.log(LogLevel::Error, problem);
        }
        self.set_state(RunState::Terminated { error });
        let process = lock(&self.process).take();
        lock(&self.sessions).clear();
        if let Some(mut process) = process {
            // The adapter normally exits by itself once the program ended; whatever is left is killed.
            thread::spawn(move || {
                thread::sleep(GRACE);
                process.kill();
            });
        }
    }

    fn kill_now(&self) {
        if let Some(mut process) = lock(&self.process).take() {
            process.kill();
        }
    }
}

/// Hears one session's events.
struct Listener {
    run: Weak<Run>,
    index: usize,
}

impl Listener {
    fn run(&self) -> Option<Arc<Run>> {
        self.run.upgrade()
    }
}

const FORWARDED: &[&str] = &[
    "output",
    "stopped",
    "continued",
    "thread",
    "breakpoint",
    "terminated",
    "exited",
];

impl SessionEvents for Listener {
    fn event(&self, name: &str, body: &Value) {
        let Some(run) = self.run() else { return };
        match name {
            "initialized" => {
                let entry = lock(&run.sessions).get(self.index).cloned();
                if let Some(entry) = entry {
                    if let Some(sender) = lock(&entry.initialized).as_ref() {
                        let _ = sender.send(());
                    }
                }
                return;
            }
            "stopped" => {
                *lock(&run.focus) = self.index;
                run.set_state(RunState::Stopped {
                    stopped: parse_stopped(body),
                });
            }
            "continued" => {
                if matches!(*lock(&run.state), RunState::Stopped { .. }) {
                    run.set_state(RunState::Running);
                }
            }
            "terminated" if self.index == 0 => {
                run.events.event(name, body);
                run.finish(None);
                return;
            }
            "output" if body.get("category").and_then(Value::as_str) == Some("telemetry") => {
                return;
            }
            _ => {}
        }
        if FORWARDED.contains(&name) {
            run.events.event(name, body);
        }
    }

    fn reverse_request(&self, command: &str, arguments: &Value) -> Result<Value, String> {
        let run = self.run().ok_or("the run ended")?;
        match command {
            "startDebugging" => {
                let request = arguments
                    .get("request")
                    .and_then(Value::as_str)
                    .unwrap_or("launch")
                    .to_string();
                let configuration = arguments
                    .get("configuration")
                    .cloned()
                    .unwrap_or(Value::Null);
                let child = Arc::clone(&run);
                thread::spawn(move || {
                    if let Err(err) = start_child(&child, &request, configuration) {
                        child.finish(Some(format!("The debug session couldn't start: {err}")));
                    }
                });
                Ok(json!({}))
            }
            "runInTerminal" => Err("OpenMind Studio runs the program itself.".into()),
            other => Err(format!("Not supported: {other}")),
        }
    }

    fn closed(&self) {
        let Some(run) = self.run() else { return };
        if self.index == 0 && !run.stopping.load(Ordering::SeqCst) {
            run.finish(Some("The debug adapter stopped unexpectedly.".into()));
        }
    }
}

fn add_session(
    run: &Arc<Run>,
    session: Arc<Session>,
    owns_breakpoints: bool,
    index: usize,
    tx: Sender<()>,
) -> Arc<Entry> {
    let entry = Arc::new(Entry {
        session,
        owns_breakpoints,
        initialized: Mutex::new(Some(tx)),
    });
    let mut sessions = lock(&run.sessions);
    debug_assert_eq!(sessions.len(), index);
    sessions.push(Arc::clone(&entry));
    entry
}

/// The DAP start-up sequence for one session: initialize, launch (its answer comes after
/// `configurationDone`), wait for `initialized`, send the breakpoints, `configurationDone`.
fn drive(
    run: &Arc<Run>,
    entry: &Arc<Entry>,
    initialized: &mpsc::Receiver<()>,
    adapter_id: &str,
    command: &str,
    arguments: &Value,
) -> Result<(), DapError> {
    let session = &entry.session;
    let answer = session.request(
        "initialize",
        &initialize_arguments(adapter_id),
        READ_TIMEOUT,
    )?;
    lock(&run.capabilities).merge(&Capabilities::from_initialize(&answer));
    let launch = session.send(command, arguments)?;
    initialized
        .recv_timeout(STEP_TIMEOUT)
        .map_err(|_| DapError::Timeout)?;
    if entry.owns_breakpoints {
        let breakpoints = lock(&run.breakpoints).clone();
        for (path, list) in breakpoints {
            if let Err(err) = session.request(
                "setBreakpoints",
                &set_breakpoints_arguments(&path, &list),
                READ_TIMEOUT,
            ) {
                run.events
                    .log(LogLevel::Warning, &format!("Breakpoints for {path}: {err}"));
            }
        }
    }
    session.request("configurationDone", &json!({}), READ_TIMEOUT)?;
    launch.wait(STEP_TIMEOUT)?;
    Ok(())
}

fn mark_running(run: &Run) {
    if matches!(*lock(&run.state), RunState::Starting) {
        run.set_state(RunState::Running);
    }
}

/// js-debug asked for a second connection that carries the actual debuggee.
fn start_child(run: &Arc<Run>, request: &str, configuration: Value) -> Result<(), DapError> {
    let port = (*lock(&run.port)).ok_or(DapError::Closed)?;
    let stream = connect(port)?;
    let (tx, rx) = mpsc::channel();
    let index = lock(&run.sessions).len();
    let listener = Arc::new(Listener {
        run: Arc::downgrade(run),
        index,
    });
    let reader = stream
        .try_clone()
        .map_err(|err| DapError::StartFailed(err.to_string()))?;
    let session = Session::start(reader, stream, listener);
    let entry = add_session(run, session, true, index, tx);
    *lock(&run.focus) = index;
    drive(run, &entry, &rx, "pwa-node", request, &configuration)?;
    mark_running(run);
    Ok(())
}

fn connect(port: u16) -> Result<TcpStream, DapError> {
    let address = SocketAddr::from((Ipv4Addr::LOCALHOST, port));
    TcpStream::connect_timeout(&address, Duration::from_secs(10))
        .map_err(|err| DapError::StartFailed(format!("can't connect to the adapter: {err}")))
}

/// Reads js-debug's "Debug server listening at 127.0.0.1:PORT" line; later lines go to the log.
fn read_port(
    stdout: std::process::ChildStdout,
    events: Arc<dyn DapEvents>,
) -> Result<u16, DapError> {
    let (tx, rx) = mpsc::channel();
    thread::spawn(move || {
        let mut sent = false;
        for line in BufReader::new(stdout).lines().map_while(Result::ok) {
            if !sent {
                if let Some(port) = line
                    .rsplit_once(':')
                    .and_then(|(_, port)| port.trim().parse::<u16>().ok())
                {
                    sent = true;
                    let _ = tx.send(port);
                    continue;
                }
            }
            if !line.trim().is_empty() {
                events.log(LogLevel::Info, line.trim());
            }
        }
    });
    rx.recv_timeout(PORT_TIMEOUT).map_err(|_| DapError::Timeout)
}

impl DapManager {
    pub fn new(events: Arc<dyn DapEvents>) -> Self {
        Self {
            inner: Arc::new(Inner {
                run: Mutex::new(None),
                events,
                next_id: AtomicU64::new(1),
            }),
        }
    }

    fn current(&self) -> Option<Arc<Run>> {
        lock(&self.run).clone()
    }

    fn active(&self) -> Result<Arc<Run>, DapError> {
        self.current()
            .filter(|run| lock(&run.state).is_active())
            .ok_or(DapError::NoSession)
    }

    pub fn snapshot(&self) -> Option<RunSnapshot> {
        self.current().map(|run| run.snapshot())
    }

    /// Starts the adapter and returns as soon as it is connected; the launch itself continues on a
    /// worker thread and reports through `DapEvents::state`.
    pub fn start(&self, request: StartRequest) -> Result<RunSnapshot, DapError> {
        if self
            .current()
            .is_some_and(|run| lock(&run.state).is_active())
        {
            return Err(DapError::AlreadyRunning);
        }
        request.config.validate()?;
        let target = request.config.target;
        let launch_args = request
            .config
            .launch_arguments(&request.interpreter.path.display().to_string())?;
        let spec = adapter_spawn(
            target,
            &request.interpreter,
            &request.adapter_dir,
            &request.adapter_cwd,
            request.path_prepend.clone(),
            request.vars.clone(),
        )
        .ok_or(DapError::Unsupported)?;
        let spawned = spawn(&spec).map_err(|err| DapError::StartFailed(err.to_string()))?;
        let pid = spawned.process.id();
        let _ = pump_lines(spawned.stderr, {
            let events = Arc::clone(&self.events);
            move |line| events.log(LogLevel::Warning, line)
        });
        let run = Arc::new(Run {
            id: self.next_id.fetch_add(1, Ordering::SeqCst),
            config: request.config.clone(),
            interpreter: request.interpreter.clone(),
            port: Mutex::new(None),
            process: Mutex::new(Some(spawned.process)),
            pid: Some(pid),
            sessions: Mutex::new(Vec::new()),
            focus: Mutex::new(0),
            state: Mutex::new(RunState::Starting),
            breakpoints: Mutex::new(request.breakpoints.clone()),
            capabilities: Mutex::new(Capabilities::default()),
            stopping: AtomicBool::new(false),
            finished: AtomicBool::new(false),
            events: Arc::clone(&self.events),
        });
        *lock(&self.run) = Some(Arc::clone(&run));
        self.events.log(
            LogLevel::Info,
            &format!(
                "Starting {} on {} (adapter pid {pid}).",
                run.config.name,
                run.interpreter.label(target)
            ),
        );
        self.events.state(&run.snapshot());

        let listener = Arc::new(Listener {
            run: Arc::downgrade(&run),
            index: 0,
        });
        let (tx, rx) = mpsc::channel();
        let session = match transport(target) {
            Transport::Stdio => Session::start(spawned.stdout, spawned.stdin, listener),
            Transport::Tcp => {
                let port = match read_port(spawned.stdout, Arc::clone(&self.events)) {
                    Ok(port) => port,
                    Err(err) => {
                        run.kill_now();
                        run.finish(Some(err.to_string()));
                        return Err(err);
                    }
                };
                *lock(&run.port) = Some(port);
                let stream = connect(port).inspect_err(|_| run.kill_now())?;
                let reader = stream
                    .try_clone()
                    .map_err(|err| DapError::StartFailed(err.to_string()))?;
                Session::start(reader, stream, listener)
            }
        };
        // js-debug's first session only launches; its child sessions get the breakpoints.
        let entry = add_session(&run, session, target != Target::Node, 0, tx);
        let worker = Arc::clone(&run);
        let adapter_id = request.config.adapter_id();
        thread::spawn(move || {
            match drive(&worker, &entry, &rx, adapter_id, "launch", &launch_args) {
                Ok(()) => mark_running(&worker),
                Err(err) => worker.finish(Some(format!("The debug session couldn't start: {err}"))),
            }
        });
        Ok(run.snapshot())
    }

    /// Continue, pause and the steps, on the session that is stopped (or running, for pause).
    pub fn control(&self, control: Control) -> Result<(), DapError> {
        let run = self.active()?;
        let entry = run.focused().ok_or(DapError::Closed)?;
        let thread_id = match control {
            Control::Pause => thread_of(&entry)?.unwrap_or_default(),
            _ => match &*lock(&run.state) {
                RunState::Stopped { stopped } => stopped.thread_id.unwrap_or(0),
                _ => return Err(DapError::Adapter("The program isn't paused.".into())),
            },
        };
        entry.session.request(
            control.command(),
            &thread_arguments(thread_id),
            STEP_TIMEOUT,
        )?;
        if control != Control::Pause {
            run.set_state(RunState::Running);
        }
        Ok(())
    }

    /// Reads about the paused program (stack, scopes, variables, evaluate, threads).
    pub fn request(&self, command: &str, arguments: &Value) -> Result<Value, DapError> {
        if !is_allowed_ui_request(command) {
            return Err(DapError::Refused(command.to_string()));
        }
        let run = self.active()?;
        let entry = run.focused().ok_or(DapError::Closed)?;
        entry.session.request(command, arguments, READ_TIMEOUT)
    }

    /// Sets the lines of one file (an empty list clears it); applied at once when a run is active.
    pub fn set_breakpoints(&self, path: &str, lines: &[SourceBreakpoint]) -> Result<(), DapError> {
        let Some(run) = self.current().filter(|run| lock(&run.state).is_active()) else {
            return Ok(());
        };
        {
            let mut map = lock(&run.breakpoints);
            if lines.is_empty() {
                map.remove(path);
            } else {
                map.insert(path.to_string(), lines.to_vec());
            }
        }
        let entries: Vec<Arc<Entry>> = lock(&run.sessions).clone();
        for entry in entries
            .iter()
            .filter(|e| e.owns_breakpoints && e.session.is_alive())
        {
            entry.session.request(
                "setBreakpoints",
                &set_breakpoints_arguments(path, lines),
                READ_TIMEOUT,
            )?;
        }
        Ok(())
    }

    /// Ends the run: `disconnect` (terminating the program), then the whole process tree is killed.
    pub fn stop(&self) {
        let Some(run) = self.current() else { return };
        if !lock(&run.state).is_active() {
            return;
        }
        run.stopping.store(true, Ordering::SeqCst);
        let entries: Vec<Arc<Entry>> = lock(&run.sessions).clone();
        for entry in entries.iter().rev().filter(|e| e.session.is_alive()) {
            let _ = entry.session.request(
                "disconnect",
                &disconnect_arguments(true),
                Duration::from_secs(2),
            );
        }
        run.kill_now();
        run.finish(None);
    }

    pub fn is_running(&self) -> bool {
        self.current()
            .is_some_and(|run| lock(&run.state).is_active())
    }
}

fn thread_of(entry: &Arc<Entry>) -> Result<Option<i64>, DapError> {
    let threads = entry.session.request("threads", &json!({}), READ_TIMEOUT)?;
    Ok(threads
        .get("threads")
        .and_then(Value::as_array)
        .and_then(|list| list.first())
        .and_then(|thread| thread.get("id"))
        .and_then(Value::as_i64))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::target::default_configs;

    #[derive(Default)]
    struct Recorder {
        states: Mutex<Vec<RunSnapshot>>,
        logs: Mutex<Vec<String>>,
    }

    impl DapEvents for Recorder {
        fn event(&self, _: &str, _: &Value) {}
        fn state(&self, snapshot: &RunSnapshot) {
            lock(&self.states).push(snapshot.clone());
        }
        fn log(&self, _: LogLevel, text: &str) {
            lock(&self.logs).push(text.to_string());
        }
    }

    fn request(root: &std::path::Path, program: &str) -> StartRequest {
        let mut config = default_configs(program, None).remove(0);
        config.cwd = Some(root.display().to_string());
        StartRequest {
            config,
            interpreter: Interpreter {
                path: root.join("python.exe"),
                portable: true,
                project: false,
            },
            adapter_dir: root.join("debugpy"),
            adapter_cwd: root.to_path_buf(),
            path_prepend: vec![],
            vars: vec![],
            breakpoints: HashMap::new(),
        }
    }

    #[test]
    fn with_no_run_the_controls_say_so_and_stop_is_harmless() {
        let manager = DapManager::new(Arc::new(Recorder::default()));
        assert!(manager.snapshot().is_none());
        assert!(!manager.is_running());
        assert!(matches!(
            manager.control(Control::Continue),
            Err(DapError::NoSession)
        ));
        assert!(matches!(
            manager.request("stackTrace", &json!({})),
            Err(DapError::NoSession)
        ));
        manager.stop();
        // Breakpoints set with no run are just remembered by the app; nothing is sent.
        assert!(manager
            .set_breakpoints("C:/My Site/a.py", &[SourceBreakpoint::at(3)])
            .is_ok());
    }

    #[test]
    fn requests_that_are_not_reads_are_refused_before_anything_else() {
        let manager = DapManager::new(Arc::new(Recorder::default()));
        for command in ["launch", "disconnect", "terminate", "setBreakpoints"] {
            assert!(matches!(
                manager.request(command, &json!({})),
                Err(DapError::Refused(_))
            ));
        }
    }

    #[test]
    fn a_program_that_is_not_a_file_is_refused_before_any_process_starts() {
        let root = tempfile::tempdir().expect("tempdir");
        let events = Arc::new(Recorder::default());
        let manager = DapManager::new(events.clone());
        let err = manager
            .start(request(
                root.path(),
                &root.path().join("missing.py").display().to_string(),
            ))
            .map(|_| ())
            .expect_err("no program");
        assert!(matches!(err, DapError::BadProgram(_)));
        assert!(lock(&events.states).is_empty());
        assert!(manager.snapshot().is_none());
    }

    #[test]
    fn an_adapter_that_cannot_start_is_a_start_failure_and_leaves_no_run_behind() {
        let root = tempfile::tempdir().expect("tempdir");
        let folder = root.path().join("My Site");
        std::fs::create_dir_all(&folder).expect("mkdir");
        let program = folder.join("tool.py");
        std::fs::write(&program, "print(1)").expect("file");
        let events = Arc::new(Recorder::default());
        let manager = DapManager::new(events.clone());
        // The interpreter does not exist, so spawning fails.
        let err = manager
            .start(request(&folder, &program.display().to_string()))
            .map(|_| ())
            .expect_err("no python");
        assert!(matches!(err, DapError::StartFailed(_)));
        assert!(!manager.is_running());
        assert!(lock(&events.states).is_empty());
    }

    #[test]
    fn run_states_serialize_for_the_ui() {
        let stopped = RunState::Stopped {
            stopped: Stopped {
                reason: "breakpoint".into(),
                thread_id: Some(1),
                description: None,
                text: None,
                all_threads_stopped: true,
            },
        };
        let json = serde_json::to_value(&stopped).expect("json");
        assert_eq!(json["state"], "stopped");
        assert_eq!(json["stopped"]["reason"], "breakpoint");
        assert_eq!(
            serde_json::to_value(RunState::Terminated {
                error: Some("x".into())
            })
            .expect("json")["state"],
            "terminated"
        );
        assert!(RunState::Running.is_active());
        assert!(!RunState::Terminated { error: None }.is_active());
    }
}
