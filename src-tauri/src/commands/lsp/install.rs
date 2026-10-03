//! Making a server ready: unpacking it from the offline bundle (no network), or — only on the user's request —
//! installing it from npm, pip or its pinned native archive.

use std::path::Path;

use openmind_lsp::bundle::Bundle;
use openmind_lsp::{package_by_id, server_by_id, LspManager, ServerDef, ServerState};

use crate::app_state::AppState;

use super::resolve::{bundled, resolve, Resolved};
use super::SyncOutcome;

/// Why "Install" can't run for `def` right now, if it can't.
pub(super) fn install_blocked(
    resolved: &Resolved,
    def: &ServerDef,
    live: &ServerState,
) -> Option<String> {
    if *live == ServerState::Installing {
        return Some("It is already installing.".to_string());
    }
    if bundled(resolved, def) {
        return None;
    }
    match package_by_id(def.package).map(|package| package.source) {
        // Its pinned release archive can be downloaded (the same address and SHA-256 the bundle is built from).
        Some(openmind_lsp::Source::Native)
            if openmind_lsp::native_download(def.package).is_some() =>
        {
            None
        }
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

pub(super) async fn install_server(server: &str, state: &AppState) -> Result<(), String> {
    let def = server_by_id(server).ok_or("Unknown language server.")?;
    let resolved = resolve(state).await;
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
    let proxy = crate::commands::network::process_env(state).await;
    match package_by_id(def.package).map(|package| package.source) {
        Some(openmind_lsp::Source::Native) => {
            let cache = root.join("cache").join("downloads");
            tokio::task::spawn_blocking(move || {
                manager.install_native(def, &root, |download, staging, log| {
                    fetch_native(&cache, download, staging, log)
                })
            })
            .await
            .map_err(|err| format!("The installer stopped unexpectedly: {err}"))?
            .map_err(|err| err.to_string())
        }
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

/// Downloads a native server's pinned archive into the download cache (through the app's network route, resumable),
/// checks its SHA-256 and unpacks it into `staging` with the archive's own folder stripped. A cached archive whose
/// checksum still matches is reused.
fn fetch_native(
    cache: &Path,
    download: &openmind_lsp::NativeDownload,
    staging: &Path,
    log: &dyn Fn(&str),
) -> Result<(), String> {
    use openmind_runtime_manager::download::{download as fetch, verify_sha256};
    use openmind_runtime_manager::extract::{extract_zip, ExtractSelection};
    std::fs::create_dir_all(cache).map_err(|err| err.to_string())?;
    let name = download.url.rsplit('/').next().unwrap_or("archive.zip");
    let archive = cache.join(format!("{}-{name}", &download.sha256[..12]));
    let cached =
        archive.is_file() && verify_sha256(&archive, &download.sha256, &mut |_, _| {}).is_ok();
    if !cached {
        let client = openmind_runtime_manager::UreqClient::new();
        fetch(&client, &download.url, &archive, None, &mut |_, _| {})
            .map_err(|err| err.user_message())?;
        verify_sha256(&archive, &download.sha256, &mut |_, _| {})
            .map_err(|err| err.user_message())?;
        log(&format!(
            "Downloaded and verified (SHA-256 {}).",
            download.sha256
        ));
    } else {
        log("Using the verified copy in the download cache.");
    }
    extract_zip(
        &archive,
        staging,
        ExtractSelection {
            strip_components: download.strip_components,
            only_under: None,
        },
        &mut |_, _| {},
    )
    .map_err(|err| err.user_message())?;
    log(&format!("Unpacked {}.", download.contents));
    Ok(())
}

/// Unpacks `def`'s package from the bundle when the bundle carries it and it isn't
/// installed yet (or came from another pack). Offline; a failure is the sync's answer.
pub(super) async fn prepare_from_bundle(
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
