//! Tells the frontend when files in the open workspace change on disk without
//! the editor's involvement. Only the open workspace folder can be watched
//! (whatever path the UI sends is compared with it), and what is reported is
//! already debounced and free of `node_modules`, `.git`, `target`, `dist`,
//! `build` and `vendor`.

use std::path::Path;
use std::sync::Arc;

use openmind_file_watch::{ChangeBatch, FileWatcher};
use tauri::{AppHandle, Emitter, Manager, State};

use crate::app_state::AppState;

/// Starts (or restarts) watching `root`, which must be the open workspace folder.
#[tauri::command]
pub async fn watch_start(
    root: String,
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let workspace = state
        .workspace_folder
        .active_workspace()
        .await
        .map_err(|err| err.to_string())?
        .ok_or_else(|| "Open a folder first.".to_string())?;
    // Only the open workspace can be watched, whatever path the UI sent.
    openmind_fs::ensure_within_root(Path::new(&workspace.path), Path::new(&root))
        .map_err(|err| err.to_string())?;
    if !same_folder(Path::new(&workspace.path), Path::new(&root)) {
        return Err("Only the open workspace folder can be watched.".into());
    }
    let handle = app.clone();
    let watcher = FileWatcher::start(
        Path::new(&workspace.path),
        Arc::new(move |batch: ChangeBatch| {
            let _ = handle.emit("fs:changed", batch);
        }),
    )
    .map_err(|err| err.to_string())?;
    let mut slot = state.file_watch.lock().map_err(|err| err.to_string())?;
    *slot = Some(watcher);
    Ok(())
}

#[tauri::command]
pub fn watch_stop(state: State<'_, AppState>) {
    stop_watching(&state);
}

fn same_folder(a: &Path, b: &Path) -> bool {
    match (std::fs::canonicalize(a), std::fs::canonicalize(b)) {
        (Ok(a), Ok(b)) => a == b,
        _ => false,
    }
}

pub fn stop_watching(state: &AppState) {
    if let Ok(mut slot) = state.file_watch.lock() {
        *slot = None;
    }
}

/// Stops watching at app shutdown.
pub fn stop_on_exit(app: &AppHandle) {
    stop_watching(&app.state::<AppState>());
}
