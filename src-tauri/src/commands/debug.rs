//! Debugging commands. Debugging only ever starts on an explicit `debug_start`: the UI sends a
//! launch configuration and the breakpoints; the backend checks the program and folder exist,
//! finds the interpreter (OpenMind's portable Python/Node first) and the debug adapter (a Runtime
//! Manager install) and starts the adapter as a child process in a job object, bound to 127.0.0.1
//! when it listens at all. Runs are stopped, with everything they started, when the app closes.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use openmind_dap::{
    adapter_for, readiness, resolve_interpreter, Control, DapEvents, DapManager, LaunchConfig,
    Readiness, RunSnapshot, StartRequest, Target,
};
use openmind_db::{BreakpointRow, BreakpointsRepository};
use openmind_lsp::LogLevel;
use serde::Serialize;
use serde_json::Value;
use tauri::{AppHandle, Emitter, Manager, State};

use crate::app_state::AppState;
use crate::commands::run::environment;

/// Turns manager events into UI events.
pub struct Sink {
    app: AppHandle,
}

#[derive(Serialize, Clone)]
struct DebugEvent {
    name: String,
    body: Value,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct DebugLog {
    level: LogLevel,
    text: String,
}

impl DapEvents for Sink {
    fn event(&self, name: &str, body: &Value) {
        let _ = self.app.emit(
            "debug:event",
            DebugEvent {
                name: name.to_string(),
                body: body.clone(),
            },
        );
    }

    fn state(&self, snapshot: &RunSnapshot) {
        let _ = self.app.emit("debug:state", snapshot.clone());
    }

    fn log(&self, level: LogLevel, text: &str) {
        let _ = self.app.emit(
            "debug:log",
            DebugLog {
                level,
                text: text.to_string(),
            },
        );
    }
}

pub fn new_manager(app: AppHandle) -> DapManager {
    DapManager::new(Arc::new(Sink { app }))
}

/// Stops the running debug session, if any (app close).
pub fn stop_debug(app: &AppHandle) {
    app.state::<AppState>().dap.stop();
}

async fn workspace_path(state: &AppState) -> Option<PathBuf> {
    state
        .workspace_folder
        .active_workspace()
        .await
        .ok()
        .flatten()
        .map(|workspace| PathBuf::from(workspace.path))
}

/// The three targets' readiness, the workspace and the run in progress.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DebugStatus {
    workspace: Option<String>,
    run: Option<RunSnapshot>,
    python: Readiness,
    node: Readiness,
    php: Readiness,
}

async fn target_readiness(state: &AppState, target: Target, prepend: &[PathBuf]) -> Readiness {
    let interpreter = resolve_interpreter(target, prepend, std::env::var_os("PATH"));
    let dir = match adapter_for(target) {
        Some(adapter) => state.runtime.installed_dir(adapter.runtime_kind).await,
        None => None,
    };
    readiness(target, interpreter.as_ref(), dir.as_deref())
}

#[tauri::command]
pub async fn debug_status(state: State<'_, AppState>) -> Result<DebugStatus, String> {
    let environment = environment(&state).await;
    Ok(DebugStatus {
        workspace: workspace_path(&state)
            .await
            .map(|path| path.display().to_string()),
        run: state.dap.snapshot(),
        python: target_readiness(&state, Target::Python, &environment.path_prepend).await,
        node: target_readiness(&state, Target::Node, &environment.path_prepend).await,
        php: target_readiness(&state, Target::Php, &environment.path_prepend).await,
    })
}

/// Starts debugging `config` with the given breakpoints (enabled ones are sent to the adapter).
#[tauri::command]
pub async fn debug_start(
    config: LaunchConfig,
    breakpoints: Vec<BreakpointRow>,
    state: State<'_, AppState>,
) -> Result<RunSnapshot, String> {
    let target = config.target;
    let environment = environment(&state).await;
    let interpreter =
        resolve_interpreter(target, &environment.path_prepend, std::env::var_os("PATH"));
    let adapter = adapter_for(target);
    let adapter_dir = match adapter {
        Some(adapter) => state.runtime.installed_dir(adapter.runtime_kind).await,
        None => None,
    };
    let ready = readiness(target, interpreter.as_ref(), adapter_dir.as_deref());
    if !ready.ready {
        return Err(ready
            .problem
            .unwrap_or_else(|| "No debugger is available for this file type.".into()));
    }
    let (Some(interpreter), Some(adapter_dir)) = (interpreter, adapter_dir) else {
        return Err("Debugger is not installed yet.".into());
    };
    let adapter_cwd = workspace_path(&state)
        .await
        .filter(|path| path.is_dir())
        .unwrap_or_else(|| {
            Path::new(&config.program)
                .parent()
                .map_or_else(|| state.app_root.clone(), Path::to_path_buf)
        });
    let mut lines: HashMap<String, Vec<u32>> = HashMap::new();
    for breakpoint in breakpoints.iter().filter(|bp| bp.enabled) {
        lines
            .entry(breakpoint.file_path.clone())
            .or_default()
            .push(breakpoint.line);
    }
    let request = StartRequest {
        config,
        interpreter,
        adapter_dir,
        adapter_cwd,
        path_prepend: environment.path_prepend,
        vars: environment.vars,
        breakpoints: lines,
    };
    let manager = state.dap.clone();
    tokio::task::spawn_blocking(move || manager.start(request))
        .await
        .map_err(|err| format!("The debugger stopped unexpectedly: {err}"))?
        .map_err(|err| err.to_string())
}

#[tauri::command]
pub async fn debug_stop(state: State<'_, AppState>) -> Result<(), String> {
    let manager = state.dap.clone();
    tokio::task::spawn_blocking(move || manager.stop())
        .await
        .map_err(|err| err.to_string())
}

/// `continue`, `pause`, `stepOver`, `stepInto` or `stepOut`.
#[tauri::command]
pub async fn debug_control(action: String, state: State<'_, AppState>) -> Result<(), String> {
    let control =
        Control::parse(&action).ok_or_else(|| format!("Unknown debug action: {action}"))?;
    let manager = state.dap.clone();
    tokio::task::spawn_blocking(move || manager.control(control))
        .await
        .map_err(|err| err.to_string())?
        .map_err(|err| err.to_string())
}

/// Reads about the paused program: threads, stack trace, scopes, variables, evaluate.
#[tauri::command]
pub async fn debug_request(
    command: String,
    arguments: Value,
    state: State<'_, AppState>,
) -> Result<Value, String> {
    let manager = state.dap.clone();
    tokio::task::spawn_blocking(move || manager.request(&command, &arguments))
        .await
        .map_err(|err| err.to_string())?
        .map_err(|err| err.to_string())
}

#[tauri::command]
pub async fn debug_set_breakpoints(
    path: String,
    lines: Vec<u32>,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let manager = state.dap.clone();
    tokio::task::spawn_blocking(move || manager.set_breakpoints(&path, &lines))
        .await
        .map_err(|err| err.to_string())?
        .map_err(|err| err.to_string())
}

#[tauri::command]
pub async fn breakpoints_load(state: State<'_, AppState>) -> Result<Vec<BreakpointRow>, String> {
    BreakpointsRepository::new(state.db.pool())
        .list()
        .await
        .map_err(|err| err.to_string())
}

#[tauri::command]
pub async fn breakpoints_save(
    rows: Vec<BreakpointRow>,
    state: State<'_, AppState>,
) -> Result<(), String> {
    BreakpointsRepository::new(state.db.pool())
        .replace_all(&rows)
        .await
        .map_err(|err| err.to_string())
}
