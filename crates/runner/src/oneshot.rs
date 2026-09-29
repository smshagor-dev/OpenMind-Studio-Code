//! Runs a planned command to completion with a time limit and returns what it
//! printed. For short helper commands (MariaDB's initializer, `ping` and
//! `shutdown`); long-running processes go through [`crate::RunRegistry`].

use std::io::Read;
use std::process::{Command, Stdio};
use std::sync::mpsc;
use std::time::Duration;

use crate::error::RunError;
use crate::plan::RunPlan;

/// How a one-shot command ended.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Completed {
    /// The exit code, `None` when it had to be killed for taking too long.
    pub code: Option<i32>,
    pub timed_out: bool,
    /// stdout then stderr, lossily decoded.
    pub output: String,
}

impl Completed {
    pub fn success(&self) -> bool {
        self.code == Some(0) && !self.timed_out
    }
}

/// Spawns the plan (argument list, no shell), waits up to `timeout` and kills
/// it if it hasn't finished.
pub fn run_to_completion(plan: &RunPlan, timeout: Duration) -> Result<Completed, RunError> {
    let mut command = Command::new(&plan.argv[0]);
    command
        .args(&plan.argv[1..])
        .current_dir(&plan.cwd)
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
    let mut child = command.spawn().map_err(|err| RunError::StartFailed {
        command: plan.display.clone(),
        reason: err.to_string(),
    })?;
    let mut out = child.stdout.take();
    let mut err = child.stderr.take();
    let (sender, receiver) = mpsc::channel();
    let readers = [
        std::thread::spawn({
            let sender = sender.clone();
            move || {
                let mut text = String::new();
                if let Some(pipe) = out.as_mut() {
                    let mut bytes = Vec::new();
                    let _ = pipe.read_to_end(&mut bytes);
                    text = String::from_utf8_lossy(&bytes).into_owned();
                }
                let _ = sender.send((0, text));
            }
        }),
        std::thread::spawn(move || {
            let mut text = String::new();
            if let Some(pipe) = err.as_mut() {
                let mut bytes = Vec::new();
                let _ = pipe.read_to_end(&mut bytes);
                text = String::from_utf8_lossy(&bytes).into_owned();
            }
            let _ = sender.send((1, text));
        }),
    ];

    let deadline = std::time::Instant::now() + timeout;
    let (code, timed_out) = loop {
        match child.try_wait() {
            Ok(Some(status)) => break (status.code(), false),
            Ok(None) if std::time::Instant::now() >= deadline => {
                let _ = child.kill();
                let _ = child.wait();
                break (None, true);
            }
            Ok(None) => std::thread::sleep(Duration::from_millis(25)),
            Err(_) => break (None, false),
        }
    };
    let mut parts = [String::new(), String::new()];
    for _ in 0..2 {
        if let Ok((index, text)) = receiver.recv_timeout(Duration::from_secs(3)) {
            parts[index] = text;
        }
    }
    for reader in readers {
        let _ = reader.join();
    }
    let [stdout, stderr] = parts;
    Ok(Completed {
        code,
        timed_out,
        output: format!("{stdout}{stderr}"),
    })
}

#[cfg(all(test, windows))]
mod tests {
    use super::*;
    use crate::kind::RunnableKind;
    use crate::runtime::RuntimeSource;
    use std::ffi::OsString;

    fn plan(args: &[&str]) -> RunPlan {
        let argv: Vec<String> = ["C:\\Windows\\System32\\cmd.exe"]
            .iter()
            .chain(args.iter())
            .map(ToString::to_string)
            .collect();
        RunPlan {
            kind: RunnableKind::MariaDb,
            file: std::env::temp_dir(),
            display: argv.join(" "),
            resolved: argv[0].clone().into(),
            argv,
            cwd: std::env::temp_dir(),
            env: vec![("OM_ONESHOT".into(), "yes".into())],
            path_var: std::env::var_os("PATH").unwrap_or_else(|| OsString::from("")),
            build: None,
            runtime_label: "test".into(),
            source: RuntimeSource::Portable,
        }
    }

    #[test]
    fn captures_output_and_the_exit_code_and_passes_the_environment() {
        let done = run_to_completion(
            &plan(&["/C", "echo %OM_ONESHOT% & exit 3"]),
            Duration::from_secs(10),
        )
        .expect("run");

        assert_eq!(done.code, Some(3));
        assert!(!done.success());
        assert!(done.output.contains("yes"), "{}", done.output);
    }

    #[test]
    fn a_command_that_takes_too_long_is_killed_and_reported() {
        let done = run_to_completion(
            &plan(&["/C", "ping -n 30 127.0.0.1 >nul"]),
            Duration::from_millis(400),
        )
        .expect("run");

        assert!(done.timed_out);
        assert_eq!(done.code, None);
    }

    #[test]
    fn a_missing_program_is_a_structured_error() {
        let mut broken = plan(&[]);
        broken.argv[0] = "C:\\definitely\\missing.exe".into();

        let error = run_to_completion(&broken, Duration::from_secs(1)).expect_err("fails");

        assert!(matches!(error, RunError::StartFailed { .. }));
    }
}
