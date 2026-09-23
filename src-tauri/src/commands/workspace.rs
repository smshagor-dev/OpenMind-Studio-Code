use openmind_workspace::{ExplorerState, RecentFileInfo, SessionSnapshot, WorkspaceInfo};
use tauri::State;

use crate::app_state::AppState;

const RECENT_FOLDERS_LIMIT: i64 = 20;

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

#[tauri::command]
pub async fn workspace_open_folder(
    path: String,
    state: State<'_, AppState>,
) -> Result<WorkspaceInfo, String> {
    state
        .workspace_folder
        .open_folder(&path)
        .await
        .map_err(|err| err.to_string())
}

#[tauri::command]
pub async fn workspace_close_folder(state: State<'_, AppState>) -> Result<(), String> {
    state
        .workspace_folder
        .close_folder()
        .await
        .map_err(|err| err.to_string())
}

#[tauri::command]
pub async fn workspace_recent_folders(
    state: State<'_, AppState>,
) -> Result<Vec<WorkspaceInfo>, String> {
    state
        .workspace_folder
        .recent_folders(RECENT_FOLDERS_LIMIT)
        .await
        .map_err(|err| err.to_string())
}

#[tauri::command]
pub async fn workspace_active_folder(
    state: State<'_, AppState>,
) -> Result<Option<WorkspaceInfo>, String> {
    state
        .workspace_folder
        .active_workspace()
        .await
        .map_err(|err| err.to_string())
}

#[tauri::command]
pub async fn explorer_state_load(
    workspace_path: String,
    state: State<'_, AppState>,
) -> Result<ExplorerState, String> {
    state
        .explorer_state
        .load(&workspace_path)
        .await
        .map_err(|err| err.to_string())
}

#[tauri::command]
pub async fn explorer_state_save(
    workspace_path: String,
    explorer_state: ExplorerState,
    state: State<'_, AppState>,
) -> Result<(), String> {
    state
        .explorer_state
        .save(&workspace_path, &explorer_state)
        .await
        .map_err(|err| err.to_string())
}
