//! The language servers' status as the Language Tools list shows it — also the canonical state's language-server
//! domain. Local reads only.

use std::path::Path;

use openmind_lsp::{
    install, package_by_id, server_by_id, summaries, unpack, Capabilities, Runtime, ServerDef,
    ServerState,
};
use serde::Serialize;

use crate::app_state::AppState;

use super::events::log_path;
use super::folder::workspace_path;
use super::install::install_blocked;
use super::resolve::{bundled, resolve, Resolved};

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
    /// For a Python-package server (fortls): the Python it installs and runs with, and whether that is the computer's
    /// own Python because OpenMind's portable one isn't installed.
    python: Option<String>,
    python_is_system: bool,
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

/// What `lsp_status` returns: every server with its install state and live state (also the canonical state's
/// language-server domain).
pub(crate) async fn snapshot(state: &AppState) -> LspSnapshot {
    let resolved = resolve(state).await;
    let (node_label, node_problem) = match &resolved.node {
        Ok(node) => (Some(node.label()), None),
        Err(err) => (None, Some(err.to_string())),
    };
    let python_system = resolved
        .python
        .as_ref()
        .is_ok_and(|python| python.label.starts_with("System Python"));
    let servers = summaries()
        .into_iter()
        .filter_map(|summary| {
            let def = server_by_id(summary.id)?;
            let python = (def.runtime == Runtime::PythonModule)
                .then(|| {
                    resolved
                        .python
                        .as_ref()
                        .ok()
                        .map(|python| python.label.clone())
                })
                .flatten();
            let package = package_by_id(def.package)?;
            let installed = install::is_installed(&state.app_root, def, package);
            let live = state.lsp.status(def.id);
            let blocked = install_blocked(&resolved, def, &live.state);
            let path = log_path(state, def.id);
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
                python: python.clone(),
                python_is_system: python.is_some() && python_system,
                log_exists: path.is_file(),
                log_path: path.display().to_string(),
            })
        })
        .collect();
    LspSnapshot {
        workspace: workspace_path(state)
            .await
            .map(|path| path.display().to_string()),
        node: node_label,
        node_problem,
        bundle: bundle_info(&resolved),
        verbose: state.lsp.verbose(),
        servers,
    }
}
