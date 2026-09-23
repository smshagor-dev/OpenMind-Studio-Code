use std::collections::BTreeMap;
use std::io::Read;
use std::path::Path;
use std::process::{Command, Stdio};
use std::thread;
use std::time::{Duration, Instant};

use crate::detect::join_path;
use crate::error::RuntimeError;
use crate::manifest::PostInstallStep;

const STEP_TIMEOUT: Duration = Duration::from_secs(300);
/// Interpreter-selecting variables that would point a step at some other install.
const SCRUBBED_ENV: [&str; 3] = ["PYTHONHOME", "PYTHONPATH", "PYTHONSTARTUP"];

/// Runs each step with the runtime's own executable, inside `dir`, in order.
/// Only called after the archive's checksum was verified, on the files that
/// archive produced — never on anything unverified. The step's PATH starts
/// with `dir` (the process's own environment; the system PATH isn't touched).
pub fn run_steps(
    steps: &[PostInstallStep],
    dir: &Path,
    env: &BTreeMap<String, String>,
) -> Result<(), RuntimeError> {
    for step in steps {
        run_step(step, dir, env)?;
    }
    Ok(())
}

fn run_step(
    step: &PostInstallStep,
    dir: &Path,
    env: &BTreeMap<String, String>,
) -> Result<(), RuntimeError> {
    let failed = |detail: String| RuntimeError::PostInstall {
        description: step.description.clone(),
        detail,
    };
    let mut command = Command::new(dir.join(&step.executable));
    command
        .args(&step.args)
        .current_dir(dir)
        .env(
            "PATH",
            join_path([dir.to_path_buf()], std::env::var_os("PATH")),
        )
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    for name in SCRUBBED_ENV {
        command.env_remove(name);
    }
    // The runtime's own variables (e.g. PYTHONNOUSERSITE), as a terminal would get them.
    for (key, value) in env {
        command.env(key, value.replace("{dir}", &dir.to_string_lossy()));
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    }
    let mut child = command
        .spawn()
        .map_err(|err| failed(format!("couldn't start {}: {err}", step.executable)))?;
    let readers: Vec<_> = [
        child
            .stdout
            .take()
            .map(|s| Box::new(s) as Box<dyn Read + Send>),
        child
            .stderr
            .take()
            .map(|s| Box::new(s) as Box<dyn Read + Send>),
    ]
    .into_iter()
    .flatten()
    .map(|mut stream| {
        thread::spawn(move || {
            let mut text = String::new();
            let _ = stream.read_to_string(&mut text);
            text
        })
    })
    .collect();

    let deadline = Instant::now() + STEP_TIMEOUT;
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status,
            Ok(None) if Instant::now() < deadline => thread::sleep(Duration::from_millis(50)),
            Ok(None) => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(failed("it took too long and was stopped".into()));
            }
            Err(err) => return Err(failed(err.to_string())),
        }
    };
    let output: String = readers
        .into_iter()
        .filter_map(|reader| reader.join().ok())
        .collect::<Vec<_>>()
        .join("\n");
    if status.success() {
        Ok(())
    } else {
        Err(failed(format!(
            "exited with {status}: {}",
            tail(output.trim(), 400)
        )))
    }
}

/// The last `max` characters, so a long traceback keeps its useful end.
fn tail(text: &str, max: usize) -> String {
    let count = text.chars().count();
    if count <= max {
        return text.to_string();
    }
    let kept: String = text.chars().skip(count - max).collect();
    format!("…{kept}")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tail_keeps_the_end_of_long_output() {
        assert_eq!(tail("short", 10), "short");
        assert_eq!(tail("abcdefghij", 3), "…hij");
    }

    #[cfg(windows)]
    fn cmd_step(script: &str) -> PostInstallStep {
        PostInstallStep {
            description: "test step".into(),
            executable: "step.cmd".into(),
            args: vec![script.into()],
        }
    }

    #[cfg(windows)]
    #[test]
    fn a_successful_step_runs_inside_the_install_dir() {
        let dir = tempfile::tempdir().expect("tempdir");
        std::fs::write(
            dir.path().join("step.cmd"),
            "@echo off\r\necho hi> marker.txt\r\n",
        )
        .expect("script");

        run_steps(&[cmd_step("x")], dir.path(), &BTreeMap::new()).expect("step");

        assert!(dir.path().join("marker.txt").is_file());
    }

    #[cfg(windows)]
    #[test]
    fn a_failing_step_reports_its_description_and_output() {
        let dir = tempfile::tempdir().expect("tempdir");
        std::fs::write(
            dir.path().join("step.cmd"),
            "@echo off\r\necho bootstrap exploded 1>&2\r\nexit /b 3\r\n",
        )
        .expect("script");

        let error =
            run_steps(&[cmd_step("x")], dir.path(), &BTreeMap::new()).expect_err("must fail");

        let message = error.to_string();
        assert!(message.contains("test step"), "{message}");
        assert!(message.contains("bootstrap exploded"), "{message}");
    }

    #[cfg(windows)]
    #[test]
    fn a_step_sees_the_runtime_variables_with_the_install_dir_substituted() {
        let dir = tempfile::tempdir().expect("tempdir");
        std::fs::write(
            dir.path().join("step.cmd"),
            "@echo off
echo %OM_FLAG%^|%OM_HOME%> seen.txt
",
        )
        .expect("script");
        let env = BTreeMap::from([
            ("OM_FLAG".to_string(), "1".to_string()),
            ("OM_HOME".to_string(), "{dir}".to_string()),
        ]);

        run_steps(&[cmd_step("x")], dir.path(), &env).expect("step");

        let seen = std::fs::read_to_string(dir.path().join("seen.txt")).expect("seen");
        assert_eq!(seen.trim(), format!("1|{}", dir.path().to_string_lossy()));
    }

    #[test]
    fn a_missing_executable_is_a_step_failure_not_a_panic() {
        let dir = tempfile::tempdir().expect("tempdir");
        let step = PostInstallStep {
            description: "gone".into(),
            executable: "nope.exe".into(),
            args: vec![],
        };

        assert!(matches!(
            run_steps(&[step], dir.path(), &BTreeMap::new()),
            Err(RuntimeError::PostInstall { .. })
        ));
    }
}
