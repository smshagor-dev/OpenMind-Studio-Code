use openmind_runtime_manager::{InstallProgress, InstalledVersion, RuntimeStatus};
use tauri::{AppHandle, Emitter, State};

use crate::app_state::AppState;

const PROGRESS_EVENT: &str = "runtime:progress";

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
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<InstalledVersion, String> {
    state
        .runtime
        .install(&kind, version.as_deref(), progress_sink(app))
        .await
        .map_err(|err| err.user_message())
}

#[tauri::command]
pub async fn runtime_repair(
    kind: String,
    version: String,
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<bool, String> {
    state
        .runtime
        .repair(&kind, &version, progress_sink(app))
        .await
        .map_err(|err| err.user_message())
}

#[tauri::command]
pub async fn runtime_set_active(
    kind: String,
    version: String,
    state: State<'_, AppState>,
) -> Result<(), String> {
    state
        .runtime
        .set_active(&kind, &version)
        .await
        .map_err(|err| err.user_message())
}

#[tauri::command]
pub async fn runtime_delete(
    kind: String,
    version: String,
    state: State<'_, AppState>,
) -> Result<(), String> {
    state
        .runtime
        .delete(&kind, &version)
        .await
        .map_err(|err| err.user_message())
}

fn progress_sink(app: AppHandle) -> openmind_runtime_manager::manager::ProgressSink {
    std::sync::Arc::new(move |progress: InstallProgress| {
        if let Err(err) = app.emit(PROGRESS_EVENT, progress) {
            tracing::error!(?err, "failed to emit runtime progress event");
        }
    })
}
