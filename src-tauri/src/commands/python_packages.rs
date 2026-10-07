//! The offline Python package bundle (`<app>/python-bundle`, see `openmind_runtime_manager::python_bundle`): installed
//! into a portable Python right after the Runtime Manager installs it (so `import numpy, pandas, cv2, flask, tkinter`
//! work at once), and again on request (Command Palette > "Python: Install Bundled Packages"). Only that install
//! changes: the user's own Python, PATH and pip are never touched, and nothing is downloaded.

use std::path::PathBuf;

use openmind_runtime_manager::manager::{InstallPhase, InstallProgress, ProgressSink};
use openmind_runtime_manager::python_bundle::{self, PythonBundle};
use serde::Serialize;
use tauri::{AppHandle, State};

use crate::app_state::AppState;
use crate::commands::runtime::progress_sink;

const KIND: &str = "python";

fn bundle_dir(state: &AppState) -> PathBuf {
    state.app_root.join("python-bundle")
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PythonBundleStatus {
    /// A bundle ships with this copy.
    pub present: bool,
    /// Why it can't be used (damaged `bundle.json`).
    pub problem: Option<String>,
    /// The Python line its wheels are for (`3.14`).
    pub python: Option<String>,
    pub packages: Vec<String>,
    pub stdlib: Vec<String>,
}

/// What ships with this copy (a local read).
#[tauri::command]
pub fn python_packages_status(state: State<'_, AppState>) -> PythonBundleStatus {
    match PythonBundle::load(&bundle_dir(&state)) {
        Ok(Some(bundle)) => PythonBundleStatus {
            present: true,
            problem: None,
            python: Some(bundle.python.clone()),
            packages: bundle.packages.iter().map(|p| p.name.clone()).collect(),
            stdlib: bundle.stdlib.clone(),
        },
        Ok(None) => PythonBundleStatus {
            present: false,
            problem: None,
            python: None,
            packages: Vec::new(),
            stdlib: Vec::new(),
        },
        Err(problem) => PythonBundleStatus {
            present: false,
            problem: Some(problem),
            python: None,
            packages: Vec::new(),
            stdlib: Vec::new(),
        },
    }
}

fn report(progress: &ProgressSink, version: &str, phase: InstallPhase) {
    progress(InstallProgress {
        kind: KIND.into(),
        version: version.into(),
        phase,
        current: 0,
        total: None,
    });
}

/// Tcl/Tk (tkinter) from the bundle: its archive is put where the Runtime Manager looks before downloading (the
/// add-on install checks the SHA-256 again), so no network is needed. Skipped when the version has no such add-on.
async fn add_tcltk(state: &AppState, bundle: &PythonBundle, version: &str, progress: ProgressSink) {
    let dir = bundle_dir(state);
    let Some((archive, addon)) = bundle.addon_archive(&dir) else {
        return;
    };
    let has_addon = state
        .runtime
        .registry()
        .get(KIND)
        .ok()
        .and_then(|manifest| {
            manifest
                .versions
                .iter()
                .find(|v| v.version == version)
                .cloned()
        })
        .is_some_and(|v| v.addons.iter().any(|a| a.id == addon.id));
    if !has_addon {
        return;
    }
    let cached = state
        .runtime
        .paths()
        .download_path(&addon.sha256, &addon.url);
    if !cached.exists() {
        if let Some(parent) = cached.parent() {
            let _ = std::fs::create_dir_all(parent);
        }
        if let Err(err) = std::fs::copy(&archive, &cached) {
            tracing::warn!(%err, "the bundled Tcl/Tk package couldn't be copied to the download cache");
        }
    }
    if let Err(err) = state
        .runtime
        .install_addon(KIND, version, &addon.id, progress)
        .await
    {
        tracing::warn!(%version, error = %err, "the bundled Tcl/Tk add-on wasn't added");
    }
}

/// Installs the bundle into Python `version` (Tcl/Tk first, so `tkinter` is part of the final import check).
/// `Ok(None)` when nothing ships or the bundle is for another Python line.
pub async fn install_into(
    state: &AppState,
    version: &str,
    progress: ProgressSink,
) -> Result<Option<String>, String> {
    let dir = bundle_dir(state);
    let Some(bundle) = PythonBundle::load(&dir)? else {
        return Ok(None);
    };
    if !bundle.fits(version) {
        return Ok(None);
    }
    add_tcltk(state, &bundle, version, progress.clone()).await;
    let python_dir = state
        .runtime
        .paths()
        .version_dir(KIND, version)
        .map_err(|err| err.user_message())?;
    let env = state
        .runtime
        .registry()
        .get(KIND)
        .map(|manifest| manifest.env.clone())
        .unwrap_or_default();
    let work = state.paths.temp_dir.join("python-bundle").join(version);
    report(&progress, version, InstallPhase::Finalize);
    let result = tauri::async_runtime::spawn_blocking(move || {
        let result = python_bundle::install_packages(&bundle, &dir, &python_dir, &work, &env);
        // The unpacked wheels are gone; the empty `temp/python-bundle` goes too (only when empty).
        if let Some(parent) = work.parent() {
            let _ = std::fs::remove_dir(parent);
        }
        result
    })
    .await
    .map_err(|err| err.to_string())?;
    report(&progress, version, InstallPhase::Done);
    match result {
        Ok(record) => {
            tracing::info!(%version, packages = record.packages.len(), "bundled Python packages installed");
            Ok(Some(format!(
                "Python {version}: the bundled packages are installed ({}).",
                record.packages.join(", ")
            )))
        }
        Err(err) => {
            tracing::warn!(%version, error = %err, "bundled Python packages were not installed");
            Err(format!(
                "The bundled Python packages weren't installed: {err}"
            ))
        }
    }
}

/// "Python: Install Bundled Packages": into `version`, or the active portable Python.
#[tauri::command]
pub async fn python_packages_install(
    version: Option<String>,
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<String, String> {
    let version = match version {
        Some(version) => version,
        None => state
            .runtime
            .list()
            .await
            .map_err(|err| err.user_message())?
            .into_iter()
            .find(|status| status.id == KIND)
            .and_then(|status| status.active_version)
            .ok_or(
                "No portable Python is installed. Install Python from the Runtime Manager first.",
            )?,
    };
    let message = install_into(&state, &version, progress_sink(app.clone())).await?;
    crate::commands::runtime::notify_changed(&app).await;
    crate::sync::announce_now(&app, crate::sync::Topic::Packages).await;
    message.ok_or_else(|| {
        format!("OpenMind Studio's Python bundle is for another Python line, or this copy has none (Python {version}).")
    })
}
