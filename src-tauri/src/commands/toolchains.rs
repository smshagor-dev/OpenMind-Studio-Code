//! Bundled toolchain packs (`<app>/tools`, `tools/toolchains.json`): what is there, which version is active, and the
//! folders that go on the PATH of processes OpenMind itself starts. Read-only: nothing is downloaded or installed
//! here, and the system PATH is never touched.

use std::collections::HashMap;
use std::path::PathBuf;

use openmind_db::EditorSettingsRepository;
use openmind_toolchains::{current_platform, load, verify, Packs, ToolStatus, VerifyResult};
use tauri::State;

use crate::app_state::AppState;

/// `editor_settings` key: `{ "<tool id>": "<version>" }`, the user's chosen active versions.
const ACTIVE_KEY: &str = "toolchains.active";

async fn chosen(state: &AppState) -> HashMap<String, String> {
    let stored = EditorSettingsRepository::new(state.db.pool())
        .get(ACTIVE_KEY)
        .await
        .ok()
        .flatten();
    stored
        .and_then(|text| serde_json::from_str(&text).ok())
        .unwrap_or_default()
}

/// The packs as they are on disk right now (cheap: one manifest read and a file check per listed version).
pub(crate) async fn packs(state: &AppState) -> Packs {
    let chosen = chosen(state).await;
    let root = state.app_root.clone();
    tokio::task::spawn_blocking(move || load(&root, current_platform(), &chosen))
        .await
        .unwrap_or_else(|err| {
            tracing::warn!(%err, "reading the toolchain packs stopped unexpectedly");
            load(
                std::path::Path::new(""),
                current_platform(),
                &HashMap::new(),
            )
        })
}

/// The folders of the active bundled programs, for the PATH of a process OpenMind starts. A debugger's files are
/// not a command, so they are not put on a PATH.
pub(crate) async fn bundled_dirs(state: &AppState) -> Vec<PathBuf> {
    packs(state).await.injection().path_prepend
}

/// The PATH folders and the variables of the active tools (the Rust toolchain's `RUSTUP_HOME`/`CARGO_HOME`), for a
/// process OpenMind starts.
pub(crate) async fn injection(state: &AppState) -> openmind_toolchains::Injection {
    packs(state).await.injection()
}

/// The folder holding `debugpy/adapter/__main__.py` of the active bundled debugpy, when there is one.
pub(crate) async fn debugpy_dir(state: &AppState) -> Option<PathBuf> {
    debugpy_root(&packs(state).await.active_program("debugpy")?)
}

/// `<dir>/debugpy/adapter/__main__.py` -> `<dir>`, only when that entry file exists.
fn debugpy_root(entry: &std::path::Path) -> Option<PathBuf> {
    let dir = entry.ancestors().nth(3)?;
    (dir.join("debugpy").join("adapter").join("__main__.py") == entry && entry.is_file())
        .then(|| dir.to_path_buf())
}

/// The active bundled Composer when it is a `composer.phar` (the control panel runs it on OpenMind's PHP).
pub(crate) async fn composer_phar(state: &AppState) -> Option<PathBuf> {
    let program = packs(state).await.active_program("composer")?;
    (program.extension().is_some_and(|e| e == "phar")).then_some(program)
}

/// Makes `version` the active one for `id`. Only a version that is listed and really present can be chosen.
#[tauri::command]
pub async fn toolchains_set_active(
    id: String,
    version: String,
    app: tauri::AppHandle,
    state: State<'_, AppState>,
) -> Result<Packs, String> {
    let current = packs(&state).await;
    let tool = current
        .tool(&id)
        .ok_or_else(|| format!("Unknown tool \"{id}\"."))?;
    if !current.can_select(&id, &version) {
        return Err(format!(
            "{} {version} is not available: it isn't listed in tools/toolchains.json or its program is missing.",
            tool.name
        ));
    }
    let mut map = chosen(&state).await;
    map.insert(id, version);
    let text = serde_json::to_string(&map).map_err(|err| err.to_string())?;
    EditorSettingsRepository::new(state.db.pool())
        .set(ACTIVE_KEY, &text)
        .await
        .map_err(|err| err.to_string())?;
    crate::sync::announce_now(&app, crate::sync::Topic::Tools).await;
    Ok(packs(&state).await)
}

/// Verify (on a click): the program exists and, when the manifest says how, prints its version.
#[tauri::command]
pub async fn toolchains_verify(
    id: String,
    version: Option<String>,
    state: State<'_, AppState>,
) -> Result<VerifyResult, String> {
    let current = packs(&state).await;
    let tool = current
        .tool(&id)
        .ok_or_else(|| format!("Unknown tool \"{id}\"."))?;
    let wanted = version.or_else(|| tool.active_version.clone());
    let Some(entry) = wanted.and_then(|w| tool.versions.iter().find(|v| v.version == w)) else {
        return Ok(VerifyResult {
            ok: false,
            message: if tool.status == ToolStatus::External {
                "This tool isn't bundled; OpenMind only looks for it on your computer.".into()
            } else {
                "No bundled version to verify.".into()
            },
            executed: false,
            output: None,
        });
    };
    let program = PathBuf::from(&entry.path);
    let args = entry.verify_args.clone();
    tokio::task::spawn_blocking(move || verify(&program, args.as_deref()))
        .await
        .map_err(|err| format!("the check stopped unexpectedly: {err}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_debugpy_folder_is_the_one_holding_the_adapter_entry() {
        let dir = tempfile::tempdir().expect("tmp");
        let entry = dir
            .path()
            .join("1.8.5")
            .join("debugpy")
            .join("adapter")
            .join("__main__.py");
        std::fs::create_dir_all(entry.parent().expect("parent")).expect("dirs");
        assert!(
            debugpy_root(&entry).is_none(),
            "a missing file is not a debugger"
        );
        std::fs::write(&entry, "").expect("file");
        assert_eq!(debugpy_root(&entry), Some(dir.path().join("1.8.5")));
        let elsewhere = dir.path().join("1.8.5").join("other.py");
        std::fs::write(&elsewhere, "").expect("file");
        assert!(
            debugpy_root(&elsewhere).is_none(),
            "only the adapter entry counts"
        );
    }
}
