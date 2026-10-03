//! Which folder a language server works in for a file a window asks about.

use std::path::{Path, PathBuf};

use crate::app_state::AppState;

use super::SyncOutcome;

/// The open workspace folder, if any.
pub(crate) async fn workspace_path(state: &AppState) -> Option<PathBuf> {
    state
        .workspace_folder
        .active_workspace()
        .await
        .ok()
        .flatten()
        .map(|workspace| PathBuf::from(workspace.path))
}

/// The folder a server works in for a file opened in the window `label`, or why there is none. It is decided by the
/// *asking window's* folder, never another window's: a window with no folder never hears "outside the open folder".
/// Servers run for one folder at a time, so an extra window gets them only while the main window has no other folder
/// (the main window keeps priority, which keeps the choice deterministic instead of restarting servers per window).
pub(super) async fn server_root(
    state: &AppState,
    label: &str,
    path: &Path,
) -> Result<PathBuf, SyncOutcome> {
    let folder = crate::windows::window_workspace(state, label)
        .await
        .ok()
        .flatten()
        .map(|info| PathBuf::from(info.path))
        .ok_or(SyncOutcome::NoWorkspace)?;
    if openmind_fs::ensure_within_root(&folder, path).is_err() {
        return Err(SyncOutcome::OutsideWorkspace);
    }
    if !crate::windows::is_main(label) {
        if let Some(main) = workspace_path(state).await {
            if !same_folder(&main, &folder) {
                return Err(SyncOutcome::OtherWindowFolder);
            }
        }
    }
    Ok(folder)
}

fn same_folder(a: &Path, b: &Path) -> bool {
    match (
        openmind_fs::normalize_path(a),
        openmind_fs::normalize_path(b),
    ) {
        (Ok(a), Ok(b)) => a == b,
        _ => a == b,
    }
}
