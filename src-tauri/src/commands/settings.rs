use openmind_db::{EditorSettingsRepository, PinnedFolderEntry, PinnedFoldersRepository};
use tauri::State;

use crate::app_state::AppState;

#[tauri::command]
pub async fn settings_get(
    key: String,
    state: State<'_, AppState>,
) -> Result<Option<String>, String> {
    EditorSettingsRepository::new(state.db.pool())
        .get(&key)
        .await
        .map_err(|err| err.to_string())
}

#[tauri::command]
pub async fn settings_set(
    key: String,
    value: String,
    state: State<'_, AppState>,
) -> Result<(), String> {
    EditorSettingsRepository::new(state.db.pool())
        .set(&key, &value)
        .await
        .map_err(|err| err.to_string())
}

#[tauri::command]
pub async fn workspace_pin_folder(
    path: String,
    label: Option<String>,
    state: State<'_, AppState>,
) -> Result<(), String> {
    PinnedFoldersRepository::new(state.db.pool())
        .pin(&path, label.as_deref())
        .await
        .map_err(|err| err.to_string())
}

#[tauri::command]
pub async fn workspace_unpin_folder(
    path: String,
    state: State<'_, AppState>,
) -> Result<(), String> {
    PinnedFoldersRepository::new(state.db.pool())
        .unpin(&path)
        .await
        .map_err(|err| err.to_string())
}

#[tauri::command]
pub async fn workspace_list_pinned_folders(
    state: State<'_, AppState>,
) -> Result<Vec<PinnedFolderEntry>, String> {
    PinnedFoldersRepository::new(state.db.pool())
        .list()
        .await
        .map_err(|err| err.to_string())
}
