//! Language server commands. Servers run only for files inside the open
//! workspace: the UI sends a file path and its text, the backend decides which
//! server (by name/extension), whether the file is inside the workspace, whether
//! the server is installed — unpacking it from the offline LSP bundle shipped in
//! `lsp/` when it isn't yet — and whether Node.js is available (the bundle's own
//! Node first), then starts it on first use. Nothing is downloaded without an
//! explicit `lsp_install` of a server the bundle doesn't carry.

mod events;
mod folder;
mod install;
mod resolve;
mod status;

use std::path::Path;
use std::sync::Arc;
use std::time::Duration;

use openmind_lsp::{
    install as installed, package_by_id, server_for_path, LspError, LspManager, Runtime, ServerDef,
    StartContext,
};
use serde::Serialize;
use serde_json::Value;
use tauri::{AppHandle, State};

use crate::app_state::AppState;

pub use events::Sink;
pub(crate) use folder::workspace_path;
pub(crate) use resolve::installers;
pub(crate) use status::{server_facts, snapshot};

const REQUEST_TIMEOUT: Duration = Duration::from_secs(20);

/// Makes the server ready: from the offline bundle when it carries it (no network), otherwise
/// from npm with its pinned lockfile. Only ever runs on the user's request.
#[tauri::command]
pub async fn lsp_install(
    server: String,
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let outcome = install::install_server(&server, &state).await;
    crate::sync::announce_now(&app, crate::sync::Topic::LanguageServers).await;
    outcome
}

/// What happened to a document sync, so the UI can say why a file has no language features.
#[derive(Serialize)]
#[serde(tag = "state", rename_all = "camelCase")]
pub enum SyncOutcome {
    Ready {
        server: &'static str,
    },
    Unsupported,
    /// The file's server is switched off by a setting (asm-lsp: `assembly.enableLanguageServer`).
    TurnedOff {
        server: &'static str,
    },
    NoWorkspace,
    OutsideWorkspace,
    /// This extra window's folder isn't the main window's, and servers serve the main window's folder.
    OtherWindowFolder,
    NotInstalled {
        server: &'static str,
    },
    NodeMissing,
    Failed {
        server: &'static str,
        message: String,
    },
}

/// Gives the server the editor's current text of `path` (starting the server if needed).
#[tauri::command]
pub async fn lsp_sync_document(
    path: String,
    text: String,
    window: tauri::Window,
    state: State<'_, AppState>,
) -> Result<SyncOutcome, String> {
    let Some(def) = server_for_path(&path) else {
        return Ok(SyncOutcome::Unsupported);
    };
    if def.id == "assembly" && !crate::commands::assembly::language_server_enabled(&state) {
        return Ok(SyncOutcome::TurnedOff { server: def.id });
    }
    let workspace = match folder::server_root(&state, window.label(), Path::new(&path)).await {
        Ok(root) => root,
        Err(outcome) => return Ok(outcome),
    };
    let package = package_by_id(def.package).ok_or("Unknown language server package.")?;
    let resolved = resolve::resolve(&state).await;
    if state.lsp.status(def.id).pid.is_none() {
        if let Err(outcome) =
            install::prepare_from_bundle(&state, def, resolved.bundle.clone()).await
        {
            return Ok(outcome);
        }
    }
    if !installed::is_installed(&state.app_root, def, package) {
        return Ok(SyncOutcome::NotInstalled { server: def.id });
    }
    let node = match (def.runtime, resolved.node) {
        (Runtime::Node, Err(_)) => return Ok(SyncOutcome::NodeMissing),
        (_, node) => node.ok(),
    };
    let python = match (def.runtime, resolved.python) {
        (Runtime::PythonModule, Err(err)) => {
            return Ok(SyncOutcome::Failed {
                server: def.id,
                message: err.to_string(),
            })
        }
        (_, python) => python.ok(),
    };
    let config_root = match config_root_of(
        &state,
        def,
        &workspace,
        &resolved.path_prepend,
        &resolved.vars,
    ) {
        Ok(root) => root,
        Err(outcome) => return Ok(outcome),
    };
    let context = StartContext {
        app_root: state.app_root.clone(),
        workspace,
        node,
        python,
        path_prepend: resolved.path_prepend,
        vars: resolved.vars,
        config_root,
    };
    let manager = state.lsp.clone();
    let outcome =
        tokio::task::spawn_blocking(move || manager.sync_document(def, &context, &path, &text))
            .await
            .map_err(|err| format!("The language server stopped unexpectedly: {err}"))?;
    Ok(match outcome {
        Ok(()) => SyncOutcome::Ready { server: def.id },
        Err(LspError::NotInstalled) => SyncOutcome::NotInstalled { server: def.id },
        Err(LspError::NodeMissing) => SyncOutcome::NodeMissing,
        Err(err) => SyncOutcome::Failed {
            server: def.id,
            message: err.to_string(),
        },
    })
}

/// The folder named as `rootPath` for `def`: asm-lsp gets the configuration written from the Assembly settings (see
/// `commands::assembly::lsp_config_root`); every other server the workspace.
fn config_root_of(
    state: &AppState,
    def: &'static ServerDef,
    workspace: &Path,
    path_prepend: &[std::path::PathBuf],
    vars: &[(String, String)],
) -> Result<Option<std::path::PathBuf>, SyncOutcome> {
    if def.id != "assembly" {
        return Ok(None);
    }
    let environment = openmind_runner::RunEnvironment {
        path_prepend: path_prepend.to_vec(),
        vars: vars.to_vec(),
    };
    crate::commands::assembly::lsp_config_root(state, workspace, &environment).map_err(|message| {
        SyncOutcome::Failed {
            server: def.id,
            message,
        }
    })
}

#[tauri::command]
pub fn lsp_save_document(path: String, state: State<'_, AppState>) {
    if let Some(def) = server_for_path(&path) {
        state.lsp.save_document(def.id, &path);
    }
}

#[tauri::command]
pub fn lsp_close_document(path: String, state: State<'_, AppState>) {
    if let Some(def) = server_for_path(&path) {
        state.lsp.close_document(def.id, &path);
    }
}

/// One editor request (hover, completion, ...) for `path`'s server. Anything
/// outside the fixed list of editor features is refused by the manager.
#[tauri::command]
pub async fn lsp_request(
    path: String,
    method: String,
    params: Value,
    state: State<'_, AppState>,
) -> Result<Value, String> {
    let def = server_for_path(&path).ok_or_else(|| LspError::Unsupported.to_string())?;
    let manager = state.lsp.clone();
    tokio::task::spawn_blocking(move || manager.request(def.id, &method, &params, REQUEST_TIMEOUT))
        .await
        .map_err(|err| format!("The language server stopped unexpectedly: {err}"))?
        .map_err(|err| err.to_string())
}

#[tauri::command]
pub async fn lsp_stop(server: String, state: State<'_, AppState>) -> Result<(), String> {
    let manager = state.lsp.clone();
    tokio::task::spawn_blocking(move || manager.stop(&server))
        .await
        .map_err(|err| err.to_string())
}

#[tauri::command]
pub async fn lsp_stop_all(state: State<'_, AppState>) -> Result<(), String> {
    let manager = state.lsp.clone();
    tokio::task::spawn_blocking(move || manager.stop_all())
        .await
        .map_err(|err| err.to_string())
}

#[tauri::command]
pub fn lsp_set_verbose(verbose: bool, state: State<'_, AppState>) {
    state.lsp.set_verbose(verbose);
}

/// Stops every language server (app close).
pub fn stop_lsp(app: &AppHandle) {
    use tauri::Manager;
    app.state::<AppState>().lsp.stop_all();
}

/// Builds the manager (called once from `main`).
pub fn new_manager(app: AppHandle, logs_dir: &Path) -> LspManager {
    LspManager::new(Arc::new(Sink::new(app, logs_dir)))
}
