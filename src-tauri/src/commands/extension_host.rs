//! The extension host's lifecycle and the window's allow-listed channel to it (see `extensions.rs`).

use std::sync::atomic::Ordering;
use std::sync::Arc;
use std::time::Duration;

use openmind_extensions::host::HostStart;
use openmind_extensions::{
    activation_order, extensions_for, host_descriptor, resolve_host_node, ExtensionError, ExtensionHost, Trigger,
};
use serde::Serialize;
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, Manager, State};

use crate::app_state::AppState;
use crate::commands::extensions::{lock, workspace_key_of, HostStatus, Sink, ACTIVATE_TIMEOUT};
use crate::commands::preferences::user_bool;
use crate::commands::run::environment;

/// A command may wait for the user (a quick pick, an input box), so it gets a long time.
const COMMAND_TIMEOUT: Duration = Duration::from_secs(600);
const PROVIDE_TIMEOUT: Duration = Duration::from_secs(10);

/// Requests the window may send to the host.
const ALLOWED_REQUESTS: [&str; 14] = [
    "host/activate",
    "host/deactivate",
    "host/executeCommand",
    "host/provide",
    "host/cancelProvide",
    "host/workbench",
    "host/tree",
    "host/resolveWebviewView",
    "host/provideTasks",
    "host/fs",
    "host/quickInputEvent",
    "host/validateTask",
    "host/executeCustomTask",
    "host/willSaveDocument",
];
/// Notifications the window may send to the host.
const ALLOWED_NOTIFICATIONS: [&str; 22] = [
    "host/windowStateChanged",
    "host/documentLanguageChanged",
    "host/editorSnapshot",
    "host/editorOptionsChanged",
    "host/activeTerminalChanged",
    "host/terminalStateChanged",
    "host/ptyEvent",
    "host/terminalClosed",
    "host/filesChanged",
    "host/taskStarted",
    "host/taskEnded",
    "host/configurationChanged",
    "host/workspaceFoldersChanged",
    "host/documentOpened",
    "host/documentChanged",
    "host/documentSaved",
    "host/documentClosed",
    "host/activeEditorChanged",
    "host/selectionChanged",
    "host/webviewMessage",
    "host/webviewDisposed",
    "host/webviewViewState",
];

fn publish(app: &AppHandle, status: HostStatus) {
    let state = app.state::<AppState>();
    state.extensions.set_status(status.clone());
    let _ = app.emit_to("main", "ext:host-state", json!(status));
    crate::state::refresh_soon(app, &[crate::state::Domain::Extensions]);
}

fn failure(app: &AppHandle, state: &'static str, message: &str) {
    publish(
        app,
        HostStatus {
            state,
            pid: None,
            node: None,
            error: Some(message.to_string()),
        },
    );
}

/// Starts the host (once) and tells it about the enabled extensions plus what the window knows now
/// (`initial`: configuration, workspace folders, open documents, the active editor).
#[tauri::command]
pub async fn ext_host_start(
    initial: Value,
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<HostStatus, String> {
    if state.extensions.running_host().is_some() {
        return Ok(lock(&state.extensions.status).clone());
    }
    publish(
        &app,
        HostStatus {
            state: "starting",
            pid: None,
            node: None,
            error: None,
        },
    );
    let environment = environment(&state).await;
    let allow_system = user_bool(&state, "extensions.allowSystemNode");
    let path = std::env::var_os("PATH");
    let node = match resolve_host_node(&environment.path_prepend, path, allow_system) {
        Ok(node) => node,
        Err(err) => {
            let message = err.to_string();
            failure(&app, "unavailable", &message);
            return Err(message);
        }
    };
    let key = workspace_key_of(&state).await;
    let paths = state.extensions.store.paths().clone();
    let descriptors: Vec<Value> = state
        .extensions
        .store
        .list()
        .extensions
        .iter()
        .filter(|extension| extension.enabled && extension.manifest.has_code())
        .map(|extension| host_descriptor(&paths, extension, key.as_deref()))
        .collect();
    let generation = state.extensions.generation.fetch_add(1, Ordering::SeqCst) + 1;
    let sink = Arc::new(Sink {
        app: app.clone(),
        generation,
    });
    let start = HostStart {
        node,
        path_prepend: environment.path_prepend,
        vars: environment.vars,
    };
    let host = tokio::task::spawn_blocking(move || {
        let host = ExtensionHost::start(&paths, start, sink)?;
        let mut init = initial;
        init["extensions"] = Value::Array(descriptors);
        host.request("host/init", init, ACTIVATE_TIMEOUT)?;
        Ok::<_, ExtensionError>(host)
    })
    .await
    .map_err(|err| err.to_string())?
    .map_err(|err| {
        let message = err.to_string();
        failure(&app, "crashed", &message);
        message
    })?;
    let status = HostStatus {
        state: "running",
        pid: Some(host.pid()),
        node: Some(host.node_label().to_string()),
        error: None,
    };
    *lock(&state.extensions.host) = Some(Arc::new(host));
    state.extensions.reset_active();
    publish(&app, status.clone());
    Ok(status)
}

/// Stops the host and everything it started. Extensions deactivate first.
pub fn stop_host(app: &AppHandle) {
    let state = app.state::<AppState>();
    state.extensions.generation.fetch_add(1, Ordering::SeqCst);
    let host = lock(&state.extensions.host).take();
    if let Some(host) = host {
        host.stop();
    }
    state.extensions.reset_active();
    state.extensions.set_status(HostStatus::stopped());
}

#[tauri::command]
pub async fn ext_host_stop(app: AppHandle) -> Result<(), String> {
    let stopper = app.clone();
    tokio::task::spawn_blocking(move || stop_host(&stopper))
        .await
        .map_err(|err| err.to_string())?;
    publish(&app, HostStatus::stopped());
    Ok(())
}

fn host_or_reason(state: &AppState) -> Result<Arc<ExtensionHost>, String> {
    state
        .extensions
        .running_host()
        .ok_or_else(|| ExtensionError::HostNotRunning.to_string())
}

fn timeout_for(method: &str) -> Duration {
    match method {
        "host/willSaveDocument" => Duration::from_secs(3),
        // A tree item's click runs its command, which may wait for the user too.
        "host/executeCommand"
        | "host/tree"
        | "host/resolveWebviewView"
        | "host/provideTasks"
        | "host/validateTask"
        | "host/executeCustomTask"
        | "host/fs"
        | "host/workbench" => COMMAND_TIMEOUT,
        "host/provide" => PROVIDE_TIMEOUT,
        _ => ACTIVATE_TIMEOUT,
    }
}

/// One request to the host from the window: only the allow-listed methods, and activation only of
/// extensions that are enabled.
#[tauri::command]
pub async fn ext_host_request(
    method: String,
    params: Value,
    state: State<'_, AppState>,
) -> Result<Value, String> {
    if !ALLOWED_REQUESTS.contains(&method.as_str()) {
        return Err(format!("Not an allowed extension host request: {method}"));
    }
    let host = host_or_reason(&state)?;
    if method == "host/activate" {
        let id = params.get("id").and_then(Value::as_str).unwrap_or_default();
        return activate(&state, &host, id).await;
    }
    let timeout = timeout_for(&method);
    tokio::task::spawn_blocking(move || host.request(&method, params, timeout))
        .await
        .map_err(|err| err.to_string())?
        .map_err(|err| err.to_string())
}

async fn activate(state: &AppState, host: &Arc<ExtensionHost>, id: &str) -> Result<Value, String> {
    let installed = state.extensions.store.list().extensions;
    let order = activation_order(&installed, &[id.to_string()])?;
    let mut result = Value::Null;
    for extension_id in order {
        // A dependency can be shared by several requested extensions.
        if lock(&state.extensions.activity)
            .get(&extension_id)
            .is_some_and(|activity| activity.active)
        {
            continue;
        }
        let requested_id = extension_id.clone();
        let host = Arc::clone(host);
        let outcome = tokio::task::spawn_blocking(move || {
            host.request("host/activate", json!({ "id": requested_id }), ACTIVATE_TIMEOUT)
        })
        .await
        .map_err(|err| err.to_string())?
        .map_err(|err| err.to_string());
        let recorded = outcome.as_ref().map(|_| ()).map_err(Clone::clone);
        state.extensions.record_activation(&extension_id, &recorded);
        result = outcome.map_err(|error| format!("{extension_id}: {error}"))?;
    }
    Ok(result)
}

#[tauri::command]
pub fn ext_host_notify(
    method: String,
    params: Value,
    state: State<'_, AppState>,
) -> Result<(), String> {
    if !ALLOWED_NOTIFICATIONS.contains(&method.as_str()) {
        return Err(format!(
            "Not an allowed extension host notification: {method}"
        ));
    }
    // A host that isn't running has nothing to tell; not an error for the window.
    if let Some(host) = state.extensions.running_host() {
        host.notify(&method, params)
            .map_err(|err| err.to_string())?;
    }
    Ok(())
}

/// The window's answer to a request the host made (`ext:host-request`).
#[tauri::command]
pub fn ext_host_respond(
    id: Value,
    result: Option<Value>,
    error: Option<String>,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let host = host_or_reason(&state)?;
    let answer = match error {
        Some(message) => Err(message),
        None => Ok(result.unwrap_or(Value::Null)),
    };
    host.respond(&id, answer).map_err(|err| err.to_string())
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ActivationResult {
    id: String,
    ok: bool,
    error: Option<String>,
}

/// Wakes every enabled extension the trigger names (a command about to run, a language opened, start-up
/// finished, a folder opened, a view shown). Extensions that are already active are left alone.
#[tauri::command]
pub async fn ext_activate_for(
    trigger: Trigger,
    state: State<'_, AppState>,
) -> Result<Vec<ActivationResult>, String> {
    let ids = extensions_for(&state.extensions.store.list().extensions, &trigger);
    if ids.is_empty() {
        return Ok(Vec::new());
    }
    let host = host_or_reason(&state).map_err(|reason| {
        lock(&state.extensions.status)
            .error
            .clone()
            .unwrap_or(reason)
    })?;
    let mut results = Vec::new();
    for id in ids {
        let already = lock(&state.extensions.activity)
            .get(&id)
            .is_some_and(|activity| activity.active);
        if already {
            continue;
        }
        let outcome = activate(&state, &host, &id).await;
        results.push(ActivationResult {
            ok: outcome.is_ok(),
            error: outcome.err(),
            id,
        });
    }
    Ok(results)
}


