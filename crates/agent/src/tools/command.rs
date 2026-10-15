//! `run_command`: one command in the open folder, after the user allowed it. On Windows it runs in PowerShell, handed
//! over as `-EncodedCommand` (UTF-16LE base64), so no quoting of the command can break out; with no console window,
//! stdin closed, inside a Job Object (stopping kills the whole tree), with a time limit and capped output.

use std::io::Read;
use std::process::{Command, Stdio};
use std::sync::atomic::Ordering;
use std::sync::mpsc;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use serde_json::Value;

use super::{arg_str, Op, Outcome, Prepared, ToolContext, ToolKind};

const DEFAULT_TIMEOUT: u64 = 120;
const MAX_TIMEOUT: u64 = 600;
/// What is kept of the output while it runs (the end matters most: errors and summaries come last).
const KEEP_BYTES: usize = 256 * 1024;
/// What the model gets to read.
const MODEL_CHARS: usize = 16_000;

/// Environment for commands: the app's runtimes on PATH, its proxy settings and so on (same as its terminals).
#[derive(Debug, Clone, Default)]
pub struct CommandEnv {
    pub vars: Vec<(String, String)>,
}

#[derive(Debug, Clone)]
pub struct Planned {
    pub command: String,
    pub timeout: Duration,
}

pub fn prepare(args: &Value, _ctx: &ToolContext<'_>) -> Prepared {
    let command = match arg_str(args, "command") {
        Ok(c) => c.trim().to_string(),
        Err(e) => {
            return Prepared::finished(ToolKind::Command, "Run", String::new(), Outcome::failed(e))
        }
    };
    if command.is_empty() || command.contains('\0') || command.len() > 8_000 {
        return Prepared::finished(
            ToolKind::Command,
            "Run",
            String::new(),
            Outcome::failed("The command is empty or too long."),
        );
    }
    let seconds = args["timeout_seconds"]
        .as_u64()
        .unwrap_or(DEFAULT_TIMEOUT)
        .clamp(1, MAX_TIMEOUT);
    Prepared {
        kind: ToolKind::Command,
        title: "Run".into(),
        target: command.clone(),
        diff: None,
        op: Op::Command(Planned {
            command,
            timeout: Duration::from_secs(seconds),
        }),
    }
}

const BASE64: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

pub fn base64(bytes: &[u8]) -> String {
    let mut out = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for chunk in bytes.chunks(3) {
        let b = [
            chunk[0],
            *chunk.get(1).unwrap_or(&0),
            *chunk.get(2).unwrap_or(&0),
        ];
        let n = (u32::from(b[0]) << 16) | (u32::from(b[1]) << 8) | u32::from(b[2]);
        for i in 0..4 {
            if i <= chunk.len() {
                out.push(BASE64[((n >> (18 - 6 * i)) & 63) as usize] as char);
            } else {
                out.push('=');
            }
        }
    }
    out
}

/// The program and its arguments for `command`.
pub fn shell_argv(command: &str) -> (String, Vec<String>) {
    if cfg!(windows) {
        let script = format!(
            "[Console]::OutputEncoding = [System.Text.Encoding]::UTF8; $ProgressPreference = 'SilentlyContinue'\n{command}\nif ($LASTEXITCODE) {{ exit $LASTEXITCODE }}"
        );
        let utf16: Vec<u8> = script.encode_utf16().flat_map(u16::to_le_bytes).collect();
        (
            "powershell.exe".into(),
            vec![
                "-NoLogo".into(),
                "-NoProfile".into(),
                "-NonInteractive".into(),
                "-EncodedCommand".into(),
                base64(&utf16),
            ],
        )
    } else {
        ("sh".into(), vec!["-c".into(), command.into()])
    }
}

/// Removes terminal colour codes and other escape sequences.
pub fn strip_ansi(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut chars = text.chars().peekable();
    while let Some(c) = chars.next() {
        if c == '\u{1b}' {
            if chars.peek() == Some(&'[') {
                chars.next();
                for d in chars.by_ref() {
                    if ('@'..='~').contains(&d) {
                        break;
                    }
                }
            }
            continue;
        }
        if c != '\r' {
            out.push(c);
        }
    }
    out
}

/// Keeps the start and the end of a long output.
pub fn shorten(text: &str, max: usize) -> String {
    let count = text.chars().count();
    if count <= max {
        return text.to_string();
    }
    let head: String = text.chars().take(max / 4).collect();
    let tail: String = text.chars().skip(count - max * 3 / 4).collect();
    format!("{head}\n… [{} characters left out] …\n{tail}", count - max)
}

fn pump(mut source: impl Read + Send + 'static, sink: Arc<Mutex<Vec<u8>>>) -> mpsc::Receiver<()> {
    let (done, finished) = mpsc::channel();
    std::thread::spawn(move || {
        let mut buffer = [0u8; 8192];
        while let Ok(n) = source.read(&mut buffer) {
            if n == 0 {
                break;
            }
            let mut out = sink
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            out.extend_from_slice(&buffer[..n]);
            if out.len() > KEEP_BYTES * 2 {
                let cut = out.len() - KEEP_BYTES;
                out.drain(..cut);
            }
        }
        let _ = done.send(());
    });
    finished
}

#[cfg(unix)]
fn terminate_group(pid: u32) {
    if let Ok(pid) = i32::try_from(pid) {
        // SAFETY: the child was started as leader of its own process group. A negative pid targets only that group.
        unsafe {
            libc::kill(-pid, libc::SIGKILL);
        }
    }
}

pub fn run(planned: &Planned, ctx: &ToolContext<'_>) -> Outcome {
    let (program, args) = shell_argv(&planned.command);
    let mut command = Command::new(&program);
    command
        .args(&args)
        .current_dir(ctx.ws.root())
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    for (name, value) in &ctx.env.vars {
        command.env(name, value);
    }
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        command.process_group(0);
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x0800_0000);
    }
    let mut child = match command.spawn() {
        Ok(child) => child,
        Err(err) => return Outcome::failed(format!("The command could not start: {err}")),
    };
    #[cfg(windows)]
    let tree = {
        use std::os::windows::io::AsRawHandle;
        match openmind_process::ProcessTree::new().and_then(|tree| {
            tree.assign(child.as_raw_handle())?;
            Ok(tree)
        }) {
            Ok(tree) => tree,
            Err(e) => {
                let _ = child.kill();
                let _ = child.wait();
                return Outcome::failed(format!(
                    "The command could not be contained in a process tree: {e}"
                ));
            }
        }
    };
    let output = Arc::new(Mutex::new(Vec::new()));
    let mut pumps = Vec::new();
    if let Some(out) = child.stdout.take() {
        pumps.push(pump(out, Arc::clone(&output)));
    }
    if let Some(err) = child.stderr.take() {
        pumps.push(pump(err, Arc::clone(&output)));
    }
    let started = Instant::now();
    let mut stopped: Option<&str> = None;
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break Some(status),
            Ok(None) => {}
            Err(_) => break None,
        }
        if ctx.cancel.load(Ordering::Relaxed) {
            stopped = Some("Stopped");
        } else if started.elapsed() > planned.timeout {
            stopped = Some("Timed out");
        }
        if stopped.is_some() {
            #[cfg(windows)]
            tree.terminate();
            #[cfg(unix)]
            terminate_group(child.id());
            let _ = child.kill();
            break child.wait().ok();
        }
        std::thread::sleep(Duration::from_millis(40));
    };
    #[cfg(windows)]
    tree.terminate();
    #[cfg(unix)]
    terminate_group(child.id());
    for finished in pumps {
        // An escaped descendant must not keep Stop or timeout blocked on an inherited pipe.
        let _ = finished.recv_timeout(Duration::from_secs(2));
    }
    let bytes = output
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
        .clone();
    let text = strip_ansi(&String::from_utf8_lossy(&bytes));
    let text = text.trim_end();
    let code = status.and_then(|s| s.code());
    let seconds = started.elapsed().as_secs_f32();
    let summary = match (stopped, code) {
        (Some("Timed out"), _) => format!("Timed out after {} s", planned.timeout.as_secs()),
        (Some(reason), _) => reason.to_string(),
        (None, Some(code)) => format!("Exit code {code} · {seconds:.1} s"),
        (None, None) => "Ended".into(),
    };
    let body = if text.is_empty() {
        "(no output)".to_string()
    } else {
        shorten(text, MODEL_CHARS)
    };
    Outcome {
        ok: stopped.is_none() && code == Some(0),
        for_model: format!("{summary}\n{body}"),
        summary,
        diff: None,
        change: None,
        todos: None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn base64_matches_the_standard_alphabet() {
        assert_eq!(base64(b""), "");
        assert_eq!(base64(b"f"), "Zg==");
        assert_eq!(base64(b"fo"), "Zm8=");
        assert_eq!(base64(b"foo"), "Zm9v");
        assert_eq!(base64(b"foobar"), "Zm9vYmFy");
    }

    #[test]
    fn colour_codes_and_carriage_returns_are_removed() {
        assert_eq!(strip_ansi("\u{1b}[31merror\u{1b}[0m: x\r\n"), "error: x\n");
    }

    #[test]
    fn long_output_keeps_its_end() {
        let text: String = (0..10_000).map(|i| format!("{i}\n")).collect();
        let short = shorten(&text, 1_000);
        assert!(short.contains("characters left out"));
        assert!(short.trim_end().ends_with("9999"));
        assert!(short.starts_with("0\n"));
    }
}
