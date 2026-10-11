//! The collaborative-editing commands (Milestone 24, phase 6) the editor windows call. Binary values travel as base64.
//! The Owner's editor follows documents participants opened (`collab_doc_owner_*`); a participant opens, changes and
//! closes documents of a joined room (`collab_doc_*`). Every decision about a change is the Owner's (`host::docs`).

use base64::engine::general_purpose::STANDARD as B64;
use base64::Engine as _;
use openmind_collab::FileId;
use tauri::{AppHandle, State};

use super::net_docs;
use super::now_ms;
use crate::app_state::AppState;

fn file(id: &str) -> Result<FileId, String> {
    FileId::parse(id).map_err(|e| e.to_string())
}

fn bytes(text: &str) -> Result<Vec<u8>, String> {
    B64.decode(text)
        .map_err(|_| "The data isn't valid.".to_string())
}

/// The whole document the Owner's editor starts following (base64 Yjs update).
#[tauri::command]
pub async fn collab_doc_owner_state(
    state: State<'_, AppState>,
    room_uid: String,
    file_id: String,
) -> Result<String, String> {
    let file = file(&file_id)?;
    state
        .collab
        .owner_doc_state(&room_uid, &file)
        .await
        .map(|s| B64.encode(s))
        .ok_or_else(|| "The document isn't open.".into())
}

/// A change made in the Owner's own editor: stored, then sent to the participants who have the file open.
#[tauri::command]
pub async fn collab_doc_owner_update(
    app: AppHandle,
    state: State<'_, AppState>,
    room_uid: String,
    file_id: String,
    update: String,
) -> Result<(), String> {
    let messages = state
        .collab
        .owner_doc_update(
            &state.db,
            &room_uid,
            &file(&file_id)?,
            bytes(&update)?,
            now_ms(),
        )
        .await?;
    net_docs::send_all(&app, &room_uid, messages);
    Ok(())
}

/// Whether the Owner's editor follows a document (a followed document stays loaded).
#[tauri::command]
pub async fn collab_doc_owner_bind(
    state: State<'_, AppState>,
    room_uid: String,
    file_id: String,
    bound: bool,
) -> Result<(), String> {
    state
        .collab
        .owner_doc_bind(&state.db, &room_uid, &file(&file_id)?, bound, now_ms())
        .await;
    Ok(())
}

/// Opens a file of a joined room for collaborative editing (answered with a `sync` event).
#[tauri::command]
pub fn collab_doc_subscribe(
    state: State<'_, AppState>,
    room_uid: String,
    file_id: String,
    state_vector: String,
) -> Result<(), String> {
    let remote = state
        .collab
        .net
        .remote(&room_uid)
        .ok_or("You aren't connected to this room.")?;
    remote
        .subscribe(file(&file_id)?, bytes(&state_vector)?)
        .map(|_| ())
        .map_err(|e| e.to_string())
}

/// One change made by this participant (kept in the outbox until the Owner stored it; sent now if connected).
#[tauri::command]
pub async fn collab_doc_send(
    state: State<'_, AppState>,
    room_uid: String,
    file_id: String,
    update: String,
) -> Result<(), String> {
    net_docs::send_update(&state, &room_uid, file(&file_id)?, bytes(&update)?).await
}

#[tauri::command]
pub fn collab_doc_unsubscribe(
    state: State<'_, AppState>,
    room_uid: String,
    file_id: String,
) -> Result<(), String> {
    if let Some(remote) = state.collab.net.remote(&room_uid) {
        let _ = remote.unsubscribe(file(&file_id)?);
    }
    Ok(())
}

/// This window's presence in a room (what it has active, its cursor, whether its user is typing). The computer sends one
/// merged, throttled presence per room.
#[tauri::command]
pub fn collab_presence_set(
    window: tauri::Window,
    app: AppHandle,
    room_uid: String,
    presence: super::net_presence::LocalPresence,
) {
    super::net_presence::set_local(&app, window.label(), &room_uid, presence);
}

/// The room's members and their current presence, for a window that opens later.
#[tauri::command]
pub async fn collab_presence_snapshot(
    state: State<'_, AppState>,
    room_uid: String,
) -> Result<super::net_presence::PresenceSnapshot, String> {
    super::net_presence::snapshot(&state, &room_uid).await
}
