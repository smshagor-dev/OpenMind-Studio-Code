//! Language Tools actions next to install/start: removing a language server that was downloaded (npm or pip), and
//! the workspace symbols of the running servers that offer them (Ctrl+T, the Search view's Symbols tab).

use std::time::Duration;

use openmind_lsp::registry::SERVERS;
use openmind_lsp::symbols::{parse_workspace_symbols, point_hits_at_names, WorkspaceSymbol};
use openmind_lsp::{install, package_by_id, server_by_id, unpack, ServerState};
use serde_json::json;
use tauri::{AppHandle, Emitter, State};

use crate::app_state::AppState;
use crate::commands::lsp::workspace_path;

/// One server's answer may take this long; a slow one is skipped, the others still count.
const SYMBOL_TIMEOUT: Duration = Duration::from_secs(5);
const MAX_SYMBOLS: usize = 500;

/// Symbols matching `query` from every running server that offers `workspace/symbol`, inside the open folder only,
/// best matches first. No server is started for this: with none running the answer is empty.
#[tauri::command]
pub async fn lsp_workspace_symbols(
    query: String,
    limit: Option<usize>,
    state: State<'_, AppState>,
) -> Result<Vec<WorkspaceSymbol>, String> {
    let Some(root) = workspace_path(&state).await else {
        return Ok(Vec::new());
    };
    let manager = state.lsp.clone();
    let limit = limit.unwrap_or(200).min(MAX_SYMBOLS);
    tokio::task::spawn_blocking(move || {
        let mut hits = Vec::new();
        for def in SERVERS {
            let status = manager.status(def.id);
            let offers = status
                .capabilities
                .as_ref()
                .is_some_and(|caps| caps.workspace_symbol);
            if status.state != ServerState::Running || !offers {
                continue;
            }
            match manager.request(
                def.id,
                "workspace/symbol",
                &json!({ "query": query }),
                SYMBOL_TIMEOUT,
            ) {
                Ok(answer) => {
                    let mut found = parse_workspace_symbols(&answer, &root, &query);
                    point_hits_at_names(&mut found);
                    hits.extend(found);
                }
                Err(err) => tracing::warn!(server = def.id, %err, "workspace symbols skipped"),
            }
        }
        hits.sort_by(|a, b| b.score.cmp(&a.score).then_with(|| a.name.cmp(&b.name)));
        hits.truncate(limit);
        hits
    })
    .await
    .map_err(|err| err.to_string())
}

/// Why `server` can't be removed now, if it can't.
fn uninstall_blocked(state: &AppState, server: &str) -> Result<(), String> {
    let def = server_by_id(server).ok_or_else(|| format!("Unknown language server: {server}"))?;
    let package = package_by_id(def.package).ok_or("Unknown language server package.")?;
    let members = SERVERS.iter().filter(|other| other.package == def.package);
    if members
        .clone()
        .any(|member| state.lsp.status(member.id).state == ServerState::Installing)
    {
        return Err(format!(
            "{} is installing. Wait for it to finish.",
            def.name
        ));
    }
    if !members
        .clone()
        .any(|member| install::is_installed(&state.app_root, member, package))
    {
        return Err(format!("{} is not installed.", def.name));
    }
    if unpack::unpacked_from(&state.app_root, package).is_some() {
        return Err(format!(
            "{} comes from OpenMind Studio's offline bundle and is unpacked again when needed; there is nothing to remove.",
            def.name
        ));
    }
    Ok(())
}

/// Removes a downloaded language server: its running processes are stopped first, then `language-servers/<package>/`
/// is deleted. Nothing outside that folder is touched (no Python, pip or npm state).
#[tauri::command]
pub async fn lsp_uninstall(
    server: String,
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<(), String> {
    uninstall_blocked(&state, &server)?;
    let def = server_by_id(&server).ok_or("Unknown language server.")?;
    let package = package_by_id(def.package).ok_or("Unknown language server package.")?;
    let manager = state.lsp.clone();
    let root = state.app_root.clone();
    let outcome = tokio::task::spawn_blocking(move || {
        for member in SERVERS.iter().filter(|other| other.package == def.package) {
            manager.stop(member.id);
        }
        install::uninstall(&root, package)
    })
    .await
    .map_err(|err| err.to_string())?;
    let _ = app.emit("lsp:changed", ());
    match outcome {
        Ok(()) => {
            tracing::info!(server = def.id, "language server removed");
            Ok(())
        }
        Err(err) => Err(err.to_string()),
    }
}
