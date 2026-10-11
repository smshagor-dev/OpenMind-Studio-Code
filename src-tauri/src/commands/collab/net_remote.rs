//! A joined room's shared workspace on this (participant) machine: the remote tree and file fetching from
//! `openmind_collab_net::remote`, its transient events (`collab:remote`: tree ready/changed/stale, transfer progress)
//! and connection states (`collab:net`). Nothing here is canonical state: a remote tree belongs to one connection.
//!
//! A fetched text file is decoded the way local files are (`openmind_fs::encoding`: BOM-sniffed UTF-8/UTF-16, else
//! Windows-1252) and handed to the page, which opens it as an `omcollab:` read-only document. Binary files are not
//! decoded; the page is told so.

use std::sync::Arc;

use openmind_collab::manifest::ManifestEntry;
use openmind_collab::FileId;
use openmind_collab_net::participant::Participant;
use openmind_collab_net::remote::{self, RemoteEvent};
use openmind_collab_net::ConnectionState;
use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager};

use super::net::{NetEvent, NET_EVENT};
use crate::app_state::AppState;
use crate::state::Domain;

pub const REMOTE_EVENT: &str = "collab:remote";

#[derive(Debug, Clone, Serialize)]
#[serde(
    rename_all = "camelCase",
    tag = "kind",
    rename_all_fields = "camelCase"
)]
enum RemoteNotice {
    TreeReady {
        version: u64,
    },
    TreeDelta {
        base: u64,
        version: u64,
        upserts: Vec<ManifestEntry>,
        removed: Vec<FileId>,
    },
    TreeStale,
    Progress {
        file: FileId,
        received: u64,
        total: u64,
    },
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase", tag = "kind")]
enum ConnectionNotice {
    State {
        state: ConnectionState,
    },
    Invalid {
        reason: String,
    },
    /// How the room was reached (`localLan`: directly over the local network; `internetRelay`).
    Route {
        route: openmind_collab_net::ConnectionRoute,
    },
    /// The kind of path the connection takes (direct, STUN, or a TURN relay over UDP, TCP or TLS); no address.
    Path {
        path: openmind_collab_net::transport::IcePath,
    },
}

/// Tells the windows how a joined room was reached.
pub fn announce_route(app: &AppHandle, room: &str, route: openmind_collab_net::ConnectionRoute) {
    let _ = app.emit(
        NET_EVENT,
        NetEvent {
            room_uid: room,
            side: "participant",
            event: ConnectionNotice::Route { route },
        },
    );
}

/// Follows an admitted participant session until it ends (then the room's local session is recorded as ended).
pub fn follow(app: &AppHandle, room: &str, participant: Participant) {
    let session = participant.admission().session.clone();
    let (handle, room_id) = (app.clone(), room.to_string());
    let listener: remote::Listener = Arc::new(move |event| {
        let notice = match event {
            RemoteEvent::Doc(event) => {
                if super::net_manage::intercept(&handle, &event) {
                    return; // the answer to a management command
                }
                return super::net_docs::on_remote_doc(&handle, &room_id, event);
            }
            RemoteEvent::Voice(event) => {
                return super::net_voice::on_remote_voice(&handle, &room_id, event)
            }
            RemoteEvent::Presence(event) => {
                return super::net_presence::on_remote_presence(&handle, &room_id, event)
            }
            RemoteEvent::TreeReady { version } => RemoteNotice::TreeReady { version },
            RemoteEvent::TreeDelta {
                base,
                version,
                upserts,
                removed,
            } => RemoteNotice::TreeDelta {
                base,
                version,
                upserts,
                removed,
            },
            RemoteEvent::TreeStale => RemoteNotice::TreeStale,
            RemoteEvent::Progress {
                file,
                received,
                total,
            } => RemoteNotice::Progress {
                file,
                received,
                total,
            },
            RemoteEvent::State(state) => {
                return connection(&handle, &room_id, ConnectionNotice::State { state })
            }
            RemoteEvent::Invalid(reason) => {
                return connection(&handle, &room_id, ConnectionNotice::Invalid { reason })
            }
            RemoteEvent::Path(path) => {
                if let Some(state) = handle.try_state::<AppState>() {
                    state.collab.net.remember_path(&room_id, path);
                }
                return connection(&handle, &room_id, ConnectionNotice::Path { path });
            }
        };
        let _ = handle.emit(
            REMOTE_EVENT,
            NetEvent {
                room_uid: &room_id,
                side: "participant",
                event: notice,
            },
        );
    });
    let (workspace, task) = remote::spawn(participant, listener);
    if let Some(state) = app.try_state::<AppState>() {
        state.collab.net.remember_remote(room, workspace);
    }
    super::net_presence::republish(app, room);
    let (app, room) = (app.clone(), room.to_string());
    tauri::async_runtime::spawn(async move {
        let _ = task.await;
        if let Some(state) = app.try_state::<AppState>() {
            state.collab.net.forget_joined(&room);
            super::net_presence::connection_ended(&app, &room);
            super::net_voice::connection_ended(&app, &room);
            super::net_join::session_ended(&state.db, &room, &session, "connection ended").await;
        }
        crate::state::refresh_soon(&app, &[Domain::Collaboration]);
    });
}

fn connection(app: &AppHandle, room: &str, notice: ConnectionNotice) {
    if let (ConnectionNotice::State { state }, Some(app_state)) =
        (&notice, app.try_state::<AppState>())
    {
        app_state.collab.net.set_state(room, *state);
    }
    let _ = app.emit(
        NET_EVENT,
        NetEvent {
            room_uid: room,
            side: "participant",
            event: notice,
        },
    );
}

/// The remote tree of a joined room, as the page shows it.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteTreeView {
    pub ready: bool,
    pub version: u64,
    pub root: String,
    pub entries: Vec<ManifestEntry>,
}

/// A fetched remote file: verified bytes, decoded when it is text.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteFile {
    pub room_uid: String,
    pub file_id: FileId,
    /// Workspace-relative (never an absolute Owner path).
    pub path: String,
    pub name: String,
    pub size: u64,
    pub sha256: String,
    pub binary: bool,
    pub text: Option<String>,
    pub encoding: Option<openmind_fs::TextEncoding>,
}

pub fn tree(state: &AppState, room: &str) -> Result<RemoteTreeView, String> {
    let remote = state
        .collab
        .net
        .remote(room)
        .ok_or("You aren't connected to this room.")?;
    Ok(remote.tree(|t| RemoteTreeView {
        ready: t.is_ready(),
        version: t.version(),
        root: t.root().to_string(),
        entries: t.entries().values().cloned().collect(),
    }))
}

pub async fn open(state: &AppState, room: &str, file: &str) -> Result<RemoteFile, String> {
    let remote = state
        .collab
        .net
        .remote(room)
        .ok_or("You aren't connected to this room.")?;
    let id = FileId::parse(file).map_err(|e| e.to_string())?;
    let entry = remote
        .tree(|t| t.get(&id).cloned())
        .ok_or("This file isn't available.")?;
    if entry.kind != openmind_collab::FileKind::File {
        return Err("A folder can't be opened.".into());
    }
    let received = remote.fetch(id.clone()).await.map_err(|e| e.to_string())?;
    let (text, encoding) = if received.text {
        let decoded = openmind_fs::encoding::decode(&received.bytes);
        (Some(decoded.text), Some(decoded.encoding))
    } else {
        (None, None)
    };
    Ok(RemoteFile {
        room_uid: room.to_string(),
        file_id: id,
        path: entry.path.to_string(),
        name: entry.name,
        size: received.bytes.len() as u64,
        sha256: received.sha256,
        binary: !received.text,
        text,
        encoding,
    })
}
