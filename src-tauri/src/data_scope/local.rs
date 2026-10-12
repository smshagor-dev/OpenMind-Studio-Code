//! Start-up of the installer-managed layouts whose writable state lives on each computer
//! (`openmind_core::install::InstallLayout::local_state`): the per-machine install in Program Files and a network
//! installation shared by several computers. There is nothing to choose: the installer decided, so the setup window never
//! appears, and the workbench's Data Scope page only shows the layout.
//!
//! - **Per-machine** (`C:\Program Files\OpenMind Studio`, read-only for users): every Windows user's whole layout lives
//!   in their local folder (`AppPaths::per_machine_install`). A database an earlier version kept next to the program
//!   (only possible when it ran as administrator) is copied in once, never moved.
//! - **Network** (`\\server\share\OpenMind Studio`, or the teacher's own shared folder): runtimes, tools, language
//!   servers and extensions stay shared; the database, settings, logs and the rest go to this computer's and this
//!   Windows user's local folder (`AppPaths::network`). When the shared folder was a portable copy in the per-computer
//!   scope before, this computer's own profile there (`data/machines/<id>/`) is copied in once — the shared copy is only
//!   read.
//!
//! Either way the copy is the verified one of `migrate::import_profile`, under a lock in the local folder, and it runs
//! only while the local database doesn't exist yet: a later start just opens it.

use std::path::{Path, PathBuf};

use openmind_core::install::{self, InstallLayout};
use openmind_core::machine_identity::MachineIdentity;
use openmind_core::machine_paths::{find_own_profile, MachineDataPaths};
use openmind_core::profile_lock::{ProfileLock, DEFAULT_WAIT};
use openmind_core::AppPaths;
use openmind_db::migration::{self, Prepared};
use openmind_db::DbError;

use super::{failure_paths, migrate, note, now_secs, remember_start, ScopeRuntime};

/// The paths of `layout` for the program in `exe_dir` and this user's `local` folder.
pub fn paths_for(layout: InstallLayout, exe_dir: &Path, local: &Path) -> AppPaths {
    match layout {
        InstallLayout::Network => AppPaths::network(
            exe_dir.to_path_buf(),
            MachineDataPaths::local(local, &install::install_key(exe_dir)),
        ),
        _ => AppPaths::per_machine_install(exe_dir.to_path_buf(), local.to_path_buf()),
    }
}

/// Where earlier data of this computer can come from (read only): see the module text.
pub fn earlier_profile(
    layout: InstallLayout,
    exe_dir: &Path,
    identity: &MachineIdentity,
) -> Option<AppPaths> {
    match layout {
        InstallLayout::Network => find_own_profile(exe_dir, identity)
            .map(|machine| AppPaths::per_machine(exe_dir.to_path_buf(), machine)),
        _ => {
            let legacy = AppPaths::from_root(exe_dir.to_path_buf());
            legacy.db_path.is_file().then_some(legacy)
        }
    }
}

/// Prepares this computer's database for `paths` (see the module text).
pub fn prepare(
    paths: &AppPaths,
    earlier: Option<&AppPaths>,
    stamp: u64,
) -> Result<Prepared, DbError> {
    let lock_root = paths
        .machine
        .as_ref()
        .map_or_else(|| paths.root_dir.clone(), |machine| machine.root.clone());
    let _lock = ProfileLock::acquire(&lock_root, DEFAULT_WAIT)
        .map_err(|err| DbError::Copy(format!("couldn't lock this computer's profile: {err}")))?;
    match earlier {
        Some(from) if !paths.db_path.exists() => {
            match migrate::import_profile(from, paths, stamp) {
                Ok(outcome) => {
                    note(format!(
                        "earlier profile {} brought into this computer's folder ({outcome:?})",
                        from.db_path.display()
                    ));
                    Ok(outcome)
                }
                // The earlier profile stays where it is, untouched; this computer starts with a new one rather than not at all
                // (the import can't be retried from a page: it is the database the error window would offer to set aside).
                Err(err) => {
                    note(format!("the earlier profile {} couldn't be copied ({err}); starting with a new one (the earlier one was not changed)", from.db_path.display()));
                    migration::prepare(&paths.db_path, None, stamp)
                }
            }
        }
        _ => migration::prepare(&paths.db_path, None, stamp),
    }
}

/// [`super::resolve`] for the layouts of this module.
pub fn resolve(
    layout: InstallLayout,
    exe_dir: PathBuf,
    identity: MachineIdentity,
    local_dir: Option<PathBuf>,
) -> ScopeRuntime {
    let Some(local) = local_dir.clone() else {
        let reason =
            "This installation keeps each user's data in their local application data folder \
                      (%LOCALAPPDATA%), which is not set for this user. Nothing was changed.";
        return failed(&exe_dir, identity, local_dir, DbError::Copy(reason.into()));
    };
    let paths = paths_for(layout, &exe_dir, &local);
    if let Err(err) = paths.ensure_dirs() {
        return failed(
            &exe_dir,
            identity,
            local_dir,
            DbError::Copy(err.to_string()),
        );
    }
    let earlier = earlier_profile(layout, &exe_dir, &identity);
    let failure = prepare(&paths, earlier.as_ref(), now_secs()).err();
    note(format!(
        "installer-managed layout {}: this computer's state is in {}",
        layout.label(),
        local.display()
    ));
    let runtime = ScopeRuntime {
        machine: paths.machine.clone(),
        paths,
        identity,
        needs_setup: false,
        unreadable: None,
        single_computer: layout == InstallLayout::PerMachine,
        failure,
        local_dir,
        temporary_folder: false,
    };
    if runtime.failure.is_none() {
        remember_start(&runtime);
    }
    runtime
}

fn failed(
    exe_dir: &Path,
    identity: MachineIdentity,
    local_dir: Option<PathBuf>,
    err: DbError,
) -> ScopeRuntime {
    ScopeRuntime {
        paths: failure_paths(exe_dir, &identity),
        machine: None,
        identity,
        needs_setup: false,
        unreadable: None,
        single_computer: true,
        failure: Some(err),
        local_dir,
        temporary_folder: false,
    }
}

#[cfg(test)]
#[path = "local_tests.rs"]
mod tests;
