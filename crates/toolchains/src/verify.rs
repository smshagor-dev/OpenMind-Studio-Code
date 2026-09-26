//! Verify: does the selected program exist and, when the manifest says how, does it print its version? This runs only
//! when the user clicks Verify — listing tools never executes anything.

use std::io::Read;
use std::path::Path;
use std::process::{Command, Stdio};
use std::sync::mpsc;
use std::time::Duration;

use serde::Serialize;

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct VerifyResult {
    pub ok: bool,
    pub message: String,
    /// Whether the program was actually run (false = only checked that the file exists).
    pub executed: bool,
    /// The first line the program printed.
    pub output: Option<String>,
}

const LIMIT: Duration = Duration::from_secs(8);

pub fn verify(program: &Path, args: Option<&[String]>) -> VerifyResult {
    if !program.is_file() {
        return VerifyResult {
            ok: false,
            message: format!("{} is missing.", program.display()),
            executed: false,
            output: None,
        };
    }
    let Some(args) = args.filter(|a| !a.is_empty()) else {
        return VerifyResult {
            ok: true,
            message: "The file is present. The manifest gives no way to ask it for its version, so it was not run."
                .into(),
            executed: false,
            output: None,
        };
    };
    run(program, args)
}

fn run(program: &Path, args: &[String]) -> VerifyResult {
    let mut command = Command::new(program);
    command
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    }
    let mut child = match command.spawn() {
        Ok(child) => child,
        Err(err) => {
            return VerifyResult {
                ok: false,
                message: format!("It could not be started: {err}"),
                executed: false,
                output: None,
            }
        }
    };
    let mut stdout = child.stdout.take();
    let (tx, rx) = mpsc::channel();
    std::thread::spawn(move || {
        let mut text = String::new();
        if let Some(out) = stdout.as_mut() {
            let mut bytes = Vec::new();
            let _ = out.take(64 * 1024).read_to_end(&mut bytes);
            text = String::from_utf8_lossy(&bytes).to_string();
        }
        let _ = tx.send(text);
    });
    match rx.recv_timeout(LIMIT) {
        Ok(text) => {
            let status = child.wait();
            let first = text
                .lines()
                .find(|l| !l.trim().is_empty())
                .map(|l| l.trim().to_string());
            let ok = status.as_ref().is_ok_and(|s| s.success());
            VerifyResult {
                ok,
                message: if ok {
                    "It ran and answered.".into()
                } else {
                    format!(
                        "It ran but exited with {}.",
                        status.map_or("an error".into(), |s| s.to_string())
                    )
                },
                executed: true,
                output: first,
            }
        }
        Err(_) => {
            let _ = child.kill();
            let _ = child.wait();
            VerifyResult {
                ok: false,
                message: "It did not answer within 8 seconds and was stopped.".into(),
                executed: true,
                output: None,
            }
        }
    }
}
