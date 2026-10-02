use std::collections::HashMap;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use portable_pty::{native_pty_system, Child, ChildKiller, CommandBuilder, MasterPty, PtySize};
use serde::Serialize;
use uuid::Uuid;

use crate::error::TerminalError;
use crate::shell::{default_shell, resolve_executable, ShellKind};

#[cfg(windows)]
use openmind_process::ProcessTree;

const READ_BUFFER_SIZE: usize = 8192;
const EXIT_OUTPUT_DRAIN: std::time::Duration = std::time::Duration::from_millis(150);

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalSessionInfo {
    pub id: String,
    pub shell: ShellKind,
    pub cwd: String,
    pub pid: Option<u32>,
}

#[derive(Debug, Clone, Default)]
pub struct CreateTerminalRequest {
    pub shell: Option<ShellKind>,
    /// The workspace folder to start in, if any. Falls back to
    /// `fallback_cwd` (passed separately to `create`) when this is `None`,
    /// doesn't exist, or isn't a directory — never fails/crashes over a bad
    /// cwd.
    pub cwd: Option<PathBuf>,
    pub cols: u16,
    pub rows: u16,
    /// Extra environment variables to set on top of this process's own
    /// inherited environment (which `CommandBuilder` passes through
    /// unchanged) — never a wholesale replacement, so PATH and everything
    /// else the shell needs stays intact.
    pub env: Vec<(String, String)>,
    /// Folders put in front of the shell's PATH (portable runtimes). Only the
    /// spawned shell sees the change — this process's and the system's PATH
    /// are never modified.
    pub path_prepend: Vec<PathBuf>,
    /// Runs this program in the terminal instead of the interactive shell (a task: the terminal ends when it
    /// ends, and its exit code is the program's). `shell` still names the shell family for the tab.
    pub program: Option<PathBuf>,
    pub args: Vec<String>,
}

/// Environment variables every terminal gets on top of the inherited
/// environment: enough for CLI tools to detect an xterm-compatible, colour
/// capable terminal (which is what xterm.js emulates). Deliberately tiny —
/// no PATH edits, no project-specific values.
pub fn default_environment() -> Vec<(String, String)> {
    vec![
        ("TERM".to_string(), "xterm-256color".to_string()),
        ("COLORTERM".to_string(), "truecolor".to_string()),
    ]
}

/// Kills a session's process tree. On Windows this is a real tree-kill (a
/// Job Object — see `job.rs`); everywhere else it falls back to killing just
/// the direct child process, since `portable-pty` has no cross-platform
/// process-tree API. This project targets Windows first; the fallback keeps
/// the crate compiling and minimally functional elsewhere rather than
/// claiming Unix support this milestone doesn't actually verify.
enum Killer {
    #[cfg(windows)]
    Tree(ProcessTree),
    Direct(Box<dyn ChildKiller + Send + Sync>),
}

impl Killer {
    fn kill(&mut self) {
        match self {
            #[cfg(windows)]
            Killer::Tree(tree) => tree.terminate(),
            Killer::Direct(killer) => {
                let _ = killer.kill();
            }
        }
    }
}

struct Session {
    master: Box<dyn MasterPty + Send>,
    writer: Box<dyn Write + Send>,
    killer: Killer,
}

/// Owns every live PTY session: spawning, writing input, resizing, and
/// killing. Framework-agnostic on purpose (no Tauri types anywhere in this
/// crate) — `on_output`/`on_exit` are plain closures the caller (the Tauri
/// command layer) uses to forward events however it likes, typically by
/// emitting a window event.
#[derive(Default)]
pub struct TerminalRegistry {
    sessions: Mutex<HashMap<String, Session>>,
}

impl TerminalRegistry {
    pub fn new() -> Self {
        Self::default()
    }

    /// A fresh, unique session id. Generated up front (rather than inside
    /// `create`) so the caller can move it into the `on_output`/`on_exit`
    /// closures it builds *before* calling `create` — those closures are the
    /// only place that knows which session a given event belongs to, since
    /// `create` doesn't return until after the shell has spawned, by which
    /// point output may already be arriving on the reader thread.
    pub fn generate_id() -> String {
        Uuid::new_v4().to_string()
    }

    pub fn create(
        &self,
        id: String,
        request: CreateTerminalRequest,
        fallback_cwd: &Path,
        on_output: impl Fn(&[u8]) + Send + 'static,
        on_exit: impl FnOnce(Option<i32>) + Send + 'static,
    ) -> Result<TerminalSessionInfo, TerminalError> {
        let shell = request.shell.unwrap_or_else(default_shell);
        let executable = match &request.program {
            Some(program) => program.clone(),
            None => resolve_executable(shell)?,
        };
        let cwd = resolve_cwd(request.cwd.as_deref(), fallback_cwd);

        let pty_system = native_pty_system();
        let pair = pty_system
            .openpty(PtySize {
                rows: request.rows.max(1),
                cols: request.cols.max(1),
                pixel_width: 0,
                pixel_height: 0,
            })
            .map_err(TerminalError::Spawn)?;

        let mut cmd = CommandBuilder::new(&executable);
        cmd.args(&request.args);
        cmd.cwd(&cwd);
        for (key, value) in &request.env {
            cmd.env(key, value);
        }
        if !request.path_prepend.is_empty() {
            let existing = cmd.get_env("PATH").map(std::ffi::OsStr::to_os_string);
            cmd.env("PATH", prepend_to_path(&request.path_prepend, existing));
        }

        let mut child = pair
            .slave
            .spawn_command(cmd)
            .map_err(TerminalError::Spawn)?;
        // The slave-side handle isn't needed once the child is spawned;
        // holding it open would keep the pty from ever reporting EOF to the
        // master's reader after the child exits.
        drop(pair.slave);

        let pid = child.process_id();
        let killer = make_killer(child.as_ref());
        let mut reader = pair
            .master
            .try_clone_reader()
            .map_err(TerminalError::Spawn)?;
        let writer = pair.master.take_writer().map_err(TerminalError::Spawn)?;

        let info = TerminalSessionInfo {
            id: id.clone(),
            shell,
            cwd: cwd.to_string_lossy().into_owned(),
            pid,
        };

        // portable-pty's reader is a blocking `Read`, so it needs its own OS
        // thread; this is the only place terminal output is produced. On
        // Windows (ConPTY) it does *not* see EOF when the shell exits — the
        // pipe stays open until the master is dropped — so it can't be what
        // detects the exit; it just ends once the session is closed.
        let thread_id = id.clone();
        std::thread::Builder::new()
            .name(format!("openmind-terminal-{thread_id}"))
            .spawn(move || {
                let mut buf = [0u8; READ_BUFFER_SIZE];
                loop {
                    match reader.read(&mut buf) {
                        Ok(0) | Err(_) => break,
                        Ok(n) => on_output(&buf[..n]),
                    }
                }
            })
            .expect("failed to spawn terminal reader thread");

        // Exit is detected by waiting on the child process itself. The short
        // pause lets the reader deliver whatever the shell printed as it
        // exited before the exit notification goes out behind it.
        std::thread::Builder::new()
            .name(format!("openmind-terminal-wait-{thread_id}"))
            .spawn(move || {
                let code = child.wait().ok().map(|status| status.exit_code() as i32);
                std::thread::sleep(EXIT_OUTPUT_DRAIN);
                on_exit(code);
            })
            .expect("failed to spawn terminal exit-watcher thread");

        self.sessions
            .lock()
            .expect("terminal registry poisoned")
            .insert(
                id,
                Session {
                    master: pair.master,
                    writer,
                    killer,
                },
            );

        Ok(info)
    }

    pub fn write(&self, id: &str, data: &[u8]) -> Result<(), TerminalError> {
        let mut sessions = self.sessions.lock().expect("terminal registry poisoned");
        let session = sessions
            .get_mut(id)
            .ok_or_else(|| TerminalError::NotFound(id.to_string()))?;
        session.writer.write_all(data).map_err(TerminalError::Write)
    }

    pub fn resize(&self, id: &str, cols: u16, rows: u16) -> Result<(), TerminalError> {
        let sessions = self.sessions.lock().expect("terminal registry poisoned");
        let session = sessions
            .get(id)
            .ok_or_else(|| TerminalError::NotFound(id.to_string()))?;
        session
            .master
            .resize(PtySize {
                rows: rows.max(1),
                cols: cols.max(1),
                pixel_width: 0,
                pixel_height: 0,
            })
            .map_err(TerminalError::Resize)
    }

    /// Whether a program is running in the session besides its shell (`None` for an unknown session, or where the
    /// process tree can't be read). A busy terminal is never restarted behind the user's back.
    pub fn is_busy(&self, id: &str) -> Option<bool> {
        let sessions = self.sessions.lock().ok()?;
        match &sessions.get(id)?.killer {
            #[cfg(windows)]
            Killer::Tree(tree) => tree.active_processes().ok().map(|count| count > 1),
            Killer::Direct(_) => None,
        }
    }

    /// Kills this session's whole process tree and forgets it. Safe to call
    /// on a session whose shell already exited on its own — killing an
    /// already-dead process tree is a no-op, not an error.
    pub fn close(&self, id: &str) -> Result<(), TerminalError> {
        let mut sessions = self.sessions.lock().expect("terminal registry poisoned");
        let mut session = sessions
            .remove(id)
            .ok_or_else(|| TerminalError::NotFound(id.to_string()))?;
        session.killer.kill();
        Ok(())
    }

    /// Kills every live session's process tree. Called once, from the app's
    /// shutdown path, so closing the last window can never leave a shell (or
    /// anything it spawned) running behind it.
    pub fn kill_all(&self) {
        let mut sessions = self.sessions.lock().expect("terminal registry poisoned");
        for (_, mut session) in sessions.drain() {
            session.killer.kill();
        }
    }
}

#[cfg(windows)]
fn make_killer(child: &(dyn Child + Send + Sync)) -> Killer {
    let Some(handle) = child.as_raw_handle() else {
        return Killer::Direct(child.clone_killer());
    };
    match ProcessTree::new() {
        Ok(tree) => match tree.assign(handle) {
            Ok(()) => Killer::Tree(tree),
            Err(err) => {
                tracing::warn!(?err, "failed to put terminal process into a job object");
                Killer::Direct(child.clone_killer())
            }
        },
        Err(err) => {
            tracing::warn!(
                ?err,
                "failed to create job object for terminal process tree"
            );
            Killer::Direct(child.clone_killer())
        }
    }
}

#[cfg(not(windows))]
fn make_killer(child: &(dyn Child + Send + Sync)) -> Killer {
    Killer::Direct(child.clone_killer())
}

/// `dirs` in front of `existing`, PATH-joined. Pure, so it's unit-tested
/// without spawning anything.
fn prepend_to_path(dirs: &[PathBuf], existing: Option<std::ffi::OsString>) -> std::ffi::OsString {
    openmind_core::path_env::prepend_path(dirs, existing.as_deref())
        .or(existing)
        .unwrap_or_default()
}

fn resolve_cwd(requested: Option<&Path>, fallback: &Path) -> PathBuf {
    match requested {
        Some(path) if path.is_dir() => path.to_path_buf(),
        _ => fallback.to_path_buf(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn resolve_cwd_falls_back_when_requested_path_is_missing() {
        let fallback = Path::new(".");
        let missing = Path::new("Z:/definitely/does/not/exist/anywhere");

        assert_eq!(resolve_cwd(Some(missing), fallback), fallback);
    }

    #[test]
    fn resolve_cwd_falls_back_when_nothing_was_requested() {
        let fallback = Path::new(".");

        assert_eq!(resolve_cwd(None, fallback), fallback);
    }

    #[test]
    fn resolve_cwd_uses_the_requested_path_when_it_is_a_real_directory() {
        let dir = tempfile::tempdir().expect("tempdir");
        let fallback = Path::new(".");

        assert_eq!(resolve_cwd(Some(dir.path()), fallback), dir.path());
    }

    #[test]
    fn default_environment_sets_terminal_capabilities_and_never_touches_path() {
        let env = default_environment();

        assert!(env.contains(&("TERM".to_string(), "xterm-256color".to_string())));
        assert!(env.contains(&("COLORTERM".to_string(), "truecolor".to_string())));
        assert!(env.iter().all(|(key, _)| !key.eq_ignore_ascii_case("PATH")));
    }

    #[test]
    fn session_ids_are_unique() {
        assert_ne!(
            TerminalRegistry::generate_id(),
            TerminalRegistry::generate_id()
        );
    }

    #[test]
    fn operations_on_an_unknown_session_report_not_found() {
        let registry = TerminalRegistry::new();

        assert!(matches!(
            registry.write("nope", b"x"),
            Err(TerminalError::NotFound(_))
        ));
        assert!(matches!(
            registry.resize("nope", 80, 24),
            Err(TerminalError::NotFound(_))
        ));
        assert!(matches!(
            registry.close("nope"),
            Err(TerminalError::NotFound(_))
        ));
    }

    #[test]
    fn creating_a_session_with_an_unavailable_shell_fails_cleanly_and_leaves_no_session() {
        let registry = TerminalRegistry::new();
        let id = TerminalRegistry::generate_id();

        for shell in crate::shell::detect_shells()
            .into_iter()
            .filter(|shell| !shell.available)
        {
            let result = registry.create(
                id.clone(),
                CreateTerminalRequest {
                    shell: Some(shell.kind),
                    cols: 80,
                    rows: 24,
                    ..Default::default()
                },
                &std::env::temp_dir(),
                |_| {},
                |_| {},
            );

            assert!(matches!(result, Err(TerminalError::ShellUnavailable)));
            assert!(matches!(
                registry.write(&id, b"x"),
                Err(TerminalError::NotFound(_))
            ));
        }
    }

    #[test]
    fn a_bad_cwd_falls_back_instead_of_failing_the_spawn() {
        let registry = TerminalRegistry::new();
        let fallback = std::env::temp_dir();

        let info = registry
            .create(
                TerminalRegistry::generate_id(),
                CreateTerminalRequest {
                    shell: Some(ShellKind::Cmd),
                    cwd: Some(PathBuf::from("Z:/definitely/does/not/exist")),
                    cols: 80,
                    rows: 24,
                    env: default_environment(),
                    path_prepend: Vec::new(),
                    ..Default::default()
                },
                &fallback,
                |_| {},
                |_| {},
            )
            .expect("spawn with a bad cwd");

        assert_eq!(PathBuf::from(&info.cwd), fallback);
        registry.kill_all();
    }

    #[test]
    fn kill_all_removes_every_session() {
        let registry = TerminalRegistry::new();
        let fallback = std::env::temp_dir();
        let ids: Vec<String> = (0..2)
            .map(|_| {
                registry
                    .create(
                        TerminalRegistry::generate_id(),
                        CreateTerminalRequest {
                            shell: Some(ShellKind::Cmd),
                            cols: 80,
                            rows: 24,
                            ..Default::default()
                        },
                        &fallback,
                        |_| {},
                        |_| {},
                    )
                    .expect("create")
                    .id
            })
            .collect();

        registry.kill_all();

        for id in ids {
            assert!(matches!(
                registry.write(&id, b"x"),
                Err(TerminalError::NotFound(_))
            ));
        }
    }

    /// A terminal is busy while a program it started runs, and idle again at the prompt: what decides whether it
    /// may be restarted for a new runtime environment.
    #[cfg(windows)]
    #[test]
    fn a_session_is_busy_only_while_a_program_runs_in_it() {
        let registry = std::sync::Arc::new(TerminalRegistry::new());
        let info = create_answering_cursor_queries(&registry);
        let idle = (0..50).any(|_| {
            std::thread::sleep(std::time::Duration::from_millis(100));
            registry.is_busy(&info.id) == Some(false)
        });
        assert!(idle, "an idle shell counted as busy");

        registry
            .write(&info.id, b"ping -n 4 127.0.0.1 > nul\r\n")
            .expect("start child");
        let busy = (0..50).any(|_| {
            std::thread::sleep(std::time::Duration::from_millis(100));
            registry.is_busy(&info.id) == Some(true)
        });
        assert!(busy, "a running program wasn't seen");
        let idle_again = (0..100).any(|_| {
            std::thread::sleep(std::time::Duration::from_millis(100));
            registry.is_busy(&info.id) == Some(false)
        });
        assert!(idle_again, "the shell stayed busy after its program ended");
        assert_eq!(registry.is_busy("no such session"), None);
        registry.close(&info.id).expect("close");
    }

    /// The whole point of the job object: a process the shell started must die
    /// with the shell, not be orphaned. Marked with a unique title so this
    /// test can find *its own* ping process among any others on the machine.
    #[cfg(windows)]
    #[test]
    fn closing_a_session_kills_processes_the_shell_spawned() {
        let registry = std::sync::Arc::new(TerminalRegistry::new());
        let info = create_answering_cursor_queries(&registry);
        let shell_pid = info.pid.expect("shell pid");
        registry
            .write(&info.id, b"ping -n 60 127.0.0.1 > nul\r\n")
            .expect("start child");

        let child_pid = wait_for_child_of(shell_pid);
        assert!(child_pid.is_some(), "the shell never started its child");

        registry.close(&info.id).expect("close");

        let child_pid = child_pid.unwrap_or_default();
        let gone = (0..40).any(|_| {
            std::thread::sleep(std::time::Duration::from_millis(100));
            !process_exists(child_pid)
        });
        assert!(
            gone,
            "the shell's child process survived closing the terminal"
        );
    }

    /// ConPTY asks its host where the cursor is (`ESC[6n`) and holds the
    /// shell back until it gets an answer — in the app xterm.js replies, so a
    /// test driving a real shell has to play that part itself.
    #[cfg(windows)]
    fn create_answering_cursor_queries(
        registry: &std::sync::Arc<TerminalRegistry>,
    ) -> TerminalSessionInfo {
        create_answering_cursor_queries_with_exit(registry, |_| {})
    }

    #[cfg(windows)]
    fn create_answering_cursor_queries_with_exit(
        registry: &std::sync::Arc<TerminalRegistry>,
        on_exit: impl FnOnce(Option<i32>) + Send + 'static,
    ) -> TerminalSessionInfo {
        create_answering(
            registry,
            CreateTerminalRequest {
                shell: Some(ShellKind::Cmd),
                cols: 80,
                rows: 24,
                ..Default::default()
            },
            |_| {},
            on_exit,
        )
    }

    /// Like `create`, but also plays xterm's part in answering ConPTY's
    /// cursor-position query, and hands every output chunk to `on_output`.
    #[cfg(windows)]
    fn create_answering(
        registry: &std::sync::Arc<TerminalRegistry>,
        request: CreateTerminalRequest,
        on_output: impl Fn(&[u8]) + Send + 'static,
        on_exit: impl FnOnce(Option<i32>) + Send + 'static,
    ) -> TerminalSessionInfo {
        let id = TerminalRegistry::generate_id();
        let responder = registry.clone();
        let responder_id = id.clone();
        registry
            .create(
                id,
                request,
                &std::env::temp_dir(),
                move |data| {
                    on_output(data);
                    if data.windows(4).any(|w| w == b"[6n") {
                        // The query can arrive before `create` has recorded the
                        // session, so retry until the write is accepted.
                        let responder = responder.clone();
                        let id = responder_id.clone();
                        std::thread::spawn(move || {
                            for _ in 0..50 {
                                if responder.write(&id, b"[1;1R").is_ok() {
                                    break;
                                }
                                std::thread::sleep(std::time::Duration::from_millis(20));
                            }
                        });
                    }
                },
                on_exit,
            )
            .expect("create")
    }

    #[cfg(windows)]
    fn wait_for_child_of(parent: u32) -> Option<u32> {
        for _ in 0..20 {
            let output = std::process::Command::new("powershell")
                .args([
                    "-NoProfile",
                    "-Command",
                    &format!(
                        "(Get-CimInstance Win32_Process -Filter 'ParentProcessId={parent}' | Select-Object -First 1).ProcessId"
                    ),
                ])
                .output()
                .ok()?;
            let text = String::from_utf8_lossy(&output.stdout).into_owned();
            if let Ok(pid) = text.trim().parse::<u32>() {
                return Some(pid);
            }
            std::thread::sleep(std::time::Duration::from_millis(100));
        }
        None
    }

    #[cfg(windows)]
    fn process_exists(pid: u32) -> bool {
        let output = std::process::Command::new("tasklist")
            .args(["/FI", &format!("PID eq {pid}"), "/NH"])
            .output();
        output
            .map(|out| String::from_utf8_lossy(&out.stdout).contains(&pid.to_string()))
            .unwrap_or(false)
    }

    /// A task runs as the terminal's own program: its output is the terminal's, and its exit code is reported.
    #[cfg(windows)]
    #[test]
    fn a_program_runs_in_place_of_the_shell_and_its_exit_code_is_reported() {
        let registry = std::sync::Arc::new(TerminalRegistry::new());
        let (tx, rx) = std::sync::mpsc::channel();
        let cmd = crate::shell::ShellKind::Cmd.executable().expect("cmd.exe");
        let output = std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));
        let sink = std::sync::Arc::clone(&output);
        create_answering(
            &registry,
            CreateTerminalRequest {
                shell: Some(ShellKind::Cmd),
                cols: 80,
                rows: 24,
                program: Some(cmd),
                args: vec![
                    "/d".into(),
                    "/c".into(),
                    "echo task-output && exit 3".into(),
                ],
                ..Default::default()
            },
            move |chunk| sink.lock().expect("lock").extend_from_slice(chunk),
            move |code| {
                let _ = tx.send(code);
            },
        );
        let code = rx
            .recv_timeout(std::time::Duration::from_secs(10))
            .expect("the exit was never reported");
        assert_eq!(code, Some(3));
        let text = String::from_utf8_lossy(&output.lock().expect("lock")).to_string();
        assert!(text.contains("task-output"), "{text}");
    }

    /// Regression: on Windows the pty's output pipe never reports EOF while
    /// the master is open, so exit has to be detected from the child process.
    #[cfg(windows)]
    #[test]
    fn a_shell_that_exits_on_its_own_is_reported_even_though_the_pty_stays_open() {
        let registry = std::sync::Arc::new(TerminalRegistry::new());
        let (tx, rx) = std::sync::mpsc::channel();
        let info = create_answering_cursor_queries_with_exit(&registry, move |code| {
            let _ = tx.send(code);
        });

        registry.write(&info.id, b"exit 7\r\n").expect("write exit");

        let code = rx
            .recv_timeout(std::time::Duration::from_secs(10))
            .expect("the exit was never reported");
        assert_eq!(code, Some(7));
        // The tab stays around until the user closes it, and closing an
        // already-exited session is clean.
        registry.close(&info.id).expect("close after exit");
    }

    #[test]
    fn prepend_to_path_puts_runtime_folders_first_and_keeps_the_existing_path() {
        let existing =
            std::env::join_paths([PathBuf::from("/a"), PathBuf::from("/b")]).expect("join");

        let joined = prepend_to_path(&[PathBuf::from("/rt")], Some(existing));

        assert_eq!(
            std::env::split_paths(&joined).collect::<Vec<_>>(),
            vec![
                PathBuf::from("/rt"),
                PathBuf::from("/a"),
                PathBuf::from("/b")
            ]
        );
        assert_eq!(
            std::env::split_paths(&prepend_to_path(&[PathBuf::from("/rt")], None))
                .collect::<Vec<_>>(),
            vec![PathBuf::from("/rt")]
        );
    }

    /// The point of the feature: a runtime folder handed to a new terminal is
    /// really on that shell's PATH (a tool inside it runs by bare name) —
    /// while this test process's own PATH is untouched.
    #[cfg(windows)]
    #[test]
    fn a_shell_sees_injected_folders_on_its_path_and_the_parent_process_does_not() {
        let tools = tempfile::tempdir().expect("tempdir");
        std::fs::write(tools.path().join("omtool.cmd"), "@echo OMTOOL-RAN-OK\r\n").expect("tool");
        let parent_path_before = std::env::var_os("PATH");
        let registry = std::sync::Arc::new(TerminalRegistry::new());
        let output = std::sync::Arc::new(std::sync::Mutex::new(Vec::<u8>::new()));
        let sink = output.clone();

        let info = create_answering(
            &registry,
            CreateTerminalRequest {
                shell: Some(ShellKind::Cmd),
                cols: 200,
                rows: 24,
                path_prepend: vec![tools.path().to_path_buf()],
                ..Default::default()
            },
            move |data| sink.lock().expect("lock").extend_from_slice(data),
            |_| {},
        );
        registry.write(&info.id, b"omtool\r\n").expect("run tool");

        let ran = (0..60).any(|_| {
            std::thread::sleep(std::time::Duration::from_millis(100));
            String::from_utf8_lossy(&output.lock().expect("lock")).contains("OMTOOL-RAN-OK")
        });
        registry.close(&info.id).expect("close");

        assert!(
            ran,
            "the shell could not run a tool from an injected folder"
        );
        assert_eq!(std::env::var_os("PATH"), parent_path_before);
        assert!(std::env::var_os("PATH").is_none_or(|path| !path
            .to_string_lossy()
            .contains(&*tools.path().to_string_lossy())));
    }

    #[test]
    fn create_write_and_close_a_real_shell_session() {
        let registry = TerminalRegistry::new();
        let fallback = std::env::temp_dir();
        let exited = std::sync::Arc::new(std::sync::Mutex::new(None));
        let exited_writer = exited.clone();

        let info = registry
            .create(
                TerminalRegistry::generate_id(),
                CreateTerminalRequest {
                    shell: Some(ShellKind::Cmd),
                    cols: 80,
                    rows: 24,
                    ..Default::default()
                },
                &fallback,
                |_data| {},
                move |code| {
                    *exited_writer.lock().expect("lock") = Some(code);
                },
            )
            .expect("create a cmd.exe session");

        assert!(!info.id.is_empty());
        assert_eq!(info.shell, ShellKind::Cmd);

        registry.write(&info.id, b"exit\r\n").expect("write exit");
        registry.resize(&info.id, 100, 30).expect("resize");

        // Give the shell a moment to process `exit` before we tear it down
        // ourselves; either way is a valid end state for this test.
        std::thread::sleep(std::time::Duration::from_millis(300));
        registry.close(&info.id).expect("close");

        assert!(matches!(
            registry.write(&info.id, b"noop"),
            Err(TerminalError::NotFound(_))
        ));
    }
}
