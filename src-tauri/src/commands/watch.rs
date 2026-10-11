//! Tells each editor window when files in its open folder change on disk without
//! the editor's involvement. Only that window's open folder can be watched
//! (whatever path the UI sends is compared with it), and what is reported is
//! already debounced and free of `node_modules`, `.git`, `target`, `dist`,
//! `build` and `vendor`.

use std::path::Path;
use std::sync::Arc;

use openmind_file_watch::{ChangeBatch, FileWatcher};
use tauri::{AppHandle, Emitter, Manager, State};

use crate::app_state::AppState;

/// Starts (or restarts) watching `root`, which must be the calling window's open folder.
#[tauri::command]
pub async fn watch_start(
    root: String,
    window: tauri::Window,
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let label = window.label().to_string();
    let workspace = crate::windows::window_workspace(&state, &label)
        .await?
        .ok_or_else(|| "Open a folder first.".to_string())?;
    // Only the window's own folder can be watched, whatever path the UI sent.
    openmind_fs::ensure_within_root(Path::new(&workspace.path), Path::new(&root))
        .map_err(|err| err.to_string())?;
    if !same_folder(Path::new(&workspace.path), Path::new(&root)) {
        return Err("Only the open workspace folder can be watched.".into());
    }
    let handle = app.clone();
    let target = label.clone();
    let index = state.index.clone();
    let index_root = std::path::PathBuf::from(&workspace.path);
    let announcer = app.clone();
    let folder = std::path::PathBuf::from(&workspace.path);
    let topic_folder = folder.clone();
    let watcher = FileWatcher::start_with_topics(
        Path::new(&workspace.path),
        Arc::new(move |batch: ChangeBatch| {
            // Each window hears only about its own folder.
            crate::commands::index::apply_watch_batch(&index, &index_root, &batch);
            crate::commands::watch_state::files_changed(&handle, &folder, &batch);
            // Rooms this folder hosts: participants' trees follow the same batches (no second watcher).
            crate::commands::collab::net_share::files_changed(&handle, &folder, &batch);
            let _ = handle.emit_to(target.as_str(), "fs:changed", batch);
        }),
        // The project's installed packages (`npm install`, `pip install` into `.venv` in a terminal ...) and its
        // repository (`.git`: a commit, checkout or stage — also from a terminal): that folder's canonical state.
        Some(Arc::new(move |topic, _burst| {
            crate::commands::watch_state::project_topic(&announcer, &topic_folder, topic);
        })),
    )
    .map_err(|err| err.to_string())?;
    let mut watchers = state.file_watch.lock().map_err(|err| err.to_string())?;
    watchers.insert(label, watcher);
    Ok(())
}

#[tauri::command]
pub fn watch_stop(window: tauri::Window, state: State<'_, AppState>) {
    stop_watching_window(&state, window.label());
}

fn same_folder(a: &Path, b: &Path) -> bool {
    match (std::fs::canonicalize(a), std::fs::canonicalize(b)) {
        (Ok(a), Ok(b)) => a == b,
        _ => false,
    }
}

/// Stops the watcher of one window (dropping it stops its thread).
pub fn stop_watching_window(state: &AppState, label: &str) {
    if let Ok(mut watchers) = state.file_watch.lock() {
        watchers.remove(label);
    }
}

/// Stops every watcher at app shutdown.
pub fn stop_on_exit(app: &AppHandle) {
    if let Ok(mut watchers) = app.state::<AppState>().file_watch.lock() {
        watchers.clear();
    }
}
