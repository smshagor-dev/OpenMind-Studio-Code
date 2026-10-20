//! PascalABC.NET's app side. OpenMind Studio for Windows ships the official `PABCNETC.zip` unchanged in
//! `<app>/pascalabc-bundle` (with `bundle.json` and the licence texts). It is put in the Runtime Manager's download cache
//! before an install or repair of `pascalabc`, so those need no network (the install still checks its SHA-256 against
//! the manifest), and the bundled version is installed once by itself after start-up — a fresh install, and the first
//! start after an update that ships a newer one. Removing it in the Runtime Manager is remembered, so it isn't put back.
//! Nothing is ever started here: installing copies and unpacks files. The .NET Framework it needs is only detected.

use std::path::{Path, PathBuf};
use std::time::Duration;

use openmind_db::EditorSettingsRepository;
use openmind_runtime_manager::RuntimeManifest;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager, State};

use crate::app_state::AppState;
use crate::commands::runtime::{notify_changed, progress_sink};

/// The Runtime Manager item.
pub const KIND: &str = openmind_runner::PASCALABC_RUNTIME;
/// The shipped folder, next to the program (or `<app>` in a development build).
const BUNDLE_DIR: &str = "pascalabc-bundle";
const BUNDLE_FORMAT: &str = "openmind-pascalabc-bundle";
/// `editor_settings` key: the bundled version the user removed, so it isn't installed again by itself.
const DECLINED_KEY: &str = "pascalabc.bundled.removed";
/// After start-up, so the window and the session come first.
const START_DELAY: Duration = Duration::from_secs(20);

/// `bundle.json`.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct BundleFile {
    format: String,
    version: u32,
    compiler_version: String,
    file: String,
    sha256: String,
    size: u64,
    source: String,
    #[serde(default)]
    licenses: Vec<String>,
}

/// The bundled archive, checked against its own record.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Bundle {
    pub compiler_version: String,
    pub archive: PathBuf,
    pub sha256: String,
    pub size: u64,
}

/// Reads `<dir>/bundle.json`: `Ok(None)` when no bundle ships, an error when it is damaged or its archive is not the
/// recorded one (by name and size; the SHA-256 is checked by the install).
pub fn load_bundle(dir: &Path) -> Result<Option<Bundle>, String> {
    let record = dir.join("bundle.json");
    let text = match std::fs::read_to_string(&record) {
        Ok(text) => text,
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(err) => return Err(format!("The PascalABC.NET bundle can't be read: {err}")),
    };
    let file: BundleFile = serde_json::from_str(text.trim_start_matches('\u{feff}'))
        .map_err(|err| format!("The PascalABC.NET bundle record is damaged: {err}"))?;
    if file.format != BUNDLE_FORMAT || file.version != 1 {
        return Err("The PascalABC.NET bundle record is from another version of OpenMind.".into());
    }
    let plain = |name: &str| {
        !name.is_empty() && !name.contains(['/', '\\', ':']) && name != "." && name != ".."
    };
    if !plain(&file.file) || !file.licenses.iter().all(|name| plain(name)) {
        return Err("The PascalABC.NET bundle names a file outside its folder.".into());
    }
    if file.sha256.len() != 64 || !file.sha256.bytes().all(|b| b.is_ascii_hexdigit()) {
        return Err("The PascalABC.NET bundle record has no valid SHA-256.".into());
    }
    if !file.source.starts_with("https://") {
        return Err("The PascalABC.NET bundle record names no official source.".into());
    }
    let archive = dir.join(&file.file);
    let size = std::fs::metadata(&archive)
        .map_err(|_| format!("The bundled {} is missing.", file.file))?
        .len();
    if size != file.size {
        return Err(format!(
            "The bundled {} isn't the recorded file (its size differs).",
            file.file
        ));
    }
    Ok(Some(Bundle {
        compiler_version: file.compiler_version,
        archive,
        sha256: file.sha256.to_ascii_lowercase(),
        size,
    }))
}

/// The manifest's download the bundle stands in for: same version, same SHA-256 and size.
pub fn bundle_artifact<'a>(
    bundle: &Bundle,
    manifest: &'a RuntimeManifest,
    platform: &str,
) -> Result<&'a openmind_runtime_manager::manifest::Artifact, String> {
    let artifact = manifest
        .artifact(&bundle.compiler_version, platform)
        .ok_or_else(|| {
            format!(
                "The bundled PascalABC.NET {} isn't a version this OpenMind knows for this computer.",
                bundle.compiler_version
            )
        })?;
    if artifact.sha256 != bundle.sha256
        || artifact.size_bytes.is_some_and(|size| size != bundle.size)
    {
        return Err(
            "The bundled PascalABC.NET archive isn't the official file this OpenMind expects."
                .into(),
        );
    }
    Ok(artifact)
}

fn bundle_dir(state: &AppState) -> PathBuf {
    openmind_core::paths::shipped_dir(&state.app_root, BUNDLE_DIR)
}

/// Copies the bundled archive to where the Runtime Manager looks before downloading. `Ok(None)`: nothing ships (an
/// install then downloads from pascalabc.net); `Ok(Some(version))`: that version installs offline.
pub fn seed_download_cache(state: &AppState) -> Result<Option<String>, String> {
    let Some(bundle) = load_bundle(&bundle_dir(state))? else {
        return Ok(None);
    };
    let manifest = state
        .runtime
        .registry()
        .get(KIND)
        .map_err(|err| err.user_message())?;
    let artifact = bundle_artifact(
        &bundle,
        manifest,
        openmind_runtime_manager::current_platform(),
    )?;
    let cached = state
        .runtime
        .paths()
        .download_path(&artifact.sha256, &artifact.url);
    let present = std::fs::metadata(&cached).is_ok_and(|meta| meta.len() == bundle.size);
    if !present {
        let parent = cached.parent().ok_or("The download cache has no folder.")?;
        std::fs::create_dir_all(parent).map_err(|err| err.to_string())?;
        // Written beside it and renamed, so a half-copied file is never taken for the archive.
        let partial = cached.with_extension("bundle-copy");
        std::fs::copy(&bundle.archive, &partial)
            .and_then(|_| std::fs::rename(&partial, &cached))
            .map_err(|err| {
                let _ = std::fs::remove_file(&partial);
                format!("The bundled PascalABC.NET couldn't be copied to the download cache: {err}")
            })?;
    }
    Ok(Some(bundle.compiler_version))
}

/// Before an install or repair of PascalABC.NET: the bundled archive goes into the cache (a failure is logged; the
/// install then downloads).
pub fn before_install(state: &AppState) {
    if let Err(err) = seed_download_cache(state) {
        tracing::warn!(error = %err, "the bundled PascalABC.NET wasn't used");
    }
}

/// An install from the Runtime Manager forgets an earlier removal.
pub async fn after_user_install(state: &AppState) {
    if let Err(err) = EditorSettingsRepository::new(state.db.pool())
        .delete(DECLINED_KEY)
        .await
    {
        tracing::warn!(?err, "couldn't forget the removed bundled PascalABC.NET");
    }
}

/// The user removed `version`: the bundled copy of that version is not installed by itself again.
pub async fn after_user_delete(state: &AppState, version: &str) {
    if let Err(err) = EditorSettingsRepository::new(state.db.pool())
        .set(DECLINED_KEY, version)
        .await
    {
        tracing::warn!(?err, "couldn't remember the removed PascalABC.NET");
    }
}

/// Whether the bundled version should be installed now: shipped, not installed, not removed by the user.
fn wanted(bundled: &str, installed: &[String], declined: Option<&str>) -> bool {
    !installed.iter().any(|version| version == bundled) && declined != Some(bundled)
}

/// After start-up: installs the bundled PascalABC.NET when this copy ships one that isn't installed (a fresh install,
/// or an update with a newer version) and the user didn't remove it. Every outcome is logged; nothing is shown.
pub fn install_bundled_at_start(app: &AppHandle) {
    if !cfg!(windows) {
        return;
    }
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(START_DELAY).await;
        let state = app.state::<AppState>();
        let version = match seed_download_cache(&state) {
            Ok(Some(version)) => version,
            Ok(None) => return,
            Err(err) => {
                tracing::warn!(error = %err, "the bundled PascalABC.NET can't be installed");
                return;
            }
        };
        let installed: Vec<String> = match state.runtime.list().await {
            Ok(list) => list
                .into_iter()
                .find(|runtime| runtime.id == KIND)
                .map(|runtime| runtime.installed.into_iter().map(|v| v.version).collect())
                .unwrap_or_default(),
            Err(err) => {
                tracing::warn!(error = %err, "PascalABC.NET: the installed runtimes couldn't be read");
                return;
            }
        };
        let declined = EditorSettingsRepository::new(state.db.pool())
            .get(DECLINED_KEY)
            .await
            .ok()
            .flatten();
        if !wanted(&version, &installed, declined.as_deref()) {
            return;
        }
        match state
            .runtime
            .install(KIND, Some(&version), progress_sink(app.clone()))
            .await
        {
            Ok(_) => tracing::info!(%version, "installed the bundled PascalABC.NET"),
            Err(err) => {
                tracing::warn!(%version, error = %err, "the bundled PascalABC.NET wasn't installed")
            }
        }
        notify_changed(&app).await;
    });
}

#[derive(Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DotnetFrameworkStatus {
    /// "4.8.1", or `None` when .NET Framework 4.5+ isn't installed.
    pub version: Option<String>,
    /// 4.7.2 or later: what PascalABC.NET needs.
    pub satisfied: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PascalStatus {
    /// The compiler Run Code uses for the asking window's folder: `fpc` or `pascalabc`.
    pub compiler: String,
    /// PascalABC.NET can run on this platform at all (Windows).
    pub platform_supported: bool,
    pub dotnet_framework: DotnetFrameworkStatus,
    /// The version that ships with this copy, if any.
    pub bundled_version: Option<String>,
    /// Why the shipped bundle can't be used.
    pub bundle_problem: Option<String>,
}

pub fn dotnet_status(release: Option<u32>) -> DotnetFrameworkStatus {
    use openmind_core::dotnet_framework::{satisfies, version_name, RELEASE_4_7_2};
    DotnetFrameworkStatus {
        version: release.map(|release| version_name(release).to_string()),
        satisfied: satisfies(release, RELEASE_4_7_2),
    }
}

/// What the Runtime Manager card and Run Code show for Pascal (local reads only).
#[tauri::command]
pub async fn pascal_status(
    window: tauri::Window,
    state: State<'_, AppState>,
) -> Result<PascalStatus, String> {
    let folder = crate::windows::window_workspace(&state, window.label())
        .await
        .ok()
        .flatten()
        .map(|info| PathBuf::from(info.path));
    let options = crate::commands::run::pascal_options(&state, folder.as_deref());
    let (bundled_version, bundle_problem) = match load_bundle(&bundle_dir(&state)) {
        Ok(bundle) => (bundle.map(|b| b.compiler_version), None),
        Err(problem) => (None, Some(problem)),
    };
    Ok(PascalStatus {
        compiler: options.compiler.id().to_string(),
        platform_supported: cfg!(windows),
        dotnet_framework: dotnet_status(options.dotnet_framework),
        bundled_version,
        bundle_problem,
    })
}

#[cfg(test)]
#[path = "pascalabc_tests.rs"]
mod tests;
