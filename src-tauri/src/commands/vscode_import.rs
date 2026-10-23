//! VS Code import. Sources are resolved by edition/profile ID, not caller-supplied paths.
//! The preview is rebuilt on Apply so a stale UI cannot overwrite unexpected values.
use std::fs;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use openmind_settings::{keybindings, store, vscode_import};
use serde::Serialize;
use serde_json::{Map, Value};
use tauri::{AppHandle, State};

use crate::app_state::AppState;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportResult {
    settings_imported: usize,
    shortcuts_imported: usize,
    settings_backup: Option<String>,
    shortcuts_backup: Option<String>,
    skipped: Vec<String>,
    warnings: Vec<String>,
}

#[tauri::command]
pub fn vscode_import_sources() -> Vec<vscode_import::Source> {
    vscode_import::sources()
}

#[tauri::command]
pub fn vscode_import_preview(
    edition: String,
    profile: String,
    state: State<'_, AppState>,
) -> Result<vscode_import::Preview, String> {
    vscode_import::inspect(&edition, &profile, &crate::commands::extensions::extras(&state))
}

fn backup(path: &Path) -> Result<Option<PathBuf>, String> {
    if !path.exists() { return Ok(None); }
    let unique = SystemTime::now().duration_since(UNIX_EPOCH)
        .map_err(|e| e.to_string())?.as_nanos();
    let name = path.file_name().ok_or("Invalid target filename.")?.to_string_lossy();
    let backup = path.with_file_name(format!("{name}.before-vscode-import-{unique}.bak"));
    fs::copy(path, &backup)
        .map_err(|e| format!("Couldn't back up {}: {e}", path.display()))?;
    Ok(Some(backup))
}

fn restore(target: &Path, saved: &Option<PathBuf>) -> Result<(), String> {
    if let Some(backup) = saved {
        fs::copy(backup, target).map_err(|e| format!(
            "Couldn't restore {} from {}: {e}", target.display(), backup.display()
        ))?;
    } else if target.exists() {
        fs::remove_file(target).map_err(|e| format!(
            "Couldn't remove newly created {}: {e}", target.display()
        ))?;
    }
    Ok(())
}

/// Import matching, validated editor settings and supported unconditional shortcuts.
/// Unsupported settings, credentials, third-party code and VS Code-only behavior
/// remain untouched and are disclosed in the report.
#[tauri::command]
pub fn vscode_import_apply(
    edition: String,
    profile: String,
    import_settings: bool,
    import_shortcuts: bool,
    state: State<'_, AppState>,
) -> Result<ImportResult, String> {
    if !import_settings && !import_shortcuts {
        return Err("Select settings or keyboard shortcuts to import.".into());
    }
    let preview = vscode_import::inspect(
        &edition, &profile, &crate::commands::extensions::extras(&state)
    )?;
    let settings_file = &state.settings_file;
    let shortcuts_file = &state.keybindings_file;
    if import_settings {
        if let Some(error) = store::read_layer(settings_file).error {
            return Err(format!("Existing OpenMind settings are invalid; import refused: {error}"));
        }
    }
    if import_shortcuts {
        if let Some(error) = keybindings::read_file(shortcuts_file).error {
            return Err(format!("Existing OpenMind shortcuts are invalid; import refused: {error}"));
        }
    }

    let settings_backup = if import_settings && !preview.settings.is_empty() {
        backup(settings_file)?
    } else { None };
    let shortcuts_backup = if import_shortcuts && !preview.keybindings.is_empty() {
        match backup(shortcuts_file) {
            Ok(value) => value,
            Err(error) => return Err(error),
        }
    } else { None };
    let mut settings_imported = 0;
    let mut shortcuts_imported = 0;
    if import_settings && !preview.settings.is_empty() {
        let candidates: Map<String, Value> = preview.settings.iter()
            .map(|entry| (entry.id.clone(), entry.value.clone()))
            .collect();
        match store::merge_values(
            settings_file, &candidates, false, &crate::commands::extensions::extras(&state)
        ) {
            Ok(count) => settings_imported = count,
            Err(error) => return Err(format!("Settings import failed; backup retained: {error}")),
        }
    }
    if import_shortcuts && !preview.keybindings.is_empty() {
        // Replacing the shortcut file is intentional, with backup for recovery.
        match keybindings::write_file(shortcuts_file, &preview.keybindings) {
            Ok(entries) => shortcuts_imported = entries.len(),
            Err(error) => {
                let restored = if import_settings && settings_imported > 0 {
                    restore(settings_file, &settings_backup)
                } else { Ok(()) }
                    .and_then(|()| restore(shortcuts_file, &shortcuts_backup));
                return Err(match restored {
                    Ok(()) => format!("Shortcut import failed; existing settings restored: {error}"),
                    Err(rollback) => format!(
                        "Shortcut import failed: {error}; rollback failed: {rollback}. Restore from the backup files."
                    ),
                });
            }
        }
    }
    Ok(ImportResult {
        settings_imported,
        shortcuts_imported,
        settings_backup: settings_backup.map(|path| path.to_string_lossy().into_owned()),
        shortcuts_backup: shortcuts_backup.map(|path| path.to_string_lossy().into_owned()),
        skipped: preview.skipped,
        warnings: preview.warnings,
    })
}

/// An imported snippet collection that the editor can register for a language.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportedSnippet {
    pub language: String,
    pub text: String,
}

fn snippets_dir(state: &AppState) -> Result<PathBuf, String> {
    Ok(state.settings_file.parent()
        .ok_or("Cannot locate settings directory.")?
        .join("snippets"))
}

/// Copy compatible snippet definitions into OpenMind's settings area. Backups
/// of replaced files are retained and no files from VS Code are modified.
#[tauri::command]
pub fn vscode_import_snippets(
    edition: String,
    profile: String,
    state: State<'_, AppState>,
) -> Result<usize, String> {
    let files = vscode_import::snippet_contents(&edition, &profile)?;
    let dest = snippets_dir(&state)?;
    fs::create_dir_all(&dest).map_err(|e| e.to_string())?;
    let mut count = 0;
    for (name, text) in files {
        let target = dest.join(&name);
        let saved = backup(&target)?;
        let temp = dest.join(format!("{name}.importing"));
        if let Err(error) = fs::write(&temp, text) {
            return Err(format!("Couldn't write snippet {name}: {error}"));
        }
        if target.exists() {
            fs::remove_file(&target).map_err(|e| e.to_string())?;
        }
        if let Err(error) = fs::rename(&temp, &target) {
            restore(&target, &saved)?;
            return Err(format!("Couldn't import snippet {name}: {error}"));
        }
        count += 1;
    }
    Ok(count)
}

/// Snippets imported to OpenMind are now usable in completion lists; a
/// globally-scoped VS Code snippet requires a specific language scope.
#[tauri::command]
pub fn vscode_imported_snippets(
    state: State<'_, AppState>,
) -> Result<Vec<ImportedSnippet>, String> {
    let dir = snippets_dir(&state)?;
    let entries = match fs::read_dir(dir) {
        Ok(entries) => entries,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(error) => return Err(error.to_string()),
    };
    let mut result = Vec::new();
    for file in entries.take(200) {
        let file = file.map_err(|e| e.to_string())?;
        let path = file.path();
        let name = file.file_name().to_string_lossy().to_string();
        if !(name.ends_with(".json") || name.ends_with(".code-snippets")) { continue; }
        let metadata = fs::symlink_metadata(&path).map_err(|e| e.to_string())?;
        if metadata.file_type().is_symlink() || !metadata.is_file() || metadata.len() > 1024 * 1024 { continue; }
        let text = fs::read_to_string(&path).map_err(|e| e.to_string())?;
        if name.ends_with(".json") {
            let language = name.trim_end_matches(".json").to_string();
            result.push(ImportedSnippet { language, text });
        } else {
            let Ok(Value::Object(snippets)) = serde_json::from_str::<Value>(&text) else { continue; };
            let mut scoped: std::collections::BTreeMap<String, Map<String, Value>> =
                std::collections::BTreeMap::new();
            for (label, value) in snippets {
                let Some(scope) = value.get("scope").and_then(Value::as_str) else { continue; };
                for language in scope.split(',').map(str::trim).filter(|scope| !scope.is_empty()) {
                    if language.len() > 64 || !language.bytes().all(|c| c.is_ascii_alphanumeric() || c == b'-' || c == b'_') {
                        continue;
                    }
                    scoped.entry(language.to_string()).or_default().insert(label.clone(), value.clone());
                }
            }
            for (language, definitions) in scoped {
                result.push(ImportedSnippet {
                    language,
                    text: serde_json::to_string(&definitions).map_err(|e| e.to_string())?,
                });
            }
        }
    }
    Ok(result)
}

/// Store a VS Code profile as a separate OpenMind profile without switching the
/// current editor settings. OpenMind profile rules filter paths and credentials.
#[tauri::command]
pub fn vscode_import_profile(
    edition: String,
    profile: String,
    state: State<'_, AppState>,
) -> Result<openmind_settings::profiles::ProfileList, String> {
    use openmind_settings::profiles::{self, ProfileStore};
    let preview = vscode_import::inspect(
        &edition, &profile, &crate::commands::extensions::extras(&state)
    )?;
    let settings_dir = state.settings_file.parent()
        .ok_or("Cannot locate OpenMind settings directory.")?;
    let store = ProfileStore::new(settings_dir);
    let current = store::read_layer(&state.settings_file);
    if let Some(error) = current.error {
        return Err(format!("Existing settings are invalid: {error}"));
    }
    let shortcuts = keybindings::read_file(&state.keybindings_file);
    if let Some(error) = shortcuts.error {
        return Err(format!("Existing shortcuts are invalid: {error}"));
    }
    store.ensure_seeded(&current.values, &shortcuts.entries)
        .map_err(|error| error.to_string())?;
    let values: Map<String, Value> = preview.settings.iter()
        .map(|item| (item.id.clone(), item.value.clone())).collect();
    let name = format!("VS Code {} {}", edition, profile);
    store.create(
        &name.chars().take(40).collect::<String>(),
        profiles::snapshot(&values),
        preview.keybindings,
    ).map_err(|error| error.to_string())?;
    Ok(store.summary())
}

/// Package a user-selected installed VS Code extension with the same safe VSIX
/// checks as a normal install. It is imported DISABLED: users must inspect
/// its permissions and explicitly enable it before any third-party code runs.
#[tauri::command]
pub async fn vscode_import_extension(
    edition: String,
    folder: String,
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<openmind_extensions::InstalledExtension, String> {
    let source = vscode_import::extension_path(&edition, &folder)?;
    let store = state.extensions.store.clone();
    let installed = tokio::task::spawn_blocking(move || {
        let unique = SystemTime::now().duration_since(UNIX_EPOCH)
            .map_err(|e| e.to_string())?.as_nanos();
        let staging = std::env::temp_dir().join(format!(
            "openmind-vscode-import-{}-{unique}", std::process::id()
        ));
        fs::create_dir(&staging).map_err(|e| e.to_string())?;
        let archive = staging.join("extension.vsix");
        let result = (|| {
            openmind_extensions::vsix::pack(&source, &archive)
                .map_err(|e| e.to_string())?;
            let installed = store.install(&archive, false)
                .map_err(|e| e.to_string())?;
            match store.set_enabled(&installed.id, false) {
                Ok(disabled) => Ok(disabled),
                Err(error) => {
                    let _ = store.uninstall(&installed.id);
                    Err(format!("Couldn't disable imported extension: {error}"))
                }
            }
        })();
        let _ = fs::remove_dir_all(&staging);
        result
    }).await.map_err(|error| error.to_string())??;
    crate::state::refresh_soon(&app, &[crate::state::Domain::Extensions]);
    crate::sync::announce_now(&app, crate::sync::Topic::Extensions).await;
    Ok(installed)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn backup_and_restore_preserves_the_original_file() {
        let temp = tempfile::tempdir().unwrap();
        let file = temp.path().join("settings.json");
        fs::write(&file, "old").unwrap();
        let backup = backup(&file).unwrap();
        fs::write(&file, "new").unwrap();
        restore(&file, &backup).unwrap();
        assert_eq!(fs::read_to_string(&file).unwrap(), "old");
    }
}

