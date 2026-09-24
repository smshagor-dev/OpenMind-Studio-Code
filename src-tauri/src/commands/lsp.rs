//! Language server commands. Servers run only for files inside the open
//! workspace: the UI sends a file path and its text, the backend decides which
//! server (by extension), whether the file is inside the workspace, whether the
//! server is installed and whether Node.js is available, then starts it on
//! first use. Nothing is downloaded without an explicit `lsp_install`.

use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use openmind_lsp::{
    install, package_by_id, resolve_node, server_by_id, server_for_path, summaries, Capabilities,
    LogLevel, LspError, LspEvents, LspManager, NodeExecutable, PublishedDiagnostics, ServerState,
    StartContext,
};
use serde::Serialize;
use serde_json::Value;
use tauri::{AppHandle, Emitter, State};

use crate::app_state::AppState;
use crate::commands::run::environment;

const REQUEST_TIMEOUT: Duration = Duration::from_secs(20);
/// A log file over this size is moved aside (`.old`) so it can't grow without bound.
const MAX_LOG_BYTES: u64 = 2 * 1024 * 1024;

/// Turns manager events into UI events and per-server log files under `logs/lsp/`.
pub struct Sink {
    app: AppHandle,
    log_dir: PathBuf,
}

impl Sink {
    pub fn new(app: AppHandle, logs_dir: &Path) -> Self {
        Self {
            app,
            log_dir: logs_dir.join("lsp"),
        }
    }

    fn append(&self, server: &str, level: LogLevel, text: &str) {
        if std::fs::create_dir_all(&self.log_dir).is_err() {
            return;
        }
        let path = self.log_dir.join(format!("{server}.log"));
        if std::fs::metadata(&path).is_ok_and(|meta| meta.len() > MAX_LOG_BYTES) {
            let _ = std::fs::rename(&path, self.log_dir.join(format!("{server}.old.log")));
        }
        let seconds = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map_or(0, |elapsed| elapsed.as_secs());
        let line = format!(
            "{:02}:{:02}:{:02} [{level:?}] {text}\n",
            seconds / 3600 % 24,
            seconds / 60 % 60,
            seconds % 60
        );
        if let Ok(mut file) = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(path)
        {
            let _ = file.write_all(line.as_bytes());
        }
    }
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct DiagnosticsEvent {
    server: String,
    #[serde(flatten)]
    published: PublishedDiagnostics,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct LogEvent {
    server: String,
    level: LogLevel,
    text: String,
}

impl LspEvents for Sink {
    fn diagnostics(&self, server: &str, published: PublishedDiagnostics) {
        let _ = self.app.emit(
            "lsp:diagnostics",
            DiagnosticsEvent {
                server: server.to_string(),
                published,
            },
        );
    }

    fn log(&self, server: &str, level: LogLevel, text: &str) {
        self.append(server, level, text);
        let _ = self.app.emit(
            "lsp:log",
            LogEvent {
                server: server.to_string(),
                level,
                text: text.to_string(),
            },
        );
    }

    fn status_changed(&self) {
        let _ = self.app.emit("lsp:changed", ());
    }
}

/// The open workspace folder, if any.
async fn workspace_path(state: &AppState) -> Option<PathBuf> {
    state
        .workspace_folder
        .active_workspace()
        .await
        .ok()
        .flatten()
        .map(|workspace| PathBuf::from(workspace.path))
}

struct Resolved {
    node: Result<NodeExecutable, LspError>,
    path_prepend: Vec<PathBuf>,
    vars: Vec<(String, String)>,
}

async fn resolve(state: &AppState) -> Resolved {
    let environment = environment(state).await;
    Resolved {
        node: resolve_node(&environment.path_prepend, std::env::var_os("PATH")),
        path_prepend: environment.path_prepend,
        vars: environment.vars,
    }
}

fn log_path(state: &AppState, server: &str) -> PathBuf {
    state
        .app_root
        .join("logs")
        .join("lsp")
        .join(format!("{server}.log"))
}

/// One server as the Language Tools list shows it.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ServerInfo {
    id: &'static str,
    name: &'static str,
    languages: Vec<&'static str>,
    note: Option<&'static str>,
    contents: &'static str,
    installed: bool,
    #[serde(flatten)]
    state: ServerState,
    workspace: Option<String>,
    node: Option<String>,
    capabilities: Option<Capabilities>,
    open_documents: usize,
    pid: Option<u32>,
    /// Whether "Install" would work right now; when not, `install_blocked` says why.
    can_install: bool,
    install_blocked: Option<String>,
    log_path: String,
    log_exists: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LspSnapshot {
    workspace: Option<String>,
    /// Which Node.js language servers would run on, or why there is none.
    node: Option<String>,
    node_problem: Option<String>,
    verbose: bool,
    servers: Vec<ServerInfo>,
}

#[tauri::command]
pub async fn lsp_status(state: State<'_, AppState>) -> Result<LspSnapshot, String> {
    let resolved = resolve(&state).await;
    let (node_label, node_problem, npm_ok) = match &resolved.node {
        Ok(node) => (Some(node.label()), None, node.npm_cli().is_some()),
        Err(err) => (None, Some(err.to_string()), false),
    };
    let servers = summaries()
        .into_iter()
        .filter_map(|summary| {
            let def = server_by_id(summary.id)?;
            let package = package_by_id(def.package)?;
            let installed = install::is_installed(&state.app_root, def, package);
            let live = state.lsp.status(def.id);
            let blocked = if node_problem.is_some() {
                node_problem.clone()
            } else if !npm_ok {
                Some("npm was not found next to Node.js. Repair the Node.js runtime.".to_string())
            } else if live.state == ServerState::Installing {
                Some("It is already installing.".to_string())
            } else {
                None
            };
            let path = log_path(&state, def.id);
            Some(ServerInfo {
                id: summary.id,
                name: summary.name,
                languages: summary.languages,
                note: summary.note,
                contents: summary.contents,
                installed,
                state: live.state,
                workspace: live.workspace,
                node: live.node,
                capabilities: live.capabilities,
                open_documents: live.open_documents,
                pid: live.pid,
                can_install: blocked.is_none(),
                install_blocked: blocked,
                log_exists: path.is_file(),
                log_path: path.display().to_string(),
            })
        })
        .collect();
    Ok(LspSnapshot {
        workspace: workspace_path(&state)
            .await
            .map(|path| path.display().to_string()),
        node: node_label,
        node_problem,
        verbose: state.lsp.verbose(),
        servers,
    })
}

/// Installs the server's package from its pinned lockfile. Only ever runs on the user's request.
#[tauri::command]
pub async fn lsp_install(server: String, state: State<'_, AppState>) -> Result<(), String> {
    let def = server_by_id(&server).ok_or("Unknown language server.")?;
    let node = resolve(&state).await.node.map_err(|err| err.to_string())?;
    let manager: LspManager = state.lsp.clone();
    let root = state.app_root.clone();
    tokio::task::spawn_blocking(move || manager.install_package(def, &root, &node))
        .await
        .map_err(|err| format!("The installer stopped unexpectedly: {err}"))?
        .map_err(|err| err.to_string())
}

/// What happened to a document sync, so the UI can say why a file has no language features.
#[derive(Serialize)]
#[serde(tag = "state", rename_all = "camelCase")]
pub enum SyncOutcome {
    Ready {
        server: &'static str,
    },
    Unsupported,
    NoWorkspace,
    OutsideWorkspace,
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
    state: State<'_, AppState>,
) -> Result<SyncOutcome, String> {
    let Some(def) = server_for_path(&path) else {
        return Ok(SyncOutcome::Unsupported);
    };
    let Some(workspace) = workspace_path(&state).await else {
        return Ok(SyncOutcome::NoWorkspace);
    };
    if openmind_fs::ensure_within_root(&workspace, Path::new(&path)).is_err() {
        return Ok(SyncOutcome::OutsideWorkspace);
    }
    let package = package_by_id(def.package).ok_or("Unknown language server package.")?;
    if !install::is_installed(&state.app_root, def, package) {
        return Ok(SyncOutcome::NotInstalled { server: def.id });
    }
    let resolved = resolve(&state).await;
    let Ok(node) = resolved.node else {
        return Ok(SyncOutcome::NodeMissing);
    };
    let context = StartContext {
        app_root: state.app_root.clone(),
        workspace,
        node,
        path_prepend: resolved.path_prepend,
        vars: resolved.vars,
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
