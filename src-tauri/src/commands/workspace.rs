use openmind_workspace::{ExplorerState, RecentFileInfo, SessionSnapshot, WorkspaceInfo};
use tauri::State;

use crate::app_state::AppState;
use crate::windows::{is_main, window_workspace};

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

/// The saved session belongs to the main window; an extra window starts empty.
#[tauri::command]
pub async fn session_load(
    window: tauri::Window,
    state: State<'_, AppState>,
) -> Result<SessionSnapshot, String> {
    if !is_main(window.label()) {
        return Ok(SessionSnapshot::default());
    }
    state.session.load().await.map_err(|err| err.to_string())
}

/// Only the main window's session is saved (an extra window's isn't restored).
#[tauri::command]
pub async fn session_save(
    snapshot: SessionSnapshot,
    window: tauri::Window,
    state: State<'_, AppState>,
) -> Result<(), String> {
    if !is_main(window.label()) {
        return Ok(());
    }
    state
        .session
        .save(&snapshot)
        .await
        .map_err(|err| err.to_string())
}

/// Opens `path` in the calling window. The main window's folder is saved (and
/// restored on launch); an extra window's is only remembered while it is open.
/// Either way the folder joins the recent folders.
#[tauri::command]
pub async fn workspace_open_folder(
    path: String,
    window: tauri::Window,
    state: State<'_, AppState>,
) -> Result<WorkspaceInfo, String> {
    if is_main(window.label()) {
        return state
            .workspace_folder
            .open_folder(&path)
            .await
            .map_err(|err| err.to_string());
    }
    let info = state
        .workspace_folder
        .remember_folder(&path)
        .await
        .map_err(|err| err.to_string())?;
    state
        .editor_windows
        .set_folder(window.label(), Some(info.clone()));
    Ok(info)
}

#[tauri::command]
pub async fn workspace_close_folder(
    window: tauri::Window,
    state: State<'_, AppState>,
) -> Result<(), String> {
    if !is_main(window.label()) {
        state.editor_windows.set_folder(window.label(), None);
        return Ok(());
    }
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

/// The folder open in the calling window (`null` in a new, empty window).
#[tauri::command]
pub async fn workspace_active_folder(
    window: tauri::Window,
    state: State<'_, AppState>,
) -> Result<Option<WorkspaceInfo>, String> {
    window_workspace(&state, window.label()).await
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

/// A file or folder was renamed or moved from the Explorer: the recent-files list follows it.
#[tauri::command]
pub async fn recent_files_rename(
    from: String,
    to: String,
    state: State<'_, AppState>,
) -> Result<(), String> {
    state
        .recent_files
        .rename(&from, &to)
        .await
        .map_err(|err| err.to_string())
}
