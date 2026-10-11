//! Collaboration rooms (Milestone 24, phases 1-3): the Owner's authority in Rust, persisted in this machine's own
//! database. Commands here act as the user of this app (`Actor::Host`); remote peers will reach the same authority
//! through the networking layer (phase 4), never through these commands. After every change the `Collaboration`
//! canonical domain is refreshed, which is how every window learns about it.
//!
//! What these commands never return: the private key, the TURN password, a Room Code (except to the host who asks
//! for it with `collab_room_invite`) and the shared folder's path.
//!
//! Phase 4 adds the network (`net*` modules): hosting a room through the signaling relay and joining one, with the
//! commands in `net_commands`.

pub mod docs_commands;
mod host;
mod identity;
mod net;
mod net_authority;
pub mod net_commands;
mod net_docs;
mod net_join;
pub mod net_manage;
pub mod net_presence;
mod net_remote;
pub mod net_share;
pub mod net_voice;
pub mod net_voice_ice;
mod persist;
pub mod sfu;
mod turn_login;
mod view;

use std::time::{SystemTime, UNIX_EPOCH};

use openmind_collab::audit::{verify_chain, ChainHead};
use openmind_collab::netconfig::NetConfig;
use openmind_collab::{Command, PublicKey, RoomUid};
use openmind_db::collab::{logs, rooms, ActionLogRow};
use openmind_db::EditorSettingsRepository;
use serde::Serialize;
use tauri::{AppHandle, State};

use crate::app_state::AppState;
use crate::commands::preferences::user_string;
use crate::secret;
use crate::state::Domain;

pub use host::{CollabRuntime, CreatedRoom};
pub use view::snapshot;

const TURN_CREDENTIAL_KEY: &str = "collab.turn.credential";
const HISTORY_PAGE: i64 = 1000;

/// The collaboration network settings, parsed (invalid values are listed in `issues`, never used).
pub(crate) fn read_config(state: &AppState) -> NetConfig {
    NetConfig::parse(
        &user_string(state, "collaboration.signalingUrl"),
        &user_string(state, "collaboration.stunUrls"),
        &user_string(state, "collaboration.turnUrls"),
        &user_string(state, "collaboration.turnUsername"),
    )
}

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| i64::try_from(d.as_millis()).unwrap_or(i64::MAX))
        .unwrap_or(0)
}

async fn changed(app: &AppHandle) {
    crate::state::refresh(app, &[Domain::Collaboration]).await;
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IdentityInfo {
    pub peer_id: String,
    pub fingerprint: String,
    pub public_key: String,
}

/// This profile's collaboration identity (created on first use; the private key never leaves the backend).
#[tauri::command]
pub async fn collab_identity(state: State<'_, AppState>) -> Result<IdentityInfo, String> {
    let identity = state.collab.identity(&state.db).await?;
    Ok(IdentityInfo {
        peer_id: identity.peer_id().to_string(),
        fingerprint: identity.peer_id().fingerprint(),
        public_key: identity.public_key().to_text(),
    })
}

/// Creates a room that shares this window's open folder; returns its id and Room Code.
#[tauri::command]
pub async fn collab_room_create(
    window: tauri::Window,
    app: AppHandle,
    state: State<'_, AppState>,
    name: String,
    display_name: Option<String>,
) -> Result<CreatedRoom, String> {
    let folder = crate::windows::window_workspace(&state, window.label())
        .await?
        .ok_or("Open a folder first: a room shares the folder of this window.")?;
    let display_name = display_name
        .filter(|n| !n.trim().is_empty())
        .unwrap_or_else(|| user_string(&state, "collaboration.displayName"));
    if display_name.trim().is_empty() {
        return Err(
            "Set your display name first (Settings > Collaboration > Display Name).".into(),
        );
    }
    let new = host::NewHostedRoom {
        name: &name,
        display_name: &display_name,
        workspace_path: &folder.path,
        workspace_name: &folder.name,
    };
    let created = state.collab.create_room(&state.db, &new, now_ms()).await?;
    changed(&app).await;
    Ok(created)
}

/// The current Room Code of a room this machine hosts.
#[tauri::command]
pub async fn collab_room_invite(
    state: State<'_, AppState>,
    room_uid: String,
) -> Result<String, String> {
    state
        .collab
        .invite_code(&state.db, &room_uid, now_ms())
        .await
}

/// Changes a hosted room or one of its members as this machine's user (authorized like any other actor).
#[tauri::command]
pub async fn collab_room_command(
    app: AppHandle,
    state: State<'_, AppState>,
    room_uid: String,
    command: Command,
) -> Result<(), String> {
    let result = state
        .collab
        .run_command(&state.db, &room_uid, command, now_ms())
        .await;
    changed(&app).await;
    // A kick, ban, removal or closing ends sessions: their connections close; an approval admits a waiting member.
    result.map(|effects| net_authority::apply_effects(&app, &room_uid, effects))
}

/// Hides a room from the room list (its history is kept) or brings it back.
#[tauri::command]
pub async fn collab_room_archive(
    app: AppHandle,
    state: State<'_, AppState>,
    room_uid: String,
    archived: bool,
) -> Result<(), String> {
    let row = rooms::get_by_uid(state.db.pool(), &room_uid)
        .await
        .map_err(|err| err.to_string())?
        .ok_or("This room isn't stored on this computer.")?;
    rooms::set_archived(state.db.pool(), row.id, archived)
        .await
        .map_err(|err| err.to_string())?;
    changed(&app).await;
    Ok(())
}

/// A room's history after `after_seq`, oldest first (at most 500 events).
#[tauri::command]
pub async fn collab_room_history(
    state: State<'_, AppState>,
    room_uid: String,
    after_seq: i64,
    limit: u32,
) -> Result<Vec<ActionLogRow>, String> {
    let row = rooms::get_by_uid(state.db.pool(), &room_uid)
        .await
        .map_err(|err| err.to_string())?
        .ok_or("This room isn't stored on this computer.")?;
    logs::list_after(
        state.db.pool(),
        row.id,
        after_seq.max(0),
        i64::from(limit.clamp(1, 500)),
    )
    .await
    .map_err(|err| err.to_string())
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HistoryCheck {
    pub events: u64,
    pub intact: bool,
    pub broken_at: Option<u64>,
    pub problem: Option<String>,
}

/// Checks a room's stored history: sequence, hash links and the hosting identity's signatures.
#[tauri::command]
pub async fn collab_room_verify(
    state: State<'_, AppState>,
    room_uid: String,
) -> Result<HistoryCheck, String> {
    let row = rooms::get_by_uid(state.db.pool(), &room_uid)
        .await
        .map_err(|err| err.to_string())?
        .ok_or("This room isn't stored on this computer.")?;
    let uid = RoomUid::parse(&row.room_uid).map_err(|err| err.to_string())?;
    // A hosted room's events are signed by this profile's identity; a joined room's by its host's key.
    let key = if row.relation == "created" {
        state.collab.identity(&state.db).await?.public_key()
    } else {
        PublicKey::parse(&row.owner_public_key).map_err(|err| err.to_string())?
    };
    let mut head = ChainHead::genesis();
    let mut events = 0u64;
    loop {
        let page = logs::list_after(state.db.pool(), row.id, events as i64, HISTORY_PAGE)
            .await
            .map_err(|err| err.to_string())?;
        if page.is_empty() {
            return Ok(HistoryCheck {
                events,
                intact: true,
                broken_at: None,
                problem: None,
            });
        }
        let parsed: Result<Vec<_>, String> =
            page.iter().map(|r| persist::event_of(r, &uid)).collect();
        let parsed = match parsed {
            Ok(parsed) => parsed,
            Err(problem) => {
                return Ok(HistoryCheck {
                    events,
                    intact: false,
                    broken_at: Some(events + 1),
                    problem: Some(problem),
                })
            }
        };
        if let Err(broken) = verify_chain(&parsed, &head, Some(&key)) {
            return Ok(HistoryCheck {
                events,
                intact: false,
                broken_at: Some(broken.seq),
                problem: Some(broken.problem.into()),
            });
        }
        if let Some(last) = parsed.last() {
            head = ChainHead {
                next_seq: last.seq + 1,
                last_hash: last.hash.clone(),
            };
        }
        events += parsed.len() as u64;
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NetworkConfigView {
    #[serde(flatten)]
    pub config: NetConfig,
    pub has_turn_credential: bool,
    /// Whether TURN relaying can be used (servers configured and a login saved), else why not.
    pub relay: openmind_collab_net::transport::RelayStatus,
}

/// The collaboration network settings as they will be used, with every ignored value and why. Nothing is contacted.
#[tauri::command]
pub async fn collab_network_config(
    state: State<'_, AppState>,
) -> Result<NetworkConfigView, String> {
    let config = read_config(&state);
    let stored = EditorSettingsRepository::new(state.db.pool())
        .get(TURN_CREDENTIAL_KEY)
        .await
        .map_err(|err| err.to_string())?;
    let ice = openmind_collab_net::ice::IceSetup::from_config(&config);
    let relay = turn_login::relay(&state, &ice);
    Ok(NetworkConfigView {
        config,
        has_turn_credential: stored.is_some(),
        relay: openmind_collab_net::transport::RelayProvider::status(relay.as_ref()),
    })
}

/// Stores the TURN password, encrypted for this Windows user. It is never returned to the page.
#[tauri::command]
pub async fn collab_turn_credential_set(
    state: State<'_, AppState>,
    credential: String,
) -> Result<(), String> {
    if credential.is_empty() || credential.len() > 512 || credential.chars().any(char::is_control) {
        return Err(
            "The TURN password must be 1-512 characters without control characters.".into(),
        );
    }
    let protected = secret::protect(&credential).map_err(|err| err.to_string())?;
    EditorSettingsRepository::new(state.db.pool())
        .set(TURN_CREDENTIAL_KEY, &protected)
        .await
        .map_err(|err| err.to_string())
}

#[tauri::command]
pub async fn collab_turn_credential_clear(state: State<'_, AppState>) -> Result<(), String> {
    EditorSettingsRepository::new(state.db.pool())
        .delete(TURN_CREDENTIAL_KEY)
        .await
        .map_err(|err| err.to_string())
}
