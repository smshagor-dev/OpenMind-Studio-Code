use std::path::{Path, PathBuf};

use openmind_settings::{
    keybindings, schema, store, EffectiveSetting, Issue, KeybindingEntry, KeybindingsFile, Layer,
    SettingDef, Source,
};
use serde::Serialize;
use serde_json::Value;
use tauri::State;

use crate::app_state::AppState;
use crate::windows::window_workspace;

/// The folder inside a workspace that holds its settings, like VS Code's `.vscode`.
const WORKSPACE_DIR: &str = ".openmind";
const WORKSPACE_FILE: &str = "settings.json";

pub fn workspace_settings_path(folder: &Path) -> PathBuf {
    folder.join(WORKSPACE_DIR).join(WORKSPACE_FILE)
}

/// Everything the Settings page needs in one answer, so it never mixes two moments.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PreferencesSnapshot {
    definitions: Vec<SettingDef>,
    categories: Vec<&'static str>,
    values: Vec<EffectiveSetting>,
    /// The open folder of the asking window; `None` means there are no workspace settings to edit.
    workspace: Option<String>,
    user_file: String,
    workspace_file: Option<String>,
    /// Ids that the user file / the workspace file set to an accepted value (so "reset" has something to do).
    user_set: Vec<String>,
    workspace_set: Vec<String>,
    user_error: Option<String>,
    workspace_error: Option<String>,
    user_issues: Vec<Issue>,
    workspace_issues: Vec<Issue>,
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Scope {
    User,
    Workspace,
}

fn parse_scope(scope: &str) -> Result<Scope, String> {
    match scope {
        "user" => Ok(Scope::User),
        "workspace" => Ok(Scope::Workspace),
        other => Err(format!("Unknown settings scope \"{other}\".")),
    }
}

async fn open_folder(state: &AppState, window: &tauri::Window) -> Result<Option<PathBuf>, String> {
    Ok(window_workspace(state, window.label())
        .await?
        .map(|workspace| PathBuf::from(workspace.path)))
}

async fn scope_path(
    state: &AppState,
    window: &tauri::Window,
    scope: Scope,
) -> Result<PathBuf, String> {
    match scope {
        Scope::User => Ok(state.settings_file.clone()),
        Scope::Workspace => open_folder(state, window)
            .await?
            .map(|folder| workspace_settings_path(&folder))
            .ok_or_else(|| "Open a folder to use workspace settings.".to_string()),
    }
}

/// The theme the previous versions saved in the `theme` table counts as the default until the
/// user picks one in the settings file, so an existing choice isn't lost.
async fn with_legacy_theme(
    state: &AppState,
    user: &Layer,
    mut values: Vec<EffectiveSetting>,
) -> Vec<EffectiveSetting> {
    if user.values.contains_key("workbench.colorTheme") {
        return values;
    }
    if let Ok(legacy) = state.theme.get().await {
        let name = serde_json::to_value(legacy).unwrap_or(Value::Null);
        for entry in values
            .iter_mut()
            .filter(|entry| entry.id == "workbench.colorTheme" && entry.source == Source::Default)
        {
            entry.value = name.clone();
        }
    }
    values
}

/// The ids a file sets to a value that is accepted for that file.
fn accepted_ids(layer: &Layer, workspace: bool) -> Vec<String> {
    schema::definitions()
        .into_iter()
        .filter(|def| !workspace || def.scope == openmind_settings::SettingScope::Both)
        .filter(|def| {
            layer
                .values
                .get(def.id)
                .is_some_and(|value| schema::validate(def, value).is_ok())
        })
        .map(|def| def.id.to_string())
        .collect()
}

async fn snapshot(state: &AppState, window: &tauri::Window) -> Result<PreferencesSnapshot, String> {
    let user = store::read_layer(&state.settings_file);
    let folder = open_folder(state, window).await?;
    let workspace_file = folder.as_deref().map(workspace_settings_path);
    let workspace = workspace_file.as_deref().map(store::read_layer);
    let values = with_legacy_theme(state, &user, store::effective(&user, workspace.as_ref())).await;
    let user_set = accepted_ids(&user, false);
    let workspace_set = workspace
        .as_ref()
        .map(|layer| accepted_ids(layer, true))
        .unwrap_or_default();
    Ok(PreferencesSnapshot {
        definitions: schema::definitions(),
        categories: schema::CATEGORIES.to_vec(),
        values,
        workspace: folder.map(|folder| folder.to_string_lossy().into_owned()),
        user_file: state.settings_file.to_string_lossy().into_owned(),
        workspace_file: workspace_file.map(|path| path.to_string_lossy().into_owned()),
        user_set,
        workspace_set,
        user_issues: store::issues(&user.values, false),
        workspace_issues: workspace
            .as_ref()
            .map(|layer| store::issues(&layer.values, true))
            .unwrap_or_default(),
        user_error: user.error,
        workspace_error: workspace.and_then(|layer| layer.error),
    })
}

#[tauri::command]
pub async fn preferences_load(
    window: tauri::Window,
    state: State<'_, AppState>,
) -> Result<PreferencesSnapshot, String> {
    snapshot(&state, &window).await
}

#[tauri::command]
pub async fn preferences_set(
    scope: String,
    id: String,
    value: Value,
    window: tauri::Window,
    state: State<'_, AppState>,
) -> Result<PreferencesSnapshot, String> {
    let scope = parse_scope(&scope)?;
    let path = scope_path(&state, &window, scope).await?;
    store::set_value(&path, &id, &value, scope == Scope::Workspace)
        .map_err(|err| err.to_string())?;
    snapshot(&state, &window).await
}

#[tauri::command]
pub async fn preferences_reset(
    scope: String,
    id: String,
    window: tauri::Window,
    state: State<'_, AppState>,
) -> Result<PreferencesSnapshot, String> {
    let scope = parse_scope(&scope)?;
    let path = scope_path(&state, &window, scope).await?;
    store::reset_value(&path, &id).map_err(|err| err.to_string())?;
    snapshot(&state, &window).await
}

/// The settings file's path, created as `{}` when it doesn't exist, for the JSON editor to open.
#[tauri::command]
pub async fn preferences_file(
    scope: String,
    window: tauri::Window,
    state: State<'_, AppState>,
) -> Result<String, String> {
    let path = scope_path(&state, &window, parse_scope(&scope)?).await?;
    store::ensure_file(&path).map_err(|err| err.to_string())?;
    Ok(path.to_string_lossy().into_owned())
}

#[tauri::command]
pub fn preferences_validate(scope: String, text: String) -> Result<Vec<Issue>, String> {
    Ok(store::validate_text(
        &text,
        parse_scope(&scope)? == Scope::Workspace,
    ))
}

/// Which settings file (`user`, `workspace` or `keybindings`), if any, `path` is — so the UI can re-read after it is saved.
#[tauri::command]
pub async fn preferences_scope_of(
    path: String,
    window: tauri::Window,
    state: State<'_, AppState>,
) -> Result<Option<String>, String> {
    let same = |a: &Path, b: &Path| {
        a.to_string_lossy()
            .eq_ignore_ascii_case(&b.to_string_lossy())
    };
    let given = Path::new(&path);
    if same(given, &state.settings_file) {
        return Ok(Some("user".into()));
    }
    if same(given, &state.keybindings_file) {
        return Ok(Some("keybindings".into()));
    }
    let workspace = open_folder(&state, &window)
        .await?
        .map(|folder| workspace_settings_path(&folder));
    Ok(workspace
        .filter(|candidate| same(given, candidate))
        .map(|_| "workspace".into()))
}

#[tauri::command]
pub fn keybindings_load(state: State<'_, AppState>) -> KeybindingsFile {
    keybindings::read_file(&state.keybindings_file)
}

#[tauri::command]
pub fn keybindings_save(
    entries: Vec<KeybindingEntry>,
    state: State<'_, AppState>,
) -> Result<Vec<KeybindingEntry>, String> {
    keybindings::write_file(&state.keybindings_file, &entries).map_err(|err| err.to_string())
}

#[tauri::command]
pub fn keybindings_file(state: State<'_, AppState>) -> Result<String, String> {
    keybindings::ensure_file(&state.keybindings_file).map_err(|err| err.to_string())?;
    Ok(state.keybindings_file.to_string_lossy().into_owned())
}

/// A user boolean setting read straight from the settings file, for backend decisions such as
/// whether closing the window hides it to the tray.
pub fn user_bool(state: &AppState, id: &str) -> bool {
    let layer = store::read_layer(&state.settings_file);
    store::effective(&layer, None)
        .into_iter()
        .find(|entry| entry.id == id)
        .and_then(|entry| entry.value.as_bool())
        .unwrap_or(false)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn workspace_settings_live_in_a_dot_folder_of_the_workspace() {
        let path = workspace_settings_path(Path::new("C:/My Site"));
        assert_eq!(path, Path::new("C:/My Site/.openmind/settings.json"));
    }

    #[test]
    fn scopes_are_user_or_workspace_only() {
        assert!(parse_scope("user").is_ok());
        assert!(parse_scope("workspace").is_ok());
        assert!(parse_scope("machine").is_err());
    }
}
