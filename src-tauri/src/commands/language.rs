//! Language and project support (Milestone 14): the language registry, the status of the open folder's projects
//! (what was detected, which commands they have, which tools exist) and of one file, and a command rendered as a
//! line for a terminal. Everything is a lookup of files: nothing is run, installed or downloaded here, and the
//! machine's PATH is only read. The folder is always the asking window's, found server-side.

use std::path::{Path, PathBuf};

use openmind_language::{
    file_status, typed_line, workspace_status, FileStatus, LanguageDef, ShellStyle, ToolEnv,
    WorkspaceStatus, LANGUAGES,
};
use tauri::State;

use crate::app_state::AppState;

async fn workspace_root(state: &AppState, window: &tauri::Window) -> Result<PathBuf, String> {
    crate::windows::window_workspace(state, window.label())
        .await?
        .map(|workspace| PathBuf::from(workspace.path))
        .ok_or_else(|| "Open a folder first.".to_string())
}

/// The lookup environment: OpenMind's portable runtimes, then the machine's PATH (read, never written).
async fn tool_env(state: &AppState) -> ToolEnv {
    let portable = match state.runtime.environment().await {
        Ok(environment) => environment.path_prepend,
        Err(err) => {
            tracing::warn!(
                ?err,
                "could not read the runtime environment for tool lookup"
            );
            Vec::new()
        }
    };
    ToolEnv::from_process(portable)
}

/// Every language OpenMind knows (static data).
#[tauri::command]
pub fn language_registry() -> Vec<&'static LanguageDef> {
    LANGUAGES.iter().collect()
}

#[tauri::command]
pub async fn language_workspace_status(
    window: tauri::Window,
    state: State<'_, AppState>,
) -> Result<WorkspaceStatus, String> {
    let root = workspace_root(&state, &window).await?;
    let env = tool_env(&state).await;
    tokio::task::spawn_blocking(move || workspace_status(&root, &env))
        .await
        .map_err(|err| format!("the scan stopped unexpectedly: {err}"))
}

/// The language, language servers, formatters and linters of one file inside the open folder.
#[tauri::command]
pub async fn language_file_status(
    path: String,
    window: tauri::Window,
    state: State<'_, AppState>,
) -> Result<FileStatus, String> {
    let root = workspace_root(&state, &window).await?;
    let env = tool_env(&state).await;
    tokio::task::spawn_blocking(move || file_status_of(&root, Path::new(&path), &path, &env))
        .await
        .map_err(|err| format!("the lookup stopped unexpectedly: {err}"))?
}

fn file_status_of(
    root: &Path,
    file: &Path,
    shown: &str,
    env: &ToolEnv,
) -> Result<FileStatus, String> {
    let canonical =
        openmind_fs::path_safety::ensure_within_root(root, file).map_err(|err| err.to_string())?;
    let root_canonical = std::fs::canonicalize(root).map_err(|err| err.to_string())?;
    let workspace = workspace_status(&root_canonical, env);
    let mut status = file_status(&root_canonical, &canonical, env, &workspace);
    status.path = shown.replace('\\', "/");
    Ok(status)
}

/// The line to type into a terminal for a command (plain words stay plain; a line that can't be quoted safely is refused).
#[tauri::command]
pub fn language_terminal_line(argv: Vec<String>, style: ShellStyle) -> Result<String, String> {
    typed_line(&argv, style).map_err(|err| err.to_string())
}
