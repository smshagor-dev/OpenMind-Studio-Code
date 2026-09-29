//! Network: offline packages. Files the user brings (USB drive, another computer) are recognized, checked and kept
//! in `cache/offline`; a runtime archive goes where the Runtime Manager looks for its downloads, so installing it
//! needs no network. Nothing is installed or run by importing; global package-manager caches are never touched.

use std::path::{Path, PathBuf};

use openmind_network::env::file_url;
use openmind_network::offline::{
    extract_source, inspect, CacheEntry, Inspection, KnownArtifact, OfflineCache, PackageKind,
};
use openmind_network::wheelhouse::{offline_install_argv, parse_requirements, wheel_files};
use serde::Serialize;
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

/// A wheel that wasn't imported, and why (another platform, not a wheel file name ...).
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RefusedWheel {
    file: String,
    reason: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WheelFolderImport {
    imported: Vec<CacheEntry>,
    refused: Vec<RefusedWheel>,
}

/// Import Wheels: every `.whl` directly in `folder` is inspected; the ones for this computer are copied into the
/// wheelhouse (checked by SHA-256), the others are listed with the reason. Nothing is installed.
#[tauri::command]
pub async fn network_offline_import_wheels(
    folder: String,
    state: State<'_, AppState>,
) -> Result<WheelFolderImport, String> {
    let folder = absolute_file(&folder)?;
    let platform = state.runtime.platform().to_string();
    let cache = cache(&state);
    let result =
        tauri::async_runtime::spawn_blocking(move || -> Result<WheelFolderImport, String> {
            let files =
                wheel_files(&folder).map_err(|err| format!("{}: {err}", folder.display()))?;
            if files.is_empty() {
                return Err("There are no .whl files in that folder.".to_string());
            }
            let mut imported = Vec::new();
            let mut refused = Vec::new();
            for file in files {
                let name = file
                    .file_name()
                    .map(|n| n.to_string_lossy().into_owned())
                    .unwrap_or_default();
                let outcome = inspect(&file, &[], &platform)
                    .map_err(|err| err.to_string())
                    .and_then(|found| {
                        if found.kind != Some(PackageKind::Wheel) {
                            return Err(found
                                .reason
                                .unwrap_or_else(|| "This isn't a wheel.".to_string()));
                        }
                        cache.import(&found, None).map_err(|err| err.to_string())
                    });
                match outcome {
                    Ok(entry) => imported.push(entry),
                    Err(reason) => refused.push(RefusedWheel { file: name, reason }),
                }
            }
            Ok(WheelFolderImport { imported, refused })
        })
        .await
        .map_err(|err| err.to_string())??;
    tracing::info!(
        imported = result.imported.len(),
        refused = result.refused.len(),
        "offline wheels imported"
    );
    Ok(result)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Wheelhouse {
    folder: String,
    /// The folder as the file URL pip reads (works with spaces).
    url: String,
    wheels: Vec<CacheEntry>,
}

/// The imported wheels and where they are (local reads only).
#[tauri::command]
pub fn network_wheelhouse(state: State<'_, AppState>) -> Wheelhouse {
    let cache = cache(&state);
    let folder = cache.wheelhouse();
    Wheelhouse {
        url: file_url(&folder),
        folder: folder.display().to_string(),
        wheels: cache
            .list()
            .into_iter()
            .filter(|entry| entry.kind == PackageKind::Wheel)
            .collect(),
    }
}

/// The argument list that installs `requirements` from the wheelhouse only (`--no-index`: no network request). The
/// frontend quotes it for the terminal's shell and types it there when the user clicks Install.
#[tauri::command]
pub fn network_wheelhouse_command(
    requirements: String,
    state: State<'_, AppState>,
) -> Result<Vec<String>, String> {
    let requirements = parse_requirements(&requirements).map_err(|err| err.to_string())?;
    let folder = cache(&state).wheelhouse();
    if !folder.is_dir() {
        return Err("No wheels are imported yet. Import a wheel folder first.".to_string());
    }
    Ok(offline_install_argv(&folder, &requirements))
}
