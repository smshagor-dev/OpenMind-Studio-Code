use std::path::Path;

use openmind_search::{SearchOutcome, SearchQuery};
use tauri::State;

use crate::app_state::AppState;

/// Runs a workspace search on a blocking thread (so the UI never waits on the
/// disk) and returns everything found. `search_id` lets `search_cancel` stop
/// it; a newer search under the same id cancels this one.
#[tauri::command]
pub async fn search_run(
    search_id: String,
    query: SearchQuery,
    window: tauri::Window,
    state: State<'_, AppState>,
) -> Result<SearchOutcome, String> {
    let workspace = crate::windows::window_workspace(&state, window.label())
        .await?
        .ok_or_else(|| "Open a folder to search in it.".to_string())?;
    // Only the calling window's folder can be searched, whatever path the UI sent.
    openmind_fs::ensure_within_root(Path::new(&workspace.path), &query.root)
        .map_err(|err| err.to_string())?;

    let cancel = state.search.begin(&search_id);
    let worker_cancel = cancel.clone();
    let outcome =
        tokio::task::spawn_blocking(move || openmind_search::search(&query, &worker_cancel)).await;
    state.search.finish(&search_id, &cancel);
    outcome
        .map_err(|err| format!("the search stopped unexpectedly: {err}"))?
        .map_err(|err| err.to_string())
}

/// Cancels a running search; `false` if none by that id is running.
#[tauri::command]
pub fn search_cancel(search_id: String, state: State<'_, AppState>) -> bool {
    state.search.cancel(&search_id)
}
