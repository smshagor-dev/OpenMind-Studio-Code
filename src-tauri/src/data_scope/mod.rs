//! The portable data scope at start-up and its commands (see `openmind_core::data_scope` and `docs/data-scope.md`).
//!
//! [`resolve`] runs first in `main`, before logging, the database, the WebView or any service:
//!
//! 1. the app folder ([`AppPaths::resolve`]) and this computer's identity (`machine_identity::resolve`: read from the
//!    computer itself, never from the drive);
//! 2. the saved choice (`data/data-scope.json`); a portable copy that never chose opens the **setup window**
//!    ([`SETUP_WINDOW_LABEL`]) instead of the workbench;
//! 3. under the OS profile lock (`openmind_core::profile_lock`): this computer's folder (`select_profile`, which checks
//!    `machine.json`'s hash and steps around a prefix collision) and the database's preparation (`migrate::prepare_at_start`:
//!    an import the user asked for, or the recovery of an interrupted one);
//! 4. `main` opens the database at [`AppPaths::db_path`] — never anything else.
//!
//! Installed copies (the per-user setup, the MSI) and a Linux copy that keeps its data in the user's folder belong to one
//! computer and keep the one-profile layout without asking; they can still switch from the workbench.

pub mod migrate;

use std::path::PathBuf;

use openmind_core::data_scope::{read_choice, read_pending_import, ScopeChoice};
use openmind_core::machine_identity::{self, IdentitySource};
use openmind_core::machine_paths::{
    list_profiles, select_profile, MachineDataPaths, MachineProfileSummary,
};
use openmind_core::profile_lock::{ProfileLock, DEFAULT_WAIT};
use openmind_core::{AppPaths, CoreError, DataScope, MachineIdentity};
use openmind_db::DbError;
use serde::Serialize;
use tauri::{AppHandle, Manager, State};

use migrate::ScheduledChange;

/// The setup window's label; `main.tsx` shows the data-scope page for it.
pub const SETUP_WINDOW_LABEL: &str = "data-scope-setup";

/// What start-up decided, kept as managed state for the commands below.
pub struct ScopeRuntime {
    pub identity: MachineIdentity,
    pub paths: AppPaths,
    /// This computer's folder when it was selected (always in the per-computer scope).
    pub machine: Option<MachineDataPaths>,
    /// The choice has to be made in the setup window before the workbench starts.
    pub needs_setup: bool,
    /// A damaged `data-scope.json`, shown on the setup page.
    pub unreadable: Option<String>,
    /// Installed copy or user-folder data: one computer by nature.
    pub single_computer: bool,
    /// The profile couldn't be prepared: `main` shows the start-up error window and opens no database.
    pub failure: Option<DbError>,
}

/// Facts [`decide`] works from.
#[derive(Debug, Clone)]
pub struct ScopeFacts {
    pub choice: ScopeChoice,
    /// The data folder is the program's folder (not `~/.local/share/...`).
    pub portable_root: bool,
    /// Installed by the per-user setup or the MSI.
    pub installed: bool,
}

/// The scope to start in, and whether the user must be asked first (`None`).
pub fn decide(facts: &ScopeFacts) -> Option<DataScope> {
    match facts.choice {
        ScopeChoice::Chosen(scope) => Some(scope),
        _ if !facts.portable_root || facts.installed => Some(DataScope::Personal),
        _ => None,
    }
}

/// Resolves the app folder, this computer's profile and the scope, and prepares the database. Fails only when the app
/// folder itself can't be found; every other problem becomes [`ScopeRuntime::failure`].
pub fn resolve() -> Result<ScopeRuntime, CoreError> {
    let base = AppPaths::resolve()?;
    let exe_dir = std::env::current_exe()
        .ok()
        .and_then(|exe| exe.parent().map(PathBuf::from));
    let installed = !matches!(
        crate::updates::install_kind(),
        crate::updates::InstallKind::Portable
    );
    let facts = ScopeFacts {
        choice: read_choice(&base.root_dir),
        portable_root: exe_dir.as_deref() == Some(base.root_dir.as_path()),
        installed,
    };
    let identity = machine_identity::resolve(&base.root_dir);
    let unreadable = match &facts.choice {
        ScopeChoice::Unreadable(reason) => Some(reason.clone()),
        _ => None,
    };
    let decided = decide(&facts);
    let single_computer = !facts.portable_root || facts.installed;
    // While the user decides, logs and the page's WebView profile go to this computer's folder.
    let scope = decided.unwrap_or(DataScope::PerMachine);
    let (paths, machine, failure) =
        match prepare(&base.root_dir, scope, &identity, decided.is_some()) {
            Ok((paths, machine)) => (paths, machine, None),
            // The database step failed: the error window names (and can only back up) this profile's own database.
            Err(Failure::Database(failed)) => {
                let (paths, machine, err) = *failed;
                (paths, machine, Some(err))
            }
            Err(Failure::Profile(err)) => {
                (failure_paths(&base.root_dir, &identity), None, Some(err))
            }
        };
    Ok(ScopeRuntime {
        paths,
        machine,
        identity,
        needs_setup: decided.is_none(),
        unreadable,
        single_computer,
        failure,
    })
}

/// Why [`prepare`] stopped.
#[derive(Debug)]
enum Failure {
    /// Before the profile's paths were known (the lock, the folder).
    Profile(DbError),
    /// Preparing the database at these paths failed.
    Database(Box<(AppPaths, Option<MachineDataPaths>, DbError)>),
}

/// Step 3 of the module text, all under the profile lock.
fn prepare(
    root: &std::path::Path,
    scope: DataScope,
    identity: &MachineIdentity,
    chosen: bool,
) -> Result<(AppPaths, Option<MachineDataPaths>), Failure> {
    let _lock = ProfileLock::acquire(root, DEFAULT_WAIT).map_err(|err| {
        Failure::Profile(DbError::Copy(format!(
            "couldn't lock this computer's profile: {err}"
        )))
    })?;
    let pending = read_pending_import(root).filter(|import| {
        chosen && import.identity_hash == identity.identity_hash() && import.from != scope
    });
    // The per-computer folder is needed for that scope, and as the source of an import back to one profile.
    let machine = if scope == DataScope::PerMachine || pending.is_some() {
        Some(select_profile(root, identity).map_err(|err| {
            Failure::Profile(DbError::Copy(format!(
                "couldn't prepare this computer's profile folder: {err}"
            )))
        })?)
    } else {
        None
    };
    let paths = match (scope, &machine) {
        (DataScope::PerMachine, Some(machine)) => {
            AppPaths::per_machine(root.to_path_buf(), machine.clone())
        }
        _ => AppPaths::from_root(root.to_path_buf()),
    };
    match migrate::prepare_at_start(&paths, machine.as_ref(), pending.as_ref(), now_secs()) {
        Ok(_) => Ok((paths, machine)),
        Err(err) => Err(Failure::Database(Box::new((paths, machine, err)))),
    }
}

/// The paths of the start-up error window when no profile folder could be prepared: its WebView profile and log in a
/// folder of this computer (never the drive's shared `data/webview`), and as "the database" this computer's own
/// would-be database, never the one-profile `data/openmind-studio.db` (the window can offer to back it up).
fn failure_paths(root: &std::path::Path, identity: &MachineIdentity) -> AppPaths {
    let machine = MachineDataPaths::new(root, identity.profile_id());
    let mut paths = AppPaths::per_machine(root.to_path_buf(), machine);
    let local = machine_identity::local_state_dir().unwrap_or_else(std::env::temp_dir);
    paths.webview_dir = local.join("startup-error-webview");
    paths.logs_dir = local.join("logs");
    paths.machine = None;
    paths
}

/// Opens the setup window in place of the workbench.
pub fn show_setup(app: &tauri::App, paths: &AppPaths) -> tauri::Result<()> {
    tauri::WebviewWindowBuilder::new(
        app,
        SETUP_WINDOW_LABEL,
        tauri::WebviewUrl::App("index.html".into()),
    )
    .title("OpenMind Studio")
    .inner_size(720.0, 680.0)
    .min_inner_size(460.0, 420.0)
    .center()
    .data_directory(paths.webview_dir.clone())
    .build()?;
    Ok(())
}

/// What the data-scope page (setup window or workbench dialog) shows. No raw machine identifier is ever here.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScopeStatus {
    /// The scope in force (`None` while it hasn't been chosen).
    pub mode: Option<DataScope>,
    pub recommended: DataScope,
    pub profile_id: String,
    pub identity_source: IdentitySource,
    pub app_folder: String,
    /// The one-profile database (`data/openmind-studio.db`), when it exists.
    pub shared_database: Option<ExistingDatabase>,
    /// This computer's database in the per-computer layout, when it exists.
    pub machine_database: Option<ExistingDatabase>,
    pub profiles: Vec<MachineProfileSummary>,
    pub unreadable: Option<String>,
    pub single_computer: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExistingDatabase {
    pub path: String,
    pub bytes: u64,
}

fn existing(path: &std::path::Path) -> Option<ExistingDatabase> {
    let meta = std::fs::metadata(path)
        .ok()
        .filter(std::fs::Metadata::is_file)?;
    Some(ExistingDatabase {
        path: path.display().to_string(),
        bytes: meta.len(),
    })
}

/// This computer's folder: the selected one, else the one its id would normally name (shown only; never created here).
pub fn machine_folder(runtime: &ScopeRuntime) -> MachineDataPaths {
    runtime.machine.clone().unwrap_or_else(|| {
        MachineDataPaths::new(&runtime.paths.root_dir, runtime.identity.profile_id())
    })
}

pub fn status(runtime: &ScopeRuntime) -> ScopeStatus {
    let root = &runtime.paths.root_dir;
    let machine = machine_folder(runtime);
    ScopeStatus {
        mode: (!runtime.needs_setup).then_some(runtime.paths.scope),
        recommended: if runtime.single_computer {
            DataScope::Personal
        } else {
            DataScope::PerMachine
        },
        profile_id: machine.machine_id.clone(),
        identity_source: runtime.identity.source(),
        app_folder: root.display().to_string(),
        shared_database: existing(&runtime.paths.shared_db_path),
        machine_database: existing(&machine.database),
        profiles: list_profiles(root),
        unreadable: runtime.unreadable.clone(),
        single_computer: runtime.single_computer,
    }
}

fn now_secs() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or_default()
}

#[tauri::command]
pub fn data_scope_status(runtime: State<'_, ScopeRuntime>) -> ScopeStatus {
    status(&runtime)
}

/// The setup window's choice (before any database is open). The page restarts the app afterwards; the import, if any,
/// runs at that start.
#[tauri::command]
pub fn data_scope_setup_apply(
    mode: DataScope,
    use_existing: bool,
    runtime: State<'_, ScopeRuntime>,
) -> Result<ScheduledChange, String> {
    if !runtime.needs_setup {
        return Err("The data scope was already chosen; change it from the workbench.".into());
    }
    migrate::schedule(&runtime, mode, use_existing)
}

/// A change from the workbench, carried out at the next start. Refused while a server runs (MariaDB's files must not be
/// copied while it uses them).
#[tauri::command]
pub fn data_scope_change(
    mode: DataScope,
    use_existing: bool,
    app: AppHandle,
    runtime: State<'_, ScopeRuntime>,
) -> Result<ScheduledChange, String> {
    if runtime.needs_setup {
        return Err("Choose the data scope in the setup window first.".into());
    }
    if mode == runtime.paths.scope {
        return Err("That is already the data scope in use.".into());
    }
    if crate::tray::servers_running(&app) {
        return Err(
            "Stop the PHP and MySQL servers first: their data can't be copied while they run."
                .into(),
        );
    }
    migrate::schedule(&runtime, mode, use_existing)
}

/// Restarts into the scope just saved. From the workbench everything OpenMind started is stopped first, as on a
/// normal close.
#[tauri::command]
pub async fn data_scope_restart(app: AppHandle) {
    if app.try_state::<crate::app_state::AppState>().is_some() {
        crate::window_events::stop_everything(&app).await;
    }
    app.restart();
}

#[tauri::command]
pub fn data_scope_exit(app: AppHandle) {
    app.exit(0);
}

#[cfg(test)]
#[path = "mod_tests.rs"]
mod tests;
