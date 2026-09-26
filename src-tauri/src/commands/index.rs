//! The persistent workspace index (Milestone 12): background indexing of the calling window's open folder, and
//! queries answered from it (file names, text, symbols). Everything stays on this machine; the index file lives in
//! the app's own `data/search-index/` folder. Every command works on the calling window's folder only, found
//! server-side; a path the UI sends is checked to be inside it.

use std::path::{Path, PathBuf};
use std::sync::Arc;

use openmind_file_watch::ChangeBatch;
use openmind_search::index::{
    file_symbols, search_files, search_symbols, search_text, FileHit, IndexEvents, IndexManager,
    IndexSettings, IndexStatus, SymbolHit,
};
use openmind_search::{SearchOutcome, SearchQuery};
use tauri::{AppHandle, Emitter, State};

use crate::app_state::AppState;

/// Pushes status to the windows; each ignores a status whose folder isn't its own.
pub struct TauriIndexEvents {
    pub app: AppHandle,
}

impl IndexEvents for TauriIndexEvents {
    fn status(&self, status: &IndexStatus) {
        let _ = self.app.emit("index:status", status);
    }
}

pub fn new_manager(app: AppHandle, dir: PathBuf) -> Arc<IndexManager> {
    Arc::new(IndexManager::new(dir, Arc::new(TauriIndexEvents { app })))
}

async fn workspace_root(state: &AppState, window: &tauri::Window) -> Result<PathBuf, String> {
    crate::windows::window_workspace(state, window.label())
        .await?
        .map(|workspace| PathBuf::from(workspace.path))
        .ok_or_else(|| "Open a folder first.".to_string())
}

async fn blocking<T, F>(work: F) -> Result<T, String>
where
    T: Send + 'static,
    F: FnOnce() -> Result<T, openmind_search::SearchError> + Send + 'static,
{
    tokio::task::spawn_blocking(work)
        .await
        .map_err(|err| format!("the search stopped unexpectedly: {err}"))?
        .map_err(|err| err.to_string())
}

/// Starts indexing the open folder in the background (only what changed since last time is read). With
/// `restart`, a pass that is running is replaced by one with these settings.
#[tauri::command]
pub async fn index_start(
    settings: IndexSettings,
    restart: bool,
    window: tauri::Window,
    state: State<'_, AppState>,
) -> Result<IndexStatus, String> {
    let root = workspace_root(&state, &window).await?;
    if restart {
        state.index.restart(&root, settings);
    } else {
        state.index.start(&root, settings);
    }
    Ok(state.index.status(&root))
}

#[tauri::command]
pub async fn index_status(
    window: tauri::Window,
    state: State<'_, AppState>,
) -> Result<IndexStatus, String> {
    let root = workspace_root(&state, &window).await?;
    let index = state.index.clone();
    tokio::task::spawn_blocking(move || index.status(&root))
        .await
        .map_err(|err| err.to_string())
}

#[tauri::command]
pub async fn index_cancel(window: tauri::Window, state: State<'_, AppState>) -> Result<(), String> {
    let root = workspace_root(&state, &window).await?;
    state.index.cancel(&root);
    Ok(())
}

/// Deletes the index and builds it again.
#[tauri::command]
pub async fn index_rebuild(
    settings: IndexSettings,
    window: tauri::Window,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let root = workspace_root(&state, &window).await?;
    let index = state.index.clone();
    blocking(move || index.rebuild(&root, settings)).await
}

/// Deletes everything the index holds for the open folder (Clear Search Index).
#[tauri::command]
pub async fn index_clear(window: tauri::Window, state: State<'_, AppState>) -> Result<(), String> {
    let root = workspace_root(&state, &window).await?;
    let index = state.index.clone();
    blocking(move || index.clear(&root)).await
}

/// Files the editor saved: indexed now instead of waiting for the file watcher.
#[tauri::command]
pub async fn index_touch(
    paths: Vec<String>,
    window: tauri::Window,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let root = workspace_root(&state, &window).await?;
    let index = state.index.clone();
    let paths: Vec<PathBuf> = paths.into_iter().map(PathBuf::from).collect();
    blocking(move || index.apply_changes(&root, &paths)).await
}

/// File names and paths matching `text`, best first.
#[tauri::command]
pub async fn search_files_indexed(
    text: String,
    extension: Option<String>,
    limit: usize,
    window: tauri::Window,
    state: State<'_, AppState>,
) -> Result<Vec<FileHit>, String> {
    let root = workspace_root(&state, &window).await?;
    let index = state.index.clone();
    blocking(move || {
        let store = index.open_store(&root)?;
        search_files(&store, &root, &text, extension.as_deref(), limit)
    })
    .await
}

/// Symbols of the whole folder matching `text`.
#[tauri::command]
pub async fn search_symbols_indexed(
    text: String,
    kind: Option<String>,
    limit: usize,
    window: tauri::Window,
    state: State<'_, AppState>,
) -> Result<Vec<SymbolHit>, String> {
    let root = workspace_root(&state, &window).await?;
    let index = state.index.clone();
    blocking(move || {
        let store = index.open_store(&root)?;
        search_symbols(&store, &root, &text, kind.as_deref(), limit)
    })
    .await
}

/// The symbols of one file of the open folder.
#[tauri::command]
pub async fn search_file_symbols(
    path: String,
    window: tauri::Window,
    state: State<'_, AppState>,
) -> Result<Vec<SymbolHit>, String> {
    let root = workspace_root(&state, &window).await?;
    openmind_fs::ensure_within_root(&root, Path::new(&path)).map_err(|err| err.to_string())?;
    let index = state.index.clone();
    blocking(move || {
        let relative = openmind_search::index::crawl::relative_inside(&root, Path::new(&path))?;
        let store = index.open_store(&root)?;
        file_symbols(&store, &root, &relative)
    })
    .await
}

/// The symbols found in a piece of text (an open, possibly unsaved buffer) for a Monaco language id. Heuristic,
/// line-based; no index or file is involved.
#[tauri::command]
pub fn search_symbols_of_text(
    language: String,
    text: String,
) -> Vec<openmind_search::index::Symbol> {
    openmind_search::index::symbols::extract(&language, &text)
}

/// Text search answered from the index (same query and result shape as `search_run`). Cancel it with
/// `search_cancel` under the same id.
#[tauri::command]
pub async fn search_text_indexed(
    search_id: String,
    query: SearchQuery,
    window: tauri::Window,
    state: State<'_, AppState>,
) -> Result<SearchOutcome, String> {
    let root = workspace_root(&state, &window).await?;
    openmind_fs::ensure_within_root(&root, &query.root).map_err(|err| err.to_string())?;
    let cancel = state.search.begin(&search_id);
    let worker_cancel = cancel.clone();
    let index = state.index.clone();
    let outcome = blocking(move || {
        let store = index.open_store(&root)?;
        search_text(&store, &root, &query, &worker_cancel)
    })
    .await;
    state.search.finish(&search_id, &cancel);
    outcome
}

/// What the file watcher reported: apply it to the index (a lost or huge batch asks for a fresh pass).
pub fn apply_watch_batch(index: &Arc<IndexManager>, root: &Path, batch: &ChangeBatch) {
    if batch.overflow {
        index.refresh(root);
        return;
    }
    let mut paths: Vec<PathBuf> = Vec::new();
    for change in &batch.changes {
        paths.push(PathBuf::from(&change.path));
        if let Some(from) = &change.from {
            paths.push(PathBuf::from(from));
        }
    }
    if let Err(err) = index.apply_changes(root, &paths) {
        tracing::warn!(%err, "couldn't apply file changes to the search index");
    }
}
