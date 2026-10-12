//! One computer at a time per database, for as long as the app runs.
//!
//! SQLite can't be shared by two *computers* through a network folder (its locking over SMB is unreliable and WAL
//! needs shared memory): two computers writing one `openmind-studio.db` can damage it. That happens when a portable copy
//! on a share is set up as "Only for me" and started from several computers at once, or when two cloned lab computers
//! end up with the same identity. [`claim`] stops the second computer before it opens the database.
//!
//! The first start holds an operating-system lock on `<profile>/session.lock` (released by the OS when the process ends,
//! crashes or loses the network, so it never outlives a start) and writes `session-owner.json` with a token of its
//! computer name — a hash, never the name itself. A later start that can't take the lock reads the owner:
//! - the same computer (another window or a second start of this copy): allowed, as always — SQLite locks reliably on
//!   one computer;
//! - another computer: refused ([`Claim::OtherComputer`]); nothing is opened or changed.
//!
//! When locking isn't possible at all (a read-only folder, a file system without locks) the start goes on: this guard
//! must never be the reason a copy that worked before stops starting.

use std::fs::{File, OpenOptions, TryLockError};
use std::path::Path;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

pub const SESSION_LOCK: &str = "session.lock";
pub const SESSION_OWNER: &str = "session-owner.json";

/// How long a start waits for the owner's record when the lock was taken a moment ago and the record isn't there yet.
const OWNER_WAIT: Duration = Duration::from_secs(2);

/// Held for the life of the process: the lock goes with it.
#[derive(Debug)]
pub struct SessionGuard {
    _file: File,
}

/// What [`claim`] found.
#[derive(Debug)]
pub enum Claim {
    /// This start owns the database now.
    Owner(SessionGuard),
    /// Another start on this same computer owns it: fine.
    SameComputer,
    /// Another computer has this database open right now.
    OtherComputer,
    /// Locking isn't possible here; the start goes on unguarded (the reason is for the log).
    Unguarded(String),
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Owner {
    computer: String,
    pid: u32,
    started_at: String,
}

/// A token for this computer's name: equal on one computer, different between computers with different names, and
/// not the name itself.
pub fn computer_token() -> String {
    computer_token_of(&computer_name())
}

fn computer_token_of(name: &str) -> String {
    let digest = Sha256::digest(format!(
        "openmind-studio:session:v1\n{}",
        name.trim().to_lowercase()
    ));
    digest.iter().take(8).map(|b| format!("{b:02x}")).collect()
}

fn computer_name() -> String {
    for var in ["COMPUTERNAME", "HOSTNAME"] {
        if let Some(name) = std::env::var_os(var).filter(|name| !name.is_empty()) {
            return name.to_string_lossy().into_owned();
        }
    }
    std::fs::read_to_string("/etc/hostname").unwrap_or_default()
}

/// Claims the database in `dir` for this computer (see the module text).
pub fn claim(dir: &Path) -> Claim {
    claim_as(dir, &computer_token())
}

/// [`claim`] for a given computer token (tests play several computers).
pub fn claim_as(dir: &Path, computer: &str) -> Claim {
    if let Err(err) = std::fs::create_dir_all(dir) {
        return Claim::Unguarded(format!("couldn't create {}: {err}", dir.display()));
    }
    let lock_path = dir.join(SESSION_LOCK);
    let file = match OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .open(&lock_path)
    {
        Ok(file) => file,
        Err(err) => {
            return Claim::Unguarded(format!("couldn't open {}: {err}", lock_path.display()))
        }
    };
    match file.try_lock() {
        Ok(()) => {
            let owner = Owner {
                computer: computer.to_string(),
                pid: std::process::id(),
                started_at: crate::data_scope::rfc3339_now(),
            };
            // A record that can't be written leaves the lock alone in force: a later start then can't tell whose it is
            // and is let through (see `wait_for_owner`) — never worse than before this guard existed.
            let _ = serde_json::to_vec_pretty(&owner)
                .map_err(std::io::Error::other)
                .and_then(|bytes| {
                    crate::data_scope::write_atomic(&dir.join(SESSION_OWNER), &bytes)
                });
            Claim::Owner(SessionGuard { _file: file })
        }
        Err(TryLockError::WouldBlock) => match wait_for_owner(dir) {
            Some(owner) if owner.computer == computer => Claim::SameComputer,
            Some(_) => Claim::OtherComputer,
            // Held, but nobody says by whom: a start on this computer that is still writing, or an old build.
            None => Claim::SameComputer,
        },
        Err(TryLockError::Error(err)) => {
            Claim::Unguarded(format!("couldn't lock {}: {err}", lock_path.display()))
        }
    }
}

fn wait_for_owner(dir: &Path) -> Option<Owner> {
    let deadline = std::time::Instant::now() + OWNER_WAIT;
    loop {
        let owner = std::fs::read_to_string(dir.join(SESSION_OWNER))
            .ok()
            // A byte-order mark (a record written by another tool) is not part of the JSON.
            .and_then(|text| {
                serde_json::from_str::<Owner>(text.trim_start_matches('\u{feff}')).ok()
            });
        if owner.is_some() || std::time::Instant::now() >= deadline {
            return owner;
        }
        std::thread::sleep(Duration::from_millis(100));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_second_start_on_the_same_computer_is_allowed_and_another_computer_is_refused() {
        let dir = tempfile::tempdir().expect("tempdir");
        let first = claim_as(dir.path(), "pc-one");
        assert!(matches!(first, Claim::Owner(_)), "{first:?}");
        assert!(matches!(
            claim_as(dir.path(), "pc-one"),
            Claim::SameComputer
        ));
        assert!(matches!(
            claim_as(dir.path(), "pc-two"),
            Claim::OtherComputer
        ));
        let owner = std::fs::read_to_string(dir.path().join(SESSION_OWNER)).expect("owner");
        assert!(owner.contains("pc-one") && owner.contains(&std::process::id().to_string()));
        drop(first);
        // Once the first start ends, the other computer may start (a crash releases the lock the same way).
        assert!(matches!(claim_as(dir.path(), "pc-two"), Claim::Owner(_)));
    }

    #[test]
    fn an_owner_record_with_a_byte_order_mark_is_still_read() {
        let dir = tempfile::tempdir().expect("tempdir");
        let first = claim_as(dir.path(), "pc-one");
        assert!(matches!(first, Claim::Owner(_)));
        // The same record as another tool would write it (Windows PowerShell's UTF-8 adds a BOM).
        std::fs::write(
            dir.path().join(SESSION_OWNER),
            "\u{feff}{\"computer\":\"pc-one\",\"pid\":1,\"startedAt\":\"2026-01-01T00:00:00Z\"}",
        )
        .expect("write");
        assert!(matches!(
            claim_as(dir.path(), "pc-two"),
            Claim::OtherComputer
        ));
        drop(first);
    }

    #[test]
    fn leftover_files_from_an_ended_start_block_nothing() {
        let dir = tempfile::tempdir().expect("tempdir");
        std::fs::write(dir.path().join(SESSION_LOCK), b"left over").expect("write");
        std::fs::write(
            dir.path().join(SESSION_OWNER),
            r#"{"computer":"pc-gone","pid":1,"startedAt":"2026-01-01T00:00:00Z"}"#,
        )
        .expect("write");
        assert!(matches!(claim_as(dir.path(), "pc-new"), Claim::Owner(_)));
    }

    #[test]
    fn a_folder_that_cant_hold_the_lock_leaves_the_start_unguarded() {
        let dir = tempfile::tempdir().expect("tempdir");
        // A folder where the lock file should be: it can't be opened as a file.
        std::fs::create_dir_all(dir.path().join(SESSION_LOCK)).expect("dir");
        assert!(matches!(claim_as(dir.path(), "pc"), Claim::Unguarded(_)));
    }

    #[test]
    fn the_computer_token_is_stable_case_blind_and_not_the_name() {
        assert_eq!(
            computer_token_of("LAB-PC-07"),
            computer_token_of(" lab-pc-07 ")
        );
        assert_ne!(
            computer_token_of("LAB-PC-07"),
            computer_token_of("LAB-PC-08")
        );
        assert!(!computer_token_of("LAB-PC-07")
            .to_lowercase()
            .contains("lab"));
        assert_eq!(computer_token().len(), 16);
    }
}
