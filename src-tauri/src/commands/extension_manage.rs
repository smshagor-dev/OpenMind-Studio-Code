//! Enabling, disabling and uninstalling extensions, and reading what they ship (see `extensions.rs`).

use openmind_extensions::{HostLog, InstalledExtension};
use serde_json::json;
use tauri::{AppHandle, State};

use crate::app_state::AppState;
use crate::commands::extensions::{lock, register_with_host, ACTIVATE_TIMEOUT};

/// The extension list changed: the canonical extensions domain is read again (every window follows it).
fn changed(app: &AppHandle) {
    crate::state::refresh_soon(app, &[crate::state::Domain::Extensions]);
}

/// Asks the host to deactivate an extension (best effort: a host that is gone has nothing to deactivate).
pub(crate) async fn deactivate_in_host(state: &AppState, id: &str) {
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

/// Removes an extension descriptor as well as its runtime instance.
async fn unregister_from_host(state: &AppState, id: &str) {
    let Some(host) = state.extensions.running_host() else {
        return;
    };
    let id_owned = id.to_string();
    let _ = tokio::task::spawn_blocking(move || {
        host.request(
            "host/unregister",
            json!({ "id": id_owned }),
            ACTIVATE_TIMEOUT,
        )
    })
    .await;
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
    } else {
        unregister_from_host(&state, &id).await;
    }
    changed(&app);
    crate::sync::announce_now(&app, crate::sync::Topic::Extensions).await;
    Ok(extension)
}

/// The user's explicit grant of a permission the manifest doesn't request (only "filesystemOutsideWorkspace").
/// The host has to be reloaded afterwards to pick it up (the app does that).
#[tauri::command]
pub async fn ext_grant_permission(
    id: String,
    permission: String,
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<InstalledExtension, String> {
    let permission = openmind_extensions::Permission::parse(&permission)
        .ok_or_else(|| format!("Unknown permission \"{permission}\"."))?;
    let extension = state
        .extensions
        .store
        .grant_permission(&id, permission)
        .map_err(|err| err.to_string())?;
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
    unregister_from_host(&state, &id).await;
    lock(&state.extensions.activity).remove(&id);
    // Its secrets go with it (unlike its storage folder, which VS Code keeps too).
    if let Err(err) = crate::commands::extension_api::clear_secrets(&state, &id).await {
        tracing::warn!(%err, "couldn't remove an uninstalled extension's secrets");
    }
    changed(&app);
    crate::sync::announce_now(&app, crate::sync::Topic::Extensions).await;
    Ok(())
}

/// How many secrets an extension keeps (never their values).
#[tauri::command]
pub async fn ext_secrets_count(id: String, state: State<'_, AppState>) -> Result<usize, String> {
    Ok(crate::commands::extension_api::secret_count(&state, &id).await)
}

/// Forgets every secret of an extension (its details page).
#[tauri::command]
pub async fn ext_secrets_clear(id: String, state: State<'_, AppState>) -> Result<(), String> {
    crate::commands::extension_api::clear_secrets(&state, &id).await
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

/// A local file for an extension's webview (`asWebviewUri`), as a `data:` URL. Checked here again whatever the
/// host said: the roots must be allowed for the extension and the file must lie inside one of them
/// (see `openmind_extensions::webview`). The webview itself never reads the disk.
#[tauri::command]
pub async fn ext_webview_read_resource(
    id: String,
    path: String,
    roots: Vec<String>,
    window: tauri::Window,
    state: State<'_, AppState>,
) -> Result<String, String> {
    use base64::Engine as _;
    use openmind_extensions::webview::{allowed_roots, read_resource, RootPolicy};
    let extension = state
        .extensions
        .store
        .find(&id)
        .map_err(|err| err.to_string())?;
    if !extension.enabled {
        return Err(format!("{id} is disabled."));
    }
    let workspace = crate::windows::window_workspace(&state, window.label())
        .await?
        .map(|info| std::path::PathBuf::from(info.path));
    let policy = RootPolicy {
        extension_dir: &extension.path,
        workspace: workspace.as_deref(),
        accepted: &extension.permissions.accepted,
    };
    let roots: Vec<std::path::PathBuf> = roots.into_iter().map(std::path::PathBuf::from).collect();
    let allowed = allowed_roots(&policy, &roots).map_err(|err| err.to_string())?;
    let resource =
        read_resource(&allowed, std::path::Path::new(&path)).map_err(|err| err.to_string())?;
    Ok(format!(
        "data:{};base64,{}",
        resource.content_type,
        base64::engine::general_purpose::STANDARD.encode(resource.bytes)
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
