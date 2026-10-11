//! Presence between the network and the windows (Milestone 24, phase 7). Ephemeral throughout: memory only, never
//! SQLite, never the canonical state; `collab:presence` events to the windows, the `openmind-awareness` channel to peers.
//!
//! - **One member, many windows**: every window reports what it has active (`collab_presence_set`); the computer
//!   publishes one presence per room — the most recently changed window that has a shared file active — so several
//!   local windows never look like several collaborators.
//! - **Bounded**: a room's presence goes out at most every [`SEND_EVERY`]; states that arrive meanwhile collapse into
//!   the latest (presence is latest-value data).
//! - Roles and online state come from the Owner's roster (membership), never from presence.

use std::collections::HashMap;
use std::sync::Mutex;
use std::time::{Duration, Instant};

use openmind_collab::presence::{CursorState, PresenceState, RosterEntry};
use openmind_collab::protocol::Body;
use openmind_collab::{FileId, PeerId};
use openmind_collab_net::remote::PresenceEvent;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager};

use super::host::PresenceNotice;
use super::net::NetEvent;
use crate::app_state::AppState;

pub const PRESENCE_EVENT: &str = "collab:presence";
/// The shortest gap between two presence states a room sends.
pub const SEND_EVERY: Duration = Duration::from_millis(50);

#[derive(Debug, Clone, Serialize)]
#[serde(
    rename_all = "camelCase",
    tag = "kind",
    rename_all_fields = "camelCase"
)]
pub enum PresenceOut {
    Roster {
        members: Vec<RosterEntry>,
    },
    Peer {
        peer: PeerId,
        state: PresenceState,
        active_path: Option<String>,
    },
    Gone {
        peer: PeerId,
    },
    /// The connection ended: every other member's presence is gone.
    Reset,
    /// Participant: the room and its members as this member may manage them (phase 8).
    Room {
        view: Box<openmind_collab::roomview::RoomView>,
    },
}

fn emit(app: &AppHandle, room: &str, side: &'static str, event: PresenceOut) {
    let _ = app.emit(
        PRESENCE_EVENT,
        NetEvent {
            room_uid: room,
            side,
            event,
        },
    );
}

/// What one window reports.
#[derive(Debug, Clone, Default, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct LocalPresence {
    pub active: Option<FileId>,
    /// The Owner's own editor names files by where they are on this computer; resolved to the shared file here.
    #[serde(default)]
    pub path: Option<String>,
    pub cursor: Option<CursorState>,
    pub typing: bool,
}

#[derive(Default)]
struct LocalRoom {
    windows: HashMap<String, (LocalPresence, Instant)>,
    seq: u64,
    last_sent: Option<Instant>,
    sent: Option<LocalPresence>,
    scheduled: bool,
}

impl LocalRoom {
    /// The window whose presence the room shows: the newest with a shared file active, else the newest.
    fn merged(&self) -> LocalPresence {
        let newest = |with_file: bool| {
            self.windows
                .values()
                .filter(|(p, _)| !with_file || p.active.is_some())
                .max_by_key(|(_, at)| *at)
                .map(|(p, _)| p.clone())
        };
        newest(true).or_else(|| newest(false)).unwrap_or_default()
    }
}

/// A joined room as this participant knows it.
#[derive(Default, Clone)]
struct RemoteView {
    roster: Vec<RosterEntry>,
    peers: HashMap<PeerId, PresenceState>,
    /// What this member may manage, as the Owner last said (phase 8).
    room: Option<openmind_collab::roomview::RoomView>,
}

#[derive(Default)]
pub struct PresenceRuntime {
    local: Mutex<HashMap<String, LocalRoom>>,
    remote: Mutex<HashMap<String, RemoteView>>,
}

fn lock<T>(m: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    m.lock().unwrap_or_else(std::sync::PoisonError::into_inner)
}

impl PresenceRuntime {
    /// The connection to a joined room ended.
    pub fn forget_room(&self, room: &str) {
        lock(&self.remote).remove(room);
        if let Some(local) = lock(&self.local).get_mut(room) {
            local.sent = None; // republish on the next session
        }
    }
}

// ---- Owner side ----------------------------------------------------------------------------------------------

pub fn owner_notice(app: &AppHandle, room: &str, notice: PresenceNotice) {
    let active_path = notice.active_path.map(|p| p.to_string_lossy().into_owned());
    emit(
        app,
        room,
        "host",
        PresenceOut::Peer {
            peer: notice.peer,
            state: notice.state,
            active_path,
        },
    );
}

/// The roster (and each member's own room view) to every connected member and to this computer's windows (after a
/// join, a leave, a waiting member, any room or membership change).
pub async fn refresh_roster(app: &AppHandle, room: &str) {
    let Some(state) = app.try_state::<AppState>() else {
        return;
    };
    let members = state.collab.roster(room).await;
    let mut messages = Vec::new();
    for (peer, _) in state.collab.access_list(room).await {
        let roster = Body::Roster {
            members: members.clone(),
        };
        messages.push((peer.clone(), roster));
        // Phase 8: what this member may manage (pending and banned members, overrides), as the Owner decides.
        if let Some(view) = state.collab.room_view(room, &peer).await {
            messages.push((peer, Body::RoomView { view }));
        }
    }
    super::net_docs::send_all(app, room, messages);
    emit(app, room, "host", PresenceOut::Roster { members });
}

/// Someone was admitted: everyone gets the roster, and the newcomer everyone's current presence.
pub async fn on_admitted(app: &AppHandle, room: &str) {
    refresh_roster(app, room).await;
    let Some(state) = app.try_state::<AppState>() else {
        return;
    };
    let current = state.collab.presence_states(room).await;
    let mut messages = Vec::new();
    for (to, _) in state.collab.access_list(room).await {
        for (peer, presence) in current.iter().filter(|(p, _)| *p != to) {
            messages.push((
                to.clone(),
                Body::PeerPresence {
                    peer: peer.clone(),
                    state: presence.clone(),
                },
            ));
        }
    }
    super::net_docs::send_all(app, room, messages);
}

pub async fn on_left(app: &AppHandle, room: &str, peer: &PeerId) {
    let Some(state) = app.try_state::<AppState>() else {
        return;
    };
    let messages = state.collab.presence_gone(room, peer).await;
    super::net_docs::send_all(app, room, messages);
    emit(app, room, "host", PresenceOut::Gone { peer: peer.clone() });
    refresh_roster(app, room).await;
}

/// A shared file was deleted: nobody is in it any more.
pub async fn file_gone(app: &AppHandle, room: &str, file: &FileId) {
    let Some(state) = app.try_state::<AppState>() else {
        return;
    };
    let messages = state.collab.presence_file_gone(room, file).await;
    let mut told = std::collections::HashSet::new();
    for (_, body) in &messages {
        if let Body::PeerPresence {
            peer,
            state: presence,
        } = body
        {
            if told.insert(peer.clone()) {
                emit(
                    app,
                    room,
                    "host",
                    PresenceOut::Peer {
                        peer: peer.clone(),
                        state: presence.clone(),
                        active_path: None,
                    },
                );
            }
        }
    }
    super::net_docs::send_all(app, room, messages);
}

/// The shared tree changed (a rename or move): the Owner's windows hear where members' active files are now. Members
/// themselves need nothing — file ids survive renames.
pub async fn paths_moved(app: &AppHandle, room: &str) {
    let Some(state) = app.try_state::<AppState>() else {
        return;
    };
    let me = state
        .collab
        .identity(&state.db)
        .await
        .ok()
        .map(|i| i.peer_id());
    for (peer, presence) in state.collab.presence_states(room).await {
        let Some(file) = presence.active.clone() else {
            continue;
        };
        if Some(&peer) == me.as_ref() {
            continue;
        }
        let path = state.collab.file_path(&state.db, room, &file).await;
        let active_path = path.map(|p| p.to_string_lossy().into_owned());
        emit(
            app,
            room,
            "host",
            PresenceOut::Peer {
                peer,
                state: presence,
                active_path,
            },
        );
    }
}

// ---- Participant side ----------------------------------------------------------------------------------------

pub fn on_remote_presence(app: &AppHandle, room: &str, event: PresenceEvent) {
    let Some(state) = app.try_state::<AppState>() else {
        return;
    };
    let out = {
        let mut remote = lock(&state.collab.net.presence.remote);
        let view = remote.entry(room.to_string()).or_default();
        match event {
            PresenceEvent::Roster(members) => {
                view.roster = members.clone();
                PresenceOut::Roster { members }
            }
            PresenceEvent::Peer {
                peer,
                state: presence,
            } => {
                if view
                    .peers
                    .get(&peer)
                    .is_some_and(|last| last.seq >= presence.seq)
                {
                    return; // arrived late: a newer state is already shown
                }
                view.peers.insert(peer.clone(), presence.clone());
                PresenceOut::Peer {
                    peer,
                    state: presence,
                    active_path: None,
                }
            }
            PresenceEvent::Gone { peer } => {
                view.peers.remove(&peer);
                PresenceOut::Gone { peer }
            }
            PresenceEvent::Room(owner_view) => {
                view.room = Some((*owner_view).clone());
                remember_view(app, room, &owner_view);
                PresenceOut::Room { view: owner_view }
            }
        }
    };
    emit(app, room, "participant", out);
}

/// Keeps a joined room's local record as the Owner describes it (name, this member's role, settings, closed), so the
/// room history and the next start show what is true now. The pinned hosting key is never changed here.
fn remember_view(app: &AppHandle, room: &str, view: &openmind_collab::roomview::RoomView) {
    let (app, room, view) = (app.clone(), room.to_string(), view.clone());
    tauri::async_runtime::spawn(async move {
        let Some(state) = app.try_state::<AppState>() else {
            return;
        };
        let pool = state.db.pool();
        let Ok(Some(row)) = openmind_db::collab::rooms::get_by_uid(pool, &room).await else {
            return;
        };
        if row.relation != "joined" {
            return;
        }
        let settings = openmind_db::collab::RoomSettings {
            name: &view.name,
            local_role: view.you.role.as_str(),
            owner_peer: view.owner.as_str(),
            owner_public_key: &row.owner_public_key,
            locked: view.locked,
            approval_required: view.approval_required,
            default_role: view.default_role.as_str(),
            closed: view.closed,
        };
        if let Err(err) = openmind_db::collab::rooms::update_settings(pool, row.id, &settings).await
        {
            tracing::warn!(%err, "a joined room's settings couldn't be stored");
        }
        crate::state::refresh_soon(&app, &[crate::state::Domain::Collaboration]);
    });
}

pub fn connection_ended(app: &AppHandle, room: &str) {
    if let Some(state) = app.try_state::<AppState>() {
        state.collab.net.presence.forget_room(room);
    }
    emit(app, room, "participant", PresenceOut::Reset);
}

// ---- This computer's own presence ----------------------------------------------------------------------------

/// A window reports its presence in `room`; the room's merged presence goes out (throttled).
pub fn set_local(app: &AppHandle, window: &str, room: &str, presence: LocalPresence) {
    let Some(state) = app.try_state::<AppState>() else {
        return;
    };
    lock(&state.collab.net.presence.local)
        .entry(room.to_string())
        .or_default()
        .windows
        .insert(window.to_string(), (presence, Instant::now()));
    schedule(app, &state, room);
}

/// Sends the room's merged presence now, or once [`SEND_EVERY`] has passed since the last send.
fn schedule(app: &AppHandle, state: &AppState, room: &str) {
    let send_now = {
        let mut local = lock(&state.collab.net.presence.local);
        let Some(entry) = local.get_mut(room) else {
            return;
        };
        if entry.scheduled {
            return; // the scheduled send takes the latest state
        }
        let wait = entry
            .last_sent
            .map_or(Duration::ZERO, |at| SEND_EVERY.saturating_sub(at.elapsed()));
        if wait.is_zero() {
            true
        } else {
            entry.scheduled = true;
            let (app, room) = (app.clone(), room.to_string());
            tauri::async_runtime::spawn(async move {
                tokio::time::sleep(wait).await;
                publish(&app, &room, true).await;
            });
            false
        }
    };
    if send_now {
        let (app, room) = (app.clone(), room.to_string());
        tauri::async_runtime::spawn(async move { publish(&app, &room, false).await });
    }
}

/// A new session to the room (joined or reconnected): what this computer shows goes out again at once.
pub fn republish(app: &AppHandle, room: &str) {
    let Some(state) = app.try_state::<AppState>() else {
        return;
    };
    if let Some(entry) = lock(&state.collab.net.presence.local).get_mut(room) {
        entry.sent = None;
    }
    schedule(app, &state, room);
}

/// A window closed: it no longer shows anything.
pub fn window_closed(app: &AppHandle, window: &str) {
    let Some(state) = app.try_state::<AppState>() else {
        return;
    };
    let rooms: Vec<String> = {
        let mut local = lock(&state.collab.net.presence.local);
        local
            .iter_mut()
            .filter_map(|(room, entry)| entry.windows.remove(window).map(|_| room.clone()))
            .collect()
    };
    for room in rooms {
        schedule(app, &state, &room);
    }
}

async fn publish(app: &AppHandle, room: &str, scheduled: bool) {
    let Some(state) = app.try_state::<AppState>() else {
        return;
    };
    let (mut presence, path) = {
        let mut local = lock(&state.collab.net.presence.local);
        let Some(entry) = local.get_mut(room) else {
            return;
        };
        if scheduled {
            entry.scheduled = false;
        }
        let merged = entry.merged();
        let heartbeat = entry
            .last_sent
            .is_some_and(|at| at.elapsed() > Duration::from_secs(5));
        if entry.sent.as_ref() == Some(&merged) && !heartbeat {
            return;
        }
        entry.seq += 1;
        entry.last_sent = Some(Instant::now());
        entry.sent = Some(merged.clone());
        let presence = PresenceState {
            seq: entry.seq,
            active: merged.active,
            cursor: merged.cursor,
            typing: merged.typing,
        };
        (presence, merged.path)
    };
    if state.collab.net.hosting(room).is_some() {
        if let (None, Some(path)) = (&presence.active, path) {
            let file = state
                .collab
                .file_at(&state.db, room, std::path::Path::new(&path))
                .await;
            presence.active = file;
        }
        let messages = state.collab.owner_presence(&state.db, room, presence).await;
        super::net_docs::send_all(app, room, messages);
    } else if let Some(sender) = state.collab.net.joined(room) {
        let _ = sender.send(Body::Presence { state: presence });
    }
}

// ---- Snapshot for a window that opens later --------------------------------------------------------------------

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PeerView {
    pub peer: PeerId,
    pub state: PresenceState,
    pub active_path: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PresenceSnapshot {
    /// This computer's own peer (shown as "you", never as a collaborator).
    pub me: PeerId,
    pub roster: Vec<RosterEntry>,
    pub peers: Vec<PeerView>,
    /// Participant: the Owner's last room view for this member (the Owner's own computer reads the canonical state).
    pub room: Option<openmind_collab::roomview::RoomView>,
}

pub async fn snapshot(state: &AppState, room: &str) -> Result<PresenceSnapshot, String> {
    let me = state.collab.identity(&state.db).await?.peer_id();
    if state.collab.net.hosting(room).is_some() {
        let roster = state.collab.roster(room).await;
        let mut peers = Vec::new();
        for (peer, presence) in state
            .collab
            .presence_states(room)
            .await
            .into_iter()
            .filter(|(p, _)| *p != me)
        {
            let active_path = match &presence.active {
                Some(file) => state
                    .collab
                    .file_path(&state.db, room, file)
                    .await
                    .map(|p| p.to_string_lossy().into_owned()),
                None => None,
            };
            peers.push(PeerView {
                peer,
                state: presence,
                active_path,
            });
        }
        return Ok(PresenceSnapshot {
            me,
            roster,
            peers,
            room: None,
        });
    }
    let view = lock(&state.collab.net.presence.remote)
        .get(room)
        .cloned()
        .unwrap_or_default();
    let peers = view
        .peers
        .into_iter()
        .map(|(peer, state)| PeerView {
            peer,
            state,
            active_path: None,
        })
        .collect();
    Ok(PresenceSnapshot {
        me,
        roster: view.roster,
        room: view.room,
        peers,
    })
}
