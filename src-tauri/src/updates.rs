//! App updates from the GitHub releases of OpenMind Studio (`plugins.updater` in tauri.conf.json: the endpoint serves
//! `latest.json`, and every installer must carry a signature made with the release key — the public key is built into
//! the app, so a tampered or foreign installer is refused before anything runs).
//!
//! Flow (driven by `UpdateService` in the UI): check -> download in the background (installed copies only) ->
//! "Restart to update" -> OpenMind stops everything it started (terminals, servers, language servers ...), the installer
//! runs silently (per-user NSIS setup: no administrator rights; MSI: Windows asks) and the app starts again. "Later"
//! installs it when OpenMind is next closed. A portable copy can't replace itself: it is only told a new version exists.
//! The check goes through the proxy in force, like every other request OpenMind makes.

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, State};
use tauri_plugin_updater::{Update, UpdaterExt};

use crate::app_state::AppState;

/// Where release notes and manual downloads live (portable copies).
pub const RELEASES_PAGE: &str = "https://github.com/smshagor-dev/OpenMind-Studio/releases/latest";
const PROGRESS_EVENT: &str = "update:progress";

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

struct Pending {
    update: Update,
    file: PathBuf,
}

/// The update found or downloaded in this run (nothing is kept across runs).
#[derive(Default)]
pub struct UpdateState {
    found: Mutex<Option<Update>>,
    pending: Mutex<Option<Pending>>,
    install_on_exit: AtomicBool,
    downloading: AtomicBool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateInfo {
    pub current: String,
    pub available: bool,
    pub version: Option<String>,
    pub notes: Option<String>,
    pub date: Option<String>,
    pub install: InstallKind,
    /// Downloaded and ready: "Restart to update".
    pub ready: bool,
    pub install_on_exit: bool,
    pub releases_page: String,
}

fn info(app: &AppHandle, state: &UpdateState, update: Option<&Update>) -> UpdateInfo {
    let ready = state.pending.lock().ok().is_some_and(|p| p.is_some());
    UpdateInfo {
        current: app.package_info().version.to_string(),
        available: update.is_some(),
        version: update.map(|u| u.version.clone()),
        notes: update.and_then(|u| u.body.clone()),
        date: update.and_then(|u| u.date.map(|d| d.to_string())),
        install: install_kind(),
        ready,
        install_on_exit: state.install_on_exit.load(Ordering::SeqCst),
        releases_page: RELEASES_PAGE.into(),
    }
}

fn update_dir(app: &AppHandle) -> PathBuf {
    app.state::<AppState>().paths.temp_dir.join("update")
}

/// Removes installers downloaded by an earlier run (they are downloaded again when needed).
pub fn clean_stale_downloads(temp_dir: &Path) {
    let _ = std::fs::remove_dir_all(temp_dir.join("update"));
}

fn updater(app: &AppHandle) -> Result<tauri_plugin_updater::Updater, String> {
    let mut builder = app.updater_builder().timeout(Duration::from_secs(60 * 30));
    match openmind_network::http::proxy_url(RELEASES_PAGE) {
        openmind_network::http::ProxyUrl::Unchanged => {}
        openmind_network::http::ProxyUrl::Direct => builder = builder.no_proxy(),
        openmind_network::http::ProxyUrl::Via(url) => {
            if let Ok(url) = url.parse() {
                builder = builder.proxy(url);
            }
        }
    }
    builder.build().map_err(|err| err.to_string())
}

/// Asks the release server whether a newer version exists (nothing is downloaded).
#[tauri::command]
pub async fn update_check(
    app: AppHandle,
    state: State<'_, UpdateState>,
) -> Result<UpdateInfo, String> {
    let found = updater(&app)?
        .check()
        .await
        .map_err(|err| format!("Couldn't check for updates: {err}"))?;
    if let Ok(mut slot) = state.found.lock() {
        slot.clone_from(&found);
    }
    tracing::info!(available = ?found.as_ref().map(|u| u.version.clone()), "update check");
    Ok(info(&app, &state, found.as_ref()))
}

/// What is known now (after a reload of the UI).
#[tauri::command]
pub fn update_status(app: AppHandle, state: State<'_, UpdateState>) -> UpdateInfo {
    let found = state.found.lock().ok().and_then(|f| f.clone());
    info(&app, &state, found.as_ref())
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct Progress {
    version: String,
    downloaded: u64,
    total: Option<u64>,
}

/// Downloads the update found by the last check and verifies its signature; installed copies only.
#[tauri::command]
pub async fn update_download(
    app: AppHandle,
    state: State<'_, UpdateState>,
) -> Result<UpdateInfo, String> {
    if install_kind() == InstallKind::Portable {
        return Err("This portable copy can't update itself: download the new version from the releases page.".into());
    }
    let update = state
        .found
        .lock()
        .ok()
        .and_then(|f| f.clone())
        .ok_or("Check for updates first.")?;
    if state.downloading.swap(true, Ordering::SeqCst) {
        return Err("The update is already downloading.".into());
    }
    let (sink, version) = (app.clone(), update.version.clone());
    let mut downloaded = 0u64;
    let mut last = Instant::now();
    let result = update
        .download(
            move |chunk, total| {
                downloaded += chunk as u64;
                if last.elapsed() >= Duration::from_millis(250) || Some(downloaded) == total {
                    last = Instant::now();
                    let _ = sink.emit(
                        PROGRESS_EVENT,
                        Progress {
                            version: version.clone(),
                            downloaded,
                            total,
                        },
                    );
                }
            },
            || {},
        )
        .await;
    state.downloading.store(false, Ordering::SeqCst);
    let bytes = result.map_err(|err| format!("The update couldn't be downloaded: {err}"))?;
    let dir = update_dir(&app);
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).map_err(|err| err.to_string())?;
    let file = dir.join(format!("OpenMind-Studio-{}.installer", update.version));
    std::fs::write(&file, &bytes).map_err(|err| err.to_string())?;
    tracing::info!(version = %update.version, bytes = bytes.len(), "update downloaded and verified");
    if let Ok(mut slot) = state.pending.lock() {
        *slot = Some(Pending {
            update: update.clone(),
            file,
        });
    }
    Ok(info(&app, &state, Some(&update)))
}

/// "Later": install the downloaded update when OpenMind is next closed (without starting it again).
#[tauri::command]
pub fn update_install_on_exit(enabled: bool, state: State<'_, UpdateState>) {
    state.install_on_exit.store(enabled, Ordering::SeqCst);
}

/// Runs the installer of the pending update; on success the process exits (the installer replaces the files).
fn install_pending(state: &UpdateState, restart: bool) -> Result<(), String> {
    let pending = state
        .pending
        .lock()
        .ok()
        .and_then(|mut p| p.take())
        .ok_or("No update has been downloaded.")?;
    let bytes = std::fs::read(&pending.file).map_err(|err| err.to_string())?;
    tracing::info!(version = %pending.update.version, restart, "installing the update");
    pending
        .update
        .restart_after_install(restart)
        .install(bytes)
        .map_err(|err| format!("The update couldn't be installed: {err}"))
}

/// "Restart Now": stops everything OpenMind started, then runs the installer, which starts OpenMind again.
#[tauri::command]
pub async fn update_install_now(app: AppHandle) -> Result<(), String> {
    if !app
        .state::<UpdateState>()
        .pending
        .lock()
        .ok()
        .is_some_and(|p| p.is_some())
    {
        return Err("No update has been downloaded.".into());
    }
    crate::window_events::stop_everything(&app).await;
    let handle = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
        install_pending(&handle.state::<UpdateState>(), true)
    })
    .await
    .map_err(|err| err.to_string())?
}

/// Called at the end of a normal close: installs a pending update the user put off ("Later").
pub fn install_on_exit(app: &AppHandle) {
    let state = app.state::<UpdateState>();
    if !state.install_on_exit.load(Ordering::SeqCst) {
        return;
    }
    if let Err(err) = install_pending(&state, false) {
        tracing::warn!(%err, "the pending update was not installed on exit");
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn kind(exe: &str, files: &[&str]) -> InstallKind {
        let roots = [
            PathBuf::from(r"C:\Program Files"),
            PathBuf::from(r"C:\Program Files (x86)"),
        ];
        let files: Vec<PathBuf> = files.iter().map(PathBuf::from).collect();
        install_kind_for(Path::new(exe), &roots, &|path| {
            files.iter().any(|f| f == path)
        })
    }

    #[test]
    fn the_setup_msi_and_portable_copies_are_told_apart() {
        let nsis = r"C:\Users\Ivan\AppData\Local\OpenMind Studio\OpenMindStudio.exe";
        assert_eq!(
            kind(
                nsis,
                &[r"C:\Users\Ivan\AppData\Local\OpenMind Studio\uninstall.exe"]
            ),
            InstallKind::Nsis
        );
        assert_eq!(
            kind(r"C:\Program Files\OpenMind Studio\OpenMindStudio.exe", &[]),
            InstallKind::Msi
        );
        assert_eq!(
            kind(r"c:\program files\OpenMind Studio\OpenMindStudio.exe", &[]),
            InstallKind::Msi
        );
        assert_eq!(
            kind(r"E:\Tools\OpenMind Studio\OpenMindStudio.exe", &[]),
            InstallKind::Portable
        );
        // A folder that only starts like Program Files is not it.
        assert_eq!(
            kind(r"C:\Program FilesX\OpenMind Studio\OpenMindStudio.exe", &[]),
            InstallKind::Portable
        );
        assert_eq!(kind("OpenMindStudio.exe", &[]), InstallKind::Portable);
    }

    #[test]
    fn stale_downloads_are_removed() {
        let tmp = tempfile::tempdir().expect("tmp");
        let dir = tmp.path().join("temp").join("update");
        std::fs::create_dir_all(&dir).expect("dir");
        std::fs::write(dir.join("OpenMind-Studio-9.9.9.installer"), b"x").expect("write");
        clean_stale_downloads(&tmp.path().join("temp"));
        assert!(!dir.exists());
        assert!(
            tmp.path().join("temp").exists(),
            "only the update folder goes"
        );
    }
}
