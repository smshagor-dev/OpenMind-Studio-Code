use openmind_settings::ThemeKind;
use tauri::State;

use crate::app_state::AppState;

#[tauri::command]
pub async fn theme_get(state: State<'_, AppState>) -> Result<ThemeKind, String> {
    state.theme.get().await.map_err(|err| err.to_string())
}

#[tauri::command]
pub async fn theme_set(theme: ThemeKind, state: State<'_, AppState>) -> Result<(), String> {
    state.theme.set(theme).await.map_err(|err| err.to_string())
}
