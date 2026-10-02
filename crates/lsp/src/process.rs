//! Starting programs for the language tools: a direct child process (never a
//! shell), an argument list, no console window, and — on Windows — a Job
//! Object so the process and everything it starts dies together.

use std::ffi::OsString;
use std::io::{BufRead, BufReader, Read};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStderr, ChildStdin, ChildStdout, Command, Stdio};
use std::thread;
use std::time::Duration;

use crate::error::LspError;

/// What to run.
#[derive(Debug, Clone)]
pub struct SpawnSpec {
    pub program: PathBuf,
    pub args: Vec<String>,
    pub cwd: PathBuf,
    /// Extra variables for this child only.
    pub vars: Vec<(String, String)>,
    /// Folders put in front of this child's PATH (never the system PATH).
    pub path_prepend: Vec<PathBuf>,
}

impl SpawnSpec {
    fn command(&self) -> Command {
        let mut command = Command::new(&self.program);
        command.args(&self.args).current_dir(&self.cwd);
        for (key, value) in &self.vars {
            command.env(key, value);
        }
        if let Some(path) = joined_path(&self.path_prepend, std::env::var_os("PATH")) {
            command.env("PATH", path);
        }
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            command.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
        }
        command
    }
}

/// `prepend` in front of `existing` (each folder once: `openmind_core::path_env`), or `None` when there is nothing to
/// add.
pub fn joined_path(prepend: &[PathBuf], existing: Option<OsString>) -> Option<OsString> {
    if prepend.is_empty() {
        return None;
    }
    openmind_core::path_env::prepend_path(prepend, existing.as_deref())
}

/// A running child and its process tree.
pub struct ServerProcess {
    child: Child,
    #[cfg(windows)]
    tree: Option<openmind_process::ProcessTree>,
}

impl ServerProcess {
    pub fn id(&self) -> u32 {
        self.child.id()
    }

    /// Kills the process and everything it started.
    pub fn kill(&mut self) {
        #[cfg(windows)]
        if let Some(tree) = &self.tree {
            tree.terminate();
        }
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

#[cfg(windows)]
fn track(child: &Child) -> Option<openmind_process::ProcessTree> {
    use std::os::windows::io::AsRawHandle;
    let tree = openmind_process::ProcessTree::new().ok()?;
    tree.assign(child.as_raw_handle()).ok()?;
    Some(tree)
}

/// A started server: the process and its three pipes.
pub struct Spawned {
    pub process: ServerProcess,
    pub stdin: ChildStdin,
    pub stdout: ChildStdout,
    pub stderr: ChildStderr,
}

pub fn spawn(spec: &SpawnSpec) -> Result<Spawned, LspError> {
    let mut command = spec.command();
    command
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let mut child = command
        .spawn()
        .map_err(|err| LspError::StartFailed(format!("{}: {err}", spec.program.display())))?;
    let (Some(stdin), Some(stdout), Some(stderr)) =
        (child.stdin.take(), child.stdout.take(), child.stderr.take())
    else {
        let _ = child.kill();
        return Err(LspError::StartFailed("no stdio pipes".into()));
    };
    #[cfg(windows)]
    let tree = track(&child);
    Ok(Spawned {
        process: ServerProcess {
            child,
            #[cfg(windows)]
            tree,
        },
        stdin,
        stdout,
        stderr,
    })
}

/// Calls `on_line` for every line `pipe` produces, on its own thread.
pub fn pump_lines<R: Read + Send + 'static>(
    pipe: R,
    on_line: impl Fn(&str) + Send + 'static,
) -> thread::JoinHandle<()> {
    thread::spawn(move || {
        for line in BufReader::new(pipe).lines().map_while(Result::ok) {
            let line = line.trim_end();
            if !line.is_empty() {
                on_line(line);
            }
        }
    })
}

/// Runs a short-lived command to the end (used to install servers), reporting
/// its output line by line. A run over `timeout` is killed. Returns the exit code.
pub fn run_to_end(
    spec: &SpawnSpec,
    timeout: Duration,
    on_line: impl Fn(&str) + Send + Sync + Clone + 'static,
) -> Result<Option<i32>, LspError> {
    let mut command = spec.command();
    command
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let mut child = command
        .spawn()
        .map_err(|err| LspError::StartFailed(format!("{}: {err}", spec.program.display())))?;
    #[cfg(windows)]
    let tree = track(&child);
    let mut pumps = Vec::new();
    if let Some(stdout) = child.stdout.take() {
        pumps.push(pump_lines(stdout, on_line.clone()));
    }
    if let Some(stderr) = child.stderr.take() {
        pumps.push(pump_lines(stderr, on_line));
    }
    let deadline = std::time::Instant::now() + timeout;
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break Some(status),
            Ok(None) if std::time::Instant::now() >= deadline => break None,
            Ok(None) => thread::sleep(Duration::from_millis(20)),
            Err(err) => return Err(LspError::StartFailed(err.to_string())),
        }
    };
    if status.is_none() {
        #[cfg(windows)]
        if let Some(tree) = &tree {
            tree.terminate();
        }
        let _ = child.kill();
        let _ = child.wait();
    }
    for pump in pumps {
        let _ = pump.join();
    }
    status.map(|status| status.code()).ok_or(LspError::Timeout)
}

/// The folder a program lives in (for locating files shipped next to it).
pub fn parent_dir(path: &Path) -> Option<PathBuf> {
    path.parent().map(Path::to_path_buf)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn prepended_folders_come_first_and_nothing_is_added_when_empty() {
        assert!(joined_path(&[], Some(OsString::from("C:\\a"))).is_none());
        let joined = joined_path(
            &[PathBuf::from("C:/My Tools/bin")],
            Some(std::env::join_paths(["C:/x", "C:/y"]).expect("join")),
        )
        .expect("joined");
        let dirs: Vec<PathBuf> = std::env::split_paths(&joined).collect();
        assert_eq!(dirs[0], PathBuf::from("C:/My Tools/bin"));
        assert_eq!(dirs.len(), 3);
    }

    #[test]
    fn a_missing_program_is_a_start_failure_naming_it() {
        let spec = SpawnSpec {
            program: PathBuf::from("C:/does not exist/node.exe"),
            args: vec![],
            cwd: std::env::temp_dir(),
            vars: vec![],
            path_prepend: vec![],
        };
        let err = spawn(&spec).map(|_| ()).expect_err("missing");
        assert!(matches!(&err, LspError::StartFailed(text) if text.contains("does not exist")));
    }

    #[cfg(windows)]
    #[test]
    fn run_to_end_reports_output_and_the_exit_code_with_spaces_in_the_cwd() {
        let dir = tempfile::tempdir().expect("tempdir");
        let cwd = dir.path().join("with space");
        std::fs::create_dir(&cwd).expect("mkdir");
        let spec = SpawnSpec {
            program: PathBuf::from("cmd.exe"),
            args: vec!["/C".into(), "echo hello & exit 3".into()],
            cwd,
            vars: vec![],
            path_prepend: vec![],
        };
        let lines = std::sync::Arc::new(std::sync::Mutex::new(Vec::<String>::new()));
        let sink = std::sync::Arc::clone(&lines);
        let code = run_to_end(&spec, Duration::from_secs(20), move |line| {
            if let Ok(mut lines) = sink.lock() {
                lines.push(line.to_string());
            }
        })
        .expect("ran");
        assert_eq!(code, Some(3));
        assert!(lines
            .lock()
            .expect("lines")
            .iter()
            .any(|l| l.contains("hello")));
    }

    #[cfg(windows)]
    #[test]
    fn a_command_over_its_time_limit_is_killed() {
        let spec = SpawnSpec {
            program: PathBuf::from("ping.exe"),
            args: vec!["-n".into(), "30".into(), "127.0.0.1".into()],
            cwd: std::env::temp_dir(),
            vars: vec![],
            path_prepend: vec![],
        };
        let started = std::time::Instant::now();
        let err = run_to_end(&spec, Duration::from_millis(300), |_| {}).expect_err("timeout");
        assert!(matches!(err, LspError::Timeout));
        assert!(started.elapsed() < Duration::from_secs(10));
    }
}
