//! Source Control commands. The backend decides which folder is the
//! repository (the open workspace's), so the UI never sends a repository path
//! and can't point Git at anything else; it only sends repo-relative file
//! names, which the Git crate checks. Git runs on a worker thread, as an
//! argument list, and every command is reported to the Git output channel.

use std::ffi::OsString;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use openmind_db::EditorSettingsRepository;
use openmind_git::{
    find_system, resolve, Branch, DiffSides, GitClient, GitError, Identity, LogEntry, RepoStatus,
};
use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, State};

use crate::app_state::AppState;
use crate::commands::run::environment;

const ALLOW_SYSTEM_KEY: &str = "git.allowSystem";

/// What the Source Control view is showing right now.
#[derive(Debug, Serialize)]
#[serde(tag = "state", rename_all = "camelCase")]
pub enum GitSnapshot {
    NoWorkspace,
    #[serde(rename_all = "camelCase")]
    GitMissing {
        reason: String,
        /// A Git found on the machine's PATH that the user could choose to use.
        system_git: Option<String>,
    },
    #[serde(rename_all = "camelCase")]
    NotRepository {
        git: String,
    },
    #[serde(rename_all = "camelCase")]
    Repository {
        root: String,
        name: String,
        git: String,
        status: RepoStatus,
    },
}

async fn allow_system(state: &AppState) -> bool {
    EditorSettingsRepository::new(state.db.pool())
        .get(ALLOW_SYSTEM_KEY)
        .await
        .ok()
        .flatten()
        .is_some_and(|value| value == "true")
}

async fn workspace_path(state: &AppState) -> Result<PathBuf, String> {
    let workspace = state
        .workspace_folder
        .active_workspace()
        .await
        .map_err(|err| err.to_string())?
        .ok_or_else(|| "Open a folder to use Source Control.".to_string())?;
    Ok(PathBuf::from(workspace.path))
}

/// Portable Git first; the system's only if the user allowed it.
async fn build_client(app: &AppHandle, state: &AppState) -> Result<GitClient, GitError> {
    let portable = environment(state).await.path_prepend;
    let exe = resolve(
        &portable,
        allow_system(state).await,
        std::env::var_os("PATH"),
    )?;
    let handle = app.clone();
    Ok(GitClient::new(
        exe,
        Arc::new(move |entry: LogEntry| {
            let _ = handle.emit("git:log", entry);
        }),
        state.git.clone(),
    ))
}

/// Runs `operation` against the open workspace's repository on a worker thread.
async fn on_repo<T, F>(app: &AppHandle, state: &AppState, operation: F) -> Result<T, String>
where
    T: Send + 'static,
    F: FnOnce(&GitClient, &Path) -> Result<T, GitError> + Send + 'static,
{
    let workspace = workspace_path(state).await?;
    let client = build_client(app, state)
        .await
        .map_err(|err| err.to_string())?;
    tokio::task::spawn_blocking(move || {
        let root = client.find_root(&workspace)?;
        operation(&client, &root)
    })
    .await
    .map_err(|err| format!("Git stopped unexpectedly: {err}"))?
    .map_err(|err| err.to_string())
}

#[tauri::command]
pub async fn git_snapshot(
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<GitSnapshot, String> {
    let Ok(workspace) = workspace_path(&state).await else {
        return Ok(GitSnapshot::NoWorkspace);
    };
    let client = match build_client(&app, &state).await {
        Ok(client) => client,
        Err(err) => {
            let system_git: Option<OsString> = std::env::var_os("PATH");
            return Ok(GitSnapshot::GitMissing {
                reason: err.to_string(),
                system_git: find_system(system_git).map(|path| path.display().to_string()),
            });
        }
    };
    let git = client.executable().label();
    let outcome = tokio::task::spawn_blocking(move || match client.find_root(&workspace) {
        Ok(root) => client.status(&root).map(|status| Some((root, status))),
        Err(GitError::NotARepository) => Ok(None),
        Err(err) => Err(err),
    })
    .await
    .map_err(|err| format!("Git stopped unexpectedly: {err}"))?
    .map_err(|err| err.to_string())?;
    Ok(match outcome {
        None => GitSnapshot::NotRepository { git },
        Some((root, status)) => GitSnapshot::Repository {
            name: root.file_name().map_or_else(
                || root.display().to_string(),
                |n| n.to_string_lossy().into(),
            ),
            root: root.display().to_string(),
            git,
            status,
        },
    })
}

#[tauri::command]
pub async fn git_init(app: AppHandle, state: State<'_, AppState>) -> Result<(), String> {
    let workspace = workspace_path(&state).await?;
    let client = build_client(&app, &state)
        .await
        .map_err(|err| err.to_string())?;
    tokio::task::spawn_blocking(move || client.init(&workspace).map(drop))
        .await
        .map_err(|err| err.to_string())?
        .map_err(|err| err.to_string())
}

#[tauri::command]
pub async fn git_stage(
    paths: Vec<String>,
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<(), String> {
    on_repo(&app, &state, move |git, root| git.stage(root, &paths)).await
}

#[tauri::command]
pub async fn git_stage_all(app: AppHandle, state: State<'_, AppState>) -> Result<(), String> {
    on_repo(&app, &state, |git, root| git.stage_all(root)).await
}

#[tauri::command]
pub async fn git_unstage(
    paths: Vec<String>,
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<(), String> {
    on_repo(&app, &state, move |git, root| git.unstage(root, &paths)).await
}

#[tauri::command]
pub async fn git_unstage_all(app: AppHandle, state: State<'_, AppState>) -> Result<(), String> {
    on_repo(&app, &state, |git, root| git.unstage_all(root)).await
}

#[tauri::command]
pub async fn git_discard(
    paths: Vec<String>,
    confirmed: bool,
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<(), String> {
    on_repo(&app, &state, move |git, root| {
        git.discard(root, &paths, confirmed)
    })
    .await
}

#[tauri::command]
pub async fn git_discard_all(
    confirmed: bool,
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<(), String> {
    on_repo(&app, &state, move |git, root| {
        git.discard_all(root, confirmed)
    })
    .await
}

#[tauri::command]
pub async fn git_delete_untracked(
    path: String,
    confirmed: bool,
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<(), String> {
    on_repo(&app, &state, move |git, root| {
        git.delete_untracked(root, &path, confirmed)
    })
    .await
}

#[tauri::command]
pub async fn git_commit(
    message: String,
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<String, String> {
    on_repo(&app, &state, move |git, root| git.commit(root, &message)).await
}

#[tauri::command]
pub async fn git_identity(app: AppHandle, state: State<'_, AppState>) -> Result<Identity, String> {
    on_repo(&app, &state, |git, root| git.identity(root)).await
}

#[tauri::command]
pub async fn git_set_identity(
    name: String,
    email: String,
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<(), String> {
    on_repo(&app, &state, move |git, root| {
        git.set_identity(root, &name, &email)
    })
    .await
}

#[tauri::command]
pub async fn git_diff(
    path: String,
    staged: bool,
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<DiffSides, String> {
    on_repo(&app, &state, move |git, root| {
        git.diff_sides(root, &path, staged)
    })
    .await
}

#[tauri::command]
pub async fn git_branches(
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<Vec<Branch>, String> {
    on_repo(&app, &state, |git, root| git.branches(root)).await
}

#[tauri::command]
pub async fn git_switch_branch(
    name: String,
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<(), String> {
    on_repo(&app, &state, move |git, root| {
        git.switch_branch(root, &name)
    })
    .await
}

#[tauri::command]
pub async fn git_create_branch(
    name: String,
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<(), String> {
    on_repo(&app, &state, move |git, root| {
        git.create_branch(root, &name)
    })
    .await
}

#[tauri::command]
pub async fn git_delete_branch(
    name: String,
    confirmed: bool,
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<(), String> {
    on_repo(&app, &state, move |git, root| {
        git.delete_branch(root, &name, confirmed)
    })
    .await
}

#[tauri::command]
pub async fn git_fetch(app: AppHandle, state: State<'_, AppState>) -> Result<String, String> {
    on_repo(&app, &state, |git, root| git.fetch(root)).await
}

#[tauri::command]
pub async fn git_pull(app: AppHandle, state: State<'_, AppState>) -> Result<String, String> {
    on_repo(&app, &state, |git, root| git.pull(root)).await
}

#[tauri::command]
pub async fn git_push(app: AppHandle, state: State<'_, AppState>) -> Result<String, String> {
    on_repo(&app, &state, |git, root| git.push(root)).await
}

/// Whether a Git from the machine's PATH may be used when there is no portable one.
#[tauri::command]
pub async fn git_allow_system(state: State<'_, AppState>) -> Result<bool, String> {
    Ok(allow_system(&state).await)
}

#[tauri::command]
pub async fn git_set_allow_system(allow: bool, state: State<'_, AppState>) -> Result<(), String> {
    EditorSettingsRepository::new(state.db.pool())
        .set(ALLOW_SYSTEM_KEY, if allow { "true" } else { "false" })
        .await
        .map_err(|err| err.to_string())
}

/// Stops every running Git command (app shutdown).
pub fn stop_git(app: &AppHandle) {
    app.state::<AppState>().git.stop_all();
}
