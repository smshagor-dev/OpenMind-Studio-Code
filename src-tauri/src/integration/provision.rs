//! A Desktop shortcut for each Windows user of a **shared network installation**, without anyone having to set it up.
//!
//! The first time a Windows user starts a network installation on a computer, OpenMind Studio puts `OpenMind
//! Studio.lnk` on that user's own Desktop (pointing at the program's `\\server\share` path, so it works whatever drive
//! letter the computer maps), unless a shortcut to this program is already there — on the user's Desktop or on the
//! Public Desktop an administrator filled (Group Policy, the push script). It happens **once**: the offer is recorded in
//! the user's local folder for this installation ([`RECORD_FILE`]), so a shortcut the user deleted stays deleted; only an
//! explicit Create/Repair brings it back. Later starts only correct this program's own shortcut when it names a drive
//! letter instead of the network path (the setup's finish page makes one like that), never anything else.
//!
//! Nothing here needs administrator rights, writes outside the user's own Desktop and local folder, or retries what
//! Windows refused: a refusal (a locked-down Desktop) is logged once and the user can use Create Desktop Shortcut,
//! which explains the manual way. Administrators turn the whole thing off with
//! `--integration user-desktop-shortcuts off` (or the setup's `/NOUSERSHORTCUTS`).

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use super::deploy::{same_target, SHORTCUT_NAME};

/// The record of the first-start offer, in the user's local folder of the installation.
pub const RECORD_FILE: &str = "desktop-shortcut.json";
const RECORD_FORMAT: &str = "openmind-desktop-shortcut";
/// Desktop shortcuts read when looking for one to this program (a Desktop with more is left as it is).
pub const SCAN_LIMIT: usize = 400;

/// What to do at a start.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Plan {
    /// Nothing; the reason is logged.
    Nothing(&'static str),
    /// Create this user's shortcut at this path.
    Create(PathBuf),
    /// This shortcut starts this program through a drive letter: point it at the network path.
    Normalize(PathBuf),
}

/// Where the program is and what the Desktops hold.
pub struct Facts<'a> {
    /// The program as it was started (`Z:\OpenMind Studio\OpenMindStudio.exe` or the UNC path).
    pub exe: &'a Path,
    /// Its universal (`\\server\share`) path.
    pub universal: &'a Path,
    /// This user's Desktop folder.
    pub desktop: &'a Path,
    /// `(shortcut, target)` on this user's Desktop.
    pub user: &'a [(PathBuf, PathBuf)],
    /// `(shortcut, target)` on the Public Desktop.
    pub public: &'a [(PathBuf, PathBuf)],
}

fn starts_this_program(target: &Path, facts: &Facts) -> bool {
    same_target(target, facts.universal) || same_target(target, facts.exe)
}

/// The decision. `first_start` = this user has never been offered a shortcut for this installation on this computer.
pub fn plan(first_start: bool, facts: &Facts) -> Plan {
    let spelled_differently = !same_target(facts.exe, facts.universal);
    if let Some((lnk, _)) = facts.user.iter().find(|(_, target)| {
        spelled_differently
            && same_target(target, facts.exe)
            && !same_target(target, facts.universal)
    }) {
        return Plan::Normalize(lnk.clone());
    }
    if facts
        .user
        .iter()
        .chain(facts.public)
        .any(|(_, target)| starts_this_program(target, facts))
    {
        return Plan::Nothing("a Desktop shortcut to this program is already there");
    }
    if !first_start {
        return Plan::Nothing("the shortcut was offered before (a deleted shortcut stays deleted)");
    }
    let lnk = facts.desktop.join(SHORTCUT_NAME);
    if facts.user.iter().any(|(path, _)| same_target(path, &lnk)) || lnk.exists() {
        return Plan::Nothing("an OpenMind Studio shortcut for another copy is on the Desktop");
    }
    Plan::Create(lnk)
}

/// The record of the offer.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OfferRecord {
    pub format: String,
    pub offered_at: String,
    /// What happened (`created`, `normalized`, `nothing: <reason>`, `failed: <reason>`).
    pub outcome: String,
}

pub fn offered(local_dir: &Path) -> bool {
    std::fs::read_to_string(local_dir.join(RECORD_FILE))
        .ok()
        .and_then(|text| serde_json::from_str::<OfferRecord>(&text).ok())
        .is_some_and(|record| record.format == RECORD_FORMAT)
}

pub fn record_offer(local_dir: &Path, outcome: &str) -> std::io::Result<()> {
    let record = OfferRecord {
        format: RECORD_FORMAT.into(),
        offered_at: openmind_core::data_scope::rfc3339_now(),
        outcome: outcome.into(),
    };
    let text = serde_json::to_string_pretty(&record).map_err(std::io::Error::other)?;
    std::fs::create_dir_all(local_dir)?;
    openmind_core::data_scope::write_atomic(&local_dir.join(RECORD_FILE), text.as_bytes())
}

/// Runs the start-up step for a network installation (see the module text); returns what happened, for the log.
#[cfg(windows)]
pub fn at_start(exe: &Path, local_dir: &Path) -> String {
    use super::shortcut;
    let install_dir = exe.parent().unwrap_or(exe);
    match openmind_core::install::read(install_dir) {
        openmind_core::install::InstallRecord::Found(meta)
            if meta.gives_user_desktop_shortcuts() => {}
        openmind_core::install::InstallRecord::Found(_) => {
            return "per-user Desktop shortcuts are turned off for this installation".into()
        }
        _ => {
            return "no install.json: per-user Desktop shortcuts are only for network installations"
                .into()
        }
    }
    let first_start = !offered(local_dir);
    let universal = shortcut::universal_path(exe);
    let desktop = match shortcut::desktop_dir(false) {
        Ok(dir) => dir,
        Err(err) => return format!("the Desktop folder is unknown: {err}"),
    };
    let user = shortcut::shortcuts_in(&desktop, SCAN_LIMIT);
    let public = shortcut::desktop_dir(true)
        .map(|dir| shortcut::shortcuts_in(&dir, SCAN_LIMIT))
        .unwrap_or_default();
    let facts = Facts {
        exe,
        universal: &universal,
        desktop: &desktop,
        user: &user,
        public: &public,
    };
    let outcome = match plan(first_start, &facts) {
        Plan::Nothing(reason) => format!("nothing: {reason}"),
        Plan::Create(lnk) => match shortcut::write(&lnk, &universal, super::deploy::DESCRIPTION) {
            Ok(_) => format!("created {} -> {}", lnk.display(), universal.display()),
            Err(err) => format!("failed: {err}"),
        },
        Plan::Normalize(lnk) => match shortcut::write(&lnk, &universal, super::deploy::DESCRIPTION)
        {
            Ok(_) => format!("normalized {} -> {}", lnk.display(), universal.display()),
            Err(err) => format!("failed: {err}"),
        },
    };
    if first_start {
        if let Err(err) = record_offer(local_dir, &outcome) {
            return format!("{outcome} (couldn't record the offer: {err})");
        }
    }
    outcome
}

#[cfg(test)]
mod tests {
    use super::*;

    const UNC: &str = r"\\fs01\apps\OpenMind Studio\OpenMindStudio.exe";
    const MAPPED: &str = r"Z:\OpenMind Studio\OpenMindStudio.exe";

    fn link(name: &str, target: &str) -> (PathBuf, PathBuf) {
        (
            PathBuf::from(format!(r"C:\Users\s\Desktop\{name}")),
            PathBuf::from(target),
        )
    }

    fn decide(
        first: bool,
        exe: &str,
        user: &[(PathBuf, PathBuf)],
        public: &[(PathBuf, PathBuf)],
    ) -> Plan {
        plan(
            first,
            &Facts {
                exe: Path::new(exe),
                universal: Path::new(UNC),
                desktop: Path::new(r"C:\Users\s\Desktop"),
                user,
                public,
            },
        )
    }

    #[test]
    fn a_first_start_with_an_empty_desktop_creates_the_shortcut() {
        assert_eq!(
            decide(true, MAPPED, &[], &[]),
            Plan::Create(PathBuf::from(r"C:\Users\s\Desktop\OpenMind Studio.lnk"))
        );
    }

    #[test]
    fn a_later_start_never_brings_back_a_deleted_shortcut() {
        assert!(matches!(decide(false, UNC, &[], &[]), Plan::Nothing(_)));
    }

    #[test]
    fn a_shortcut_an_administrator_put_anywhere_is_enough() {
        let public = [(
            PathBuf::from(r"C:\Users\Public\Desktop\Code Editor.lnk"),
            PathBuf::from(r"\\FS01\Apps\OpenMind Studio\OpenMindStudio.exe"),
        )];
        assert!(matches!(
            decide(true, MAPPED, &[], &public),
            Plan::Nothing(_)
        ));
        let user = [link("IDE.lnk", UNC)];
        assert!(matches!(decide(true, UNC, &user, &[]), Plan::Nothing(_)));
    }

    #[test]
    fn a_drive_letter_shortcut_to_this_program_is_pointed_at_the_network_path() {
        let user = [link("OpenMind Studio.lnk", MAPPED)];
        assert_eq!(
            decide(false, MAPPED, &user, &[]),
            Plan::Normalize(user[0].0.clone())
        );
        // Started from the UNC path, the Z: shortcut can't be recognised as this program: left alone.
        assert!(matches!(decide(true, UNC, &user, &[]), Plan::Nothing(_)));
    }

    #[test]
    fn another_copys_shortcut_is_never_replaced() {
        let user = [link(
            "OpenMind Studio.lnk",
            r"C:\Users\s\AppData\Local\OpenMind Studio\OpenMindStudio.exe",
        )];
        assert!(matches!(decide(true, MAPPED, &user, &[]), Plan::Nothing(_)));
    }

    #[test]
    fn the_offer_is_recorded_once_per_local_folder() {
        let dir = tempfile::tempdir().expect("dir");
        let local = dir.path().join("Installations").join("0123456789abcdef");
        assert!(!offered(&local));
        record_offer(&local, "created").expect("record");
        assert!(offered(&local));
        std::fs::write(local.join(RECORD_FILE), "{ damaged").expect("damage");
        assert!(!offered(&local), "a damaged record is not an offer");
    }
}
