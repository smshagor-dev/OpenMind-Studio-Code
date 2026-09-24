use std::sync::Arc;

use openmind_runner::{
    php_server_plan, port_is_free, portable_version, server_url, PhpServerRequest, RunError,
    RunEventKind, RunInfo,
};
use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, State, WebviewUrl, WebviewWindowBuilder};

use crate::app_state::AppState;
use crate::commands::run::environment;

const PHP_EVENT: &str = "php:event";
/// Sent when the server starts or ends, so every window re-reads `php_server_status`.
const PHP_CHANGED_EVENT: &str = "php:changed";
/// The label of the separate PHP Server window (the frontend picks its screen by it).
pub const PHP_WINDOW_LABEL: &str = "php-server";

/// A started server: what every window shows for it. The backend is the one
/// source of truth (there are two windows, each with its own frontend state).
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PhpServerInfo {
    pub run: RunInfo,
    pub url: String,
    pub port: u16,
    /// The PHP version the process was started with (it keeps it after a switch).
    pub php_version: Option<String>,
}

/// Starts `php -S 127.0.0.1:<port> -t <root>` with the portable PHP. Only one
/// server runs at a time, the port is checked first, and output/exit arrive
/// as `php:event`s (the same shape as `run:event`) in every window.
#[tauri::command]
pub async fn php_server_start(
    request: PhpServerRequest,
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<PhpServerInfo, String> {
    if !state.php_server.active().is_empty() {
        return Err("The PHP server is already running. Stop it first.".into());
    }
    let environment = environment(&state).await;
    let plan = php_server_plan(&request, &environment, std::env::var_os("PATH"))
        .map_err(|err| err.to_string())?;
    if !port_is_free(request.port) {
        return Err(RunError::PortInUse(request.port).to_string());
    }
    let sink_app = app.clone();
    let sink: openmind_runner::EventSink = Arc::new(move |event| {
        if matches!(event.event, RunEventKind::Exited { .. }) {
            let state = sink_app.state::<AppState>();
            let cleared = state.php_server_info.lock().map(|mut info| info.take());
            drop(cleared);
            let _ = sink_app.emit(PHP_CHANGED_EVENT, ());
        }
        if let Err(err) = sink_app.emit(PHP_EVENT, event) {
            tracing::error!(?err, "failed to emit a PHP server event");
        }
    });
    let run = state
        .php_server
        .start(&plan, sink)
        .map_err(|err| err.to_string())?;
    let info = PhpServerInfo {
        run,
        url: server_url(request.port),
        port: request.port,
        php_version: portable_version(&plan.resolved),
    };
    if let Ok(mut current) = state.php_server_info.lock() {
        *current = Some(info.clone());
    }
    let _ = app.emit(PHP_CHANGED_EVENT, ());
    Ok(info)
}

#[tauri::command]
pub fn php_server_stop(run_id: String, state: State<'_, AppState>) -> bool {
    state.php_server.stop(&run_id)
}

/// Why deleting or repairing `kind` `version` must wait, if the running PHP
/// server is using that PHP (its `php.exe` is in use and can't be replaced).
pub fn php_in_use_reason(state: &AppState, kind: &str, version: &str) -> Option<String> {
    if kind != "php" || state.php_server.active().is_empty() {
        return None;
    }
    let info = state.php_server_info.lock().ok()?.clone()?;
    (info.php_version.as_deref() == Some(version))
        .then(|| format!("The PHP server is running on PHP {version}. Stop the server first."))
}

/// The running server, if any. Each window asks on start-up and whenever the
/// server starts or exits, so both always agree with the backend.
#[tauri::command]
pub fn php_server_status(state: State<'_, AppState>) -> Option<PhpServerInfo> {
    if state.php_server.active().is_empty() {
        return None;
    }
    state.php_server_info.lock().ok()?.clone()
}

/// Whether nothing on this machine is using `port` on 127.0.0.1 right now.
#[tauri::command]
pub fn php_port_free(port: u16) -> bool {
    port_is_free(port)
}

/// Opens the PHP Server window, or brings the open one to the front.
#[tauri::command]
pub async fn php_window_open(app: AppHandle) -> Result<(), String> {
    if let Some(window) = app.get_webview_window(PHP_WINDOW_LABEL) {
        let _ = window.unminimize();
        let _ = window.show();
        window.set_focus().map_err(|err| err.to_string())?;
        return Ok(());
    }
    let saved = app
        .state::<AppState>()
        .window_states
        .load_or(PHP_WINDOW_LABEL, 700.0, 560.0)
        .await
        .map_err(|err| err.to_string())?;
    // Built hidden, sized and placed from the saved geometry, then shown, so it never flashes at the wrong size.
    let window =
        WebviewWindowBuilder::new(&app, PHP_WINDOW_LABEL, WebviewUrl::App("index.html".into()))
            .title("PHP Server — OpenMind Studio")
            .min_inner_size(560.0, 400.0)
            .visible(false)
            .build()
            .map_err(|err| err.to_string())?;
    crate::window_events::apply_window_state(&window, &saved).map_err(|err| err.to_string())?;
    window.show().map_err(|err| err.to_string())?;
    crate::window_events::track_secondary_geometry(&window);
    Ok(())
}
