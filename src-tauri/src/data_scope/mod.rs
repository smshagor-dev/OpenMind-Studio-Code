//! The portable data scope at start-up and its commands (see `openmind_core::data_scope` and `docs/data-scope.md`).
//!
//! [`resolve`] runs first in `main`, before logging, the database, the WebView or any service:
//!
//! 1. the app folder ([`AppPaths::resolve`]), **how it was installed** (`install.json`, written only by the installers;
//!    see `openmind_core::install`) and this computer's identity (`machine_identity::resolve`: read from the computer
//!    itself, never from the drive). The per-machine install (Program Files) and a network installation keep every
//!    computer's and Windows user's state on that computer ([`local`]) and never show the setup window;
//! 2. the saved choice (`data/data-scope.json`, read with retries); a portable copy that never chose opens the **setup
//!    window** ([`SETUP_WINDOW_LABEL`]) instead of the workbench. A choice once made is never asked again: when the
//!    file is missing or can't be read, this computer's record of it (`install-state.json` in its local folder), then
//!    its own per-computer profile on the drive decide ([`decide`]);
//! 3. under the OS profile lock (`openmind_core::profile_lock`): this computer's folder (`select_profile`, which checks
//!    `machine.json`'s hash and steps around a prefix collision) and the database's preparation (`migrate::prepare_at_start`:
//!    an import the user asked for, or the recovery of an interrupted one);
//! 4. `main` opens the database at [`AppPaths::db_path`] — never anything else.
//!
//! Installed copies (the per-user setup, the MSI) and a Linux copy that keeps its data in the user's folder belong to one
//! computer and keep the one-profile layout without asking. The choice is made only there, at the first start (or by the
//! installer): the workbench offers no way to change it.

mod local;
pub mod migrate;

use std::path::PathBuf;

use openmind_core::data_scope::{read_choice, read_pending_import, ScopeChoice};
use openmind_core::install;
use openmind_core::machine_identity::{self, IdentitySource};
use openmind_core::machine_paths::{
    find_own_profile, list_profiles, select_profile, MachineDataPaths, MachineProfileSummary,
};
use openmind_core::profile_lock::{ProfileLock, DEFAULT_WAIT};
use openmind_core::session_guard::{self, Claim, SessionGuard};
use openmind_core::{AppPaths, CoreError, DataScope, InstallLayout, MachineIdentity};
use openmind_db::DbError;
use serde::Serialize;
use tauri::{AppHandle, State};

use migrate::ScheduledChange;

/// The setup window's label; `main.tsx` shows the data-scope page for it.
pub const SETUP_WINDOW_LABEL: &str = "data-scope-setup";

/// What start-up decided, kept until the log file exists ([`resolve`] runs before logging starts; `main` writes these
/// with [`log_start_notes`]).
static START_NOTES: std::sync::Mutex<Vec<String>> = std::sync::Mutex::new(Vec::new());

pub(crate) fn note(text: impl Into<String>) {
    if let Ok(mut notes) = START_NOTES.lock() {
        notes.push(text.into());
    }
}

/// Writes the notes [`resolve`] collected into the (now open) log.
pub fn log_start_notes() {
    let notes = START_NOTES
        .lock()
        .map(|mut notes| std::mem::take(&mut *notes))
        .unwrap_or_default();
    for text in notes {
        tracing::info!(target: "openmind_studio::data_scope", "{text}");
    }
}

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
    /// This installation's folder on this computer (its start record; the whole profile in the installer-managed layouts).
    pub local_dir: Option<PathBuf>,
    /// The program runs from a temporary folder (a ZIP opened without extracting it): nothing chosen here would last.
    pub temporary_folder: bool,
    /// This computer's claim on the database for the life of the process (`openmind_core::session_guard`): kept here
    /// because this state lives until the app exits.
    pub _session: Option<SessionGuard>,
}

/// Facts [`decide`] works from.
#[derive(Debug, Clone)]
pub struct ScopeFacts {
    pub choice: ScopeChoice,
    /// The data folder is the program's folder (not `~/.local/share/...`).
    pub portable_root: bool,
    /// Installed by the per-user setup or the MSI.
    pub installed: bool,
    /// The scope this computer recorded for this folder the last time it started (`install-state.json`, on this
    /// computer's own disk).
    pub remembered: Option<DataScope>,
    /// This computer's own profile with a database exists in `data/machines/` (an earlier per-computer choice).
    pub own_profile: bool,
}

/// What start-up does about the data scope.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Decision {
    /// Start in this scope. `restore`: `data/data-scope.json` was missing and is written again with it.
    Use { scope: DataScope, restore: bool },
    /// Nothing says which scope was chosen: the setup window asks.
    Ask,
    /// The saved choice couldn't be read and nothing else says what it was: start-up stops with this reason instead
    /// of asking again (a second choice would overwrite the first one).
    Fail(String),
}

/// The scope to start in. A completed choice is never asked again: when `data/data-scope.json` is missing, damaged or
/// can't be read for a moment, this computer's own record of it, then the presence of its per-computer profile, decide.
pub fn decide(facts: &ScopeFacts) -> Decision {
    let evidence = facts
        .remembered
        .or(facts.own_profile.then_some(DataScope::PerMachine));
    match (&facts.choice, evidence) {
        (ScopeChoice::Chosen(scope), _) => Decision::Use {
            scope: *scope,
            restore: false,
        },
        _ if !facts.portable_root || facts.installed => Decision::Use {
            scope: DataScope::Personal,
            restore: false,
        },
        (ScopeChoice::NotChosen, Some(scope)) => Decision::Use { scope, restore: true },
        (ScopeChoice::Unreadable(_) | ScopeChoice::Inaccessible(_), Some(scope)) => Decision::Use {
            scope,
            restore: false,
        },
        (ScopeChoice::NotChosen | ScopeChoice::Unreadable(_), None) => Decision::Ask,
        (ScopeChoice::Inaccessible(reason), None) => Decision::Fail(format!(
            "The saved data scope ({}) couldn't be read: {reason}. Nothing was changed. If OpenMind Studio runs from a \
             network folder or a USB drive, check that it is reachable and start it again.",
            openmind_core::data_scope::SCOPE_FILE
        )),
    }
}

/// The program's own folder.
fn exe_dir_or(fallback: &std::path::Path) -> PathBuf {
    std::env::current_exe()
        .ok()
        .and_then(|exe| exe.parent().map(PathBuf::from))
        .unwrap_or_else(|| fallback.to_path_buf())
}

/// How this copy was installed: `install.json` (written by the installers), else inferred (see
/// `openmind_core::install::infer_layout`).
fn layout_of(exe_dir: &std::path::Path) -> InstallLayout {
    match install::read(exe_dir) {
        install::InstallRecord::Found(meta) => return meta.layout,
        install::InstallRecord::Unreadable(reason) => {
            note(format!(
                "install.json can't be used ({reason}); the installation layout is inferred"
            ));
        }
        install::InstallRecord::Missing => {}
    }
    // This computer started this installation before: the layout the installer set then still holds (a missing or
    // unreadable install.json must never turn a network installation into a portable copy that asks again).
    if let Some(remembered) = install::local_install_dir(exe_dir)
        .as_deref()
        .and_then(install::read_state)
        .map(|state| state.layout)
        .filter(|layout| layout.installer_managed())
    {
        note(format!(
            "install.json is missing or unreadable; the layout this computer recorded ({}) is used",
            remembered.label()
        ));
        return remembered;
    }
    let hint = match crate::updates::install_kind() {
        crate::updates::InstallKind::Nsis => install::InstallerHint::Nsis,
        crate::updates::InstallKind::Msi => install::InstallerHint::Msi,
        crate::updates::InstallKind::Portable => install::InstallerHint::Portable,
    };
    install::infer_layout(hint, install::is_remote_path(exe_dir))
}

/// Resolves the app folder, this computer's profile and the scope, and prepares the database. Fails only when the app
/// folder itself can't be found; every other problem becomes [`ScopeRuntime::failure`].
pub fn resolve() -> Result<ScopeRuntime, CoreError> {
    let base = AppPaths::resolve()?;
    let exe_dir = exe_dir_or(&base.root_dir);
    let layout = layout_of(&exe_dir);
    let identity = machine_identity::resolve(&base.root_dir);
    let local_dir = install::local_install_dir(&exe_dir);
    let temporary_folder = install::runs_from_temporary_folder(&exe_dir, &std::env::temp_dir());
    if temporary_folder {
        note(format!("OpenMind Studio runs from a temporary folder ({}): a ZIP that wasn't extracted? Its data won't last", exe_dir.display()));
    }
    if layout.local_state() {
        return Ok(local::resolve(layout, exe_dir, identity, local_dir));
    }
    let portable_root = exe_dir == base.root_dir;
    let facts = ScopeFacts {
        choice: read_choice(&base.root_dir),
        portable_root,
        installed: layout != InstallLayout::Portable,
        remembered: local_dir
            .as_deref()
            .and_then(install::read_state)
            .and_then(|state| state.data_scope),
        own_profile: portable_root && find_own_profile(&base.root_dir, &identity).is_some(),
    };
    let unreadable = match &facts.choice {
        ScopeChoice::Unreadable(reason) | ScopeChoice::Inaccessible(reason) => Some(reason.clone()),
        _ => None,
    };
    let decision = decide(&facts);
    note(format!("layout {}; data scope decided: {decision:?} (saved choice {:?}, this computer remembers {:?}, own profile on the drive: {})", layout.label(), facts.choice, facts.remembered, facts.own_profile));
    let single_computer = !facts.portable_root || facts.installed;
    let (decided, refused) = match &decision {
        Decision::Use { scope, restore } => {
            if *restore {
                restore_choice(&base.root_dir, *scope);
            }
            (Some(*scope), None)
        }
        Decision::Ask => (None, None),
        Decision::Fail(reason) => (None, Some(DbError::Copy(reason.clone()))),
    };
    // While the user decides, logs and the page's WebView profile go to this computer's folder.
    let scope = decided.unwrap_or(DataScope::PerMachine);
    let (mut paths, machine, mut failure) = match refused {
        Some(err) => (failure_paths(&base.root_dir, &identity), None, Some(err)),
        None => match prepare(&base.root_dir, scope, &identity, decided.is_some()) {
            Ok((paths, machine)) => (paths, machine, None),
            // The database step failed: the error window names (and can only back up) this profile's own database.
            Err(Failure::Database(failed)) => {
                let (paths, machine, err) = *failed;
                (paths, machine, Some(err))
            }
            Err(Failure::Profile(err)) => {
                (failure_paths(&base.root_dir, &identity), None, Some(err))
            }
        },
    };
    // The data next to the program can be reached by other computers (a shared folder): only one may use it at a time.
    let session = if decided.is_some() && failure.is_none() {
        claim_session(&paths, &mut failure)
    } else {
        None
    };
    if matches!(failure, Some(DbError::InUseElsewhere)) {
        // The other computer has this profile's WebView and log open: the error window uses this computer's own.
        let local = machine_identity::local_state_dir().unwrap_or_else(std::env::temp_dir);
        paths.webview_dir = local.join("startup-error-webview");
        paths.logs_dir = local.join("logs");
    }
    let runtime = ScopeRuntime {
        paths: paths.with_layout(layout),
        machine,
        identity,
        needs_setup: decided.is_none() && failure.is_none(),
        unreadable,
        single_computer,
        failure,
        local_dir,
        temporary_folder,
        _session: session,
    };
    if !runtime.needs_setup && runtime.failure.is_none() {
        remember_start(&runtime);
    }
    Ok(runtime)
}

/// Claims the database's folder for this computer (see `openmind_core::session_guard`); another computer using it right
/// now becomes the start-up failure.
fn claim_session(paths: &AppPaths, failure: &mut Option<DbError>) -> Option<SessionGuard> {
    let dir = paths.db_path.parent()?;
    match session_guard::claim(dir) {
        Claim::Owner(guard) => Some(guard),
        Claim::SameComputer => None,
        Claim::OtherComputer => {
            note(format!(
                "{} is open on another computer; it isn't opened here",
                paths.db_path.display()
            ));
            *failure = Some(DbError::InUseElsewhere);
            None
        }
        Claim::Unguarded(reason) => {
            note(format!("one-computer guard not available here ({reason})"));
            None
        }
    }
}

/// Writes the choice back when `data/data-scope.json` went missing (a copied-over folder): the next start, on any
/// computer, finds it again. A failure only means this computer's record decides again next time.
fn restore_choice(root: &std::path::Path, scope: DataScope) {
    match openmind_core::data_scope::write_choice(root, scope, None) {
        Ok(()) => note(format!(
            "data/data-scope.json was missing; the earlier choice ({}) was restored",
            scope.label()
        )),
        Err(err) => note(format!(
            "couldn't restore data/data-scope.json ({err}); this computer's record is used"
        )),
    }
}

/// Records this start on this computer (see `openmind_core::install::InstallState`). A portable copy used by one
/// person (one profile) writes nothing outside its folder, as always; a multi-computer copy and an installed one leave
/// this small record, so a moment when the drive's own file can't be read never brings the setup back.
pub fn remember_start(runtime: &ScopeRuntime) {
    // An installed copy tells the setup programs where it is, so the next setup updates this folder in place. Never in
    // tests: their installer-managed layouts live in temporary folders, and the record is the real user's registry.
    #[cfg(windows)]
    if runtime.paths.layout.installer_managed() && !cfg!(test) {
        if let Err(err) = crate::commands::integration::remember_installation(
            &runtime.paths.install_dir,
            env!("CARGO_PKG_VERSION"),
        ) {
            note(format!("couldn't note this installation for setup: {err}"));
        }
    }
    let Some(local) = &runtime.local_dir else {
        return;
    };
    let scope = (!runtime.needs_setup).then_some(runtime.paths.scope);
    if !runtime.paths.layout.installer_managed() && scope != Some(DataScope::PerMachine) {
        return;
    }
    if let Err(err) = install::record_start(
        local,
        &runtime.paths.install_dir,
        runtime.paths.layout,
        scope,
        env!("CARGO_PKG_VERSION"),
    ) {
        note(format!(
            "couldn't record this start on this computer: {err}"
        ));
    }
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
pub(super) fn failure_paths(root: &std::path::Path, identity: &MachineIdentity) -> AppPaths {
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
    /// How this copy was installed (`portable`, `perUser`, `perMachine`, `network`).
    pub layout: InstallLayout,
    /// Set by the installer: shown, not changeable here.
    pub managed: bool,
    /// This computer's local folder for this installation (the managed layouts keep their data there).
    pub local_folder: Option<String>,
    /// The program runs from a temporary folder (a ZIP opened without extracting it).
    pub temporary_folder: bool,
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
        layout: runtime.paths.layout,
        managed: runtime.paths.layout.local_state(),
        local_folder: runtime
            .local_dir
            .as_ref()
            .filter(|_| runtime.paths.layout.local_state())
            .map(|dir| dir.display().to_string()),
        temporary_folder: runtime.temporary_folder,
    }
}

pub(super) fn now_secs() -> u64 {
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
        return Err("The data scope was already chosen at the first start.".into());
    }
    migrate::schedule(&runtime, mode, use_existing)
}

/// Restarts into the scope just chosen (the setup window runs before anything else was started).
#[tauri::command]
pub fn data_scope_restart(app: AppHandle) {
    app.restart();
}

#[tauri::command]
pub fn data_scope_exit(app: AppHandle) {
    app.exit(0);
}

#[cfg(test)]
#[path = "mod_tests.rs"]
mod tests;
