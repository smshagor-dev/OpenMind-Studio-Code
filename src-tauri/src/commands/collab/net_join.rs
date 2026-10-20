//! Joining a room as a participant, and the local history of it: the room row (relation `joined`, the Owner's key
//! pinned at the first join, the Room Code kept DPAPI-protected so the room can be found again) and this machine's
//! own session rows.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;

use openmind_collab::protocol::Admission;
use openmind_collab::{PublicKey, RoomCode, RoomUid, SessionId};
use openmind_collab_net::lan::parse_endpoint;
use openmind_collab_net::participant::{JoinMode, Participant, ParticipantConfig};
use openmind_collab_net::route::{self, LanOptions, RouteOptions};
use openmind_collab_net::ConnectionRoute;
use openmind_db::collab::{self as repo, rooms, sessions, NewRoom, RoomSettings, SessionRow};
use openmind_db::Db;
use serde::Serialize;
use tauri::AppHandle;

use super::net::setup;
use super::net_manage::{classify, JoinError};
use super::now_ms;
use crate::app_state::AppState;
use crate::secret;
use crate::state::Domain;

#[cfg(test)]
#[path = "net_tests.rs"]
mod tests;

#[cfg(test)]
#[path = "net_lan_tests.rs"]
mod lan_tests;

#[cfg(test)]
#[path = "net_docs_tests.rs"]
mod docs_tests;

#[cfg(test)]
#[path = "net_manage_tests.rs"]
mod manage_tests;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct JoinedRoom {
    pub room_uid: String,
    pub room_name: String,
    pub role: String,
    /// How the room was reached ("connected directly over the local network" / through the signaling server).
    pub route: ConnectionRoute,
}

fn text(err: impl std::fmt::Display) -> String {
    err.to_string()
}

/// What a rejoin needs from the stored row: the code (its topic) and the pinned Owner key.
async fn stored_rejoin(state: &AppState, room_uid: &str) -> Result<(RoomCode, JoinMode), String> {
    let row = rooms::get_by_uid(state.db.pool(), room_uid)
        .await
        .map_err(text)?
        .ok_or("This room isn't stored on this computer.")?;
    if row.relation != "joined" {
        return Err("This room is hosted here; start hosting it instead.".into());
    }
    let protected = row
        .invite_secret
        .as_deref()
        .ok_or("The Room Code of this room wasn't kept; join it again with the code.")?;
    let code = RoomCode::parse(&secret::unprotect(protected).map_err(text)?).map_err(text)?;
    let owner_key = PublicKey::parse(&row.owner_public_key).map_err(text)?;
    let room = RoomUid::parse(&row.room_uid).map_err(text)?;
    Ok((code, JoinMode::Reconnect { room, owner_key }))
}

/// How to reach the room: the local network first when it is turned on (the address that worked last time, then
/// discovery), then the Internet: the configured signaling server, else the built-in public brokers.
fn route_options(
    state: &AppState,
    setup: &super::net::NetSetup,
    room: Option<&str>,
    lan_address: Option<&str>,
) -> Result<RouteOptions, String> {
    let manual = lan_address
        .filter(|a| !a.trim().is_empty())
        .map(parse_endpoint)
        .transpose()?;
    if manual.is_some() && !setup.lan {
        return Err(
            "Turn on Settings > Collaboration > Local Network to connect to a local address."
                .into(),
        );
    }
    let lan = setup.lan.then(|| LanOptions {
        manual,
        known: room.and_then(|room| state.collab.net.known_lan(room)),
        ..LanOptions::default()
    });
    Ok(RouteOptions {
        lan,
        internet: Some(setup.internet()),
    })
}

/// The code to look for and how to introduce ourselves: a typed code (first join) or a stored room (key-based rejoin).
async fn code_and_mode(
    state: &AppState,
    code: Option<String>,
    rejoin: Option<&str>,
) -> Result<(RoomCode, JoinMode), JoinError> {
    match (code, rejoin) {
        (_, Some(room_uid)) => Ok(stored_rejoin(state, room_uid).await?),
        (Some(code), None) => Ok((
            RoomCode::parse(&code).map_err(|e| JoinError::new("invalidCode", e.to_string()))?,
            JoinMode::Join,
        )),
        (None, None) => Err(JoinError::new("invalidCode", "Enter a Room Code.")),
    }
}

/// Tells the windows (and the failure classification) that the Owner put the join on hold for approval.
fn pending_hook(app: &AppHandle, pending: &Arc<AtomicBool>) -> Arc<dyn Fn() + Send + Sync> {
    let (app, pending) = (app.clone(), pending.clone());
    Arc::new(move || {
        pending.store(true, Ordering::Relaxed);
        super::net_manage::progress(&app, "pending");
    })
}

/// Joins with a code (first time) or rejoins a stored room.
pub async fn join(
    app: &AppHandle,
    state: &AppState,
    code: Option<String>,
    rejoin: Option<String>,
    display_name: String,
    lan_address: Option<String>,
) -> Result<JoinedRoom, JoinError> {
    let (code, mode) = code_and_mode(state, code, rejoin.as_deref()).await?;
    let setup = setup(state)
        .await
        .map_err(|e| JoinError::new("notConfigured", e))?;
    let pending = Arc::new(AtomicBool::new(false));
    let on_pending = pending_hook(app, &pending);
    let identity = state.collab.identity(&state.db).await?;
    let config = ParticipantConfig {
        code: code.clone(),
        display_name,
        mode,
        ice: setup.ice.clone(),
        gatherer: setup.gatherer(),
        relay: setup.relay(),
        handshake_timeout: Duration::from_secs(30),
        approval_timeout: Duration::from_secs(300),
        on_pending: Some(on_pending),
    };
    let options = route_options(state, &setup, rejoin.as_deref(), lan_address.as_deref())
        .map_err(|e| JoinError::new("invalidAddress", e))?;
    super::net_manage::progress(app, if setup.lan { "searching" } else { "connecting" });
    let (result, report) = route::connect_with_report(identity, config, options).await;
    let failure = result
        .as_ref()
        .err()
        .map(|err| classify(err, &report, pending.load(Ordering::Relaxed)));
    state.collab.net.remember_report(report);
    if let Some(failure) = failure {
        if failure.kind == "closed" {
            if let Some(room) = rejoin.as_deref() {
                mark_closed(&state.db, room).await;
                crate::state::refresh_soon(app, &[Domain::Collaboration]);
            }
        }
        super::net_manage::progress(app, "failed");
        return Err(failure);
    }
    let routed = result.map_err(|e| JoinError::new("other", e.to_string()))?;
    let participant = routed.participant;
    remember(&state.db, &participant, &code).await?;
    let admission = participant.admission().clone();
    let room_uid = participant.room().to_string();
    state
        .collab
        .net
        .remember_joined(&room_uid, participant.sender());
    // Admitted: the connection is up (later changes arrive as `collab:net` state events).
    state
        .collab
        .net
        .set_state(&room_uid, openmind_collab_net::ConnectionState::Connected);
    state
        .collab
        .net
        .remember_route(&room_uid, routed.route, routed.endpoint);
    super::net_remote::announce_route(app, &room_uid, routed.route);
    super::net_remote::follow(app, &room_uid, participant);
    crate::state::refresh_soon(app, &[Domain::Collaboration]);
    super::net_manage::progress(app, "connected");
    Ok(JoinedRoom {
        room_uid,
        room_name: admission.room_name,
        role: admission.role.as_str().into(),
        route: routed.route,
    })
}

pub(super) async fn remember(
    db: &Db,
    participant: &Participant,
    code: &RoomCode,
) -> Result<(), String> {
    let now = now_ms();
    let admission: &Admission = participant.admission();
    let owner_key = participant.owner_key().to_text();
    let room_uid = participant.room().to_string();
    let protected = secret::protect(&code.display()).map_err(text)?;
    let mut tx = repo::begin(db).await.map_err(text)?;
    let id = match rooms::get_by_uid(&mut *tx, &room_uid).await.map_err(text)? {
        Some(row) if row.relation == "created" => {
            return Err("This computer hosts that room.".into())
        }
        Some(row) => {
            let settings = RoomSettings {
                name: &admission.room_name,
                local_role: admission.role.as_str(),
                owner_peer: admission.owner.as_str(),
                owner_public_key: &row.owner_public_key,
                locked: row.locked,
                approval_required: row.approval_required,
                default_role: &row.default_role,
                closed: row.closed,
            };
            rooms::update_settings(&mut *tx, row.id, &settings)
                .await
                .map_err(text)?;
            row.id
        }
        None => {
            let new = NewRoom {
                room_uid: &room_uid,
                relation: "joined",
                name: &admission.room_name,
                local_role: admission.role.as_str(),
                owner_peer: admission.owner.as_str(),
                owner_public_key: &owner_key,
                workspace_path: None,
                workspace_name: None,
                created_at: now,
            };
            rooms::insert(&mut *tx, &new).await.map_err(text)?
        }
    };
    rooms::set_invite(&mut *tx, id, &code.invite_hash(), &protected, 0)
        .await
        .map_err(text)?;
    rooms::touch_joined(&mut *tx, id, now).await.map_err(text)?;
    let session = SessionRow {
        session_id: admission.session.to_string(),
        room_id: id,
        peer: admission.peer.to_string(),
        role: admission.role.as_str().into(),
        epoch: 0,
        started_at: now,
        connected_at: Some(now),
        ended_at: None,
        end_reason: None,
        last_event_seq: 0,
        manifest_version: 0,
    };
    sessions::insert(&mut *tx, &session).await.map_err(text)?;
    repo::commit(tx).await.map_err(text)
}

/// The Owner said the joined room is closed: its local record says so too (the history stays).
async fn mark_closed(db: &Db, room_uid: &str) {
    let Ok(Some(row)) = rooms::get_by_uid(db.pool(), room_uid).await else {
        return;
    };
    let settings = RoomSettings {
        name: &row.name,
        local_role: &row.local_role,
        owner_peer: &row.owner_peer,
        owner_public_key: &row.owner_public_key,
        locked: row.locked,
        approval_required: row.approval_required,
        default_role: &row.default_role,
        closed: true,
    };
    if let Err(err) = rooms::update_settings(db.pool(), row.id, &settings).await {
        tracing::warn!(%err, "a closed room couldn't be marked closed");
    }
}

/// Records the end of this machine's session in a joined room.
pub async fn session_ended(db: &Db, room_uid: &str, session: &SessionId, reason: &str) {
    let now = now_ms();
    let ended = async {
        sessions::end(db.pool(), session.as_str(), now, reason)
            .await
            .map_err(text)?;
        if let Some(row) = rooms::get_by_uid(db.pool(), room_uid).await.map_err(text)? {
            rooms::touch_seen(db.pool(), row.id, now)
                .await
                .map_err(text)?;
        }
        Ok::<(), String>(())
    };
    if let Err(err) = ended.await {
        tracing::warn!(%err, "the end of a collaboration session couldn't be recorded");
    }
}
