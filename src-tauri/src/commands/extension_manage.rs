//! Enabling, disabling and uninstalling extensions, and reading what they ship (see `extensions.rs`).

use openmind_extensions::{HostLog, InstalledExtension};
use serde_json::json;
use tauri::{AppHandle, Emitter, State};

use crate::app_state::AppState;
use crate::commands::extensions::{lock, register_with_host, ACTIVATE_TIMEOUT};

fn changed(app: &AppHandle) {
    let _ = app.emit("ext:changed", serde_json::Value::Null);
}

/// Asks the host to deactivate an extension (best effort: a host that is gone has nothing to deactivate).
async fn deactivate_in_host(state: &AppState, id: &str) {
    let Some(host) = state.extensions.running_host() else {
        return;
    };
    let id_owned = id.to_string();
    let _ = tokio::task::spawn_blocking(move || {
        host.request(
            "host/deactivate",
            json!({ "id": id_owned }),
            ACTIVATE_TIMEOUT,
        )
    })
    .await;
    lock(&state.extensions.activity).remove(id);
}

#[tauri::command]
pub async fn ext_set_enabled(
    id: String,
    enabled: bool,
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<InstalledExtension, String> {
    if !enabled {
        deactivate_in_host(&state, &id).await;
    }
    let extension = state
        .extensions
        .store
        .set_enabled(&id, enabled)
        .map_err(|err| err.to_string())?;
    if enabled {
        register_with_host(&state, &extension).await;
    }
    changed(&app);
    Ok(extension)
}

#[tauri::command]
pub async fn ext_uninstall(
    id: String,
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<(), String> {
    deactivate_in_host(&state, &id).await;
    state
        .extensions
        .store
        .uninstall(&id)
        .map_err(|err| err.to_string())?;
    lock(&state.extensions.activity).remove(&id);
    changed(&app);
    Ok(())
}

/// A file inside an installed extension (a theme, a snippets file), read as text.
#[tauri::command]
pub fn ext_read_file(
    id: String,
    path: String,
    state: State<'_, AppState>,
) -> Result<String, String> {
    state
        .extensions
        .store
        .read_text(&id, &path)
        .map_err(|err| err.to_string())
}

/// An extension's icon (activity bar container, tree item) as a `data:` URL: `.svg`/`.png` inside its folder only.
#[tauri::command]
pub fn ext_read_icon(
    id: String,
    path: String,
    state: State<'_, AppState>,
) -> Result<String, String> {
    use base64::Engine as _;
    let extension = state
        .extensions
        .store
        .find(&id)
        .map_err(|err| err.to_string())?;
    let (bytes, mime) = openmind_extensions::views::read_icon(&extension.path, &path)
        .map_err(|err| err.to_string())?;
    Ok(format!(
        "data:{mime};base64,{}",
        base64::engine::general_purpose::STANDARD.encode(bytes)
    ))
}

/// The end of `logs/extension-host.log`.
#[tauri::command]
pub fn ext_host_log(state: State<'_, AppState>) -> String {
    const TAIL_BYTES: usize = 200 * 1024;
    let text = HostLog::new(state.extensions.store.paths().host_log.clone()).read();
    if text.len() <= TAIL_BYTES {
        return text;
    }
    let mut start = text.len() - TAIL_BYTES;
    while !text.is_char_boundary(start) {
        start += 1;
    }
    text[start..].to_string()
}
