//! Moving to the other data scope without losing anything.
//!
//! - **When the user chooses** ([`schedule`]): only the choice is saved (`data/data-scope.json`), with an import
//!   request when "use the existing profile" is ticked and the new scope has no database yet. An existing database of
//!   the new scope is always kept as it is.
//! - **At the next start of that computer** ([`prepare_at_start`], under the profile lock, before any database is
//!   opened): the AI history and MariaDB data folders are copied when the target has none, then the database is brought
//!   in by `openmind_db::migration::prepare` (SQLite Backup API from a read-only connection → `.migrating` →
//!   `quick_check` → rename; the recovery cases are listed there). The request is cleared only once the target
//!   database exists and is valid, so a crash at any step is picked up by the next start and nothing is imported twice.
//!
//! The source (the old profile) is only ever read. Nothing is deleted or moved away from it.

use std::path::Path;

use openmind_core::data_scope::{clear_pending_import, rfc3339_now, write_choice, PendingImport};
use openmind_core::machine_paths::MachineDataPaths;
use openmind_core::{AppPaths, DataScope};
use openmind_db::migration::{self, Prepared};
use openmind_db::DbError;
use serde::Serialize;

use super::{machine_folder, ScopeRuntime};

/// What a change will do at the next start, shown to the user.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScheduledChange {
    /// The database the next start opens.
    pub database: String,
    /// That database already exists and is used as it is (nothing is copied).
    pub kept_existing: bool,
    /// The profile in use now will be copied there at the next start.
    pub will_import: bool,
}

fn other(scope: DataScope) -> DataScope {
    match scope {
        DataScope::Personal => DataScope::PerMachine,
        DataScope::PerMachine => DataScope::Personal,
    }
}

/// Saves `mode` (and, with `use_existing`, the import request) for the next start.
pub fn schedule(
    runtime: &ScopeRuntime,
    mode: DataScope,
    use_existing: bool,
) -> Result<ScheduledChange, String> {
    let root = &runtime.paths.root_dir;
    let machine = machine_folder(runtime);
    let (source, target) = match mode {
        DataScope::PerMachine => (
            runtime.paths.shared_db_path.clone(),
            machine.database.clone(),
        ),
        DataScope::Personal => (
            machine.database.clone(),
            runtime.paths.shared_db_path.clone(),
        ),
    };
    let kept_existing = target.exists();
    let will_import = use_existing && !kept_existing && source.is_file();
    let import = will_import.then(|| PendingImport {
        identity_hash: runtime.identity.identity_hash().to_string(),
        from: other(mode),
        requested_at: rfc3339_now(),
    });
    write_choice(root, mode, import).map_err(|err| format!("couldn't save the choice: {err}"))?;
    tracing::info!(
        scope = mode.label(),
        kept_existing,
        will_import,
        "portable data scope chosen; it applies at the next start"
    );
    Ok(ScheduledChange {
        database: target.display().to_string(),
        kept_existing,
        will_import,
    })
}

/// Brings `paths.db_path` into place before it is opened (see the module text). `pending` is this computer's import
/// request into `paths.scope`, if any; `machine` is this computer's folder (required for an import).
pub fn prepare_at_start(
    paths: &AppPaths,
    machine: Option<&MachineDataPaths>,
    pending: Option<&PendingImport>,
    stamp: u64,
) -> Result<Prepared, DbError> {
    let Some(_import) = pending else {
        return migration::prepare(&paths.db_path, None, stamp);
    };
    let machine =
        machine.ok_or_else(|| DbError::Copy("this computer's profile folder is missing".into()))?;
    let root = paths.root_dir.clone();
    let personal = AppPaths::from_root(root.clone());
    let per_machine = AppPaths::per_machine(root.clone(), machine.clone());
    let (from, to) = match paths.scope {
        DataScope::PerMachine => (&personal, &per_machine),
        DataScope::Personal => (&per_machine, &personal),
    };
    if !to.db_path.exists() {
        for (name, source, dest) in [
            ("AI history", &from.ai_dir, &to.ai_dir),
            ("MariaDB data", &from.mariadb_data_dir, &to.mariadb_data_dir),
        ] {
            if source.is_dir() && !dest.exists() {
                copy_dir_verified(source, dest).map_err(|err| {
                    DbError::Copy(format!(
                        "copying the {name} failed: {err}. Nothing was changed in the original profile."
                    ))
                })?;
            }
        }
    }
    let outcome = migration::prepare(&to.db_path, Some(&from.db_path), stamp)?;
    if let Err(err) = clear_pending_import(&root) {
        // The database is in place; a request left behind only makes the next start confirm that (no second import).
        tracing::warn!(error = %err, "couldn't clear the finished import request");
    }
    tracing::info!(outcome = ?outcome, "profile import finished");
    Ok(outcome)
}

/// Copies a folder into `dest` (which must not exist) through `<dest>.partial`, then renames it. SQLite files are copied
/// with the Backup API and checked (their `-wal`/`-shm`/`-journal` files are not copied: the snapshot includes them);
/// other files are flushed and compared by size. Links are skipped, never followed. A `.partial` left by a crash is this
/// copy's own (the profile lock is held) and is made again.
pub fn copy_dir_verified(source: &Path, dest: &Path) -> Result<(), String> {
    if dest.exists() {
        return Err(format!("{} already exists", dest.display()));
    }
    if in_use(source) {
        return Err(format!(
            "{} is in use (is MariaDB still running from another OpenMind Studio window?)",
            source.display()
        ));
    }
    let partial = dest.with_extension("partial");
    if partial.exists() {
        std::fs::remove_dir_all(&partial).map_err(|e| e.to_string())?;
    }
    match copy_tree(source, &partial) {
        Ok(()) => std::fs::rename(&partial, dest).map_err(|e| e.to_string()),
        Err(err) => {
            let _ = std::fs::remove_dir_all(&partial);
            Err(err)
        }
    }
}

fn is_sqlite(name: &str) -> bool {
    name.ends_with(".sqlite") || name.ends_with(".db")
}

fn is_sqlite_sidecar(name: &str) -> bool {
    ["-wal", "-shm", "-journal"]
        .iter()
        .any(|side| name.strip_suffix(side).is_some_and(is_sqlite))
}

fn copy_tree(source: &Path, dest: &Path) -> Result<(), String> {
    std::fs::create_dir_all(dest).map_err(|e| format!("{}: {e}", dest.display()))?;
    for entry in std::fs::read_dir(source).map_err(|e| format!("{}: {e}", source.display()))? {
        let entry = entry.map_err(|e| e.to_string())?;
        let kind = entry.file_type().map_err(|e| e.to_string())?;
        let name = entry.file_name().to_string_lossy().into_owned();
        let target = dest.join(entry.file_name());
        if kind.is_dir() {
            copy_tree(&entry.path(), &target)?;
        } else if kind.is_file() && is_sqlite_sidecar(&name) {
            continue;
        } else if kind.is_file()
            && is_sqlite(&name)
            && openmind_db::snapshot::quick_check_source(&entry.path())
        {
            openmind_db::snapshot::snapshot_to(&entry.path(), &target)
                .map_err(|e| e.to_string())?;
            if !openmind_db::snapshot::quick_check(&target) {
                return Err(format!("the copy of {name} failed its integrity check"));
            }
        } else if kind.is_file() {
            let expected = entry.metadata().map_err(|e| e.to_string())?.len();
            let copied = std::fs::copy(entry.path(), &target)
                .map_err(|e| format!("{}: {e}", entry.path().display()))?;
            // Flushing needs write access on Windows (`FlushFileBuffers`); a read-only handle is refused.
            std::fs::OpenOptions::new()
                .write(true)
                .open(&target)
                .and_then(|file| file.sync_all())
                .map_err(|e| format!("{}: {e}", target.display()))?;
            if copied != expected {
                return Err(format!("{name}: {copied} of {expected} bytes copied"));
            }
        }
    }
    Ok(())
}

/// Whether a running server holds the folder's files (Windows: InnoDB's `ibdata1` can't be opened exclusively).
fn in_use(dir: &Path) -> bool {
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        let ibdata = dir.join("ibdata1");
        ibdata.is_file()
            && std::fs::OpenOptions::new()
                .read(true)
                .share_mode(0)
                .open(&ibdata)
                .is_err()
    }
    #[cfg(not(windows))]
    {
        let _ = dir;
        false
    }
}

#[cfg(test)]
#[path = "migrate_tests.rs"]
mod tests;
