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
    find_system, resolve, BlameLine, Branch, Commit, CommitFile, DiffSides, GitClient, GitError,
    Identity, LogEntry, RepoStatus, StashEntry,
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
    #[serde(rename_all = "camelCase")]
    NoWorkspace { runtime: GitRuntime },
    #[serde(rename_all = "camelCase")]
    GitMissing {
        reason: String,
        /// A Git found on the machine's PATH that the user could choose to use.
        system_git: Option<String>,
    },
    #[serde(rename_all = "camelCase")]
    NotRepository { git: String },
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

/// The folder open in the window that called (each editor window has its own).
pub(crate) async fn workspace_path(state: &AppState, label: &str) -> Result<PathBuf, String> {
    let workspace = crate::windows::window_workspace(state, label)
        .await?
        .ok_or_else(|| "Open a folder to use Source Control.".to_string())?;
    Ok(PathBuf::from(workspace.path))
}

/// Portable Git first; the system's only if the user allowed it.
pub(crate) async fn build_client(app: &AppHandle, state: &AppState) -> Result<GitClient, GitError> {
    let portable = environment(state).await.path_prepend;
    let exe = resolve(
        &portable,
        allow_system(state).await,
        std::env::var_os("PATH"),
    )?;
    let handle = app.clone();
    let network = crate::commands::network::refresh(state).await;
    let proxy_env = crate::commands::network::env_of(state, &network);
    let credentials = network.credentials;
    Ok(GitClient::new(
        exe,
        Arc::new(move |mut entry: LogEntry| {
            // Git's own output could quote a proxy address: never show its password.
            entry.stdout = openmind_network::redact::redact(&entry.stdout, credentials.as_ref());
            entry.stderr = openmind_network::redact::redact(&entry.stderr, credentials.as_ref());
            let _ = handle.emit("git:log", entry);
        }),
        state.git.clone(),
    )
    .with_env(proxy_env))
}

/// Runs `operation` against the open workspace's repository on a worker thread.
async fn on_repo<T, F>(
    app: &AppHandle,
    state: &AppState,
    label: &str,
    operation: F,
) -> Result<T, String>
where
    T: Send + 'static,
    F: FnOnce(&GitClient, &Path) -> Result<T, GitError> + Send + 'static,
{
    let workspace = workspace_path(state, label).await?;
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

/// What Source Control shows for the folder `workspace` (also the canonical state's per-workspace Git domain). An
/// error (Git failing on this folder) is returned as such, so a caller keeps what it showed before.
pub(crate) async fn snapshot_at(
    app: &AppHandle,
    state: &AppState,
    workspace: Option<PathBuf>,
) -> Result<GitSnapshot, String> {
    let Some(workspace) = workspace else {
        return Ok(GitSnapshot::NoWorkspace {
            runtime: runtime_info(app, state).await,
        });
    };
    let client = match build_client(app, state).await {
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
pub async fn git_init(
    window: tauri::Window,
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let workspace = workspace_path(&state, window.label()).await?;
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
    window: tauri::Window,
    paths: Vec<String>,
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<(), String> {
    on_repo(&app, &state, window.label(), move |git, root| {
        git.stage(root, &paths)
    })
    .await
}

#[tauri::command]
pub async fn git_stage_all(
    window: tauri::Window,
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<(), String> {
    on_repo(&app, &state, window.label(), |git, root| {
        git.stage_all(root)
    })
    .await
}

#[tauri::command]
pub async fn git_unstage(
    window: tauri::Window,
    paths: Vec<String>,
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<(), String> {
    on_repo(&app, &state, window.label(), move |git, root| {
        git.unstage(root, &paths)
    })
    .await
}

#[tauri::command]
pub async fn git_unstage_all(
    window: tauri::Window,
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<(), String> {
    on_repo(&app, &state, window.label(), |git, root| {
        git.unstage_all(root)
    })
    .await
}

#[tauri::command]
pub async fn git_discard(
    window: tauri::Window,
    paths: Vec<String>,
    confirmed: bool,
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<(), String> {
    on_repo(&app, &state, window.label(), move |git, root| {
        git.discard(root, &paths, confirmed)
    })
    .await
}

#[tauri::command]
pub async fn git_discard_all(
    window: tauri::Window,
    confirmed: bool,
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<(), String> {
    on_repo(&app, &state, window.label(), move |git, root| {
        git.discard_all(root, confirmed)
    })
    .await
}

#[tauri::command]
pub async fn git_delete_untracked(
    window: tauri::Window,
    path: String,
    confirmed: bool,
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<(), String> {
    on_repo(&app, &state, window.label(), move |git, root| {
        git.delete_untracked(root, &path, confirmed)
    })
    .await
}

#[tauri::command]
pub async fn git_commit(
    window: tauri::Window,
    message: String,
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<String, String> {
    on_repo(&app, &state, window.label(), move |git, root| {
        git.commit(root, &message)
    })
    .await
}

#[tauri::command]
pub async fn git_identity(
    window: tauri::Window,
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<Identity, String> {
    on_repo(&app, &state, window.label(), |git, root| git.identity(root)).await
}

#[tauri::command]
pub async fn git_set_identity(
    window: tauri::Window,
    name: String,
    email: String,
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<(), String> {
    on_repo(&app, &state, window.label(), move |git, root| {
        git.set_identity(root, &name, &email)
    })
    .await
}

#[tauri::command]
pub async fn git_diff(
    window: tauri::Window,
    path: String,
    staged: bool,
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<DiffSides, String> {
    on_repo(&app, &state, window.label(), move |git, root| {
        git.diff_sides(root, &path, staged)
    })
    .await
}

#[tauri::command]
pub async fn git_branches(
    window: tauri::Window,
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<Vec<Branch>, String> {
    on_repo(&app, &state, window.label(), |git, root| git.branches(root)).await
}

#[tauri::command]
pub async fn git_switch_branch(
    window: tauri::Window,
    name: String,
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<(), String> {
    on_repo(&app, &state, window.label(), move |git, root| {
        git.switch_branch(root, &name)
    })
    .await
}

#[tauri::command]
pub async fn git_create_branch(
    window: tauri::Window,
    name: String,
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<(), String> {
    on_repo(&app, &state, window.label(), move |git, root| {
        git.create_branch(root, &name)
    })
    .await
}

#[tauri::command]
pub async fn git_delete_branch(
    window: tauri::Window,
    name: String,
    confirmed: bool,
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<(), String> {
    on_repo(&app, &state, window.label(), move |git, root| {
        git.delete_branch(root, &name, confirmed)
    })
    .await
}

#[tauri::command]
pub async fn git_fetch(
    window: tauri::Window,
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<String, String> {
    on_repo(&app, &state, window.label(), |git, root| git.fetch(root)).await
}

#[tauri::command]
pub async fn git_pull(
    window: tauri::Window,
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<String, String> {
    on_repo(&app, &state, window.label(), |git, root| git.pull(root)).await
}

#[tauri::command]
pub async fn git_push(
    window: tauri::Window,
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<String, String> {
    on_repo(&app, &state, window.label(), |git, root| git.push(root)).await
}

/// Whether Git can be used right now, and which one (for the Clone form, which needs no repository).
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitRuntime {
    pub ready: bool,
    pub label: Option<String>,
    pub reason: Option<String>,
    pub system_git: Option<String>,
}

/// Which Git (if any) is usable now — reported with every snapshot so the Clone form knows.
async fn runtime_info(app: &AppHandle, state: &AppState) -> GitRuntime {
    match build_client(app, state).await {
        Ok(client) => GitRuntime {
            ready: true,
            label: Some(client.executable().label()),
            reason: None,
            system_git: None,
        },
        Err(err) => GitRuntime {
            ready: false,
            label: None,
            reason: Some(err.to_string()),
            system_git: find_system(std::env::var_os("PATH"))
                .map(|path| path.display().to_string()),
        },
    }
}

/// Clones into `<parent>/<name>` (never into a folder that has anything in it). Runs
/// without an open repository; output goes to the Git channel like every command.
#[tauri::command]
pub async fn git_clone(
    url: String,
    parent: String,
    name: String,
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<String, String> {
    let client = build_client(&app, &state)
        .await
        .map_err(|err| err.to_string())?;
    tokio::task::spawn_blocking(move || {
        client
            .clone_repository(&url, Path::new(&parent), &name)
            .map(|path| path.display().to_string())
    })
    .await
    .map_err(|err| format!("Git stopped unexpectedly: {err}"))?
    .map_err(|err| err.to_string())
}

#[tauri::command]
pub async fn git_history(
    window: tauri::Window,
    limit: u32,
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<Vec<Commit>, String> {
    on_repo(&app, &state, window.label(), move |git, root| {
        git.history(root, limit)
    })
    .await
}

#[tauri::command]
pub async fn git_commit_files(
    window: tauri::Window,
    hash: String,
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<Vec<CommitFile>, String> {
    on_repo(&app, &state, window.label(), move |git, root| {
        git.commit_files(root, &hash)
    })
    .await
}

#[tauri::command]
pub async fn git_commit_diff(
    window: tauri::Window,
    hash: String,
    file: CommitFile,
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<DiffSides, String> {
    on_repo(&app, &state, window.label(), move |git, root| {
        git.commit_diff_sides(root, &hash, &file)
    })
    .await
}

/// Blame for a file of the open repository (absolute or repo-relative path).
#[tauri::command]
pub async fn git_blame(
    window: tauri::Window,
    path: String,
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<Vec<BlameLine>, String> {
    on_repo(&app, &state, window.label(), move |git, root| {
        git.blame(root, &path)
    })
    .await
}

#[tauri::command]
pub async fn git_stash_list(
    window: tauri::Window,
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<Vec<StashEntry>, String> {
    on_repo(&app, &state, window.label(), |git, root| {
        git.stash_list(root)
    })
    .await
}

#[tauri::command]
pub async fn git_stash_push(
    window: tauri::Window,
    message: String,
    include_untracked: bool,
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<String, String> {
    on_repo(&app, &state, window.label(), move |git, root| {
        git.stash_push(root, &message, include_untracked)
    })
    .await
}

#[tauri::command]
pub async fn git_stash_apply(
    window: tauri::Window,
    index: u32,
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<String, String> {
    on_repo(&app, &state, window.label(), move |git, root| {
        git.stash_apply(root, index)
    })
    .await
}

#[tauri::command]
pub async fn git_stash_pop(
    window: tauri::Window,
    index: u32,
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<String, String> {
    on_repo(&app, &state, window.label(), move |git, root| {
        git.stash_pop(root, index)
    })
    .await
}

#[tauri::command]
pub async fn git_stash_drop(
    window: tauri::Window,
    index: u32,
    confirmed: bool,
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<(), String> {
    on_repo(&app, &state, window.label(), move |git, root| {
        git.stash_drop(root, index, confirmed)
    })
    .await
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
