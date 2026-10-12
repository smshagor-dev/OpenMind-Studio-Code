//! One computer's folder in the per-computer data scope: `data/machines/<profile id>/`. This is the only place that
//! builds those paths; [`crate::AppPaths`] takes its database, logs, WebView profile, search index, AI history,
//! temporary files and MariaDB folders from here when the scope is [`crate::DataScope::PerMachine`].
//!
//! ```text
//! data/machines/<profile id>/
//!     machine.json          schema/identity version, profile id, the full identity hash, platform, created/last used
//!     openmind-studio.db    this computer's SQLite database (WAL)
//!     logs/                 this computer's logs (app, lsp/, mariadb/, phpmyadmin/, extensions/, network diagnostics)
//!     cache/                this computer's small caches (phpMyAdmin's generated configuration)
//!     state/                webview/, search-index/, ai/, mariadb/ (data), mariadb-config/, asm-lsp/
//!     temp/                 download staging, update downloads, the per-run npm configuration
//! ```
//!
//! **Which folder** ([`select_profile`]): the identity is resolved from the computer first
//! ([`crate::machine_identity`]); its full hash names the folder by its first 12 characters. `machine.json` is then read
//! only to *confirm* the folder is this computer's (same full hash). If another computer's folder has the same prefix,
//! the next longer prefix is used (16, 24, 32, then the full 64 characters). Nothing in `machine.json` can make the app
//! pick a folder its own hash doesn't name.

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::data_scope::{rfc3339_now, write_atomic};
use crate::machine_identity::{MachineIdentity, IDENTITY_VERSION};

/// The folder of all computers' profiles, relative to the app folder.
pub const MACHINES_DIR: &str = "data/machines";
/// The database file name inside a computer's folder (the same name as the one-profile database).
pub const MACHINE_DB_FILENAME: &str = "openmind-studio.db";
const MACHINE_FILE: &str = "machine.json";
const SCHEMA_VERSION: u32 = 1;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MachineDataPaths {
    /// The profile id (a prefix of the hashed identity, never a raw machine identifier).
    pub machine_id: String,
    pub root: PathBuf,
    pub database: PathBuf,
    pub logs: PathBuf,
    pub cache: PathBuf,
    pub state: PathBuf,
    pub temp: PathBuf,
}

impl MachineDataPaths {
    /// The folder of `machine_id` under `app_root`. Only [`select_profile`] (and tests) should call this with an id; it
    /// must be a profile id ([`crate::machine_identity::is_profile_id`]).
    pub fn new(app_root: &Path, machine_id: &str) -> Self {
        let root = machines_dir(app_root).join(machine_id);
        Self {
            machine_id: machine_id.to_string(),
            database: root.join(MACHINE_DB_FILENAME),
            logs: root.join("logs"),
            cache: root.join("cache"),
            state: root.join("state"),
            temp: root.join("temp"),
            root,
        }
    }

    /// A profile kept on this computer's own disk (an installer-managed layout, see [`crate::install`]): the same files
    /// directly under `dir` (`<dir>/openmind-studio.db`, `logs/`, `cache/`, `state/`, `temp/`). `id` is what is shown
    /// for it (the install key).
    pub fn local(dir: &Path, id: &str) -> Self {
        Self {
            machine_id: id.to_string(),
            database: dir.join(MACHINE_DB_FILENAME),
            logs: dir.join("logs"),
            cache: dir.join("cache"),
            state: dir.join("state"),
            temp: dir.join("temp"),
            root: dir.to_path_buf(),
        }
    }

    pub fn profile_file(&self) -> PathBuf {
        self.root.join(MACHINE_FILE)
    }

    /// Creates the sub-folders.
    pub fn ensure_dirs(&self) -> std::io::Result<()> {
        for dir in [&self.root, &self.logs, &self.cache, &self.state, &self.temp] {
            std::fs::create_dir_all(dir)?;
        }
        Ok(())
    }

    /// `machine.json` as stored (only for display and for [`select_profile`]'s confirmation).
    pub fn read_profile(&self) -> Option<MachineProfile> {
        let text = std::fs::read_to_string(self.profile_file()).ok()?;
        serde_json::from_str::<MachineProfile>(&text)
            .ok()
            .filter(|p| p.profile_id == self.machine_id)
    }

    fn write_profile(&self, profile: &MachineProfile) -> std::io::Result<()> {
        let text = serde_json::to_string_pretty(profile).map_err(std::io::Error::other)?;
        write_atomic(&self.profile_file(), text.as_bytes())
    }
}

/// `data/machines/<id>/machine.json`: derived values only (the hash can't be turned back into the computer's ids).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MachineProfile {
    pub schema_version: u32,
    pub identity_version: u32,
    pub profile_id: String,
    /// The full SHA-256 identity hash ([`MachineIdentity::identity_hash`]).
    pub identity_hash: String,
    pub platform: String,
    pub created_at: String,
    pub last_used_at: String,
}

/// Finds or creates this computer's folder (see the module text). Call it while holding the
/// [`crate::profile_lock::ProfileLock`]. Another computer's folder is never written to.
pub fn select_profile(
    app_root: &Path,
    identity: &MachineIdentity,
) -> std::io::Result<MachineDataPaths> {
    for candidate in identity.candidate_ids() {
        let paths = MachineDataPaths::new(app_root, candidate);
        match claim(&paths, identity)? {
            Claim::Mine => {
                paths.ensure_dirs()?;
                return Ok(paths);
            }
            Claim::Taken => {
                tracing::warn!(
                    profile = candidate,
                    "a profile folder with this prefix belongs to another computer; using a longer profile id"
                );
            }
        }
    }
    Err(std::io::Error::other(
        "no profile folder could be used for this computer",
    ))
}

enum Claim {
    Mine,
    Taken,
}

fn claim(paths: &MachineDataPaths, identity: &MachineIdentity) -> std::io::Result<Claim> {
    let now = rfc3339_now();
    let fresh = || MachineProfile {
        schema_version: SCHEMA_VERSION,
        identity_version: IDENTITY_VERSION,
        profile_id: paths.machine_id.clone(),
        identity_hash: identity.identity_hash().to_string(),
        platform: platform().to_string(),
        created_at: now.clone(),
        last_used_at: now.clone(),
    };
    if !paths.root.exists() {
        // machine.json first: a folder never holds data before it says whose it is.
        std::fs::create_dir_all(&paths.root)?;
        paths.write_profile(&fresh())?;
        return Ok(Claim::Mine);
    }
    match paths.read_profile() {
        Some(mut profile) if profile.identity_hash == identity.identity_hash() => {
            profile.last_used_at = now;
            paths.write_profile(&profile)?;
            Ok(Claim::Mine)
        }
        Some(_) => Ok(Claim::Taken),
        // No readable machine.json: only a folder with nothing in it (a start that stopped right after creating it) is
        // claimed; one holding anything else may be another computer's and is left alone.
        None if holds_nothing(&paths.root) => {
            paths.write_profile(&fresh())?;
            Ok(Claim::Mine)
        }
        None => Ok(Claim::Taken),
    }
}

/// Only leftovers of an interrupted `machine.json` write (`*.tmp`) or nothing at all.
fn holds_nothing(dir: &Path) -> bool {
    std::fs::read_dir(dir).is_ok_and(|entries| {
        entries.filter_map(Result::ok).all(|entry| {
            let name = entry.file_name().to_string_lossy().into_owned();
            name.starts_with(MACHINE_FILE) && entry.file_type().is_ok_and(|t| t.is_file())
        })
    })
}

/// This computer's existing folder under `data/machines/`, without creating or changing anything: the first candidate id
/// whose `machine.json` names this computer's full identity hash and which holds a database. Used to bring a profile
/// along when a shared portable copy becomes a network installation, and as evidence of an earlier per-computer choice.
pub fn find_own_profile(app_root: &Path, identity: &MachineIdentity) -> Option<MachineDataPaths> {
    identity
        .candidate_ids()
        .map(|id| MachineDataPaths::new(app_root, id))
        .find(|paths| {
            paths.database.is_file()
                && paths
                    .read_profile()
                    .is_some_and(|p| p.identity_hash == identity.identity_hash())
        })
}

pub fn machines_dir(app_root: &Path) -> PathBuf {
    app_root.join(MACHINES_DIR)
}

/// The profiles found under `data/machines/` (folders with a valid id), for the data-scope page.
pub fn list_profiles(app_root: &Path) -> Vec<MachineProfileSummary> {
    let Ok(entries) = std::fs::read_dir(machines_dir(app_root)) else {
        return Vec::new();
    };
    let mut found: Vec<MachineProfileSummary> = entries
        .filter_map(Result::ok)
        .filter(|entry| entry.file_type().is_ok_and(|t| t.is_dir()))
        .filter_map(|entry| {
            let id = entry.file_name().to_string_lossy().into_owned();
            if !crate::machine_identity::is_profile_id(&id) {
                return None;
            }
            let paths = MachineDataPaths::new(app_root, &id);
            Some(MachineProfileSummary {
                has_database: paths.database.is_file(),
                last_used_at: paths.read_profile().map(|p| p.last_used_at),
                profile_id: id,
            })
        })
        .collect();
    found.sort_by(|a, b| a.profile_id.cmp(&b.profile_id));
    found
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MachineProfileSummary {
    pub profile_id: String,
    pub has_database: bool,
    pub last_used_at: Option<String>,
}

fn platform() -> &'static str {
    if cfg!(windows) {
        "windows"
    } else if cfg!(target_os = "macos") {
        "macos"
    } else {
        "linux"
    }
}

#[cfg(test)]
#[path = "machine_paths_tests.rs"]
mod tests;
