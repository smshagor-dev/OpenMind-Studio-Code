//! Editor bookmarks: the frontend keeps them and saves the whole list (debounced), like breakpoints.

use openmind_db::{BookmarkRow, BookmarksRepository};
use tauri::State;

use crate::app_state::AppState;

/// At most this many bookmarks are stored (a sanity limit for a list the page sends in one piece).
const MAX_BOOKMARKS: usize = 10_000;

#[tauri::command]
pub async fn bookmarks_load(state: State<'_, AppState>) -> Result<Vec<BookmarkRow>, String> {
    BookmarksRepository::new(state.db.pool())
        .list()
        .await
        .map_err(|err| err.to_string())
}

#[tauri::command]
pub async fn bookmarks_save(
    rows: Vec<BookmarkRow>,
    state: State<'_, AppState>,
) -> Result<(), String> {
    if rows.len() > MAX_BOOKMARKS {
        return Err(format!("At most {MAX_BOOKMARKS} bookmarks can be saved."));
    }
    BookmarksRepository::new(state.db.pool())
        .replace_all(&rows)
        .await
        .map_err(|err| err.to_string())
}
