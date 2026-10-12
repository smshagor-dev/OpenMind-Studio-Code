//! Installation and deployment requests run by the installers, logon scripts and administrators (never by the app's UI):
//!
//! ```text
//! OpenMindStudio.exe --integration set-layout portable|per-user|per-machine|network
//! OpenMindStudio.exe --integration layout
//! OpenMindStudio.exe --integration desktop-shortcut [--all-users]
//! OpenMindStudio.exe --integration remove-desktop-shortcut [--all-users]
//! ```
//!
//! - `set-layout` writes `install.json` next to the program (see `openmind_core::install`): the per-user setup writes
//!   `per-user`, its "Recommended for All Users" choice writes `network`. The app reads it at every start and never shows
//!   the data-scope setup for an installer-managed layout.
//! - `desktop-shortcut` creates — or repairs, when it points elsewhere — `OpenMind Studio.lnk` on this user's Desktop,
//!   or on the Public Desktop every user of the computer sees (`--all-users`, which needs administrator rights). Run from
//!   a network share, the shortcut points at the share's `\\server\share` path, never at a drive letter. Running it
//!   again changes nothing, so it can sit in a logon script.
//! - `remove-desktop-shortcut` removes that shortcut only when it points at this program.

use std::path::Path;

use openmind_core::install::{self, InstallLayout};

/// The shortcut's file name (the same name the per-user setup's own Desktop shortcut uses).
pub const SHORTCUT_NAME: &str = "OpenMind Studio.lnk";
const DESCRIPTION: &str = "OpenMind Studio";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DeployAction {
    SetLayout(InstallLayout),
    Layout,
    DesktopShortcut { all_users: bool },
    RemoveDesktopShortcut { all_users: bool },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ShortcutOutcome {
    Created,
    Repaired,
    AlreadyCorrect,
}

pub const USAGE: &str = "usage: OpenMindStudio.exe --integration set-layout portable|per-user|per-machine|network | layout | desktop-shortcut [--all-users] | remove-desktop-shortcut [--all-users]";

/// One of the actions above, from the words after `--integration`; `None` when the first word is not one of them.
pub fn parse(words: &[String]) -> Option<Result<DeployAction, String>> {
    let (first, rest) = words.split_first()?;
    let all_users = || match rest {
        [] => Ok(false),
        [flag] if flag == "--all-users" => Ok(true),
        _ => Err(USAGE.to_string()),
    };
    Some(match first.as_str() {
        "set-layout" => match rest {
            [layout] => InstallLayout::parse(layout)
                .map(DeployAction::SetLayout)
                .ok_or_else(|| format!("unknown layout \"{layout}\". {USAGE}")),
            _ => Err(USAGE.to_string()),
        },
        "layout" if rest.is_empty() => Ok(DeployAction::Layout),
        "desktop-shortcut" => {
            all_users().map(|all_users| DeployAction::DesktopShortcut { all_users })
        }
        "remove-desktop-shortcut" => {
            all_users().map(|all_users| DeployAction::RemoveDesktopShortcut { all_users })
        }
        _ => return None,
    })
}

/// Two shortcut targets name the same program (any spelling, case, `\\?\` prefix).
pub fn same_target(a: &Path, b: &Path) -> bool {
    install::normalized_key_path(a) == install::normalized_key_path(b)
}

/// The layout as written, or what the app would infer (for `layout`).
fn describe_layout(dir: &Path) -> String {
    match install::read(dir) {
        install::InstallRecord::Found(meta) => format!(
            "{} (install.json, written by {} on {})",
            meta.layout.label(),
            meta.app_version,
            meta.installed_at
        ),
        install::InstallRecord::Missing => {
            "not recorded (no install.json): the app infers it at start".into()
        }
        install::InstallRecord::Unreadable(reason) => {
            format!("install.json can't be used: {reason}")
        }
    }
}

/// Runs `action` for the program at `exe`.
pub fn run(action: DeployAction, exe: &Path) -> Result<String, String> {
    let dir = exe.parent().ok_or("the program's folder is unknown")?;
    match action {
        DeployAction::SetLayout(layout) => {
            install::write(dir, layout, env!("CARGO_PKG_VERSION")).map_err(|err| {
                format!(
                    "couldn't write {}: {err}",
                    install::install_file(dir).display()
                )
            })?;
            Ok(format!("Installation layout: {}", layout.label()))
        }
        DeployAction::Layout => Ok(describe_layout(dir)),
        DeployAction::DesktopShortcut { all_users } => desktop_shortcut(exe, all_users),
        DeployAction::RemoveDesktopShortcut { all_users } => {
            remove_desktop_shortcut(exe, all_users)
        }
    }
}

#[cfg(windows)]
fn desktop_shortcut(exe: &Path, all_users: bool) -> Result<String, String> {
    let target = super::shortcut::universal_path(exe);
    let lnk = super::shortcut::desktop_dir(all_users)?.join(SHORTCUT_NAME);
    let outcome = super::shortcut::write(&lnk, &target, DESCRIPTION).map_err(|err| {
        if all_users {
            format!("{err}. Writing to the Public Desktop needs administrator rights.")
        } else {
            err
        }
    })?;
    Ok(format!(
        "{} {} -> {}",
        match outcome {
            ShortcutOutcome::Created => "Created",
            ShortcutOutcome::Repaired => "Repaired",
            ShortcutOutcome::AlreadyCorrect => "Already correct:",
        },
        lnk.display(),
        target.display()
    ))
}

#[cfg(windows)]
fn remove_desktop_shortcut(exe: &Path, all_users: bool) -> Result<String, String> {
    let target = super::shortcut::universal_path(exe);
    let lnk = super::shortcut::desktop_dir(all_users)?.join(SHORTCUT_NAME);
    if !lnk.is_file() {
        return Ok(format!("No shortcut at {}", lnk.display()));
    }
    match super::shortcut::read_target(&lnk) {
        Some(current) if same_target(&current, &target) || same_target(&current, exe) => {
            std::fs::remove_file(&lnk).map_err(|err| format!("{}: {err}", lnk.display()))?;
            Ok(format!("Removed {}", lnk.display()))
        }
        Some(current) => Ok(format!(
            "Left {} alone: it starts {}, not this copy",
            lnk.display(),
            current.display()
        )),
        None => Ok(format!("Left {} alone: it couldn't be read", lnk.display())),
    }
}

#[cfg(not(windows))]
fn desktop_shortcut(_exe: &Path, _all_users: bool) -> Result<String, String> {
    Err("Desktop shortcuts are created by this command on Windows only.".into())
}

#[cfg(not(windows))]
fn remove_desktop_shortcut(_exe: &Path, _all_users: bool) -> Result<String, String> {
    Err("Desktop shortcuts are removed by this command on Windows only.".into())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn words(text: &str) -> Vec<String> {
        text.split_whitespace().map(String::from).collect()
    }

    #[test]
    fn the_installer_words_parse_and_anything_else_is_refused_or_left_to_the_shell_actions() {
        assert_eq!(
            parse(&words("set-layout network")),
            Some(Ok(DeployAction::SetLayout(InstallLayout::Network)))
        );
        assert_eq!(
            parse(&words("set-layout per-user")),
            Some(Ok(DeployAction::SetLayout(InstallLayout::PerUser)))
        );
        assert_eq!(parse(&words("layout")), Some(Ok(DeployAction::Layout)));
        assert_eq!(
            parse(&words("desktop-shortcut")),
            Some(Ok(DeployAction::DesktopShortcut { all_users: false }))
        );
        assert_eq!(
            parse(&words("desktop-shortcut --all-users")),
            Some(Ok(DeployAction::DesktopShortcut { all_users: true }))
        );
        assert_eq!(
            parse(&words("remove-desktop-shortcut --all-users")),
            Some(Ok(DeployAction::RemoveDesktopShortcut { all_users: true }))
        );
        assert!(matches!(parse(&words("set-layout cloud")), Some(Err(_))));
        assert!(matches!(parse(&words("set-layout")), Some(Err(_))));
        assert!(matches!(
            parse(&words("desktop-shortcut --everyone")),
            Some(Err(_))
        ));
        // The shell-integration actions are not this module's.
        assert_eq!(parse(&words("add-path")), None);
        assert_eq!(parse(&[]), None);
    }

    #[test]
    fn set_layout_writes_install_json_next_to_the_program() {
        let dir = tempfile::tempdir().expect("dir");
        let exe = dir.path().join("OpenMindStudio.exe");
        let said = run(DeployAction::SetLayout(InstallLayout::Network), &exe).expect("write");
        assert!(said.contains("network"), "{said}");
        assert!(matches!(
            install::read(dir.path()),
            install::InstallRecord::Found(meta) if meta.layout == InstallLayout::Network
        ));
        assert!(run(DeployAction::Layout, &exe)
            .expect("read")
            .starts_with("network"));
    }

    #[test]
    fn targets_compare_in_any_spelling() {
        assert!(same_target(
            Path::new(r"\\lab\apps\OpenMind Studio\OpenMindStudio.exe"),
            Path::new(r"\\?\UNC\lab\apps\OpenMind Studio\OpenMindStudio.exe")
        ));
        assert!(!same_target(
            Path::new(r"C:\a\OpenMindStudio.exe"),
            Path::new(r"C:\b\OpenMindStudio.exe")
        ));
    }

    #[cfg(windows)]
    #[test]
    fn a_shortcut_is_written_once_kept_when_right_and_repaired_when_it_points_elsewhere() {
        let dir = tempfile::tempdir().expect("dir");
        let lnk = dir.path().join(SHORTCUT_NAME);
        let program = std::env::current_exe().expect("exe");
        assert_eq!(
            super::super::shortcut::write(&lnk, &program, DESCRIPTION),
            Ok(ShortcutOutcome::Created)
        );
        let target = super::super::shortcut::read_target(&lnk).expect("target");
        assert!(same_target(&target, &program), "{}", target.display());
        assert_eq!(
            super::super::shortcut::write(&lnk, &program, DESCRIPTION),
            Ok(ShortcutOutcome::AlreadyCorrect)
        );
        // An outdated shortcut (an older install folder) is repaired, not duplicated.
        let elsewhere = dir.path().join("old").join("OpenMindStudio.exe");
        std::fs::create_dir_all(elsewhere.parent().expect("parent")).expect("dir");
        std::fs::write(&elsewhere, b"MZ").expect("exe");
        super::super::shortcut::write(&lnk, &elsewhere, DESCRIPTION).expect("point elsewhere");
        assert_eq!(
            super::super::shortcut::write(&lnk, &program, DESCRIPTION),
            Ok(ShortcutOutcome::Repaired)
        );
        assert_eq!(
            std::fs::read_dir(dir.path()).expect("dir").count(),
            2,
            "one shortcut, one folder"
        );
    }
}
