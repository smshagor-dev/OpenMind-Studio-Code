use std::ffi::OsString;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::mpsc;
use std::time::Duration;

use crate::manifest::VersionCommand;

const COMMAND_TIMEOUT: Duration = Duration::from_secs(10);

/// The version of each manifest's tool found on the system PATH, asked in parallel (each run has the same time
/// limit). A manifest with `probeSystem: false` is never run (a system Flutter may download on `--version`).
pub fn system_versions(
    manifests: &[crate::manifest::RuntimeManifest],
) -> Vec<(String, Option<String>)> {
    let handles: Vec<_> = manifests
        .iter()
        .filter(|manifest| manifest.probe_system)
        .map(|manifest| {
            let manifest = manifest.clone();
            std::thread::spawn(move || {
                let name = Path::new(&manifest.version_command.executable)
                    .file_stem()
                    .map(|stem| stem.to_string_lossy().into_owned())
                    .unwrap_or_default();
                let version = find_on_path(&name)
                    .and_then(|exe| detect_version(&exe, &manifest.version_command));
                (manifest.id, version)
            })
        })
        .collect();
    handles
        .into_iter()
        .filter_map(|handle| handle.join().ok())
        .collect()
}

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

/// The version a tool printed: the first line that starts with `prefix` (a tool may print a welcome or deprecation
/// line first — Gradle's "Welcome to Gradle", sdkmanager's warning), else the first line that starts with a digit
/// when there is no prefix, else the first non-empty line.
pub fn parse_version_output(output: &str, prefix: &str) -> Option<String> {
    let clean = strip_ansi(output);
    let lines: Vec<&str> = clean
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty())
        .collect();
    let line = if prefix.is_empty() {
        lines
            .iter()
            .find(|line| line.starts_with(|c: char| c.is_ascii_digit()))
    } else {
        lines.iter().find(|line| line.starts_with(prefix))
    }
    .or(lines.first())?;
    let rest = line.strip_prefix(prefix).unwrap_or(line).trim();
    // Only the version itself: `php --version` goes on with "(cli) (built: ...)"
    // and Composer with a build date.
    let version = rest.split_whitespace().next()?;
    Some(version.to_string())
}

/// Removes ANSI colour sequences (`ESC [ ... m`), which Composer prints even into a pipe.
fn strip_ansi(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut chars = text.chars();
    while let Some(c) = chars.next() {
        if c == '\u{1b}' {
            for next in chars.by_ref() {
                if next.is_ascii_alphabetic() {
                    break;
                }
            }
        } else {
            out.push(c);
        }
    }
    out
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
    fn php_and_composer_banners_reduce_to_just_the_version() {
        assert_eq!(
            parse_version_output(
                "PHP 8.2.12 (cli) (built: Oct 24 2023 21:15:15) (ZTS Visual C++ 2019 x64)\n",
                "PHP "
            )
            .as_deref(),
            Some("8.2.12")
        );
        assert_eq!(
            parse_version_output(
                "\u{1b}[32mComposer\u{1b}[39m version \u{1b}[33m2.10.0\u{1b}[39m 2026-05-28 11:22:08\n",
                "Composer version "
            )
            .as_deref(),
            Some("2.10.0")
        );
    }

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
    fn a_welcome_or_warning_line_before_the_version_is_skipped() {
        let gradle = "\nWelcome to Gradle 9.8.0!\n\nHere are the highlights of this release:\n\n------------\nGradle 9.8.0\n------------\n";
        assert_eq!(
            parse_version_output(gradle, "Gradle ").as_deref(),
            Some("9.8.0")
        );
        let adb = "Android Debug Bridge version 1.0.41\nVersion 37.0.1-15733141\nInstalled as C:/x/adb.exe\n";
        assert_eq!(
            parse_version_output(adb, "Version ").as_deref(),
            Some("37.0.1-15733141")
        );
        let sdkmanager = "WARNING: The SDK Manager CLI tool (sdkmanager) is deprecated.\n23.0\n";
        assert_eq!(
            parse_version_output(sdkmanager, "").as_deref(),
            Some("23.0")
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

        // Only the first word of the banner ("Microsoft Windows [Version ...]") is kept.
        assert_eq!(version, "Microsoft");
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
