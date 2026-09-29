//! Profiles (Milestone 16): thin commands over `openmind_settings::profiles`. Profile files live in
//! `settings/profiles/` next to the app; switching writes the profile's settings into the user's `settings.json` and
//! shortcuts into `keybindings.json` after saving the current values into the profile being left. Nothing here touches
//! the network, keys or passwords.

use std::path::Path;

use openmind_settings::keybindings::{self, KeybindingEntry};
use openmind_settings::profiles::{self, Profile, ProfileList, ProfileStore};
use openmind_settings::store;
use serde_json::{Map, Value};
use tauri::State;

use crate::app_state::AppState;

fn store_for(
    state: &AppState,
) -> Result<(ProfileStore, std::path::PathBuf, std::path::PathBuf), String> {
    let file = state.settings_file.clone();
    let dir = file
        .parent()
        .ok_or_else(|| "The settings folder can't be found.".to_string())?
        .to_path_buf();
    Ok((ProfileStore::new(&dir), file, state.keybindings_file.clone()))
}

fn current_values(settings_file: &Path) -> Map<String, Value> {
    store::read_layer(settings_file).values
}

fn current_keybindings(keybindings_file: &Path) -> Result<Vec<KeybindingEntry>, String> {
    let file = keybindings::read_file(keybindings_file);
    match file.error {
        Some(error) => Err(format!(
            "keybindings.json has a problem, so the profile was not switched: {error}"
        )),
        None => Ok(file.entries),
    }
}

/// Makes `id` the active profile: the current values are saved into the profile being left, then the target's
/// settings are written into `settings_file`.
fn switch_to(
    store: &ProfileStore,
    settings_file: &Path,
    keybindings_file: &Path,
    id: &str,
) -> Result<(), String> {
    let target = store.load(id).map_err(|e| e.to_string())?;
    let layer = store::read_layer(settings_file);
    if let Some(error) = layer.error {
        return Err(format!(
            "settings.json has a problem, so the profile was not switched: {error}"
        ));
    }
    let leaving = store.active_id();
    if leaving != id {
        if let Ok(mut outgoing) = store.load(&leaving) {
            outgoing.settings = profiles::snapshot(&layer.values);
            outgoing.keybindings = profiles::keybindings_snapshot(&current_keybindings(keybindings_file)?);
            store.save(&outgoing).map_err(|e| e.to_string())?;
        }
    }
    profiles::apply(&target, settings_file, keybindings_file).map_err(|e| e.to_string())?;
    store.set_active(id).map_err(|e| e.to_string())
}

fn list(
    store: &ProfileStore,
    settings_file: &Path,
    keybindings_file: &Path,
) -> Result<ProfileList, String> {
    store
        .ensure_seeded(
            &current_values(settings_file),
            &keybindings::read_file(keybindings_file).entries,
        )
        .map_err(|e| e.to_string())?;
    Ok(store.summary())
}

/// The profiles (seeding Default and the ready-made ones the first time) and which is active.
#[tauri::command]
pub fn profiles_list(state: State<'_, AppState>) -> Result<ProfileList, String> {
    let (store, file, keybindings) = store_for(&state)?;
    list(&store, &file, &keybindings)
}

/// A new profile: empty (every setting at its default) or a copy of the current values.
#[tauri::command]
pub fn profile_create(
    name: String,
    from_current: bool,
    state: State<'_, AppState>,
) -> Result<ProfileList, String> {
    let (store, file, keybindings_file) = store_for(&state)?;
    list(&store, &file, &keybindings_file)?;
    let settings = if from_current {
        current_values(&file)
    } else {
        Map::new()
    };
    let keybindings = if from_current {
        current_keybindings(&keybindings_file)?
    } else {
        Vec::new()
    };
    store
        .create(&name, settings, keybindings)
        .map_err(|e| e.to_string())?;
    Ok(store.summary())
}

#[tauri::command]
pub fn profile_switch(id: String, state: State<'_, AppState>) -> Result<ProfileList, String> {
    let (store, file, keybindings) = store_for(&state)?;
    list(&store, &file, &keybindings)?;
    switch_to(&store, &file, &keybindings, &id)?;
    Ok(store.summary())
}

#[tauri::command]
pub fn profile_rename(
    id: String,
    name: String,
    state: State<'_, AppState>,
) -> Result<ProfileList, String> {
    let (store, file, keybindings) = store_for(&state)?;
    list(&store, &file, &keybindings)?;
    store.rename(&id, &name).map_err(|e| e.to_string())?;
    Ok(store.summary())
}

#[tauri::command]
pub fn profile_duplicate(
    id: String,
    name: String,
    state: State<'_, AppState>,
) -> Result<ProfileList, String> {
    let (store, file, keybindings_file) = store_for(&state)?;
    list(&store, &file, &keybindings_file)?;
    // The active profile is copied as it is now, not as it was last saved.
    if store.active_id() == id {
        let mut current: Profile = store.load(&id).map_err(|e| e.to_string())?;
        current.settings = profiles::snapshot(&current_values(&file));
        current.keybindings = profiles::keybindings_snapshot(&current_keybindings(&keybindings_file)?);
        store.save(&current).map_err(|e| e.to_string())?;
    }
    store.duplicate(&id, &name).map_err(|e| e.to_string())?;
    Ok(store.summary())
}

#[tauri::command]
pub fn profile_delete(id: String, state: State<'_, AppState>) -> Result<ProfileList, String> {
    let (store, file, keybindings) = store_for(&state)?;
    list(&store, &file, &keybindings)?;
    store.delete(&id).map_err(|e| e.to_string())?;
    Ok(store.summary())
}

/// The text of a profile file for sharing (secrets and local paths are never in it). The active profile is exported
/// as it is now.
#[tauri::command]
pub fn profile_export(id: String, state: State<'_, AppState>) -> Result<String, String> {
    let (store, file, keybindings_file) = store_for(&state)?;
    list(&store, &file, &keybindings_file)?;
    if store.active_id() == id {
        let mut current = store.load(&id).map_err(|e| e.to_string())?;
        current.settings = profiles::snapshot(&current_values(&file));
        current.keybindings = profiles::keybindings_snapshot(&current_keybindings(&keybindings_file)?);
        store.save(&current).map_err(|e| e.to_string())?;
    }
    store.export_text(&id).map_err(|e| e.to_string())
}

/// Adds an exported profile as a new profile (it is not applied until you switch to it).
#[tauri::command]
pub fn profile_import(text: String, state: State<'_, AppState>) -> Result<ProfileList, String> {
    let (store, file, keybindings) = store_for(&state)?;
    list(&store, &file, &keybindings)?;
    store.import_text(&text).map_err(|e| e.to_string())?;
    Ok(store.summary())
}

#[cfg(test)]
mod tests {
    use super::*;
    use openmind_settings::Extras;
    use serde_json::json;

    fn binding(key: &str, command: &str) -> KeybindingEntry {
        KeybindingEntry {
            key: key.to_string(),
            command: command.to_string(),
        }
    }

    fn rig() -> (
        tempfile::TempDir,
        ProfileStore,
        std::path::PathBuf,
        std::path::PathBuf,
    ) {
        let dir = tempfile::tempdir().expect("tmp");
        let settings = dir.path().join("my app").join("settings");
        let file = settings.join("settings.json");
        let keybindings_file = settings.join("keybindings.json");
        store::set_value(
            &file,
            "editor.fontSize",
            &json!(19),
            false,
            &Extras::default(),
        )
        .expect("set");
        keybindings::write_file(
            &keybindings_file,
            &[binding("ctrl+alt+s", "file.saveAll")],
        )
        .expect("keys");
        (dir, ProfileStore::new(&settings), file, keybindings_file)
    }

    #[test]
    fn switching_saves_what_you_had_and_restoring_it_brings_it_back() {
        let (_d, store, file, keybindings_file) = rig();
        let all = list(&store, &file, &keybindings_file).expect("list");
        assert_eq!(all.active, "default");
        switch_to(&store, &file, &keybindings_file, "minimal").expect("switch");
        let now = store::read_layer(&file).values;
        assert_eq!(now.get("workbench.iconTheme"), Some(&json!("minimal")));
        assert!(
            !now.contains_key("editor.fontSize"),
            "minimal doesn't set a font size"
        );
        assert_eq!(store.active_id(), "minimal");
        // Default kept the user's own font size.
        assert_eq!(
            store
                .load("default")
                .expect("default")
                .settings
                .get("editor.fontSize"),
            Some(&json!(19))
        );
        assert_eq!(
            store.load("default").expect("default").keybindings,
            [binding("Ctrl+Alt+S", "file.saveAll")]
        );
        assert_eq!(
            keybindings::read_file(&keybindings_file).entries,
            Vec::<KeybindingEntry>::new()
        );
        switch_to(&store, &file, &keybindings_file, "default").expect("back");
        assert_eq!(
            store::read_layer(&file).values.get("editor.fontSize"),
            Some(&json!(19))
        );
        assert_eq!(
            keybindings::read_file(&keybindings_file).entries,
            [binding("Ctrl+Alt+S", "file.saveAll")]
        );
        assert_eq!(
            list(&store, &file, &keybindings_file).expect("list").active,
            "default"
        );
    }

    #[test]
    fn a_settings_file_with_a_syntax_error_blocks_the_switch_and_is_left_alone() {
        let (_d, store, file, keybindings_file) = rig();
        list(&store, &file, &keybindings_file).expect("list");
        std::fs::write(&file, "{ half typed").expect("break");
        let err = switch_to(&store, &file, &keybindings_file, "python").expect_err("refused");
        assert!(err.contains("settings.json has a problem"), "{err}");
        assert_eq!(
            std::fs::read_to_string(&file).expect("read"),
            "{ half typed"
        );
        assert_eq!(store.active_id(), "default");
    }

    #[test]
    fn switching_to_a_missing_profile_fails_cleanly() {
        let (_d, store, file, keybindings_file) = rig();
        list(&store, &file, &keybindings_file).expect("list");
        assert!(switch_to(&store, &file, &keybindings_file, "nope").is_err());
        assert_eq!(store.active_id(), "default");
    }
}
