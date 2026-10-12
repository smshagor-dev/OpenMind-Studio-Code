//! App updates from OpenMind Studio's GitHub releases.
//!
//! **Feed**: `plugins.updater.endpoints` = `https://github.com/<repo>/releases/latest/download/latest.json`, which
//! GitHub resolves to the newest *stable* release (never a draft or a pre-release). `scripts/release.mjs` writes that
//! `latest.json` (Tauri's format plus an `openmind` section: `minimumVersion`, `channel`, the signed portable archives)
//! and every installer's `.sig`. The public key is built into the app (`plugins.updater.pubkey`), so a file not signed
//! with OpenMind's release key is refused before anything runs — a SHA-256 published next to the file is never trusted
//! on its own.
//!
//! **Automatic flow** (`scheduler`): a check 45 s after start-up, then every 6 hours, retried with a growing pause after
//! a failure. When a newer stable version exists and `updates.automatic` is on, it is downloaded in the background,
//! verified, and installed when OpenMind is next closed — or at once with Restart to Update, which the UI offers only
//! when no editor has unsaved changes. Nothing ever closes the app by itself.
//!
//! **Mandatory** (`policy::is_mandatory`): only when the release's `openmind.minimumVersion` is newer than this version;
//! the UI then blocks further work behind Save All / Restart to Update — and only once the update is downloaded,
//! verified and installable here, so a missing network or a missing permission never locks anyone out.
//!
//! **Per installation** (`policy::self_update`): installed copies run the signed installer (per-user setup: no
//! administrator rights; MSI: Windows asks); a portable copy swaps its program files at a restart (`portable`); a
//! shared network installation is never changed from one of its computers — they are only told a new version exists.

mod flow;
pub mod policy;
mod portable;
mod scheduler;

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, State};
use tauri_plugin_updater::Update;

use policy::{Failure, SelfUpdate};

pub use flow::install_on_exit;
pub use portable::finish_previous_update;
pub use scheduler::start as start_scheduler;

/// Where release notes and manual downloads live.
pub const RELEASES_PAGE: &str = "https://github.com/smshagor-dev/OpenMind-Studio/releases/latest";
const PROGRESS_EVENT: &str = "update:progress";
const STATE_EVENT: &str = "update:state";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum InstallKind {
    /// Installed by the per-user setup (`uninstall.exe` next to the program).
    Nsis,
    /// Installed by the MSI (under Program Files).
    Msi,
    /// Unzipped anywhere: it can't run an installer over itself.
    Portable,
}

/// How this copy was installed. `program_files` = the Program Files folders; `exists` checks a file.
pub fn install_kind_for(
    exe: &Path,
    program_files: &[PathBuf],
    exists: &dyn Fn(&Path) -> bool,
) -> InstallKind {
    let Some(dir) = exe.parent() else {
        return InstallKind::Portable;
    };
    if exists(&dir.join("uninstall.exe")) {
        return InstallKind::Nsis;
    }
    let lower = |p: &Path| p.to_string_lossy().to_lowercase().replace('/', "\\");
    let exe_dir = lower(dir);
    if program_files.iter().map(|p| lower(p)).any(|root| {
        !root.is_empty() && exe_dir.starts_with(&format!("{}\\", root.trim_end_matches('\\')))
    }) {
        return InstallKind::Msi;
    }
    InstallKind::Portable
}

pub fn install_kind() -> InstallKind {
    let exe = std::env::current_exe().unwrap_or_default();
    let roots: Vec<PathBuf> = ["ProgramFiles", "ProgramW6432", "ProgramFiles(x86)"]
        .iter()
        .filter_map(|name| std::env::var_os(name).map(PathBuf::from))
        .collect();
    install_kind_for(&exe, &roots, &|path| path.is_file())
}

/// Where this copy's update stands.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub enum Phase {
    #[default]
    Idle,
    Checking,
    UpToDate,
    /// A newer version exists (and isn't being downloaded: automatic updates off, or updated by someone else).
    Available,
    Downloading,
    /// Downloaded and verified: installed at the next close or with Restart to Update.
    Ready,
    Installing,
    Failed,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FailureInfo {
    pub kind: Failure,
    pub message: String,
}

/// A downloaded, verified update waiting to be installed.
pub(crate) struct Pending {
    pub(crate) version: String,
    pub(crate) what: PendingKind,
}

pub(crate) enum PendingKind {
    /// The signed installer, written to `file`; `sha256` is what was verified (checked again before it runs).
    Installer {
        update: Box<Update>,
        file: PathBuf,
        sha256: String,
    },
    /// The portable copy's new program files, unpacked and verified.
    Portable(portable::Staged),
}

#[derive(Default)]
pub(crate) struct Status {
    pub(crate) phase: Phase,
    pub(crate) failure: Option<FailureInfo>,
    pub(crate) mandatory: bool,
    pub(crate) last_checked: Option<String>,
    pub(crate) downloaded: u64,
    pub(crate) total: Option<u64>,
}

/// The update found or downloaded in this run (nothing is kept across runs: a later start checks again).
#[derive(Default)]
pub struct UpdateState {
    pub(crate) found: Mutex<Option<Update>>,
    pub(crate) pending: Mutex<Option<Pending>>,
    pub(crate) status: Mutex<Status>,
    pub(crate) install_on_exit: AtomicBool,
    /// A check or download runs (one at a time in this process).
    pub(crate) busy: AtomicBool,
    /// Unsaved editors per window (each window reports its own): an update never starts while any exist.
    pub(crate) unsaved: Mutex<std::collections::HashMap<String, u32>>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateInfo {
    pub current: String,
    pub available: bool,
    pub version: Option<String>,
    pub notes: Option<String>,
    pub date: Option<String>,
    pub install: InstallKind,
    /// How this copy takes updates (installer, portable swap, or managed by someone else with the reason).
    pub mode: SelfUpdate,
    pub phase: Phase,
    /// The found release no longer supports this version.
    pub mandatory: bool,
    /// Downloaded and verified: "Restart to update".
    pub ready: bool,
    pub install_on_exit: bool,
    pub automatic: bool,
    pub downloaded: u64,
    pub total: Option<u64>,
    pub failure: Option<FailureInfo>,
    pub last_checked: Option<String>,
    pub releases_page: String,
    /// What Restart to Update would interrupt: unsaved editors in any window (never closed by an update), open
    /// terminals, terminals running a program, and running programs (Run Code).
    pub activity: Activity,
}

#[derive(Debug, Clone, Copy, Default, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Activity {
    pub unsaved: u32,
    pub terminals: usize,
    pub busy_terminals: usize,
    pub runs: usize,
}

/// The activity of every editor window that is still open.
pub(crate) fn activity(app: &AppHandle) -> Activity {
    let unsaved = app
        .state::<UpdateState>()
        .unsaved
        .lock()
        .map(|windows| {
            windows
                .iter()
                .filter(|(label, _)| app.get_webview_window(label).is_some())
                .map(|(_, count)| *count)
                .sum()
        })
        .unwrap_or(0);
    let (terminals, busy_terminals, runs) = app
        .try_state::<crate::app_state::AppState>()
        .map(|state| {
            let (open, busy) = state.terminal.activity();
            (open, busy, state.runner.active().len())
        })
        .unwrap_or_default();
    Activity {
        unsaved,
        terminals,
        busy_terminals,
        runs,
    }
}

pub(crate) fn mode(app: &AppHandle) -> SelfUpdate {
    let layout = app
        .try_state::<crate::data_scope::ScopeRuntime>()
        .map_or(openmind_core::InstallLayout::Portable, |scope| {
            scope.paths.layout
        });
    policy::self_update(install_kind(), layout)
}

/// `updates.automatic` from the user's settings (on unless turned off).
pub(crate) fn automatic(app: &AppHandle) -> bool {
    let Some(state) = app.try_state::<crate::app_state::AppState>() else {
        return true;
    };
    openmind_settings::store::read_layer(&state.settings_file)
        .values
        .get("updates.automatic")
        .and_then(serde_json::Value::as_bool)
        .unwrap_or(true)
}

pub(crate) fn info(app: &AppHandle, state: &UpdateState) -> UpdateInfo {
    let found = state.found.lock().ok().and_then(|f| f.clone());
    let ready = state.pending.lock().ok().is_some_and(|p| p.is_some());
    let (phase, mandatory, failure, last_checked, downloaded, total) = state
        .status
        .lock()
        .map(|s| {
            (
                s.phase,
                s.mandatory,
                s.failure.clone(),
                s.last_checked.clone(),
                s.downloaded,
                s.total,
            )
        })
        .unwrap_or_default();
    UpdateInfo {
        current: app.package_info().version.to_string(),
        available: found.is_some(),
        version: found.as_ref().map(|u| u.version.clone()),
        notes: found.as_ref().and_then(|u| u.body.clone()),
        date: found.as_ref().and_then(|u| u.date.map(|d| d.to_string())),
        install: install_kind(),
        mode: mode(app),
        phase,
        mandatory,
        ready,
        install_on_exit: state.install_on_exit.load(Ordering::SeqCst),
        automatic: automatic(app),
        downloaded,
        total,
        failure,
        last_checked,
        releases_page: RELEASES_PAGE.into(),
        activity: activity(app),
    }
}

/// Changes the status and tells every window.
pub(crate) fn set_status(app: &AppHandle, change: impl FnOnce(&mut Status)) {
    let state = app.state::<UpdateState>();
    if let Ok(mut status) = state.status.lock() {
        change(&mut status);
    }
    let _ = app.emit(STATE_EVENT, info(app, &state));
}

pub(crate) fn update_dir(app: &AppHandle) -> PathBuf {
    app.state::<crate::app_state::AppState>()
        .paths
        .temp_dir
        .join("update")
}

/// Removes installers downloaded by an earlier run (they are downloaded and verified again when needed).
pub fn clean_stale_downloads(temp_dir: &Path) {
    let _ = std::fs::remove_dir_all(temp_dir.join("update"));
}

/// Asks the release server whether a newer version exists (Help > Check for Updates; nothing is downloaded).
#[tauri::command]
pub async fn update_check(
    app: AppHandle,
    state: State<'_, UpdateState>,
) -> Result<UpdateInfo, String> {
    flow::check(&app).await?;
    Ok(info(&app, &state))
}

/// What is known now (a window that just opened).
#[tauri::command]
pub fn update_status(app: AppHandle, state: State<'_, UpdateState>) -> UpdateInfo {
    info(&app, &state)
}

/// Downloads and verifies the update the last check found.
#[tauri::command]
pub async fn update_download(
    app: AppHandle,
    state: State<'_, UpdateState>,
) -> Result<UpdateInfo, String> {
    flow::download(&app).await?;
    Ok(info(&app, &state))
}

/// "Later" (off) / install at the next close (on).
#[tauri::command]
pub fn update_install_on_exit(enabled: bool, state: State<'_, UpdateState>) {
    state.install_on_exit.store(enabled, Ordering::SeqCst);
}

/// A window tells how many of its editors have unsaved changes (on every change).
#[tauri::command]
pub fn update_report_unsaved(count: u32, window: tauri::Window, state: State<'_, UpdateState>) {
    if let Ok(mut windows) = state.unsaved.lock() {
        windows.insert(window.label().to_string(), count);
    }
}

/// "Restart to Update". Refused while any window has unsaved editors (nothing is ever discarded); with terminals
/// running programs or Run Code runs, only after the user confirmed (`confirmed`) — they are stopped first, as on a
/// normal close. Then installs and starts the new version.
#[tauri::command]
pub async fn update_install_now(app: AppHandle, confirmed: Option<bool>) -> Result<(), String> {
    let now = activity(&app);
    if let Some(reason) = flow::install_blocker(now, confirmed.unwrap_or(false)) {
        return Err(reason);
    }
    flow::install_now(&app).await
}

#[cfg(test)]
#[path = "kind_tests.rs"]
mod tests;
