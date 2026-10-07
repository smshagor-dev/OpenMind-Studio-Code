//! Bringing a profile's database into place at start-up, before it is opened: importing another scope's database into
//! it (the user asked for that when changing the data scope) and recovering from an import a crash interrupted.
//! [`prepare`] must run while the caller holds the profile lock (`openmind_core::profile_lock`); it re-reads the disk
//! itself, so whatever another start did while this one waited is taken into account.
//!
//! Files (`T` = the profile's database, `M` = `T.migrating`, the snapshot being built; `S` = the source):
//!
//! | Case | State | Action |
//! | --- | --- | --- |
//! | A/G/H | `T` exists and passes `quick_check` | use `T`; a leftover `M` is set aside (`.migrating-stale-<t>`); the import is done (never repeated) |
//! | E/F | `T` exists and fails `quick_check` | nothing is changed: `T`, `M` and `S` all stay; the start-up error window explains it |
//! | B | no `T`, import asked, `M` passes `quick_check` | `M` is renamed to `T` |
//! | C | no `T`, import asked, `M` fails | `M` is set aside (`.migrating-invalid-<t>`), then as D |
//! | D | no `T`, import asked, no `M` | `S` → `M` (SQLite Backup API) → `quick_check` → rename to `T` → `quick_check` |
//! | — | no `T`, nothing asked | a leftover `M` is set aside, never promoted; the app creates a new `T` |
//!
//! `S` is only ever read. `M` is never opened by the app as its database. Nothing is deleted.

use std::path::{Path, PathBuf};

use crate::snapshot::{flush, quick_check, snapshot_to};
use crate::DbError;

/// What [`prepare`] did.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Prepared {
    /// The profile's database exists and is valid (an import, if one was asked for, already happened).
    Existing,
    /// The source was copied in now.
    Imported,
    /// An interrupted import's verified snapshot was put in place.
    Recovered,
    /// No database yet and nothing to import: the app creates a new one.
    Fresh,
}

/// The snapshot file of `target` (never the app's database).
pub fn migrating_path(target: &Path) -> PathBuf {
    suffixed(target, "migrating")
}

fn suffixed(target: &Path, suffix: &str) -> PathBuf {
    let name = target
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_default();
    target.with_file_name(format!("{name}.{suffix}"))
}

/// See the module text. `import` is `Some(source)` when the user asked to copy `source` in (a missing source means there
/// is nothing to import). `stamp` names set-aside files.
pub fn prepare(target: &Path, import: Option<&Path>, stamp: u64) -> Result<Prepared, DbError> {
    let snapshot = migrating_path(target);
    if let Some(source) = import {
        if same_file(source, target) {
            return Err(DbError::Copy(
                "the source and the target are the same database".into(),
            ));
        }
    }
    if target.exists() {
        if import.is_none() && !snapshot.exists() {
            return Ok(Prepared::Existing); // the everyday start: nothing to check here
        }
        if !quick_check(target) {
            return Err(DbError::Copy(format!(
                "{} failed its integrity check. It was not replaced; {}",
                target.display(),
                if snapshot.exists() {
                    format!("the import snapshot {} was kept too.", snapshot.display())
                } else {
                    "nothing was changed.".to_string()
                }
            )));
        }
        set_aside(&snapshot, "migrating-stale", stamp)?;
        return Ok(Prepared::Existing);
    }
    let Some(source) = import else {
        set_aside(&snapshot, "migrating-orphan", stamp)?;
        return Ok(Prepared::Fresh);
    };
    if snapshot.exists() {
        if quick_check(&snapshot) {
            promote(&snapshot, target)?;
            return Ok(Prepared::Recovered);
        }
        set_aside(&snapshot, "migrating-invalid", stamp)?;
    }
    if !source.is_file() {
        return Ok(Prepared::Fresh);
    }
    if let Some(parent) = target.parent() {
        std::fs::create_dir_all(parent).map_err(|source| DbError::CreateDataDir {
            path: parent.to_path_buf(),
            source,
        })?;
    }
    if let Err(err) = snapshot_to(source, &snapshot) {
        set_aside(&snapshot, "migrating-invalid", stamp)?;
        return Err(err);
    }
    if !quick_check(&snapshot) {
        set_aside(&snapshot, "migrating-invalid", stamp)?;
        return Err(DbError::Copy(
            "the copied database failed its integrity check; the original is unchanged and the import will be tried again"
                .into(),
        ));
    }
    promote(&snapshot, target)?;
    Ok(Prepared::Imported)
}

/// `M` → `T`, only while `T` is still absent, then `T` is checked.
fn promote(snapshot: &Path, target: &Path) -> Result<(), DbError> {
    if target.exists() {
        return Err(DbError::Copy(format!(
            "{} appeared while the import ran; nothing was overwritten",
            target.display()
        )));
    }
    flush(snapshot)?;
    std::fs::rename(snapshot, target).map_err(|err| {
        DbError::Copy(format!("couldn't put the copied database in place: {err}"))
    })?;
    if !quick_check(target) {
        return Err(DbError::Copy(format!(
            "{} failed its integrity check right after the import",
            target.display()
        )));
    }
    Ok(())
}

/// Renames a leftover snapshot (and its `-wal`/`-shm`) out of the way; never deletes it.
fn set_aside(snapshot: &Path, label: &str, stamp: u64) -> Result<(), DbError> {
    if !snapshot.exists() {
        return Ok(());
    }
    let name = snapshot
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_default();
    let base = name.trim_end_matches(".migrating");
    let mut n = 0u32;
    let aside = loop {
        let extra = if n == 0 {
            String::new()
        } else {
            format!("-{n}")
        };
        let candidate = snapshot.with_file_name(format!("{base}.{label}-{stamp}{extra}"));
        if !candidate.exists() {
            break candidate;
        }
        n += 1;
    };
    std::fs::rename(snapshot, &aside).map_err(|err| {
        DbError::Copy(format!("couldn't set {} aside: {err}", snapshot.display()))
    })?;
    for side in ["-wal", "-shm"] {
        let from = PathBuf::from(format!("{}{side}", snapshot.display()));
        if from.exists() {
            let _ = std::fs::rename(&from, PathBuf::from(format!("{}{side}", aside.display())));
        }
    }
    tracing::warn!(from = %snapshot.display(), to = %aside.display(), "set an import snapshot aside");
    Ok(())
}

fn same_file(a: &Path, b: &Path) -> bool {
    match (std::fs::canonicalize(a), std::fs::canonicalize(b)) {
        (Ok(a), Ok(b)) => a == b,
        _ => a == b,
    }
}

#[cfg(test)]
#[path = "migration_tests.rs"]
mod tests;
