//! Git for one file, as the editor's context menu asks for it: the repository the file is in (a nested repository or
//! a worktree is found from the file's own folder), its history, its text at a revision, the refs to compare with, the
//! remotes, blame and commit details. The file must be inside the window's open folder (checked after resolving
//! links), so the page can't point Git at anything else; revisions and repo-relative names are checked again by the
//! Git crate before they reach Git, which always runs as an argument list on a worker thread.

use std::path::{Path, PathBuf};

use openmind_git::{
    relative_to_root, BlameLine, CommitDetails, FileLogPage, GitClient, GitError, GitRef,
    RemoteInfo, RevisionText,
};
use serde::Serialize;
use tauri::{AppHandle, State};

use crate::app_state::AppState;
use crate::commands::git::{build_client, workspace_path};

/// Where a file stands in Git.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileGitContext {
    /// The repository's root folder.
    pub root: String,
    /// The repository's folder name.
    pub name: String,
    /// The file's repo-relative name (forward slashes).
    pub relative: String,
    pub tracked: bool,
}

struct Located {
    root: PathBuf,
    relative: String,
}

/// The file's repository and repo-relative name; refuses a file outside the window's folder.
fn locate(client: &GitClient, workspace: &Path, path: &str) -> Result<Located, GitError> {
    let target = PathBuf::from(path);
    if !target.is_absolute() || path.contains('\0') {
        return Err(GitError::InvalidPath(path.to_string()));
    }
    let resolved = openmind_fs::path_safety::ensure_within_root(workspace, &target)
        .map_err(|_| GitError::OutsideRepository(path.to_string()))?;
    // A deleted file's folder may be gone too: look from the nearest folder that still exists.
    let folder = resolved
        .ancestors()
        .skip(1)
        .find(|candidate| candidate.is_dir())
        .map(Path::to_path_buf)
        .unwrap_or_else(|| workspace.to_path_buf());
    let root = client.find_root(&folder)?;
    let root = openmind_fs::path_safety::normalize_path(&root).unwrap_or(root);
    let relative = relative_to_root(&root, &resolved.to_string_lossy())?;
    Ok(Located { root, relative })
}

/// Runs `operation` for the file at `path` in its repository, on a worker thread.
async fn on_file<T, F>(
    app: &AppHandle,
    state: &AppState,
    label: &str,
    path: String,
    operation: F,
) -> Result<T, String>
where
    T: Send + 'static,
    F: FnOnce(&GitClient, &Path, &str) -> Result<T, GitError> + Send + 'static,
{
    let workspace = workspace_path(state, label).await?;
    let client = build_client(app, state)
        .await
        .map_err(|err| err.to_string())?;
    tokio::task::spawn_blocking(move || {
        let located = locate(&client, &workspace, &path)?;
        operation(&client, &located.root, &located.relative)
    })
    .await
    .map_err(|err| format!("Git stopped unexpectedly: {err}"))?
    .map_err(|err| err.to_string())
}

#[tauri::command]
pub async fn git_file_context(
    window: tauri::Window,
    path: String,
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<FileGitContext, String> {
    on_file(&app, &state, window.label(), path, |git, root, relative| {
        Ok(FileGitContext {
            root: root.to_string_lossy().into_owned(),
            name: root
                .file_name()
                .map(|name| name.to_string_lossy().into_owned())
                .unwrap_or_default(),
            relative: relative.to_string(),
            tracked: git.is_tracked(root, relative)?,
        })
    })
    .await
}

#[tauri::command]
pub async fn git_file_log(
    window: tauri::Window,
    path: String,
    skip: u32,
    limit: u32,
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<FileLogPage, String> {
    on_file(
        &app,
        &state,
        window.label(),
        path,
        move |git, root, relative| git.file_log(root, relative, skip, limit),
    )
    .await
}

/// The file's text at `revision`. `relative` names the file as it was in that revision (after a rename); without
/// it the file's current name is used.
#[tauri::command]
pub async fn git_file_at(
    window: tauri::Window,
    path: String,
    revision: String,
    relative: Option<String>,
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<RevisionText, String> {
    on_file(
        &app,
        &state,
        window.label(),
        path,
        move |git, root, current| {
            git.file_at(root, &revision, relative.as_deref().unwrap_or(current))
        },
    )
    .await
}

#[tauri::command]
pub async fn git_file_refs(
    window: tauri::Window,
    path: String,
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<Vec<GitRef>, String> {
    on_file(&app, &state, window.label(), path, |git, root, _| {
        git.refs(root)
    })
    .await
}

#[tauri::command]
pub async fn git_file_remotes(
    window: tauri::Window,
    path: String,
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<RemoteInfo, String> {
    on_file(&app, &state, window.label(), path, |git, root, _| {
        git.remote_info(root)
    })
    .await
}

/// The remote-tracking branches containing `hash` (empty: not pushed).
#[tauri::command]
pub async fn git_file_published(
    window: tauri::Window,
    path: String,
    hash: String,
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<Vec<String>, String> {
    on_file(&app, &state, window.label(), path, move |git, root, _| {
        git.remote_branches_containing(root, &hash)
    })
    .await
}

#[tauri::command]
pub async fn git_file_resolve(
    window: tauri::Window,
    path: String,
    revision: String,
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<Option<String>, String> {
    on_file(&app, &state, window.label(), path, move |git, root, _| {
        git.resolve_revision(root, &revision)
    })
    .await
}

#[tauri::command]
pub async fn git_file_commit(
    window: tauri::Window,
    path: String,
    hash: String,
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<CommitDetails, String> {
    on_file(&app, &state, window.label(), path, move |git, root, _| {
        git.commit_details(root, &hash)
    })
    .await
}

/// Blame of the saved file, in the file's own repository (a nested repository too).
#[tauri::command]
pub async fn git_file_blame(
    window: tauri::Window,
    path: String,
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<Vec<BlameLine>, String> {
    on_file(&app, &state, window.label(), path, |git, root, relative| {
        git.blame(root, relative)
    })
    .await
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;

    use openmind_git::{find_system, resolve, GitRegistry};

    use super::*;

    fn client() -> Option<GitClient> {
        let path = std::env::var_os("PATH");
        find_system(path.clone())?;
        let exe = resolve(&[], true, path).ok()?;
        Some(GitClient::new(
            exe,
            Arc::new(|_| {}),
            GitRegistry::default(),
        ))
    }

    fn init(client: &GitClient, folder: &Path) {
        let status = std::process::Command::new(&client.executable().path)
            .args(["init", "-q"])
            .current_dir(folder)
            .status()
            .unwrap();
        assert!(status.success());
    }

    #[test]
    fn a_file_in_a_nested_repository_belongs_to_that_repository() {
        let Some(client) = client() else { return };
        let temp = tempfile::tempdir().unwrap();
        let workspace = temp.path().join("work space");
        let nested = workspace.join("libs").join("inner repo");
        std::fs::create_dir_all(&nested).unwrap();
        init(&client, &workspace);
        init(&client, &nested);
        std::fs::write(nested.join("a b.txt"), "x").unwrap();
        let file = nested.join("a b.txt");
        let located = locate(&client, &workspace, &file.to_string_lossy()).unwrap();
        assert!(located.root.ends_with("inner repo"), "{:?}", located.root);
        assert_eq!(located.relative, "a b.txt");
    }

    #[test]
    fn files_outside_the_open_folder_and_relative_paths_are_refused() {
        let Some(client) = client() else { return };
        let temp = tempfile::tempdir().unwrap();
        let workspace = temp.path().join("ws");
        let outside = temp.path().join("other");
        std::fs::create_dir_all(&workspace).unwrap();
        std::fs::create_dir_all(&outside).unwrap();
        std::fs::write(outside.join("x.txt"), "x").unwrap();
        init(&client, &workspace);
        let escape = workspace.join("..").join("other").join("x.txt");
        for path in [
            outside.join("x.txt").to_string_lossy().into_owned(),
            escape.to_string_lossy().into_owned(),
            "relative.txt".to_string(),
        ] {
            assert!(locate(&client, &workspace, &path).is_err(), "{path}");
        }
    }

    #[test]
    fn a_deleted_file_is_located_from_its_remaining_folder() {
        let Some(client) = client() else { return };
        let temp = tempfile::tempdir().unwrap();
        let workspace = temp.path().join("ws");
        std::fs::create_dir_all(&workspace).unwrap();
        init(&client, &workspace);
        let gone = workspace.join("gone.txt");
        let located = locate(&client, &workspace, &gone.to_string_lossy()).unwrap();
        assert_eq!(located.relative, "gone.txt");
    }
}
