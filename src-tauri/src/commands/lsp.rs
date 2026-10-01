//! Language server commands. Servers run only for files inside the open
//! workspace: the UI sends a file path and its text, the backend decides which
//! server (by name/extension), whether the file is inside the workspace, whether
//! the server is installed — unpacking it from the offline LSP bundle shipped in
//! `lsp/` when it isn't yet — and whether Node.js is available (the bundle's own
//! Node first), then starts it on first use. Nothing is downloaded without an
//! explicit `lsp_install` of a server the bundle doesn't carry.

use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use openmind_lsp::bundle::{self, Bundle};
use openmind_lsp::{
    install, package_by_id, resolve_lsp_node, resolve_node, server_by_id, server_for_path,
    summaries, unpack, Capabilities, LogLevel, LspError, LspEvents, LspManager, NodeExecutable,
    PublishedDiagnostics, PythonExecutable, Runtime, ServerDef, ServerState, StartContext,
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
    /// The Node the servers run on: the bundle's, else portable, else system.
    node: Result<NodeExecutable, LspError>,
    /// A Node with npm next to it, for installing from npm (the bundled Node has none).
    npm_node: Result<NodeExecutable, LspError>,
    /// Python for Python-package language servers.
    python: Result<PythonExecutable, LspError>,
    bundle: Option<Bundle>,
    bundle_problem: Option<String>,
    path_prepend: Vec<PathBuf>,
    vars: Vec<(String, String)>,
}

async fn resolve(state: &AppState) -> Resolved {
    let environment = environment(state).await;
    let (bundle, bundle_problem) = match bundle::load(&state.app_root) {
        Ok(bundle) => (bundle, None),
        Err(problem) => {
            tracing::warn!(%problem, "LSP bundle not used");
            (None, Some(problem))
        }
    };
    let system = std::env::var_os("PATH");
    let python = openmind_runner::runtime::resolve_executable(
        "python",
        &environment,
        &[],
        system.as_deref(),
    )
    .map(|found| PythonExecutable {
        label: match found.source {
            openmind_runner::RuntimeSource::Portable => {
                match openmind_runner::portable_version(&found.path) {
                    Some(version) => format!("OpenMind portable Python {version}"),
                    None => "OpenMind portable Python".to_string(),
                }
            }
            openmind_runner::RuntimeSource::Project => "Project Python".to_string(),
            openmind_runner::RuntimeSource::System => "System Python".to_string(),
        },
        path: found.path,
    })
    .ok_or_else(|| LspError::InstallFailed("Python was not found. Install Python from the Runtime Manager.".into()));
    Resolved {
        node: resolve_lsp_node(
            bundle.as_ref().and_then(Bundle::node_path),
            &environment.path_prepend,
            system.clone(),
        ),
        npm_node: resolve_node(&environment.path_prepend, system),
        python,
        bundle,
        bundle_problem,
        path_prepend: environment.path_prepend,
        vars: environment.vars,
    }
}

/// Whether the bundle carries `def`'s package (for this app's revision).
fn bundled(resolved: &Resolved, def: &ServerDef) -> bool {
    let package = package_by_id(def.package);
    matches!((&resolved.bundle, package), (Some(bundle), Some(package)) if bundle.pack_for(package).is_some())
}

/// Why "Install" can't run for `def` right now, if it can't.
fn install_blocked(resolved: &Resolved, def: &ServerDef, live: &ServerState) -> Option<String> {
    if *live == ServerState::Installing {
        return Some("It is already installing.".to_string());
    }
    if bundled(resolved, def) {
        return None;
    }
    match package_by_id(def.package).map(|package| package.source) {
        Some(openmind_lsp::Source::Native) => Some(format!(
            "{} ships only in OpenMind Studio's offline LSP bundle, which this copy doesn't have.",
            def.name
        )),
        Some(openmind_lsp::Source::Python { .. }) => match &resolved.python {
            Err(err) => Some(err.to_string()),
            Ok(_) => None,
        },
        _ => match &resolved.npm_node {
            Err(err) => Some(err.to_string()),
            Ok(node) if node.npm_cli().is_none() => {
                Some("npm was not found next to Node.js. Repair the Node.js runtime.".to_string())
            }
            Ok(_) => None,
        },
    }
}

fn log_path(state: &AppState, server: &str) -> PathBuf {
    state
        .app_root
        .join("logs")
        .join("lsp")
        .join(format!("{server}.log"))
}

/// Where an installed server's files came from.
#[derive(Serialize, Clone, Copy, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
enum InstallSource {
    /// Unpacked from the offline bundle shipped with the app.
    Bundle,
    /// Installed from npm on the user's request.
    Download,
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
    runtime: Runtime,
    installed: bool,
    /// The offline bundle carries it: it is unpacked the first time it is needed, with no download.
    bundled: bool,
    install_source: Option<InstallSource>,
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

/// What the offline LSP bundle holds, for the Language Tools header.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BundleInfo {
    present: bool,
    /// Why a `lsp/bundle.json` that exists can't be used.
    problem: Option<String>,
    node_version: Option<String>,
    packs: usize,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LspSnapshot {
    workspace: Option<String>,
    /// Which Node.js the Node-based servers would run on, or why there is none.
    node: Option<String>,
    node_problem: Option<String>,
    bundle: BundleInfo,
    verbose: bool,
    servers: Vec<ServerInfo>,
}

fn install_source(root: &Path, def: &ServerDef, installed: bool) -> Option<InstallSource> {
    let package = package_by_id(def.package)?;
    installed.then(|| match unpack::unpacked_from(root, package) {
        Some(_) => InstallSource::Bundle,
        None => InstallSource::Download,
    })
}

fn bundle_info(resolved: &Resolved) -> BundleInfo {
    let usable = resolved
        .bundle
        .as_ref()
        .filter(|bundle| bundle.platform_supported());
    let foreign = resolved
        .bundle
        .as_ref()
        .filter(|bundle| !bundle.platform_supported())
        .map(|bundle| {
            format!(
                "The LSP bundle is built for {}, not this computer.",
                bundle.platform
            )
        });
    BundleInfo {
        present: usable.is_some(),
        problem: resolved.bundle_problem.clone().or(foreign),
        node_version: usable
            .filter(|bundle| bundle.node_path().is_some())
            .and_then(|bundle| bundle.node.as_ref().map(|node| node.version.clone())),
        packs: usable.map_or(0, |bundle| bundle.packs.len()),
    }
}

/// Per language server: whether the offline bundle carries it and whether it is installed (local reads only).
pub(crate) async fn server_facts(state: &AppState) -> Vec<(&'static str, bool, bool)> {
    let resolved = resolve(state).await;
    summaries()
        .into_iter()
        .filter_map(|summary| {
            let def = server_by_id(summary.id)?;
            let package = package_by_id(def.package)?;
            let installed = install::is_installed(&state.app_root, def, package);
            Some((def.id, bundled(&resolved, def), installed))
        })
        .collect()
}

#[tauri::command]
pub async fn lsp_status(state: State<'_, AppState>) -> Result<LspSnapshot, String> {
    let resolved = resolve(&state).await;
    let (node_label, node_problem) = match &resolved.node {
        Ok(node) => (Some(node.label()), None),
        Err(err) => (None, Some(err.to_string())),
    };
    let servers = summaries()
        .into_iter()
        .filter_map(|summary| {
            let def = server_by_id(summary.id)?;
            let package = package_by_id(def.package)?;
            let installed = install::is_installed(&state.app_root, def, package);
            let live = state.lsp.status(def.id);
            let blocked = install_blocked(&resolved, def, &live.state);
            let path = log_path(&state, def.id);
            Some(ServerInfo {
                id: summary.id,
                name: summary.name,
                languages: summary.languages,
                note: summary.note,
                contents: summary.contents,
                runtime: summary.runtime,
                installed,
                bundled: bundled(&resolved, def),
                install_source: install_source(&state.app_root, def, installed),
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
        bundle: bundle_info(&resolved),
        verbose: state.lsp.verbose(),
        servers,
    })
}

/// Makes the server ready: from the offline bundle when it carries it (no network), otherwise
/// from npm with its pinned lockfile. Only ever runs on the user's request.
#[tauri::command]
pub async fn lsp_install(server: String, state: State<'_, AppState>) -> Result<(), String> {
    let def = server_by_id(&server).ok_or("Unknown language server.")?;
    let resolved = resolve(&state).await;
    let manager: LspManager = state.lsp.clone();
    let root = state.app_root.clone();
    let carried = bundled(&resolved, def);
    if let Some(bundle) = resolved.bundle.filter(|_| carried) {
        return tokio::task::spawn_blocking(move || manager.prepare_bundled(def, &root, &bundle))
            .await
            .map_err(|err| format!("Unpacking stopped unexpectedly: {err}"))?
            .map(|_| ())
            .map_err(|err| err.to_string());
    }
    // npm downloads through the proxy the user configured (nothing when there is none).
    let proxy = crate::commands::network::process_env(&state).await;
    match package_by_id(def.package).map(|package| package.source) {
        Some(openmind_lsp::Source::Python { .. }) => {
            let python = resolved.python.map_err(|err| err.to_string())?;
            tokio::task::spawn_blocking(move || {
                manager.install_python_package_env(def, &root, &python, &proxy)
            })
            .await
            .map_err(|err| format!("The installer stopped unexpectedly: {err}"))?
            .map_err(|err| err.to_string())
        }
        _ => {
            let node = resolved.npm_node.map_err(|err| err.to_string())?;
            tokio::task::spawn_blocking(move || {
                manager.install_package_env(def, &root, &node, &proxy)
            })
            .await
            .map_err(|err| format!("The installer stopped unexpectedly: {err}"))?
            .map_err(|err| err.to_string())
        }
    }
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

/// Unpacks `def`'s package from the bundle when the bundle carries it and it isn't
/// installed yet (or came from another pack). Offline; a failure is the sync's answer.
async fn prepare_from_bundle(
    state: &AppState,
    def: &'static ServerDef,
    bundle: Option<Bundle>,
) -> Result<(), SyncOutcome> {
    let Some(bundle) = bundle else {
        return Ok(());
    };
    let manager = state.lsp.clone();
    let root = state.app_root.clone();
    tokio::task::spawn_blocking(move || manager.prepare_bundled(def, &root, &bundle))
        .await
        .map_err(|err| SyncOutcome::Failed {
            server: def.id,
            message: format!("Unpacking stopped unexpectedly: {err}"),
        })?
        .map(|_| ())
        .map_err(|err| SyncOutcome::Failed {
            server: def.id,
            message: err.to_string(),
        })
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
    let resolved = resolve(&state).await;
    if state.lsp.status(def.id).pid.is_none() {
        if let Err(outcome) = prepare_from_bundle(&state, def, resolved.bundle.clone()).await {
            return Ok(outcome);
        }
    }
    if !install::is_installed(&state.app_root, def, package) {
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
    let context = StartContext {
        app_root: state.app_root.clone(),
        workspace,
        node,
        python,
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
