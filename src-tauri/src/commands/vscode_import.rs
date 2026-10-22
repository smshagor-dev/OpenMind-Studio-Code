//! VS Code import. Sources are resolved by edition/profile ID, not caller-supplied paths.
//! The preview is rebuilt on Apply so a stale UI cannot overwrite unexpected values.
use std::fs;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use openmind_settings::{keybindings, store, vscode_import};
use serde::Serialize;
use serde_json::{Map, Value};
use tauri::State;

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
                let restored = restore(settings_file, &settings_backup)
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
