use base64::engine::general_purpose::STANDARD as BASE64;
use base64::Engine as _;
use openmind_terminal::{
    CreateTerminalRequest, ShellInfo, ShellKind, TerminalRegistry, TerminalSessionInfo,
};
use serde::Serialize;
use tauri::{AppHandle, Emitter, State};

use crate::app_state::AppState;

const OUTPUT_EVENT: &str = "terminal:output";
const EXIT_EVENT: &str = "terminal:exit";

/// A chunk of raw PTY output. Base64-encoded because a chunk boundary can
/// fall in the middle of a multi-byte ANSI escape sequence or UTF-8
/// character — the bytes aren't guaranteed to be valid UTF-8 on their own,
/// so they can't safely travel as a plain JSON string.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct TerminalOutputPayload {
    id: String,
    data: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct TerminalExitPayload {
    id: String,
    code: Option<i32>,
}

#[tauri::command]
pub fn terminal_list_shells() -> Vec<ShellInfo> {
    openmind_terminal::detect_shells()
}

#[tauri::command]
pub async fn terminal_create(
    shell: Option<ShellKind>,
    cwd: Option<String>,
    cols: u16,
    rows: u16,
    window: tauri::Window,
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<TerminalSessionInfo, String> {
    let id = TerminalRegistry::generate_id();
    // The terminal belongs to the window that opened it: only that window gets
    // its output, and closing that window ends it.
    let owner = window.label().to_string();
    state.editor_windows.track_terminal(&id, &owner);
    // Active portable runtimes go in front of the new shell's PATH — and only
    // that shell's. A runtime problem never blocks opening a terminal.
    let runtime = match state.runtime.environment().await {
        Ok(environment) => environment,
        Err(err) => {
            tracing::warn!(
                ?err,
                "could not read the runtime environment for a new terminal"
            );
            Default::default()
        }
    };
    let mut env = openmind_terminal::default_environment();
    env.extend(runtime.vars);
    let request = CreateTerminalRequest {
        shell,
        cwd: cwd.map(std::path::PathBuf::from),
        cols,
        rows,
        env,
        path_prepend: runtime.path_prepend,
    };

    let output_id = id.clone();
    let output_app = app.clone();
    let output_owner = owner.clone();
    let exit_id = id.clone();
    let exit_app = app;

    state
        .terminal
        .create(
            id,
            request,
            &state.app_root,
            move |chunk| {
                let payload = TerminalOutputPayload {
                    id: output_id.clone(),
                    data: BASE64.encode(chunk),
                };
                if let Err(err) = output_app.emit_to(output_owner.as_str(), OUTPUT_EVENT, payload) {
                    tracing::error!(?err, "failed to emit terminal output event");
                }
            },
            move |code| {
                let payload = TerminalExitPayload { id: exit_id, code };
                if let Err(err) = exit_app.emit_to(owner.as_str(), EXIT_EVENT, payload) {
                    tracing::error!(?err, "failed to emit terminal exit event");
                }
            },
        )
        .map_err(|err| err.to_string())
}

#[tauri::command]
pub fn terminal_write(id: String, data: String, state: State<'_, AppState>) -> Result<(), String> {
    state
        .terminal
        .write(&id, data.as_bytes())
        .map_err(|err| err.to_string())
}

#[tauri::command]
pub fn terminal_resize(
    id: String,
    cols: u16,
    rows: u16,
    state: State<'_, AppState>,
) -> Result<(), String> {
    state
        .terminal
        .resize(&id, cols, rows)
        .map_err(|err| err.to_string())
}

#[tauri::command]
pub fn terminal_close(id: String, state: State<'_, AppState>) -> Result<(), String> {
    state.editor_windows.forget_terminal(&id);
    state.terminal.close(&id).map_err(|err| err.to_string())
}
