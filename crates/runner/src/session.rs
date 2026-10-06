use std::collections::HashMap;
use std::io::Read;
use std::path::Path;
use std::process::{Child, ChildStderr, ChildStdout, Command, Stdio};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};

use serde::Serialize;

use crate::error::RunError;
use crate::plan::RunPlan;

/// How often the watcher thread checks whether the process has ended.
const POLL_INTERVAL: Duration = Duration::from_millis(25);
/// After the process ends, how long its output pipes get to drain.
const DRAIN_GRACE: Duration = Duration::from_millis(400);

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Stream {
    Stdout,
    Stderr,
}

/// Which step a line of output came from: the compiler (C, C++, Java, Rust) or the program itself.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Phase {
    Build,
    Run,
}

#[derive(Debug, Clone, Serialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum RunEventKind {
    /// A compiled language's build started (before `Started`).
    #[serde(rename_all = "camelCase")]
    Building {
        file: String,
        command_line: String,
        /// The absolute path of the compiler.
        compiler: String,
        cwd: String,
        runtime: String,
        language: String,
        pid: u32,
    },
    /// The build ended; the program starts only after a successful one.
    #[serde(rename_all = "camelCase")]
    Built {
        success: bool,
        code: Option<i32>,
        duration_ms: u64,
    },
    #[serde(rename_all = "camelCase")]
    Started {
        file: String,
        command_line: String,
        /// The absolute path of the interpreter (or built program) that was started.
        resolved: String,
        cwd: String,
        runtime: String,
        language: String,
        pid: u32,
    },
    Output {
        stream: Stream,
        line: String,
        phase: Phase,
    },
    #[serde(rename_all = "camelCase")]
    Exited {
        code: Option<i32>,
        duration_ms: u64,
        /// The user asked to stop it (so a missing exit code isn't a crash).
        stopped: bool,
        /// The build failed, so the program never ran (`code` is the compiler's).
        build_failed: bool,
    },
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RunEvent {
    pub run_id: String,
    #[serde(flatten)]
    pub event: RunEventKind,
}

pub type EventSink = Arc<dyn Fn(RunEvent) + Send + Sync>;

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RunInfo {
    pub run_id: String,
    pub file: String,
    pub pid: u32,
}

#[cfg(windows)]
type Tree = Option<Arc<openmind_process::ProcessTree>>;
#[cfg(not(windows))]
type Tree = ();

struct ActiveRun {
    info: RunInfo,
    /// The process running now: the compiler, then the program.
    child: Arc<Mutex<Child>>,
    stopped: Arc<AtomicBool>,
    #[cfg_attr(not(windows), allow(dead_code))]
    tree: Tree,
}

impl ActiveRun {
    /// Kills the process and everything it started.
    fn kill(&self) {
        self.stopped.store(true, Ordering::SeqCst);
        #[cfg(windows)]
        if let Some(tree) = &self.tree {
            tree.terminate();
        }
        if let Ok(mut child) = self.child.lock() {
            let _ = child.kill();
        }
    }
}

/// What the watcher thread needs to finish a run.
struct Watch {
    run_id: String,
    plan: RunPlan,
    child: Arc<Mutex<Child>>,
    stopped: Arc<AtomicBool>,
    tree: Tree,
    readers: Vec<thread::JoinHandle<()>>,
    sink: EventSink,
}

/// The runs in progress: at most one per file, each in its own process tree,
/// all killed when the app shuts down.
#[derive(Clone, Default)]
pub struct RunRegistry {
    runs: Arc<Mutex<HashMap<String, ActiveRun>>>,
    counter: Arc<AtomicU64>,
}

fn command_for(argv: &[String], cwd: &Path, plan: &RunPlan) -> Command {
    let mut command = Command::new(&argv[0]);
    command
        .args(&argv[1..])
        .current_dir(cwd)
        .env("PATH", &plan.path_var)
        .envs(plan.env.iter().cloned())
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    }
    command
}

fn elapsed_ms(since: Instant) -> u64 {
    u64::try_from(since.elapsed().as_millis()).unwrap_or(u64::MAX)
}

/// A fresh, empty build folder. Only folders inside a `run-builds` folder are ever cleared.
fn prepare_build_dir(dir: &Path) -> Result<(), RunError> {
    let fail = |reason: String| RunError::StartFailed {
        command: dir.display().to_string(),
        reason,
    };
    if !is_build_dir(dir) {
        return Err(fail("not a Run Code build folder".into()));
    }
    if dir.exists() {
        std::fs::remove_dir_all(dir).map_err(|err| fail(err.to_string()))?;
    }
    std::fs::create_dir_all(dir).map_err(|err| fail(err.to_string()))
}

/// A build folder lives under `.../run-builds/`: nothing else is ever deleted by a run.
pub fn is_build_dir(dir: &Path) -> bool {
    dir.is_absolute()
        && dir
            .parent()
            .into_iter()
            .flat_map(Path::ancestors)
            .any(|ancestor| ancestor.file_name().is_some_and(|name| name == BUILD_ROOT))
}

/// The folder name build folders live in (`<app>/cache/run-builds`).
pub const BUILD_ROOT: &str = "run-builds";

/// Removes a finished run's build folder. The program may hold its file for a moment after exiting, so this retries.
fn remove_build_dir(dir: &Path) {
    if !is_build_dir(dir) || !dir.exists() {
        return;
    }
    for _ in 0..20 {
        if std::fs::remove_dir_all(dir).is_ok() || !dir.exists() {
            return;
        }
        thread::sleep(Duration::from_millis(100));
    }
    tracing::warn!(dir = %dir.display(), "couldn't remove a Run Code build folder");
}

impl RunRegistry {
    pub fn new() -> Self {
        Self::default()
    }

    /// Starts the plan (its build first, for a compiled language) and streams its output to `sink`. Nothing is
    /// run through a shell: each argument list goes straight to the OS.
    pub fn start(&self, plan: &RunPlan, sink: EventSink) -> Result<RunInfo, RunError> {
        let file_key = plan.file.to_string_lossy().into_owned();
        let mut runs = self.runs.lock().map_err(|_| busy(&file_key))?;
        if runs.values().any(|run| run.info.file == file_key) {
            return Err(RunError::AlreadyRunning(file_key));
        }

        let (argv, display, cwd) = match &plan.build {
            Some(build) => {
                prepare_build_dir(&build.dir)?;
                (&build.argv, &build.display, &build.cwd)
            }
            None => (&plan.argv, &plan.display, &plan.cwd),
        };
        let mut child =
            command_for(argv, cwd, plan)
                .spawn()
                .map_err(|err| RunError::StartFailed {
                    command: display.clone(),
                    reason: err.to_string(),
                })?;
        let stdout = child.stdout.take();
        let stderr = child.stderr.take();
        let pid = child.id();
        #[cfg(windows)]
        let tree = assign_to_job(&child);
        #[cfg(not(windows))]
        let tree = ();

        let run_id = format!("run-{}", self.counter.fetch_add(1, Ordering::SeqCst) + 1);
        let info = RunInfo {
            run_id: run_id.clone(),
            file: file_key,
            pid,
        };
        let child = Arc::new(Mutex::new(child));
        let stopped = Arc::new(AtomicBool::new(false));
        runs.insert(
            run_id.clone(),
            ActiveRun {
                info: info.clone(),
                child: child.clone(),
                stopped: stopped.clone(),
                tree: tree.clone(),
            },
        );
        drop(runs);

        let phase = match &plan.build {
            Some(build) => {
                sink(RunEvent {
                    run_id: run_id.clone(),
                    event: RunEventKind::Building {
                        file: info.file.clone(),
                        command_line: build.display.clone(),
                        compiler: build.compiler.to_string_lossy().into_owned(),
                        cwd: plan.cwd.to_string_lossy().into_owned(),
                        runtime: plan.runtime_label.clone(),
                        language: plan.kind.display_name().to_string(),
                        pid,
                    },
                });
                Phase::Build
            }
            None => {
                sink(started_event(&run_id, plan, pid));
                Phase::Run
            }
        };
        let readers = pumps(stdout, stderr, phase, &run_id, &sink);
        self.watch(Watch {
            run_id,
            plan: plan.clone(),
            child,
            stopped,
            tree,
            readers,
            sink,
        });
        Ok(info)
    }

    /// Kills a run's whole process tree. `false` if it isn't running.
    pub fn stop(&self, run_id: &str) -> bool {
        let Ok(runs) = self.runs.lock() else {
            return false;
        };
        runs.get(run_id).is_some_and(|run| {
            run.kill();
            true
        })
    }

    /// Kills every run (app shutdown).
    pub fn stop_all(&self) {
        if let Ok(runs) = self.runs.lock() {
            for run in runs.values() {
                run.kill();
            }
        }
    }

    pub fn active(&self) -> Vec<RunInfo> {
        let mut infos: Vec<RunInfo> = self
            .runs
            .lock()
            .map(|runs| runs.values().map(|run| run.info.clone()).collect())
            .unwrap_or_default();
        infos.sort_by(|a, b| a.run_id.cmp(&b.run_id));
        infos
    }

    fn watch(&self, watch: Watch) {
        let runs = self.runs.clone();
        let started = Instant::now();
        thread::spawn(move || {
            let mut code = wait_for(&watch.child, &watch.readers);
            let mut build_failed = false;
            if let Some(build) = &watch.plan.build {
                // A two-step build (Assembly): the link runs only after the assembler succeeded.
                if let Some(link) = build.link.as_ref().filter(|_| code == Some(0)) {
                    code = link_program(&watch, link, &build.cwd);
                }
                let stopped = watch.stopped.load(Ordering::SeqCst);
                let success = code == Some(0) && !stopped;
                watch.sink(RunEvent {
                    run_id: watch.run_id.clone(),
                    event: RunEventKind::Built {
                        success,
                        code,
                        duration_ms: elapsed_ms(started),
                    },
                });
                if success {
                    code = run_program(&watch);
                } else {
                    build_failed = !stopped;
                }
            }
            if let Ok(mut runs) = runs.lock() {
                runs.remove(&watch.run_id);
            }
            if let Some(build) = &watch.plan.build {
                remove_build_dir(&build.dir);
            }
            (watch.sink)(RunEvent {
                run_id: watch.run_id,
                event: RunEventKind::Exited {
                    code,
                    duration_ms: elapsed_ms(started),
                    stopped: watch.stopped.load(Ordering::SeqCst),
                    build_failed,
                },
            });
        });
    }
}

impl Watch {
    fn sink(&self, event: RunEvent) {
        (self.sink)(event);
    }
}

fn started_event(run_id: &str, plan: &RunPlan, pid: u32) -> RunEvent {
    RunEvent {
        run_id: run_id.to_string(),
        event: RunEventKind::Started {
            file: plan.file.to_string_lossy().into_owned(),
            command_line: plan.display.clone(),
            resolved: plan.resolved.to_string_lossy().into_owned(),
            cwd: plan.cwd.to_string_lossy().into_owned(),
            runtime: plan.runtime_label.clone(),
            language: plan.kind.display_name().to_string(),
            pid,
        },
    }
}

/// Waits until the current process ends and its output has been read (briefly).
fn wait_for(child: &Mutex<Child>, readers: &[thread::JoinHandle<()>]) -> Option<i32> {
    let code = loop {
        let status = child.lock().ok().and_then(|mut c| c.try_wait().ok());
        match status {
            Some(Some(status)) => break status.code(),
            Some(None) => thread::sleep(POLL_INTERVAL),
            None => break None,
        }
    };
    // Let what the process wrote before dying reach the sink first.
    let deadline = Instant::now() + DRAIN_GRACE;
    while Instant::now() < deadline && readers.iter().any(|r| !r.is_finished()) {
        thread::sleep(Duration::from_millis(10));
    }
    code
}

/// After a successful assemble: runs the link command in the same process tree and waits for it. Its command line
/// and output are build output.
fn link_program(watch: &Watch, link: &crate::compiled::LinkStep, cwd: &Path) -> Option<i32> {
    watch.sink(RunEvent {
        run_id: watch.run_id.clone(),
        event: RunEventKind::Output {
            stream: Stream::Stdout,
            line: format!("> {}", link.display),
            phase: Phase::Build,
        },
    });
    let readers = spawn_next(watch, &link.argv, cwd, &link.display, Phase::Build)?;
    wait_for(&watch.child, &readers)
}

/// After a successful build: starts the program in the same process tree and waits for it.
fn run_program(watch: &Watch) -> Option<i32> {
    let readers = spawn_next(
        watch,
        &watch.plan.argv,
        &watch.plan.cwd,
        &watch.plan.display,
        Phase::Run,
    )?;
    wait_for(&watch.child, &readers)
}

/// Starts the run's next process (the linker, then the program) inside its job object, makes it the run's current
/// process and streams its output. `None` when stopped meanwhile or when it couldn't start (said in the output).
fn spawn_next(
    watch: &Watch,
    argv: &[String],
    cwd: &Path,
    display: &str,
    phase: Phase,
) -> Option<Vec<thread::JoinHandle<()>>> {
    if watch.stopped.load(Ordering::SeqCst) {
        return None;
    }
    let mut program = match command_for(argv, cwd, &watch.plan).spawn() {
        Ok(program) => program,
        Err(err) => {
            watch.sink(RunEvent {
                run_id: watch.run_id.clone(),
                event: RunEventKind::Output {
                    stream: Stream::Stderr,
                    line: format!("Couldn't start \"{display}\": {err}"),
                    phase,
                },
            });
            return None;
        }
    };
    #[cfg(windows)]
    if let Some(tree) = &watch.tree {
        use std::os::windows::io::AsRawHandle;
        if let Err(err) = tree.assign(program.as_raw_handle()) {
            tracing::warn!(
                ?err,
                "couldn't put a built program into its run's job object"
            );
        }
    }
    let stdout = program.stdout.take();
    let stderr = program.stderr.take();
    let pid = program.id();
    if let Ok(mut current) = watch.child.lock() {
        *current = program;
        // Stopped while it was starting: don't leave it running.
        if watch.stopped.load(Ordering::SeqCst) {
            let _ = current.kill();
        }
    }
    if phase == Phase::Run {
        watch.sink(started_event(&watch.run_id, &watch.plan, pid));
    }
    Some(pumps(stdout, stderr, phase, &watch.run_id, &watch.sink))
}

fn pumps(
    stdout: Option<ChildStdout>,
    stderr: Option<ChildStderr>,
    phase: Phase,
    run_id: &str,
    sink: &EventSink,
) -> Vec<thread::JoinHandle<()>> {
    [
        stdout.map(|pipe| pump(pipe, Stream::Stdout, phase, run_id, sink)),
        stderr.map(|pipe| pump(pipe, Stream::Stderr, phase, run_id, sink)),
    ]
    .into_iter()
    .flatten()
    .collect()
}

fn busy(file: &str) -> RunError {
    RunError::AlreadyRunning(file.to_string())
}

#[cfg(windows)]
fn assign_to_job(child: &Child) -> Option<Arc<openmind_process::ProcessTree>> {
    use std::os::windows::io::AsRawHandle;
    let tree = match openmind_process::ProcessTree::new() {
        Ok(tree) => tree,
        Err(err) => {
            tracing::warn!(
                ?err,
                "no job object for a run; only the process itself will be killed"
            );
            return None;
        }
    };
    match tree.assign(child.as_raw_handle()) {
        Ok(()) => Some(Arc::new(tree)),
        Err(err) => {
            tracing::warn!(?err, "couldn't put a run into its job object");
            None
        }
    }
}

/// Reads a pipe line by line (lossy UTF-8, `\r\n` trimmed) until it closes.
fn pump<R: Read + Send + 'static>(
    mut pipe: R,
    stream: Stream,
    phase: Phase,
    run_id: &str,
    sink: &EventSink,
) -> thread::JoinHandle<()> {
    let run_id = run_id.to_string();
    let sink = sink.clone();
    thread::spawn(move || {
        let mut pending: Vec<u8> = Vec::new();
        let mut buffer = [0u8; 4096];
        let emit = |bytes: &[u8]| {
            let text = String::from_utf8_lossy(bytes);
            sink(RunEvent {
                run_id: run_id.clone(),
                event: RunEventKind::Output {
                    stream,
                    line: text.trim_end_matches(['\r', '\n']).to_string(),
                    phase,
                },
            });
        };
        loop {
            match pipe.read(&mut buffer) {
                Ok(0) | Err(_) => break,
                Ok(n) => {
                    pending.extend_from_slice(&buffer[..n]);
                    while let Some(newline) = pending.iter().position(|&b| b == b'\n') {
                        let line: Vec<u8> = pending.drain(..=newline).collect();
                        emit(&line);
                    }
                }
            }
        }
        if !pending.is_empty() {
            emit(&pending);
        }
    })
}
