use openmind_runtime_manager::{InstallProgress, InstalledVersion, RuntimeStatus};
use tauri::{AppHandle, Emitter, State};

use crate::app_state::AppState;
use crate::commands::php::php_in_use_reason;

const PROGRESS_EVENT: &str = "runtime:progress";
/// Sent after any install/repair/switch/delete, so every window reloads its list.
const CHANGED_EVENT: &str = "runtime:changed";

fn notify_changed(app: &AppHandle) {
    if let Err(err) = app.emit(CHANGED_EVENT, ()) {
        tracing::error!(?err, "failed to emit runtime:changed");
    }
}

// Every error is returned as `user_message()`: what went wrong plus what to
// do about it, so the UI never has to invent recovery advice.

#[tauri::command]
pub async fn runtime_list(state: State<'_, AppState>) -> Result<Vec<RuntimeStatus>, String> {
    state.runtime.list().await.map_err(|err| err.user_message())
}

#[tauri::command]
pub async fn runtime_install(
    kind: String,
    version: Option<String>,
    accept_license: Option<bool>,
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<InstalledVersion, String> {
    // A vendor licence that must be accepted (Android SDK) is checked here too, not only in the UI.
    if let Some(reason) = state
        .runtime
        .registry()
        .get(&kind)
        .ok()
        .and_then(|manifest| manifest.license_blocker(accept_license.unwrap_or(false)))
    {
        return Err(reason);
    }
    let result = state
        .runtime
        .install(&kind, version.as_deref(), progress_sink(app.clone()))
        .await
        .map_err(|err| err.user_message());
    notify_changed(&app);
    result
}

/// Adds an optional part to an installed version (Tcl/Tk for Python 3.14.7): a pinned, checksum-verified download
/// whose files go into that install only. Nothing starts until the user asks for it.
#[tauri::command]
pub async fn runtime_addon_install(
    kind: String,
    version: String,
    addon: String,
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let result = state
        .runtime
        .install_addon(&kind, &version, &addon, progress_sink(app.clone()))
        .await
        .map_err(|err| {
            tracing::warn!(%kind, %version, %addon, error = %err, "runtime add-on install failed");
            err.user_message()
        });
    notify_changed(&app);
    result
}

/// Removes exactly the files an add-on added.
#[tauri::command]
pub async fn runtime_addon_remove(
    kind: String,
    version: String,
    addon: String,
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let result = state
        .runtime
        .remove_addon(&kind, &version, &addon)
        .await
        .map_err(|err| {
            tracing::warn!(%kind, %version, %addon, error = %err, "runtime add-on removal failed");
            err.user_message()
        });
    notify_changed(&app);
    result
}

#[tauri::command]
pub async fn runtime_repair(
    kind: String,
    version: String,
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<bool, String> {
    if let Some(reason) = php_in_use_reason(&state, &kind, &version) {
        return Err(reason);
    }
    let result = state
        .runtime
        .repair(&kind, &version, progress_sink(app.clone()))
        .await
        .map_err(|err| err.user_message());
    notify_changed(&app);
    result
}

#[tauri::command]
pub async fn runtime_set_active(
    kind: String,
    version: String,
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let result = state
        .runtime
        .set_active(&kind, &version)
        .await
        .map_err(|err| err.user_message());
    notify_changed(&app);
    result
}

#[tauri::command]
pub async fn runtime_delete(
    kind: String,
    version: String,
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<(), String> {
    if let Some(reason) = php_in_use_reason(&state, &kind, &version) {
        return Err(reason);
    }
    let result = state
        .runtime
        .delete(&kind, &version)
        .await
        .map_err(|err| err.user_message());
    notify_changed(&app);
    result
}

fn progress_sink(app: AppHandle) -> openmind_runtime_manager::manager::ProgressSink {
    std::sync::Arc::new(move |progress: InstallProgress| {
        if let Err(err) = app.emit(PROGRESS_EVENT, progress) {
            tracing::error!(?err, "failed to emit runtime progress event");
        }
    })
}
