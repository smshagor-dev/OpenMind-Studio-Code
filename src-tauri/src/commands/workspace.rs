use openmind_workspace::{RecentFileInfo, SessionSnapshot};
use tauri::State;

use crate::app_state::AppState;

#[tauri::command]
pub async fn recent_files_list(state: State<'_, AppState>) -> Result<Vec<RecentFileInfo>, String> {
    state
        .recent_files
        .list()
        .await
        .map_err(|err| err.to_string())
}

#[tauri::command]
pub async fn recent_files_clear(state: State<'_, AppState>) -> Result<(), String> {
    state
        .recent_files
        .clear()
        .await
        .map_err(|err| err.to_string())
}

#[tauri::command]
pub async fn session_load(state: State<'_, AppState>) -> Result<SessionSnapshot, String> {
    state.session.load().await.map_err(|err| err.to_string())
}

#[tauri::command]
pub async fn session_save(
    snapshot: SessionSnapshot,
    state: State<'_, AppState>,
) -> Result<(), String> {
    state
        .session
        .save(&snapshot)
        .await
        .map_err(|err| err.to_string())
}
