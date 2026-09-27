//! Runs an external formatter on text: the text goes to the tool's stdin and the formatted text comes back from its
//! stdout. The tool is started as an argument list (never through a shell) in a folder chosen by the caller, with a
//! time limit; on Windows it and everything it starts live in a Job Object, so a timeout kills the whole tree (a
//! `prettier.cmd` starts a `node`). The caller's PATH is never changed: a portable runtime's folders are put in front
//! of PATH for this one child only.

use std::ffi::OsString;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::thread;
use std::time::{Duration, Instant};

use thiserror::Error;

/// The most a formatter may print (twice the size limit of what it is given, plus room for a few notes).
const MAX_OUTPUT_BYTES: usize = 4_500_000;

#[derive(Debug, Error, PartialEq, Eq)]
pub enum RunError {
    #[error("{0} could not be started: {1}")]
    Start(String, String),
    #[error("{0} did not finish within {1} seconds and was stopped.")]
    Timeout(String, u64),
    #[error("{0} failed{1}")]
    Failed(String, String),
    #[error("{0} printed something that is not text.")]
    NotText(String),
    #[error("{0} printed nothing, so the file was left as it is.")]
    Empty(String),
    #[error("{0} printed more than the allowed amount.")]
    TooMuch(String),
}

/// Everything a run needs.
pub struct Job<'a> {
    /// Program first.
    pub argv: &'a [String],
    pub cwd: &'a Path,
    pub input: &'a str,
    pub timeout: Duration,
    /// Folders put in front of PATH for the child only.
    pub path_prepend: &'a [PathBuf],
}

fn stem(path: &str) -> String {
    Path::new(path)
        .file_stem()
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_else(|| path.to_string())
}

/// The tool's name for messages: the program's, or for a Node launcher (`node <script> ...`) the script's.
fn label(argv: &[String]) -> String {
    match argv {
        [program, script, ..] if stem(program).eq_ignore_ascii_case("node") => stem(script),
        [program, ..] => stem(program),
        [] => "The formatter".into(),
    }
}

fn child_path(prepend: &[PathBuf]) -> Option<OsString> {
    if prepend.is_empty() {
        return None;
    }
    let existing = std::env::var_os("PATH").unwrap_or_default();
    let all = prepend
        .iter()
        .cloned()
        .chain(std::env::split_paths(&existing));
    std::env::join_paths(all).ok()
}

fn drain<R: Read + Send + 'static>(pipe: Option<R>, limit: usize) -> thread::JoinHandle<Vec<u8>> {
    thread::spawn(move || {
        let mut bytes = Vec::new();
        if let Some(pipe) = pipe {
            let _ = pipe.take(limit as u64 + 1).read_to_end(&mut bytes);
        }
        bytes
    })
}

#[cfg(windows)]
fn contain(child: &std::process::Child) -> Option<openmind_process::ProcessTree> {
    use std::os::windows::io::AsRawHandle;
    let tree = openmind_process::ProcessTree::new().ok()?;
    tree.assign(child.as_raw_handle()).ok()?;
    Some(tree)
}

#[cfg(not(windows))]
fn contain(_child: &std::process::Child) -> Option<()> {
    None
}

fn stop(child: &mut std::process::Child, tree: &Option<impl StopTree>) {
    if let Some(tree) = tree {
        tree.stop_all();
    }
    let _ = child.kill();
    let _ = child.wait();
}

trait StopTree {
    fn stop_all(&self);
}

#[cfg(windows)]
impl StopTree for openmind_process::ProcessTree {
    fn stop_all(&self) {
        self.terminate();
    }
}

impl StopTree for () {
    fn stop_all(&self) {}
}

fn wait(
    child: &mut std::process::Child,
    tree: &Option<impl StopTree>,
    name: &str,
    timeout: Duration,
) -> Result<Option<i32>, RunError> {
    let deadline = Instant::now() + timeout;
    loop {
        match child.try_wait() {
            Ok(Some(status)) => return Ok(status.code()),
            Ok(None) if Instant::now() >= deadline => {
                stop(child, tree);
                return Err(RunError::Timeout(name.to_string(), timeout.as_secs()));
            }
            Ok(None) => thread::sleep(Duration::from_millis(10)),
            Err(err) => return Err(RunError::Start(name.to_string(), err.to_string())),
        }
    }
}

fn start(job: &Job<'_>, name: &str) -> Result<std::process::Child, RunError> {
    let (program, args) = job
        .argv
        .split_first()
        .ok_or_else(|| RunError::Start(name.to_string(), "no command".into()))?;
    let mut command = Command::new(program);
    command
        .args(args)
        .current_dir(job.cwd)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    if let Some(path) = child_path(job.path_prepend) {
        command.env("PATH", path);
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    }
    command
        .spawn()
        .map_err(|err| RunError::Start(name.to_string(), err.to_string()))
}

fn first_lines(text: &str) -> String {
    let trimmed = text.trim();
    if trimmed.is_empty() {
        return String::new();
    }
    let lines: Vec<&str> = trimmed.lines().take(12).collect();
    format!(
        ":\n{}",
        lines.join("\n").chars().take(2000).collect::<String>()
    )
}

/// Formats `job.input` with the tool and returns its output. A tool that fails, prints nothing for a non-empty input,
/// prints invalid text or takes too long yields an error and the caller keeps its original text.
pub fn run_stdin(job: &Job<'_>) -> Result<String, RunError> {
    let name = label(job.argv);
    let mut child = start(job, &name)?;
    let tree = contain(&child);
    let stdout = drain(child.stdout.take(), MAX_OUTPUT_BYTES);
    let stderr = drain(child.stderr.take(), 64_000);
    let input = job.input.as_bytes().to_vec();
    let stdin = child.stdin.take();
    let feeder = thread::spawn(move || {
        if let Some(mut stdin) = stdin {
            // A tool that quits early closes the pipe; that is reported by its exit code.
            let _ = stdin.write_all(&input);
        }
    });
    let code = wait(&mut child, &tree, &name, job.timeout)?;
    let _ = feeder.join();
    let out = stdout.join().unwrap_or_default();
    let err = String::from_utf8_lossy(&stderr.join().unwrap_or_default()).into_owned();
    if code != Some(0) {
        return Err(RunError::Failed(name, first_lines(&err)));
    }
    if out.len() > MAX_OUTPUT_BYTES {
        return Err(RunError::TooMuch(name));
    }
    let text = String::from_utf8(out).map_err(|_| RunError::NotText(name.clone()))?;
    if text.trim().is_empty() && !job.input.trim().is_empty() {
        return Err(RunError::Empty(name));
    }
    Ok(text)
}

#[cfg(test)]
mod label_tests {
    use super::label;

    #[test]
    fn a_node_launcher_is_named_after_its_script() {
        let argv = |items: &[&str]| items.iter().map(|s| s.to_string()).collect::<Vec<_>>();
        assert_eq!(
            label(&argv(&[
                "C:/App/lsp/node/node.exe",
                "C:/x/bin/prettier.cjs",
                "--plugin=a"
            ])),
            "prettier"
        );
        assert_eq!(label(&argv(&["C:/tools/ruff.exe", "format"])), "ruff");
        assert_eq!(label(&[]), "The formatter");
    }
}

#[cfg(all(test, windows))]
mod tests {
    use super::*;

    fn cmd(args: &[&str]) -> Vec<String> {
        let mut v = vec!["cmd.exe".to_string(), "/C".to_string()];
        v.extend(args.iter().map(|s| s.to_string()));
        v
    }

    fn job<'a>(argv: &'a [String], input: &'a str, secs: u64, cwd: &'a Path) -> Job<'a> {
        Job {
            argv,
            cwd,
            input,
            timeout: Duration::from_secs(secs),
            path_prepend: &[],
        }
    }

    #[test]
    fn text_goes_through_stdin_and_stdout() {
        let dir = tempfile::tempdir().expect("tmp");
        // `findstr "^"` copies stdin to stdout.
        let argv = vec!["findstr.exe".to_string(), "^".to_string()];
        let out = run_stdin(&job(&argv, "a\r\nb\r\n", 10, dir.path())).expect("runs");
        assert_eq!(out.replace("\r\n", "\n"), "a\nb\n");
    }

    #[test]
    fn a_failing_tool_reports_its_message_and_a_slow_one_is_stopped() {
        let dir = tempfile::tempdir().expect("tmp");
        let bad = cmd(&["echo boom 1>&2 & exit 3"]);
        let err = run_stdin(&job(&bad, "x", 10, dir.path())).expect_err("fails");
        assert!(
            matches!(&err, RunError::Failed(_, m) if m.contains("boom")),
            "{err}"
        );
        let slow = vec![
            "ping.exe".into(),
            "-n".into(),
            "30".into(),
            "127.0.0.1".into(),
        ];
        let started = Instant::now();
        let err = run_stdin(&job(&slow, "x", 1, dir.path())).expect_err("times out");
        assert!(matches!(err, RunError::Timeout(_, 1)), "{err}");
        assert!(started.elapsed() < Duration::from_secs(10));
    }

    #[test]
    fn a_tool_that_prints_nothing_never_empties_the_file() {
        let dir = tempfile::tempdir().expect("tmp");
        let quiet = cmd(&["exit 0"]);
        let err = run_stdin(&job(&quiet, "data", 10, dir.path())).expect_err("empty");
        assert!(matches!(err, RunError::Empty(_)), "{err}");
    }

    #[test]
    fn a_missing_program_is_a_start_error_naming_it() {
        let dir = tempfile::tempdir().expect("tmp");
        let argv = vec!["definitely-not-a-formatter.exe".to_string()];
        let err = run_stdin(&job(&argv, "x", 5, dir.path())).expect_err("missing");
        assert!(matches!(err, RunError::Start(name, _) if name == "definitely-not-a-formatter"));
    }

    #[test]
    fn the_tool_runs_in_the_given_folder_and_only_its_own_path_gains_the_runtime_folders() {
        let dir = tempfile::tempdir().expect("tmp");
        let cwd = dir.path().join("my project");
        let runtime = dir.path().join("portable runtime");
        std::fs::create_dir_all(&cwd).expect("dirs");
        std::fs::create_dir_all(&runtime).expect("dirs");
        let before = std::env::var_os("PATH");
        let argv = cmd(&["cd & echo %PATH%"]);
        let prepend = [runtime.clone()];
        let out = run_stdin(&Job {
            argv: &argv,
            cwd: &cwd,
            input: "x",
            timeout: Duration::from_secs(10),
            path_prepend: &prepend,
        })
        .expect("runs");
        let mut lines = out.lines();
        assert!(lines
            .next()
            .is_some_and(|line| line.trim().ends_with("my project")));
        let path_line = lines.next().unwrap_or_default();
        assert!(
            path_line.starts_with(runtime.to_string_lossy().as_ref()),
            "{path_line}"
        );
        // This process's own PATH is untouched.
        assert_eq!(std::env::var_os("PATH"), before);
    }
}
