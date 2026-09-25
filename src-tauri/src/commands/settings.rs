use openmind_db::{EditorSettingsRepository, PinnedFolderEntry, PinnedFoldersRepository};
use tauri::State;

use crate::app_state::AppState;

/// Settings that describe one window's workbench rather than a preference:
/// they belong to the main window (restored on launch); an extra editor window
/// neither reads nor overwrites them.
const MAIN_WINDOW_ONLY_KEYS: &[&str] =
    &["editor.layout", "panel.state", "workbench.secondarySideBar"];

fn shared_with(key: &str, label: &str) -> bool {
    !crate::windows::is_editor_window_extra(label) || !MAIN_WINDOW_ONLY_KEYS.contains(&key)
}

#[tauri::command]
pub async fn settings_get(
    key: String,
    window: tauri::Window,
    state: State<'_, AppState>,
) -> Result<Option<String>, String> {
    if !shared_with(&key, window.label()) {
        return Ok(None);
    }
    EditorSettingsRepository::new(state.db.pool())
        .get(&key)
        .await
        .map_err(|err| err.to_string())
}

#[tauri::command]
pub async fn settings_set(
    key: String,
    value: String,
    window: tauri::Window,
    state: State<'_, AppState>,
) -> Result<(), String> {
    if !shared_with(&key, window.label()) {
        return Ok(());
    }
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

#[cfg(test)]
mod tests {
    use super::shared_with;

    #[test]
    fn an_extra_window_keeps_out_of_the_main_windows_workbench_keys() {
        assert!(shared_with("editor.layout", "main"));
        assert!(shared_with("panel.state", "main"));
        assert!(!shared_with("editor.layout", "window-2"));
        assert!(!shared_with("panel.state", "window-2"));
        // Preferences are shared by every window.
        assert!(shared_with("workbench.welcomeOnStartup", "window-2"));
        assert!(shared_with("php.server", "php-server"));
    }
}
