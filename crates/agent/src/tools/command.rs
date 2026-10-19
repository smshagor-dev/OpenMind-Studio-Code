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
    /// Start it and return at once (a dev server, a watcher); its output is read later with `command_output`.
    pub background: bool,
}

/// A command's output as it arrives: the newest `KEEP_BYTES` and how many earlier bytes were dropped, so a later look
/// can hand over only what is new.
#[derive(Debug, Default)]
pub struct Output {
    bytes: Vec<u8>,
    dropped: usize,
}

impl Output {
    fn push(&mut self, chunk: &[u8]) {
        self.bytes.extend_from_slice(chunk);
        if self.bytes.len() > KEEP_BYTES * 2 {
            let cut = self.bytes.len() - KEEP_BYTES;
            self.bytes.drain(..cut);
            self.dropped += cut;
        }
    }

    /// Everything ever written (kept or dropped).
    pub fn total(&self) -> usize {
        self.dropped + self.bytes.len()
    }

    /// What came after the first `seen` bytes (what is still kept of it).
    pub fn since(&self, seen: usize) -> Vec<u8> {
        let start = seen.saturating_sub(self.dropped).min(self.bytes.len());
        self.bytes[start..].to_vec()
    }
}

/// Marks the line a foreground command prints last: the directory it ended in (removed from what the model reads).
const CWD_MARKER: &str = "<<OPENMIND_CWD>>";

/// Splits the working-directory line off a command's output.
pub(crate) fn split_cwd(text: &str) -> (String, Option<String>) {
    match text.rfind(CWD_MARKER) {
        Some(at) => {
            let dir = text[at + CWD_MARKER.len()..]
                .lines()
                .next()
                .unwrap_or("")
                .trim()
                .to_string();
            let before = text[..at].trim_end().to_string();
            (before, (!dir.is_empty()).then_some(dir))
        }
        None => (text.to_string(), None),
    }
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
    let background = args["run_in_background"].as_bool().unwrap_or(false);
    Prepared {
        kind: ToolKind::Command,
        title: if background {
            "Run in background"
        } else {
            "Run"
        }
        .into(),
        target: command.clone(),
        diff: None,
        op: Op::Command(Planned {
            command,
            timeout: Duration::from_secs(seconds),
            background,
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

/// The program and its arguments for `command`. With `track_cwd` the script prints the directory it ended in as its
/// last line (see `split_cwd`), keeping the command's own exit code.
pub fn shell_argv(command: &str, track_cwd: bool) -> (String, Vec<String>) {
    if cfg!(windows) {
        let tail = if track_cwd {
            format!(
                "\n$__omExit = $LASTEXITCODE\nWrite-Output (\"`n{CWD_MARKER}\" + (Get-Location).ProviderPath)\nif ($__omExit) {{ exit $__omExit }}"
            )
        } else {
            "\nif ($LASTEXITCODE) { exit $LASTEXITCODE }".to_string()
        };
        let script = format!(
            "[Console]::OutputEncoding = [System.Text.Encoding]::UTF8; $ProgressPreference = 'SilentlyContinue'\n{command}{tail}"
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
        let script = if track_cwd {
            format!(
                "{command}\n__om_exit=$?\nprintf '\\n{CWD_MARKER}%s\\n' \"$PWD\"\nexit $__om_exit"
            )
        } else {
            command.to_string()
        };
        ("sh".into(), vec!["-c".into(), script])
    }
}

/// PowerShell started with `-EncodedCommand` writes its error stream as `#< CLIXML` records when stderr is a pipe. This
/// turns them back into the lines a terminal would show (errors and warnings; progress records are dropped), without the
/// wrapper lines this module adds around the command, which PowerShell quotes in an error's position.
pub(crate) fn decode_clixml(text: &str) -> String {
    let Some(start) = text.find("#< CLIXML") else {
        return text.to_string();
    };
    let mut out = text[..start].to_string();
    let mut rest = &text[start + "#< CLIXML".len()..];
    let mut decoded = String::new();
    while let Some(at) = rest.find("<S S=\"") {
        let after = &rest[at + "<S S=\"".len()..];
        let Some(quote) = after.find("\">") else {
            break;
        };
        let stream = &after[..quote];
        let body = &after[quote + 2..];
        let Some(end) = body.find("</S>") else { break };
        if matches!(stream, "Error" | "Warning") {
            decoded.push_str(&unescape_clixml(&body[..end]));
        }
        rest = &body[end + "</S>".len()..];
    }
    if let Some(objs_end) = rest.find("</Objs>") {
        rest = &rest[objs_end + "</Objs>".len()..];
    } else {
        rest = "";
    }
    let wrapper = [
        "[Console]::OutputEncoding",
        "$__omExit",
        "Write-Output (\"`n<<OPENMIND_CWD",
        "if ($__omExit)",
        "if ($LASTEXITCODE)",
    ];
    for line in decoded.lines() {
        let trimmed = line.trim_start();
        if let Some(prefix) = wrapper.iter().find(|w| trimmed.starts_with(*w)) {
            // "if ($__omExit) { exit $__omExit } : message" keeps its message.
            if let Some((_, message)) = trimmed
                .split_once("} : ")
                .filter(|_| prefix.starts_with("if ("))
            {
                out.push_str(message);
                out.push('\n');
            }
            continue;
        }
        out.push_str(line);
        out.push('\n');
    }
    out.push_str(rest);
    out
}

fn unescape_clixml(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut rest = text;
    while let Some(at) = rest.find("_x") {
        out.push_str(&rest[..at]);
        let code = rest.get(at + 2..at + 6).filter(|hex| {
            rest.get(at + 6..at + 7) == Some("_") && hex.chars().all(|c| c.is_ascii_hexdigit())
        });
        match code
            .and_then(|hex| u32::from_str_radix(hex, 16).ok())
            .and_then(char::from_u32)
        {
            Some('\r') => rest = &rest[at + 7..],
            Some(c) => {
                out.push(c);
                rest = &rest[at + 7..];
            }
            None => {
                out.push_str("_x");
                rest = &rest[at + 2..];
            }
        }
    }
    out.push_str(rest);
    out.replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", "\"")
        .replace("&apos;", "'")
        .replace("&amp;", "&")
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

fn pump(mut source: impl Read + Send + 'static, sink: Arc<Mutex<Output>>) -> mpsc::Receiver<()> {
    let (done, finished) = mpsc::channel();
    std::thread::spawn(move || {
        let mut buffer = [0u8; 8192];
        while let Ok(n) = source.read(&mut buffer) {
            if n == 0 {
                break;
            }
            sink.lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner)
                .push(&buffer[..n]);
        }
        let _ = done.send(());
    });
    finished
}

/// A started command: the process, its process tree (Windows), its output as it arrives and the readers' end signals.
pub(crate) struct Spawned {
    pub child: std::process::Child,
    #[cfg(windows)]
    pub tree: openmind_process::ProcessTree,
    pub output: Arc<Mutex<Output>>,
    pub pumps: Vec<mpsc::Receiver<()>>,
}

/// Starts `command` in `cwd` with the app's environment: no console window, stdin closed, the whole tree contained.
pub(crate) fn spawn(
    command_text: &str,
    cwd: &std::path::Path,
    ctx: &ToolContext<'_>,
    track_cwd: bool,
) -> Result<Spawned, String> {
    let (program, args) = shell_argv(command_text, track_cwd);
    let mut command = Command::new(&program);
    command
        .args(&args)
        .current_dir(cwd)
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
    let mut child = command
        .spawn()
        .map_err(|err| format!("The command could not start: {err}"))?;
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
                return Err(format!(
                    "The command could not be contained in a process tree: {e}"
                ));
            }
        }
    };
    let output = Arc::new(Mutex::new(Output::default()));
    let mut pumps = Vec::new();
    if let Some(out) = child.stdout.take() {
        pumps.push(pump(out, Arc::clone(&output)));
    }
    if let Some(err) = child.stderr.take() {
        pumps.push(pump(err, Arc::clone(&output)));
    }
    Ok(Spawned {
        child,
        #[cfg(windows)]
        tree,
        output,
        pumps,
    })
}

#[cfg(unix)]
pub(crate) fn terminate_group(pid: u32) {
    if let Ok(pid) = i32::try_from(pid) {
        // SAFETY: the child was started as leader of its own process group. A negative pid targets only that group.
        unsafe {
            libc::kill(-pid, libc::SIGKILL);
        }
    }
}

pub fn run(planned: &Planned, ctx: &ToolContext<'_>) -> Outcome {
    if planned.background {
        return ctx.shell.start(planned, ctx);
    }
    let cwd = ctx.shell.cwd(ctx.ws);
    let Spawned {
        mut child,
        #[cfg(windows)]
        tree,
        output,
        pumps,
    } = match spawn(&planned.command, &cwd, ctx, true) {
        Ok(spawned) => spawned,
        Err(message) => return Outcome::failed(message),
    };
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
        .since(0);
    let (text, ended_in) = split_cwd(&decode_clixml(&strip_ansi(&String::from_utf8_lossy(
        &bytes,
    ))));
    let text = text.trim_end();
    // A `cd` stays in effect for the next command (never outside the project).
    let moved = ended_in.and_then(|dir| ctx.shell.set_cwd(ctx.ws, std::path::Path::new(&dir)));
    let now_in = ctx.ws.relative(&ctx.shell.cwd(ctx.ws));
    let code = status.and_then(|s| s.code());
    let seconds = started.elapsed().as_secs_f32();
    let summary = match (stopped, code) {
        (Some("Timed out"), _) => format!("Timed out after {} s", planned.timeout.as_secs()),
        (Some(reason), _) => reason.to_string(),
        (None, Some(code)) => format!("Exit code {code} · {seconds:.1} s"),
        (None, None) => "Ended".into(),
    };
    let mut body = if text.is_empty() {
        "(no output)".to_string()
    } else {
        shorten(text, MODEL_CHARS)
    };
    if let Some(note) = moved {
        body.push_str(&format!("\n{note}"));
    } else if !now_in.is_empty() && now_in != "." {
        body.push_str(&format!("\n(The next command starts in {now_in}.)"));
    }
    Outcome {
        ok: stopped.is_none() && code == Some(0),
        for_model: format!("{summary}\n{body}"),
        summary,
        ..Outcome::default()
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
