use std::sync::Arc;

use openmind_runner::{
    php_server_plan, port_is_free, server_url, PhpServerRequest, RunError, RunInfo,
};
use serde::Serialize;
use tauri::{AppHandle, Emitter, State};

use crate::app_state::AppState;
use crate::commands::run::environment;

const PHP_EVENT: &str = "php:event";

/// What the panel shows for a started server.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PhpServerInfo {
    pub run: RunInfo,
    pub url: String,
    pub port: u16,
}

/// Starts `php -S 127.0.0.1:<port> -t <root>` with the portable PHP. Only one
/// server runs at a time, the port is checked first, and output/exit arrive
/// as `php:event`s (the same shape as `run:event`).
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
    let sink: openmind_runner::EventSink = Arc::new(move |event| {
        if let Err(err) = app.emit(PHP_EVENT, event) {
            tracing::error!(?err, "failed to emit a PHP server event");
        }
    });
    let run = state
        .php_server
        .start(&plan, sink)
        .map_err(|err| err.to_string())?;
    Ok(PhpServerInfo {
        run,
        url: server_url(request.port),
        port: request.port,
    })
}

#[tauri::command]
pub fn php_server_stop(run_id: String, state: State<'_, AppState>) -> bool {
    state.php_server.stop(&run_id)
}

/// The running server, if any (the panel asks on start-up).
#[tauri::command]
pub fn php_server_active(state: State<'_, AppState>) -> Vec<RunInfo> {
    state.php_server.active()
}

/// Whether nothing on this machine is using `port` on 127.0.0.1 right now.
#[tauri::command]
pub fn php_port_free(port: u16) -> bool {
    port_is_free(port)
}
