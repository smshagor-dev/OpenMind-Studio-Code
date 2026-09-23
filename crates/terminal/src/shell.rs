use std::path::PathBuf;

use serde::{Deserialize, Serialize};

use crate::error::TerminalError;

/// The shells this milestone knows how to look for. Windows first
/// (`PowerShell`/`Cmd` always exist on Windows 10+); `GitBash`/`Wsl` are
/// optional and only offered when actually found on this machine — see
/// `detect_shells`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ShellKind {
    PowerShell,
    Cmd,
    GitBash,
    Wsl,
}

impl ShellKind {
    pub fn label(self) -> &'static str {
        match self {
            ShellKind::PowerShell => "PowerShell",
            ShellKind::Cmd => "Command Prompt",
            ShellKind::GitBash => "Git Bash",
            ShellKind::Wsl => "WSL",
        }
    }

    fn executable(self) -> Option<PathBuf> {
        match self {
            ShellKind::PowerShell => {
                find_on_path("pwsh.exe").or_else(|| find_on_path("powershell.exe"))
            }
            ShellKind::Cmd => system32_path("cmd.exe"),
            ShellKind::GitBash => find_git_bash(),
            ShellKind::Wsl => system32_path("wsl.exe"),
        }
    }
}

/// The default shell to use when the caller doesn't ask for a specific one:
/// PowerShell if present (the modern Windows default since Windows 10), else
/// Command Prompt, which every supported Windows version ships with.
pub fn default_shell() -> ShellKind {
    if ShellKind::PowerShell.executable().is_some() {
        ShellKind::PowerShell
    } else {
        ShellKind::Cmd
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ShellInfo {
    pub kind: ShellKind,
    pub label: String,
    /// `false` for a shell this machine doesn't actually have (e.g. no WSL
    /// distro installed, no Git for Windows) — the frontend hides or
    /// disables it rather than letting the user pick something that will
    /// fail to spawn.
    pub available: bool,
}

/// Probes for every known shell without assuming any of them (beyond
/// `Cmd`/`PowerShell`, which every supported Windows install has) exist.
/// Pure filesystem/PATH checks — no registry access, no admin rights, no
/// process spawning.
pub fn detect_shells() -> Vec<ShellInfo> {
    [
        ShellKind::PowerShell,
        ShellKind::Cmd,
        ShellKind::GitBash,
        ShellKind::Wsl,
    ]
    .into_iter()
    .map(|kind| ShellInfo {
        kind,
        label: kind.label().to_string(),
        available: kind.executable().is_some(),
    })
    .collect()
}

pub(crate) fn resolve_executable(kind: ShellKind) -> Result<PathBuf, TerminalError> {
    kind.executable().ok_or(TerminalError::ShellUnavailable)
}

fn system32_path(name: &str) -> Option<PathBuf> {
    let root = std::env::var_os("SystemRoot")?;
    let path = PathBuf::from(root).join("System32").join(name);
    path.is_file().then_some(path)
}

fn find_on_path(name: &str) -> Option<PathBuf> {
    let path_var = std::env::var_os("PATH")?;
    std::env::split_paths(&path_var).find_map(|dir| {
        let candidate = dir.join(name);
        candidate.is_file().then_some(candidate)
    })
}

/// Git for Windows' installer defaults to one of these locations depending on
/// whether it was installed for all users or just the current one; PATH is
/// checked last since a bare `bash.exe` there is sometimes WSL's legacy
/// launcher rather than Git Bash.
fn find_git_bash() -> Option<PathBuf> {
    let candidates = [
        std::env::var_os("ProgramFiles").map(PathBuf::from),
        std::env::var_os("ProgramFiles(x86)").map(PathBuf::from),
        std::env::var_os("LocalAppData").map(|p| PathBuf::from(p).join("Programs")),
    ];
    candidates
        .into_iter()
        .flatten()
        .map(|base| base.join("Git").join("bin").join("bash.exe"))
        .find(|path| path.is_file())
        .or_else(|| find_on_path("bash.exe"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn detect_shells_always_reports_all_four_kinds() {
        let shells = detect_shells();

        assert_eq!(shells.len(), 4);
        assert!(shells.iter().any(|s| s.kind == ShellKind::PowerShell));
        assert!(shells.iter().any(|s| s.kind == ShellKind::Cmd));
        assert!(shells.iter().any(|s| s.kind == ShellKind::GitBash));
        assert!(shells.iter().any(|s| s.kind == ShellKind::Wsl));
    }

    #[test]
    fn labels_are_human_readable() {
        assert_eq!(ShellKind::PowerShell.label(), "PowerShell");
        assert_eq!(ShellKind::Cmd.label(), "Command Prompt");
        assert_eq!(ShellKind::GitBash.label(), "Git Bash");
        assert_eq!(ShellKind::Wsl.label(), "WSL");
    }

    #[test]
    fn detect_shells_lists_shells_in_a_stable_order_with_windows_defaults_first() {
        let kinds: Vec<ShellKind> = detect_shells().into_iter().map(|s| s.kind).collect();

        assert_eq!(
            kinds,
            vec![
                ShellKind::PowerShell,
                ShellKind::Cmd,
                ShellKind::GitBash,
                ShellKind::Wsl
            ]
        );
    }

    #[test]
    fn default_shell_is_always_one_that_is_actually_available() {
        let default = default_shell();

        let info = detect_shells()
            .into_iter()
            .find(|shell| shell.kind == default)
            .expect("default shell is one of the known kinds");
        assert!(info.available || default == ShellKind::Cmd);
    }

    #[test]
    fn resolve_executable_fails_cleanly_for_a_kind_that_is_not_installed() {
        // GitBash/Wsl aren't guaranteed present on a CI/dev box; whichever of
        // them detect_shells() reports as unavailable must fail through the
        // typed error, not panic or silently return a bogus path.
        for shell in detect_shells() {
            if !shell.available {
                assert!(matches!(
                    resolve_executable(shell.kind),
                    Err(TerminalError::ShellUnavailable)
                ));
            }
        }
    }
}
