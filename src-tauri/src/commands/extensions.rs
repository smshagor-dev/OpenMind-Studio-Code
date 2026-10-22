//! Extension commands: install/enable/disable/uninstall (the folders under `extensions/`), and the extension
//! host (a separate Node.js process). The window only ever talks to the host through the allow-listed
//! `ext_host_request`/`ext_host_notify` and answers the host's own questions with `ext_host_respond`, so
//! extension code never sees anything but the API bridge.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};
use std::time::Duration;

use openmind_extensions::{
    extras_for, host_descriptor, preview, resolve_host_node, vsix, workspace_key, ExtensionHost,
    ExtensionPaths, ExtensionStore, HostEvents, InstalledExtension, Listing,
};
use openmind_settings::Extras;
use serde::Serialize;
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, Manager, State};

use crate::app_state::AppState;
use crate::commands::preferences::user_bool;
use crate::commands::run::environment;

/// The window that owns the extension UI (messages, quick picks, contributions).
const UI_WINDOW: &str = "main";
pub(crate) const ACTIVATE_TIMEOUT: Duration = Duration::from_secs(30);

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Activity {
    pub active: bool,
    pub last_error: Option<String>,
    /// How many times it was activated since the app started (a host restart activates it again).
    pub activation_count: u32,
    pub last_activation: Option<String>,
    /// VS Code APIs it called that OpenMind Studio doesn't support (seen in the host's log, at most 30).
    pub unsupported_apis: Vec<String>,
}

/// The API name in a host log line "VS Code API 'x.y' is not supported by OpenMind Studio yet.", if it is one.
pub(crate) fn unsupported_api_in(text: &str) -> Option<String> {
    let start = text.find("VS Code API '")? + "VS Code API '".len();
    let rest = &text[start..];
    let end = rest.find("' is not supported")?;
    let name = &rest[..end];
    (!name.is_empty() && name.len() <= 120).then(|| name.to_string())
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HostStatus {
    /// `stopped`, `running`, `crashed` or `unavailable` (no Node.js).
    pub state: &'static str,
    pub pid: Option<u32>,
    pub node: Option<String>,
    pub error: Option<String>,
}

impl HostStatus {
    pub(crate) fn stopped() -> Self {
        Self {
            state: "stopped",
            pid: None,
            node: None,
            error: None,
        }
    }
}

/// Everything about extensions that lives for the whole run: the installed folders, the host process and what
/// each extension has done in it.
pub struct ExtensionsRuntime {
    pub store: ExtensionStore,
    pub(crate) host: Mutex<Option<Arc<ExtensionHost>>>,
    pub(crate) status: Mutex<HostStatus>,
    pub(crate) activity: Mutex<HashMap<String, Activity>>,
    /// Bumped whenever a host starts or stops, so a late exit report of an old host is ignored.
    pub(crate) generation: AtomicU64,
}

pub(crate) fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(PoisonError::into_inner)
}

impl ExtensionsRuntime {
    /// `extensions_dir` is shared on the drive; `logs_dir` is `AppPaths::extension_logs_dir` (per computer in that scope).
    pub fn new(extensions_dir: &std::path::Path, logs_dir: &std::path::Path) -> Self {
        let paths = ExtensionPaths::with_logs(extensions_dir, logs_dir);
        if let Err(err) = paths.ensure() {
            tracing::warn!(%err, "couldn't create the extension folders");
        }
        Self {
            store: ExtensionStore::new(paths),
            host: Mutex::new(None),
            status: Mutex::new(HostStatus::stopped()),
            activity: Mutex::new(HashMap::new()),
            generation: AtomicU64::new(0),
        }
    }

    pub(crate) fn running_host(&self) -> Option<Arc<ExtensionHost>> {
        lock(&self.host).clone().filter(|host| host.is_alive())
    }

    pub(crate) fn set_status(&self, status: HostStatus) {
        *lock(&self.status) = status;
    }

    /// The host is gone or restarted: nothing is active any more (counts and last errors stay).
    pub(crate) fn reset_active(&self) {
        for entry in lock(&self.activity).values_mut() {
            entry.active = false;
        }
    }

    /// Remembers an unsupported VS Code API an extension called (shown on its details page).
    /// Remembers an unsupported API an extension used; true when it is new (the details page is then refreshed).
    pub(crate) fn record_unsupported(&self, id: &str, api: String) -> bool {
        let mut activity = lock(&self.activity);
        let entry = activity.entry(id.to_string()).or_default();
        if !entry.unsupported_apis.contains(&api) && entry.unsupported_apis.len() < 30 {
            entry.unsupported_apis.push(api);
            return true;
        }
        false
    }

    pub(crate) fn record_activation(&self, id: &str, result: &Result<(), String>) {
        let mut activity = lock(&self.activity);
        let entry = activity.entry(id.to_string()).or_default();
        match result {
            Ok(()) => {
                entry.active = true;
                entry.last_error = None;
                entry.activation_count += 1;
                entry.last_activation = Some(openmind_extensions::hostlog::timestamp());
            }
            Err(message) => {
                entry.active = false;
                entry.last_error = Some(message.clone());
            }
        }
    }
}

/// The settings and themes the enabled extensions add, for the Settings backend.
pub fn extras(state: &AppState) -> Extras {
    extras_for(&state.extensions.store.list().extensions)
}

// ---- the host's side of the conversation --------------------------------------------------------------------------

pub(crate) struct Sink {
    pub(crate) app: AppHandle,
    pub(crate) generation: u64,
}

impl Sink {
    pub(crate) fn emit(&self, event: &str, payload: Value) {
        let _ = self.app.emit_to(UI_WINDOW, event, payload);
    }
}

impl HostEvents for Sink {
    fn request(&self, id: Value, method: &str, params: Value) {
        // Secrets and file searches are answered here: they never reach the window.
        if crate::commands::extension_api::handled_here(method) {
            crate::commands::extension_api::answer(
                self.app.clone(),
                id,
                method.to_string(),
                params,
            );
            return;
        }
        self.emit(
            "ext:host-request",
            json!({ "id": id, "method": method, "params": params }),
        );
    }

    fn notification(&self, method: &str, params: Value) {
        if method == "log/output" {
            let text = params
                .get("text")
                .and_then(Value::as_str)
                .unwrap_or_default();
            let extension = params
                .get("extension")
                .and_then(Value::as_str)
                .unwrap_or_default();
            if let Some(api) = unsupported_api_in(text).filter(|_| extension.contains('.')) {
                let new = self
                    .app
                    .state::<AppState>()
                    .extensions
                    .record_unsupported(extension, api);
                if new {
                    crate::state::refresh_soon(&self.app, &[crate::state::Domain::Extensions]);
                }
            }
        }
        self.emit(
            "ext:host-notification",
            json!({ "method": method, "params": params }),
        );
    }

    fn exited(&self, reason: Option<String>) {
        let state = self.app.state::<AppState>();
        let runtime = &state.extensions;
        if runtime.generation.load(Ordering::SeqCst) != self.generation {
            return; // an old host that was stopped or replaced
        }
        let Some(reason) = reason else {
            return;
        };
        *lock(&runtime.host) = None;
        runtime.reset_active();
        let status = HostStatus {
            state: "crashed",
            pid: None,
            node: None,
            error: Some(reason),
        };
        runtime.set_status(status.clone());
        self.emit("ext:host-state", json!(status));
        crate::state::refresh_soon(&self.app, &[crate::state::Domain::Extensions]);
    }
}

// ---- snapshot ---------------------------------------------------------------------------------------------------------

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NodeInfo {
    /// OpenMind's portable Node.js is installed.
    portable: bool,
    /// A Node.js found on this computer (never used unless allowed).
    system: Option<String>,
    allow_system: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExtensionsSnapshot {
    #[serde(flatten)]
    listing: Listing,
    activity: HashMap<String, Activity>,
    host: HostStatus,
    node: NodeInfo,
    root: String,
    logs_dir: String,
    host_log: String,
}

async fn node_info(state: &AppState) -> NodeInfo {
    let portable_dirs = environment(state).await.path_prepend;
    let path = std::env::var_os("PATH");
    NodeInfo {
        portable: resolve_host_node(&portable_dirs, None, false).is_ok(),
        system: resolve_host_node(&[], path, true)
            .ok()
            .map(|node| node.path.to_string_lossy().into_owned()),
        allow_system: user_bool(state, "extensions.allowSystemNode"),
    }
}

/// The canonical state's extension domain, or why the extension folders can't be listed right now (the last known
/// list stays then: a folder that is briefly unreadable must not look like "no extensions installed").
pub(crate) async fn snapshot_checked(state: &AppState) -> Result<ExtensionsSnapshot, String> {
    let listing = state.extensions.store.try_list()?;
    let paths = state.extensions.store.paths();
    let node = node_info(state).await;
    let activity = lock(&state.extensions.activity).clone();
    let host = lock(&state.extensions.status).clone();
    Ok(ExtensionsSnapshot {
        listing,
        activity,
        host,
        node,
        root: paths.root.to_string_lossy().into_owned(),
        logs_dir: paths.logs.to_string_lossy().into_owned(),
        host_log: paths.host_log.to_string_lossy().into_owned(),
    })
}

// ---- install / enable / disable / uninstall ------------------------------------------------------------------------

/// Installed VS Code extensions are discovered but never executed automatically.
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VsCodeExtensionSource {
    pub id: String,
    pub label: String,
}

/// Only paths under the current user's VS Code extension roots are eligible.
fn vscode_extension_roots() -> Vec<(&'static str, PathBuf)> {
    let Some(home) = std::env::var_os("USERPROFILE") else { return Vec::new() };
    let root = PathBuf::from(home);
    vec![
        ("stable", root.join(".vscode").join("extensions")),
        ("insiders", root.join(".vscode-insiders").join("extensions")),
    ]
}

fn detected_vscode_extensions() -> Vec<VsCodeExtensionSource> {
    let mut found = Vec::new();
    for (product, root) in vscode_extension_roots() {
        if let Ok(entries) = std::fs::read_dir(root) {
            for entry in entries.flatten().take(1000) {
                let path = entry.path();
                if !path.is_dir() || path.is_symlink() || !path.join("package.json").is_file() { continue; }
                let folder = entry.file_name().to_string_lossy().to_string();
                if folder.starts_with('.') { continue; }
                found.push(VsCodeExtensionSource {
                    id: format!("{product}:{folder}"),
                    label: format!("{} — {}", if product == "stable" { "VS Code" } else { "VS Code Insiders" }, folder),
                });
            }
        }
    }
    found.sort_by(|a,b| a.label.cmp(&b.label));
    found
}

#[tauri::command]
pub fn ext_detect_vscode() -> Vec<VsCodeExtensionSource> {
    detected_vscode_extensions()
}

/// Refuse links and unexpectedly large trees before creating the temporary VSIX.
/// This also avoids copying files outside the VS Code extension directory.
fn validate_vscode_extension_tree(root: &std::path::Path) -> Result<(), String> {
    let mut stack = vec![(root.to_path_buf(), 0usize)];
    let mut count = 0usize;
    let mut bytes = 0u64;
    while let Some((folder, depth)) = stack.pop() {
        if depth > 40 { return Err("VS Code extension directory nesting is too deep.".into()); }
        for item in std::fs::read_dir(folder).map_err(|e| e.to_string())? {
            let item = item.map_err(|e| e.to_string())?;
            count += 1;
            if count > 20_000 { return Err("VS Code extension has too many files.".into()); }
            let meta = std::fs::symlink_metadata(item.path()).map_err(|e| e.to_string())?;
            if meta.file_type().is_symlink() {
                return Err("VS Code extension contains a symbolic link or junction; import a trusted VSIX instead.".into());
            }
            if meta.is_dir() {
                stack.push((item.path(), depth + 1));
            } else if meta.is_file() {
                bytes = bytes.saturating_add(meta.len());
                if bytes > 512 * 1024 * 1024 {
                    return Err("VS Code extension exceeds the 512 MB import limit.".into());
                }
            } else {
                return Err("VS Code extension contains an unsupported filesystem entry.".into());
            }
        }
    }
    Ok(())
}

/// Import an installed extension only on explicit user action. The installed copy is
/// repacked and passed through the regular VSIX manifest/permissions validation.
#[tauri::command]
pub async fn ext_import_vscode(
    source_id: String,
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<InstalledExtension, String> {
    let (kind, folder) = source_id.split_once(':').ok_or("Invalid VS Code extension identifier.")?;
    if folder.is_empty() || folder == "." || folder == ".." ||
        !folder.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_' || c == '.') {
        return Err("Invalid VS Code extension folder.".into());
    }
    let root = vscode_extension_roots().into_iter()
        .find(|(product, _)| *product == kind).map(|(_,path)| path)
        .ok_or("VS Code installation wasn't found.")?;
    let candidate = root.join(folder);
    let canonical_root = root.canonicalize().map_err(|e| e.to_string())?;
    let canonical_candidate = candidate.canonicalize().map_err(|e| e.to_string())?;
    if !canonical_candidate.starts_with(&canonical_root) || !candidate.is_dir() || candidate.is_symlink() {
        return Err("VS Code extension is outside the expected installation folder.".into());
    }
    // The import is initially disabled; users enable it after reviewing its permissions.
    let import = {
        let app = app.clone();
        tokio::task::spawn_blocking(move || {
            let id = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH)
                .unwrap_or_default().as_nanos();
            let archive = std::env::temp_dir().join(format!("openmind-vscode-{id}-{}.vsix", std::process::id()));
            let outcome = (|| {
                validate_vscode_extension_tree(&canonical_candidate).map_err(openmind_extensions::ExtensionError::Refused)?;
                vsix::pack(&canonical_candidate, &archive)?;
                let installed = app.state::<AppState>().extensions.store.install(&archive, false)?;
                Ok::<_, openmind_extensions::ExtensionError>(installed)
            })();
            let _ = std::fs::remove_file(&archive);
            outcome
        }).await.map_err(|e| e.to_string())?.map_err(|e| e.to_string())?
    };
    // Disabled on import; do not implicitly run untrusted migrated code.
    let extension = state.extensions.store.set_enabled(&import.id, false)
        .map_err(|e| e.to_string())?;
    crate::state::refresh_soon(&app, &[crate::state::Domain::Extensions]);
    crate::sync::announce_now(&app, crate::sync::Topic::Extensions).await;
    Ok(extension)
}

/// Reads a `.vsix` without installing it, for the trust confirmation.
#[tauri::command]
pub async fn ext_inspect_vsix(
    path: String,
    state: State<'_, AppState>,
) -> Result<InstalledExtension, String> {
    let path = PathBuf::from(path);
    let inspected = tokio::task::spawn_blocking(move || vsix::inspect(&path))
        .await
        .map_err(|err| err.to_string())?
        .map_err(|err| err.to_string())?;
    let mut extension = preview(inspected.manifest);
    if let Ok(existing) = state.extensions.store.find(&extension.id) {
        extension.warnings.push(format!(
            "Version {} is already installed; installing replaces it.",
            existing.manifest.version
        ));
    }
    Ok(extension)
}

/// The extension list changed: the canonical extensions domain is read again (every window follows it).
fn changed(app: &AppHandle) {
    crate::state::refresh_soon(app, &[crate::state::Domain::Extensions]);
}

#[tauri::command]
pub async fn ext_install(
    path: String,
    replace: bool,
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<InstalledExtension, String> {
    let path = PathBuf::from(path);
    // Running Node modules are cached by the extension host. Stop the old code
    // before replacing files, otherwise an update appears installed while old
    // commands and providers remain active in memory.
    if replace {
        let inspected = {
            let path = path.clone();
            tokio::task::spawn_blocking(move || vsix::inspect(&path))
                .await
                .map_err(|err| err.to_string())?
                .map_err(|err| err.to_string())?
        };
        let id = inspected.manifest.id();
        if state.extensions.store.find(&id).is_ok() {
            crate::commands::extension_manage::deactivate_in_host(&state, &id).await;
        }
    }
    let extension = {
        let app = app.clone();
        tokio::task::spawn_blocking(move || {
            app.state::<AppState>()
                .extensions
                .store
                .install(&path, replace)
        })
        .await
        .map_err(|err| err.to_string())?
        .map_err(|err| err.to_string())?
    };
    // A replaced extension that was active runs old code: it starts again from the new files on demand.
    lock(&state.extensions.activity).remove(&extension.id);
    register_with_host(&state, &extension).await;
    changed(&app);
    crate::sync::announce_now(&app, crate::sync::Topic::Extensions).await;
    Ok(extension)
}

/// Tells a running host about an extension (new, or moved by enabling it).
pub(crate) async fn register_with_host(state: &AppState, extension: &InstalledExtension) {
    if !extension.enabled || !extension.manifest.has_code() {
        return;
    }
    let Some(host) = state.extensions.running_host() else {
        return;
    };
    let key = workspace_key_of(state).await;
    let descriptor = host_descriptor(state.extensions.store.paths(), extension, key.as_deref());
    let outcome = tokio::task::spawn_blocking(move || {
        host.request(
            "host/register",
            json!({ "extension": descriptor }),
            ACTIVATE_TIMEOUT,
        )
    })
    .await;
    if let Ok(Err(err)) = outcome {
        tracing::warn!(%err, "the extension host did not accept an extension");
    }
}

pub(crate) async fn workspace_key_of(state: &AppState) -> Option<String> {
    let workspace = state
        .workspace_folder
        .active_workspace()
        .await
        .ok()
        .flatten()?;
    Some(workspace_key(&workspace.path))
}

#[cfg(test)]
mod vscode_import_tests {
    use super::validate_vscode_extension_tree;

    #[test]
    fn accepts_a_small_regular_extension_tree() {
        let root = tempfile::tempdir().expect("tempdir");
        std::fs::create_dir(root.path().join("dist")).expect("mkdir");
        std::fs::write(root.path().join("package.json"), "{}").expect("manifest");
        std::fs::write(root.path().join("dist").join("main.js"), "exports.activate = () => {};").expect("entry");
        validate_vscode_extension_tree(root.path()).expect("safe tree");
    }

    #[cfg(unix)]
    #[test]
    fn rejects_links_to_files_outside_the_extension() {
        let root = tempfile::tempdir().expect("tempdir");
        std::os::unix::fs::symlink("/etc/passwd", root.path().join("outside")).expect("symlink");
        assert!(validate_vscode_extension_tree(root.path()).is_err());
    }
}
