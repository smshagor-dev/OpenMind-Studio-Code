//! Network: offline packages. Files the user brings (USB drive, another computer) are recognized, checked and kept
//! in `cache/offline`; a runtime archive goes where the Runtime Manager looks for its downloads, so installing it
//! needs no network. Nothing is installed or run by importing; global package-manager caches are never touched.

use std::path::{Path, PathBuf};

use openmind_network::offline::{
    extract_source, inspect, CacheEntry, Inspection, KnownArtifact, OfflineCache,
};
use tauri::State;

use crate::app_state::AppState;

pub(crate) fn cache(state: &AppState) -> OfflineCache {
    let downloads = state.runtime.paths().downloads_dir();
    OfflineCache::new(
        downloads
            .parent()
            .map(Path::to_path_buf)
            .unwrap_or(downloads),
    )
}

/// Every runtime archive the manifests list, so an imported one is recognized by its SHA-256.
fn known(state: &AppState) -> Vec<KnownArtifact> {
    let mut all = Vec::new();
    for manifest in state.runtime.registry().all() {
        for version in &manifest.versions {
            for artifact in &version.artifacts {
                all.push(KnownArtifact {
                    runtime: manifest.id.clone(),
                    display_name: manifest.display_name.clone(),
                    version: version.version.clone(),
                    platform: artifact.platform.clone(),
                    sha256: artifact.sha256.clone(),
                });
            }
        }
    }
    all
}

fn absolute_file(path: &str) -> Result<PathBuf, String> {
    let path = PathBuf::from(path);
    if !path.is_absolute() || path.to_string_lossy().contains('\0') {
        return Err("Choose a file with the file dialog.".to_string());
    }
    Ok(path)
}

/// What a file is and whether it can be imported (nothing is copied).
#[tauri::command]
pub async fn network_offline_inspect(
    path: String,
    state: State<'_, AppState>,
) -> Result<Inspection, String> {
    let path = absolute_file(&path)?;
    let known = known(&state);
    let platform = state.runtime.platform().to_string();
    tauri::async_runtime::spawn_blocking(move || inspect(&path, &known, &platform))
        .await
        .map_err(|err| err.to_string())?
        .map_err(|err| err.to_string())
}

/// Imports a file: it is inspected again, copied into the app's cache and checked against its SHA-256.
#[tauri::command]
pub async fn network_offline_import(
    path: String,
    state: State<'_, AppState>,
) -> Result<CacheEntry, String> {
    let path = absolute_file(&path)?;
    let known = known(&state);
    let platform = state.runtime.platform().to_string();
    let cache = cache(&state);
    let registry_urls: Vec<(String, String)> = state
        .runtime
        .registry()
        .all()
        .flat_map(|m| {
            m.versions.iter().flat_map(|v| {
                v.artifacts
                    .iter()
                    .map(|a| (a.sha256.clone(), a.url.clone()))
            })
        })
        .collect();
    let paths = state.runtime.paths().clone();
    let entry = tauri::async_runtime::spawn_blocking(move || {
        let inspection = inspect(&path, &known, &platform).map_err(|err| err.to_string())?;
        let target = registry_urls
            .iter()
            .find(|(sha, _)| sha.eq_ignore_ascii_case(&inspection.sha256))
            .map(|(sha, url)| paths.download_path(sha, url));
        cache
            .import(&inspection, target.as_deref())
            .map_err(|err| err.to_string())
    })
    .await
    .map_err(|err| err.to_string())??;
    tracing::info!(kind = ?entry.kind, name = %entry.name, "offline package imported");
    Ok(entry)
}

#[tauri::command]
pub fn network_offline_list(state: State<'_, AppState>) -> Vec<CacheEntry> {
    cache(&state).list()
}

#[tauri::command]
pub fn network_offline_remove(id: String, state: State<'_, AppState>) -> Result<(), String> {
    cache(&state).remove(&id).map_err(|err| err.to_string())
}

#[tauri::command]
pub fn network_offline_clear(state: State<'_, AppState>) -> Result<(), String> {
    cache(&state).clear().map_err(|err| err.to_string())
}

/// The offline cache folder (created if missing), for "Open Package Cache Folder".
#[tauri::command]
pub fn network_offline_folder(state: State<'_, AppState>) -> Result<String, String> {
    let folder = cache(&state).folder();
    std::fs::create_dir_all(&folder).map_err(|err| err.to_string())?;
    Ok(folder.display().to_string())
}

/// The file of an imported entry (a .vsix to hand to the extension installer).
#[tauri::command]
pub fn network_offline_path(id: String, state: State<'_, AppState>) -> Result<String, String> {
    let cache = cache(&state);
    let entry = cache
        .list()
        .into_iter()
        .find(|e| e.id == id)
        .ok_or("That package is not in the offline cache.")?;
    let path = cache
        .path_of(&entry)
        .filter(|p| p.is_file())
        .ok_or("The package's file is missing.")?;
    Ok(path.display().to_string())
}

/// Extracts an imported source archive into `destination` (missing or empty; nothing is ever overwritten).
#[tauri::command]
pub async fn network_offline_extract(
    id: String,
    destination: String,
    state: State<'_, AppState>,
) -> Result<usize, String> {
    let archive = PathBuf::from(network_offline_path(id, state)?);
    let destination = absolute_file(&destination)?;
    tauri::async_runtime::spawn_blocking(move || extract_source(&archive, &destination))
        .await
        .map_err(|err| err.to_string())?
        .map_err(|err| err.to_string())
}
