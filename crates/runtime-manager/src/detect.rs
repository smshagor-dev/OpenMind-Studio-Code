use std::ffi::OsString;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::mpsc;
use std::time::Duration;

use crate::manifest::VersionCommand;

const COMMAND_TIMEOUT: Duration = Duration::from_secs(10);

/// Runs `<exe> <args>` and extracts the version from its first output line
/// (dropping `prefix`). `None` if it can't run, times out, or prints nothing
/// usable. Only ever called on binaries that were checksum-verified before
/// extraction (installed runtimes) or that the user already has on PATH.
pub fn detect_version(exe: &Path, command: &VersionCommand) -> Option<String> {
    let mut process = Command::new(exe);
    process
        .args(&command.args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        // CREATE_NO_WINDOW: no console flash when probing from a GUI app.
        process.creation_flags(0x0800_0000);
    }
    if let Some(dir) = exe.parent() {
        // Tools like npm.cmd/git find their siblings via PATH, so the probe
        // gets its own folder first — without touching the real environment.
        process.env(
            "PATH",
            join_path([dir.to_path_buf()], std::env::var_os("PATH")),
        );
    }
    let mut child = process.spawn().ok()?;
    let mut stdout = child.stdout.take()?;
    let mut stderr = child.stderr.take()?;

    let (sender, receiver) = mpsc::channel();
    std::thread::spawn(move || {
        let mut text = String::new();
        let _ = stdout.read_to_string(&mut text);
        if text.trim().is_empty() {
            let _ = stderr.read_to_string(&mut text);
        }
        let _ = sender.send(text);
    });
    match receiver.recv_timeout(COMMAND_TIMEOUT) {
        Ok(text) => {
            let _ = child.wait();
            parse_version_output(&text, &command.output_prefix)
        }
        Err(_) => {
            let _ = child.kill();
            let _ = child.wait();
            None
        }
    }
}

pub(crate) fn parse_version_output(output: &str, prefix: &str) -> Option<String> {
    let line = output
        .lines()
        .map(str::trim)
        .find(|line| !line.is_empty())?;
    let version = line.strip_prefix(prefix).unwrap_or(line).trim();
    (!version.is_empty()).then(|| version.to_string())
}

/// Finds `name` on the current PATH the way a shell would (trying the usual
/// Windows executable extensions), without running anything.
pub fn find_on_path(name: &str) -> Option<PathBuf> {
    let path = std::env::var_os("PATH")?;
    let extensions: &[&str] = if cfg!(windows) {
        &["exe", "cmd", "bat", "com"]
    } else {
        &[""]
    };
    for dir in std::env::split_paths(&path) {
        for extension in extensions {
            let file = if extension.is_empty() {
                dir.join(name)
            } else {
                dir.join(format!("{name}.{extension}"))
            };
            if file.is_file() {
                return Some(file);
            }
        }
    }
    None
}

/// `dirs` first, then whatever `existing` PATH was — the whole "injection".
pub fn join_path(dirs: impl IntoIterator<Item = PathBuf>, existing: Option<OsString>) -> OsString {
    let mut all: Vec<PathBuf> = dirs.into_iter().collect();
    if let Some(existing) = existing {
        all.extend(std::env::split_paths(&existing));
    }
    std::env::join_paths(all).unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_prefixed_and_bare_version_lines() {
        assert_eq!(
            parse_version_output("v24.21.0\n", "v").as_deref(),
            Some("24.21.0")
        );
        assert_eq!(
            parse_version_output("Python 3.14.7\r\n", "Python ").as_deref(),
            Some("3.14.7")
        );
        assert_eq!(
            parse_version_output("git version 2.55.0.windows.5\n", "git version ").as_deref(),
            Some("2.55.0.windows.5")
        );
        assert_eq!(
            parse_version_output("\n\n  1.2.3  \n", "").as_deref(),
            Some("1.2.3")
        );
    }

    #[test]
    fn empty_or_prefix_only_output_is_no_version() {
        assert_eq!(parse_version_output("", "v"), None);
        assert_eq!(parse_version_output("  \n", "v"), None);
        assert_eq!(parse_version_output("v\n", "v"), None);
    }

    #[test]
    fn join_path_puts_injected_dirs_first_and_keeps_the_rest() {
        let existing =
            std::env::join_paths([PathBuf::from("/a"), PathBuf::from("/b")]).expect("join");

        let joined = join_path(
            [PathBuf::from("/rt1"), PathBuf::from("/rt2")],
            Some(existing),
        );

        let parts: Vec<PathBuf> = std::env::split_paths(&joined).collect();
        assert_eq!(
            parts,
            vec![
                PathBuf::from("/rt1"),
                PathBuf::from("/rt2"),
                PathBuf::from("/a"),
                PathBuf::from("/b")
            ]
        );
    }

    #[test]
    fn join_path_without_an_existing_path_is_just_the_injected_dirs() {
        let joined = join_path([PathBuf::from("/rt")], None);

        assert_eq!(
            std::env::split_paths(&joined).collect::<Vec<_>>(),
            vec![PathBuf::from("/rt")]
        );
    }

    #[cfg(windows)]
    #[test]
    fn detects_a_real_versioned_tool_and_finds_it_on_path() {
        // cmd.exe is on every Windows machine and prints its version banner.
        let cmd = find_on_path("cmd").expect("cmd on PATH");
        let command = VersionCommand {
            executable: "cmd.exe".into(),
            args: vec!["/c".into(), "ver".into()],
            output_prefix: String::new(),
        };

        let version = detect_version(&cmd, &command).expect("a version banner");

        assert!(version.contains("Windows"), "{version}");
    }

    #[test]
    fn a_missing_executable_detects_nothing() {
        let command = VersionCommand {
            executable: "x".into(),
            args: vec![],
            output_prefix: String::new(),
        };

        assert_eq!(
            detect_version(Path::new("Z:/no/such/tool.exe"), &command),
            None
        );
    }
}
