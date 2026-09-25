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
    pub fn new(extensions_dir: &std::path::Path) -> Self {
        let paths = ExtensionPaths::new(extensions_dir);
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

    pub(crate) fn record_activation(&self, id: &str, result: &Result<(), String>) {
        let mut activity = lock(&self.activity);
        let entry = activity.entry(id.to_string()).or_default();
        match result {
            Ok(()) => {
                entry.active = true;
                entry.last_error = None;
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
        self.emit(
            "ext:host-request",
            json!({ "id": id, "method": method, "params": params }),
        );
    }

    fn notification(&self, method: &str, params: Value) {
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
        lock(&runtime.activity).clear();
        let status = HostStatus {
            state: "crashed",
            pid: None,
            node: None,
            error: Some(reason),
        };
        runtime.set_status(status.clone());
        self.emit("ext:host-state", json!(status));
        self.emit("ext:changed", Value::Null);
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

async fn snapshot(state: &AppState) -> ExtensionsSnapshot {
    let paths = state.extensions.store.paths();
    let node = node_info(state).await;
    let activity = lock(&state.extensions.activity).clone();
    let host = lock(&state.extensions.status).clone();
    ExtensionsSnapshot {
        listing: state.extensions.store.list(),
        activity,
        host,
        node,
        root: paths.root.to_string_lossy().into_owned(),
        logs_dir: paths.logs.to_string_lossy().into_owned(),
        host_log: paths.host_log.to_string_lossy().into_owned(),
    }
}

#[tauri::command]
pub async fn ext_list(state: State<'_, AppState>) -> Result<ExtensionsSnapshot, String> {
    Ok(snapshot(&state).await)
}

// ---- install / enable / disable / uninstall ------------------------------------------------------------------------

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

fn changed(app: &AppHandle) {
    let _ = app.emit("ext:changed", Value::Null);
}

#[tauri::command]
pub async fn ext_install(
    path: String,
    replace: bool,
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<InstalledExtension, String> {
    let path = PathBuf::from(path);
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
