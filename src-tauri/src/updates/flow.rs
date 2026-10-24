//! Check → download and verify → install, for the update commands and the scheduler.

use std::fs::File;
use std::sync::atomic::Ordering;
use std::time::{Duration, Instant};

use serde::Serialize;
use sha2::{Digest, Sha256};
use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_updater::UpdaterExt;

use super::policy::{self, SelfUpdate};
use super::{
    mode, portable, set_status, update_dir, FailureInfo, Pending, PendingKind, Phase, UpdateState,
    PROGRESS_EVENT, RELEASES_PAGE,
};

fn hex(bytes: &[u8]) -> String {
    Sha256::digest(bytes)
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
}

fn fail(app: &AppHandle, message: String) -> String {
    let kind = policy::classify(&message);
    tracing::warn!(kind = ?kind, %message, "update step failed");
    set_status(app, |s| {
        s.phase = Phase::Failed;
        s.failure = Some(FailureInfo {
            kind,
            message: message.clone(),
        });
    });
    message
}

/// The Tauri updater for the endpoint in tauri.conf.json, through the proxy in force, accepting only a newer stable
/// version (never a pre-release, never a downgrade).
fn updater(app: &AppHandle) -> Result<tauri_plugin_updater::Updater, String> {
    let mut builder = app
        .updater_builder()
        .timeout(Duration::from_secs(60 * 30))
        .version_comparator(|current, release| {
            policy::is_installable_upgrade(&current, &release.version)
        });
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

/// Asks the release feed. `Ok(true)` when a newer stable version was found.
pub(crate) async fn check(app: &AppHandle) -> Result<bool, String> {
    let state = app.state::<UpdateState>();
    if state.pending.lock().ok().is_some_and(|p| p.is_some()) {
        return Ok(true); // already downloaded and verified: nothing to ask
    }
    set_status(app, |s| {
        s.phase = Phase::Checking;
        s.failure = None;
    });
    let found = match updater(app)?.check().await {
        Ok(found) => found,
        Err(err) => return Err(fail(app, format!("Couldn't check for updates: {err}"))),
    };
    // A feed that says it belongs to another channel is not for a stable copy.
    let found = found.filter(|update| {
        policy::feed_extras(&update.raw_json)
            .channel
            .is_none_or(|channel| channel == policy::CHANNEL)
    });
    let current = app.package_info().version.clone();
    let mandatory = found.as_ref().is_some_and(|update| {
        policy::is_mandatory(&current, &policy::feed_extras(&update.raw_json))
    });
    tracing::info!(available = ?found.as_ref().map(|u| u.version.clone()), mandatory, "update check");
    let available = found.is_some();
    if let Ok(mut slot) = state.found.lock() {
        *slot = found;
    }
    set_status(app, |s| {
        s.phase = if available {
            Phase::Available
        } else {
            Phase::UpToDate
        };
        s.mandatory = mandatory;
        s.last_checked = Some(openmind_core::data_scope::rfc3339_now());
    });
    Ok(available)
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct Progress {
    version: String,
    downloaded: u64,
    total: Option<u64>,
}

/// A progress reporter that tells the windows at most four times a second.
fn reporter(app: &AppHandle, version: String) -> impl FnMut(u64, Option<u64>) + Send + 'static {
    let app = app.clone();
    let mut last = Instant::now() - Duration::from_secs(1);
    move |downloaded, total| {
        if last.elapsed() >= Duration::from_millis(250) || Some(downloaded) == total {
            last = Instant::now();
            if let Ok(mut status) = app.state::<UpdateState>().status.lock() {
                status.downloaded = downloaded;
                status.total = total;
            }
            let _ = app.emit(
                PROGRESS_EVENT,
                Progress {
                    version: version.clone(),
                    downloaded,
                    total,
                },
            );
        }
    }
}

/// Downloads the update the last check found and verifies its signature (and, for a portable copy, unpacks it).
pub(crate) async fn download(app: &AppHandle) -> Result<(), String> {
    if let SelfUpdate::Managed(reason) = mode(app) {
        return Err(reason);
    }
    let state = app.state::<UpdateState>();
    if state.pending.lock().ok().is_some_and(|p| p.is_some()) {
        return Ok(());
    }
    let update = state
        .found
        .lock()
        .ok()
        .and_then(|f| f.clone())
        .ok_or("Check for updates first.")?;
    if state.busy.swap(true, Ordering::SeqCst) {
        return Err("The update is already downloading.".into());
    }
    set_status(app, |s| {
        s.phase = Phase::Downloading;
        s.failure = None;
        s.downloaded = 0;
        s.total = None;
    });
    let result = match mode(app) {
        SelfUpdate::Portable => download_portable(app, &update).await,
        _ => download_installer(app, &update).await,
    };
    state.busy.store(false, Ordering::SeqCst);
    let pending = result.map_err(|err| fail(app, err))?;
    tracing::info!(version = %pending.version, "update downloaded and verified");
    if let Ok(mut slot) = state.pending.lock() {
        *slot = Some(pending);
    }
    // Installed at the next close unless the user installs it sooner (or says Later).
    state.install_on_exit.store(true, Ordering::SeqCst);
    set_status(app, |s| s.phase = Phase::Ready);
    Ok(())
}

async fn download_installer(
    app: &AppHandle,
    update: &tauri_plugin_updater::Update,
) -> Result<Pending, String> {
    let mut report = reporter(app, update.version.clone());
    let mut downloaded = 0u64;
    // The plugin checks the minisign signature against the built-in public key before returning the bytes.
    let bytes = update
        .download(
            move |chunk, total| {
                downloaded += chunk as u64;
                report(downloaded, total);
            },
            || {},
        )
        .await
        .map_err(|err| format!("The update couldn't be downloaded or verified: {err}"))?;
    let dir = update_dir(app);
    std::fs::create_dir_all(&dir).map_err(|err| err.to_string())?;
    let file = dir.join(format!("OpenMind-Studio-{}.installer", update.version));
    std::fs::write(&file, &bytes).map_err(|err| err.to_string())?;
    Ok(Pending {
        version: update.version.clone(),
        what: PendingKind::Installer {
            update: Box::new(update.clone()),
            file,
            sha256: hex(&bytes),
        },
    })
}

async fn download_portable(
    app: &AppHandle,
    update: &tauri_plugin_updater::Update,
) -> Result<Pending, String> {
    let root = app
        .state::<crate::app_state::AppState>()
        .paths
        .install_dir
        .clone();
    let pubkey = super::portable::public_key(app)?;
    let request = portable::Request::from_feed(
        &update.raw_json,
        &update.version,
        root,
        update_dir(app),
        pubkey,
    )?;
    let report = reporter(app, update.version.clone());
    let staged = tauri::async_runtime::spawn_blocking(move || {
        portable::download_and_stage(&request, report)
    })
    .await
    .map_err(|err| err.to_string())??;
    Ok(Pending {
        version: update.version.clone(),
        what: PendingKind::Portable(staged),
    })
}

/// One installation at a time per Windows user and copy, also across OpenMind processes: an OS lock on
/// `<temp>/update/.install.lock`, released by the system when this process ends.
fn install_lock(app: &AppHandle) -> Result<File, String> {
    let dir = update_dir(app);
    std::fs::create_dir_all(&dir).map_err(|err| err.to_string())?;
    let file = std::fs::OpenOptions::new()
        .create(true)
        .truncate(false)
        .write(true)
        .open(dir.join(".install.lock"))
        .map_err(|err| err.to_string())?;
    match file.try_lock() {
        Ok(()) => Ok(file),
        Err(std::fs::TryLockError::WouldBlock) => {
            Err("Another OpenMind Studio window is installing this update already.".into())
        }
        Err(std::fs::TryLockError::Error(err)) => Err(err.to_string()),
    }
}

/// Installs the pending update. `restart`: start the new version afterwards.
fn install_pending(app: &AppHandle, restart: bool) -> Result<(), String> {
    let state = app.state::<UpdateState>();
    let _lock = install_lock(app)?;
    let pending = state
        .pending
        .lock()
        .ok()
        .and_then(|mut p| p.take())
        .ok_or("No update has been downloaded.")?;
    tracing::info!(version = %pending.version, restart, "installing the update");
    match pending.what {
        PendingKind::Installer {
            update,
            file,
            sha256,
        } => {
            let bytes = std::fs::read(&file).map_err(|err| err.to_string())?;
            // The file was verified when it was downloaded; it must still be those exact bytes.
            if hex(&bytes) != sha256 {
                return Err("The downloaded update changed on disk after it was verified, so it was not installed. \
                            It will be downloaded again."
                    .into());
            }
            update
                .restart_after_install(restart)
                .install(bytes)
                .map_err(|err| format!("The update couldn't be installed: {err}"))
        }
        PendingKind::Portable(staged) => {
            portable::apply(&staged)?;
            if restart {
                app.restart();
            }
            Ok(())
        }
    }
}

/// Why Restart to Update can't go ahead now, if anything: unsaved editors anywhere (an update never discards work), or
/// running terminals/programs the user hasn't agreed to stop.
pub(crate) fn install_blocker(activity: super::Activity, confirmed: bool) -> Option<String> {
    if activity.unsaved > 0 {
        return Some(format!(
            "{} editor(s) have unsaved changes. Save or close them first (in every OpenMind Studio window); the \
             update is installed when you close the app otherwise.",
            activity.unsaved
        ));
    }
    if !confirmed && (activity.busy_terminals > 0 || activity.runs > 0) {
        return Some(format!(
            "{} terminal(s) are running a program and {} program(s) were started with Run Code. Restarting stops \
             them: confirm first, or wait until they finish.",
            activity.busy_terminals, activity.runs
        ));
    }
    None
}

/// Restart to Update: everything OpenMind started is stopped, then the installer (or the portable swap) runs.
pub(crate) async fn install_now(app: &AppHandle) -> Result<(), String> {
    if !app
        .state::<UpdateState>()
        .pending
        .lock()
        .ok()
        .is_some_and(|p| p.is_some())
    {
        return Err("No update has been downloaded.".into());
    }
    let state = app.state::<crate::app_state::AppState>();
    let _operation = crate::windows::lock_operations(&state).await;
    let _recovery = crate::shutdown_recovery::prepare(app).await?;
    if super::activity(app).unsaved > 0 {
        return Err("An editor changed while preparing the update. Save its changes before restarting.".into());
    }
    set_status(app, |s| s.phase = Phase::Installing);
    crate::window_events::stop_everything(app).await;
    let handle = app.clone();
    let result = tauri::async_runtime::spawn_blocking(move || install_pending(&handle, true))
        .await
        .map_err(|err| err.to_string())?;
    result.map_err(|err| fail(app, err))
}

/// The end of a normal close: installs a downloaded update (unless the user said Later). The installer runs after this
/// process has stopped everything; the next start is the new version.
pub fn install_on_exit(app: &AppHandle) {
    let state = app.state::<UpdateState>();
    if !state.install_on_exit.load(Ordering::SeqCst) {
        return;
    }
    if let Err(err) = install_pending(app, false) {
        tracing::warn!(%err, "the pending update was not installed on exit");
    }
}
