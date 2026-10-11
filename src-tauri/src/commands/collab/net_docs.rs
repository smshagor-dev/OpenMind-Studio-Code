//! Collaborative documents between the network and the editor windows (Milestone 24, phase 6). Transient by nature:
//! every change travels as a `collab:doc` event to the windows (the Yjs documents bound to Monaco live there); nothing
//! here is canonical state.
//!
//! - **Owner** (`side: "host"`): `active` when a participant opened a file (the Owner's editor then follows it),
//!   `update` for others' accepted changes, `closed` when the file was deleted.
//! - **Participant** (`side: "participant"`): `sync` (the answer to opening a file), `update`, `closed`, `access`
//!   (may this member change files now) and `rejected` (a change the Owner refused: the window resyncs).
//!
//! A participant's own changes are kept in `collab_outbox` until the Owner acknowledges them (it stored them): after
//! a crash or a reconnect they are sent again — with the same change id, so the Owner stores and forwards each once.

use std::collections::HashMap;
use std::sync::Mutex;

use base64::engine::general_purpose::STANDARD as B64;
use base64::Engine as _;
use openmind_collab::protocol::{Body, DocClosedReason};
use openmind_collab::{FileId, MessageId, PeerId};
use openmind_collab_net::remote::DocEvent;
use openmind_db::collab::{outbox, rooms};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager};

use super::host::OwnerDocEvent;
use super::net::NetEvent;
use super::now_ms;
use crate::app_state::AppState;

pub const DOC_EVENT: &str = "collab:doc";
const OUTBOX_CHANNEL: &str = "sync";

#[derive(Debug, Clone, Serialize)]
#[serde(
    rename_all = "camelCase",
    tag = "kind",
    rename_all_fields = "camelCase"
)]
pub enum DocNotice {
    Active {
        file_id: FileId,
        path: String,
    },
    Update {
        file_id: FileId,
        update: String,
    },
    Closed {
        file_id: FileId,
        reason: DocClosedReason,
    },
    Sync {
        file_id: FileId,
        state_vector: String,
        update: String,
    },
    Access {
        write: bool,
    },
    Rejected {
        file_id: FileId,
        reason: String,
    },
}

fn emit(app: &AppHandle, room: &str, side: &'static str, notice: DocNotice) {
    let _ = app.emit(
        DOC_EVENT,
        NetEvent {
            room_uid: room,
            side,
            event: notice,
        },
    );
}

/// A participant's change kept until the Owner acknowledges it.
#[derive(Serialize, Deserialize)]
struct Pending {
    file: FileId,
    update: String,
}

/// Which outbox entry a sent frame belongs to (the Owner's ack names the frame).
#[derive(Default)]
pub struct DocFrames {
    frames: Mutex<HashMap<MessageId, (String, MessageId, FileId)>>,
}

impl DocFrames {
    fn lock(&self) -> std::sync::MutexGuard<'_, HashMap<MessageId, (String, MessageId, FileId)>> {
        self.frames
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }
}

// ---- Owner side ----------------------------------------------------------------------------------------------

/// Tells the Owner's editor windows what happened to followed documents.
pub fn owner_events(app: &AppHandle, room: &str, events: Vec<OwnerDocEvent>) {
    for event in events {
        let notice = match event {
            OwnerDocEvent::Active { file, path } => DocNotice::Active {
                file_id: file,
                path: path.to_string_lossy().into_owned(),
            },
            OwnerDocEvent::Update { file, update } => DocNotice::Update {
                file_id: file,
                update: B64.encode(update),
            },
            OwnerDocEvent::Closed { file } => DocNotice::Closed {
                file_id: file,
                reason: DocClosedReason::Deleted,
            },
        };
        emit(app, room, "host", notice);
    }
}

/// Sends messages to participants of a hosted room.
pub fn send_all(app: &AppHandle, room: &str, messages: Vec<(PeerId, Body)>) {
    let Some(state) = app.try_state::<AppState>() else {
        return;
    };
    let Some(network) = state.collab.net.hosting(room) else {
        return;
    };
    for (peer, body) in messages {
        network.send(peer, body);
    }
}

/// Tells every connected member whether it may change files now (after any room or membership change, and on
/// admission). The Owner still checks every change itself.
pub async fn refresh_access(app: &AppHandle, room: &str) {
    let Some(state) = app.try_state::<AppState>() else {
        return;
    };
    let messages = state
        .collab
        .access_list(room)
        .await
        .into_iter()
        .map(|(peer, write)| (peer, Body::Access { write }))
        .collect();
    send_all(app, room, messages);
}

// ---- Participant side ----------------------------------------------------------------------------------------

async fn joined_row(state: &AppState, room: &str) -> Result<i64, String> {
    rooms::get_by_uid(state.db.pool(), room)
        .await
        .map_err(|e| e.to_string())?
        .map(|r| r.id)
        .ok_or_else(|| "This room isn't stored here.".into())
}

/// Sends (or keeps for later) one of this participant's changes.
pub async fn send_update(
    state: &AppState,
    room: &str,
    file: FileId,
    update: Vec<u8>,
) -> Result<(), String> {
    let id = MessageId::random().map_err(|e| e.to_string())?;
    let row = joined_row(state, room).await?;
    let pending = serde_json::to_vec(&Pending {
        file: file.clone(),
        update: B64.encode(&update),
    })
    .map_err(|e| e.to_string())?;
    outbox::enqueue(
        state.db.pool(),
        row,
        id.as_str(),
        OUTBOX_CHANNEL,
        &pending,
        now_ms(),
    )
    .await
    .map_err(|e| e.to_string())?;
    transmit(state, room, file, id, update).await;
    Ok(())
}

/// Sends a kept change if the room is connected (otherwise it waits in the outbox).
async fn transmit(state: &AppState, room: &str, file: FileId, id: MessageId, update: Vec<u8>) {
    let Some(remote) = state.collab.net.remote(room) else {
        return;
    };
    match remote.send_update(file.clone(), id.clone(), update) {
        Ok(frame) => {
            state
                .collab
                .net
                .doc_frames
                .lock()
                .insert(frame, (room.to_string(), id.clone(), file));
            let _ = outbox::mark_attempt(state.db.pool(), id.as_str(), now_ms()).await;
        }
        Err(err) => {
            tracing::debug!(%err, "a change waits in the outbox until the room is reachable")
        }
    }
}

/// Sends again what the Owner hasn't acknowledged for `file` (after opening it on a new session).
async fn resend_pending(state: &AppState, room: &str, file: &FileId) {
    let Ok(row) = joined_row(state, room).await else {
        return;
    };
    let Ok(rows) = outbox::pending(state.db.pool(), row, 500).await else {
        return;
    };
    for entry in rows.into_iter().filter(|r| r.channel == OUTBOX_CHANNEL) {
        let Ok(pending) = serde_json::from_slice::<Pending>(&entry.payload) else {
            continue;
        };
        let (Ok(id), Ok(update)) = (
            MessageId::parse(&entry.message_id),
            B64.decode(&pending.update),
        ) else {
            continue;
        };
        if pending.file == *file {
            transmit(state, room, pending.file, id, update).await;
        }
    }
}

/// Handles what the Owner said about documents (participant side).
pub fn on_remote_doc(app: &AppHandle, room: &str, event: DocEvent) {
    let (app, room) = (app.clone(), room.to_string());
    tauri::async_runtime::spawn(async move {
        let Some(state) = app.try_state::<AppState>() else {
            return;
        };
        let notice = match event {
            DocEvent::Sync {
                file,
                state_vector,
                update,
            } => {
                emit(
                    &app,
                    &room,
                    "participant",
                    DocNotice::Sync {
                        file_id: file.clone(),
                        state_vector: B64.encode(state_vector),
                        update: B64.encode(update),
                    },
                );
                resend_pending(&state, &room, &file).await;
                return;
            }
            DocEvent::Update { file, update } => DocNotice::Update {
                file_id: file,
                update: B64.encode(update),
            },
            DocEvent::Closed { file, reason } => DocNotice::Closed {
                file_id: file,
                reason,
            },
            DocEvent::Access { write } => DocNotice::Access { write },
            DocEvent::Acked { frame } => {
                let entry = state.collab.net.doc_frames.lock().remove(&frame);
                if let Some((_, id, _)) = entry {
                    let _ = outbox::ack(state.db.pool(), id.as_str(), now_ms()).await;
                }
                return;
            }
            DocEvent::Rejected { frame, reason } => {
                let Some((_, id, file)) = state.collab.net.doc_frames.lock().remove(&frame) else {
                    return;
                };
                let _ = outbox::reject(state.db.pool(), id.as_str(), &reason, now_ms()).await;
                DocNotice::Rejected {
                    file_id: file,
                    reason,
                }
            }
        };
        emit(&app, &room, "participant", notice);
    });
}
