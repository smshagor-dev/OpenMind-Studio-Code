//! Classroom voice (Milestone 24, phase 11): a room's call through a media server (LiveKit) instead of the peer-to-peer
//! mesh, for more people than a mesh carries. Only voice media moves; the room, its members, roles, permissions, bans,
//! approvals, history, documents and files stay on the existing OpenMind transport and the Owner's authority.
//!
//! - **Mode** (per room, chosen by the Owner, kept on the Owner's computer): peer to peer (default) or classroom. It can't
//!   change while anyone is in the call.
//! - **Media server**: the one this computer runs ([`local`], offline classroom LAN) or a self-hosted one configured
//!   in Settings (`collaboration.sfuUrl` + `collaboration.sfuApiKey`; the secret DPAPI-protected, set with
//!   `collab_classroom_secret_set`). Only the Owner's computer needs it.
//! - **Tokens**: minted by the Owner after OpenMind's own checks (current session, active member, `voice.join`;
//!   publishing only with `voice.speak` and not force-muted), for one opaque media room and identity, valid 120 s. A
//!   member asks over the authenticated room connection (`VoiceMediaRequest`); its window gets the address and token.
//! - **Enforcement** ([`enforce`]): what OpenMind decides is applied on the media server by the Owner (publishing
//!   permission, removal), never left to a member's own client.

pub mod enforce;
pub mod local;
pub mod twirp;

use std::collections::HashMap;
use std::sync::Mutex;

use openmind_collab::sfu::{
    media_identity, member_token, ApiKey, SecretText, VoiceMediaGrant, VoiceMode,
};
use openmind_collab::Actor;
use openmind_db::EditorSettingsRepository;
use serde::Serialize;
use tauri::{AppHandle, State};

use crate::app_state::AppState;
use crate::secret;

const SECRET_KEY: &str = "collab.sfu.secret";
const MODE_KEY_PREFIX: &str = "collab.voice.mode.";

pub(crate) fn now_secs() -> i64 {
    super::now_ms() / 1000
}

fn lock<T>(m: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    m.lock().unwrap_or_else(std::sync::PoisonError::into_inner)
}

/// This computer's classroom voice: the local media server, and what the Owner last told the media server per room.
#[derive(Default)]
pub struct SfuRuntime {
    local: Mutex<Option<local::LocalSfu>>,
    /// Per hosted room: media identity -> may publish, as granted or applied on the media server.
    applied: Mutex<HashMap<String, HashMap<String, bool>>>,
    /// One enforcement pass at a time.
    syncing: tokio::sync::Mutex<()>,
    /// Per hosted room: identities removed from the media room lately (see `enforce::Watch`).
    watched: Mutex<HashMap<String, enforce::Watch>>,
}

impl SfuRuntime {
    /// Stops the local media server (app shutdown).
    pub fn stop_all(&self) {
        lock(&self.local).take();
    }
}

/// A media server the Owner can use now.
#[derive(Clone)]
pub struct MediaServer {
    /// The ws(s):// address members connect to.
    pub url: String,
    pub api: ApiKey,
}

async fn stored_secret(state: &AppState) -> Result<Option<String>, String> {
    let stored = EditorSettingsRepository::new(state.db.pool())
        .get(SECRET_KEY)
        .await
        .map_err(|e| e.to_string())?;
    stored
        .map(|value| secret::unprotect(&value).map_err(|e| e.to_string()))
        .transpose()
}

fn user_string(state: &AppState, id: &str) -> String {
    crate::commands::preferences::user_string(state, id)
        .trim()
        .to_string()
}

/// The media server to use: this computer's own (when running), else the configured one (secret read now).
pub async fn server(state: &AppState) -> Result<MediaServer, String> {
    if let Some(local) = lock(&state.collab.net.sfu.local).as_ref() {
        return Ok(MediaServer {
            url: local.url(),
            api: local.api.clone(),
        });
    }
    let url = user_string(state, "collaboration.sfuUrl");
    let key = user_string(state, "collaboration.sfuApiKey");
    if url.is_empty() || key.is_empty() {
        return Err(
            "Classroom voice needs a media server: start the one on this computer, or set one in Settings > \
             Collaboration."
                .into(),
        );
    }
    twirp::http_base(&url)?;
    let secret = stored_secret(state)
        .await?
        .ok_or("The classroom media server's secret isn't saved on this computer.")?;
    Ok(MediaServer {
        url,
        api: ApiKey { key, secret },
    })
}

/// What `actor` gets to carry its media in `room`: peer to peer, or a token for the media server.
pub async fn grant(state: &AppState, room: &str, actor: &Actor) -> Result<VoiceMediaGrant, String> {
    let (mode, can_speak) = state.collab.voice_media_check(room, actor).await?;
    if mode == VoiceMode::P2p {
        return Ok(VoiceMediaGrant::P2p);
    }
    let server = server(state).await?;
    let peer = match actor {
        Actor::Host(peer) | Actor::Remote { peer, .. } => peer,
    };
    let now = now_secs();
    let token = member_token(&server.api, room, peer, can_speak, now).map_err(|e| e.to_string())?;
    lock(&state.collab.net.sfu.applied)
        .entry(room.to_string())
        .or_default()
        .insert(media_identity(room, peer), can_speak);
    Ok(VoiceMediaGrant::Sfu {
        url: server.url,
        token: SecretText(token),
        expires_ms: (now + openmind_collab::sfu::TOKEN_TTL_SECS) * 1000,
    })
}

/// The voice mode the Owner chose for `room` earlier (peer to peer when never set).
pub async fn saved_mode(state: &AppState, room: &str) -> VoiceMode {
    let stored = EditorSettingsRepository::new(state.db.pool())
        .get(&format!("{MODE_KEY_PREFIX}{room}"))
        .await
        .ok()
        .flatten();
    match stored.as_deref() {
        Some("sfu") => VoiceMode::Sfu,
        _ => VoiceMode::P2p,
    }
}

/// A hosted room starts with the mode its Owner chose.
pub async fn restore_mode(state: &AppState, room: &str) {
    let mode = saved_mode(state, room).await;
    if let Err(err) = state.collab.voice_restore_mode(room, mode).await {
        tracing::warn!(%err, "the room's voice mode couldn't be restored");
    }
}

// ---- Commands ------------------------------------------------------------------------------------------------

/// Peer to peer or classroom for a room this computer hosts (refused while anyone is in the call).
#[tauri::command]
pub async fn collab_voice_mode_set(
    app: AppHandle,
    state: State<'_, AppState>,
    room_uid: String,
    mode: VoiceMode,
) -> Result<(), String> {
    if state.collab.net.hosting(&room_uid).is_none() {
        return Err(
            "Only the room's Owner, on the hosting computer, changes the voice mode.".into(),
        );
    }
    if !state
        .collab
        .voice_set_mode(&state.db, &room_uid, mode, super::now_ms())
        .await?
    {
        return Ok(());
    }
    let value = match mode {
        VoiceMode::P2p => "p2p",
        VoiceMode::Sfu => "sfu",
    };
    EditorSettingsRepository::new(state.db.pool())
        .set(&format!("{MODE_KEY_PREFIX}{room_uid}"), value)
        .await
        .map_err(|e| e.to_string())?;
    super::net_voice::broadcast(&app, &room_uid).await;
    Ok(())
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ClassroomStatus {
    /// A classroom voice server can run on this computer at all (the Runtime Manager has one for its platform: Windows
    /// x64 today). Elsewhere only a configured server (or peer-to-peer voice) is offered.
    pub local_supported: bool,
    /// The Runtime Manager has the classroom voice server installed.
    pub installed: bool,
    pub local: local::LocalStatus,
    /// The configured media server (address only).
    pub external_url: Option<String>,
    pub external_has_secret: bool,
    /// The addresses this computer could run its server on (its LAN interfaces, then loopback).
    pub addresses: Vec<String>,
}

const LOCAL_UNSUPPORTED: &str = "A classroom voice server can't run on this computer (it is available for Windows x64 \
     only). Configure your school's media server in Settings > Collaboration, or use peer-to-peer voice.";

/// Whether the Runtime Manager offers the classroom voice server for this computer's platform.
fn local_supported(state: &AppState) -> bool {
    let platform = openmind_runtime_manager::current_platform();
    state
        .runtime
        .registry()
        .get("livekit")
        .is_ok_and(|manifest| {
            manifest
                .artifact(&manifest.default_version, platform)
                .is_some()
        })
}

fn local_addresses() -> Vec<String> {
    let mut out: Vec<String> = openmind_collab_net::lan::netif::current()
        .iter()
        .flat_map(|i| i.ipv4.iter().map(|(ip, _)| ip.to_string()))
        .collect();
    out.push("127.0.0.1".into());
    out.dedup();
    out
}

#[tauri::command]
pub async fn collab_classroom_status(
    state: State<'_, AppState>,
) -> Result<ClassroomStatus, String> {
    let local_supported = local_supported(&state);
    let installed = local_supported && state.runtime.installed_dir("livekit").await.is_some();
    let local = lock(&state.collab.net.sfu.local).as_ref().map_or(
        local::LocalStatus {
            running: false,
            bind: None,
            url: None,
            http_port: local::HTTP_PORT,
            udp_port: local::UDP_PORT,
        },
        local::LocalSfu::status,
    );
    let url = user_string(&state, "collaboration.sfuUrl");
    Ok(ClassroomStatus {
        local_supported,
        installed,
        local,
        external_url: (!url.is_empty()).then_some(url),
        external_has_secret: stored_secret(&state).await.ok().flatten().is_some(),
        addresses: local_addresses(),
    })
}

/// Starts the classroom voice server on this computer, on `bind` (one of its own addresses; default: its LAN address).
#[tauri::command]
pub async fn collab_classroom_local_start(
    state: State<'_, AppState>,
    bind: Option<String>,
) -> Result<local::LocalStatus, String> {
    if !local_supported(&state) {
        return Err(LOCAL_UNSUPPORTED.into());
    }
    let addresses = local_addresses();
    let chosen = bind.unwrap_or_else(|| {
        addresses
            .first()
            .cloned()
            .unwrap_or_else(|| "127.0.0.1".into())
    });
    if !addresses.contains(&chosen) {
        return Err("Choose one of this computer's own addresses.".into());
    }
    let ip: std::net::IpAddr = chosen.parse().map_err(|_| "not an address".to_string())?;
    if let Some(running) = lock(&state.collab.net.sfu.local).as_ref() {
        // Already running (one server per computer): say where, rather than report its own ports as taken.
        return if running.bind == ip {
            Ok(running.status())
        } else {
            Err(format!(
                "The classroom voice server is already running on {}. Stop it first to use another address.",
                running.bind
            ))
        };
    }
    let dir = state.runtime.installed_dir("livekit").await.ok_or(
        "The classroom voice server isn't installed. Install it from the Runtime Manager.",
    )?;
    let (work, log) = local::locations(&state.paths);
    let started =
        tauri::async_runtime::spawn_blocking(move || local::LocalSfu::start(&dir, &work, &log, ip))
            .await
            .map_err(|e| e.to_string())??;
    let status = started.status();
    let mut slot = lock(&state.collab.net.sfu.local);
    slot.take();
    *slot = Some(started);
    Ok(status)
}

/// Stops this computer's classroom voice server (calls through it end on every member's side).
#[tauri::command]
pub fn collab_classroom_local_stop(state: State<'_, AppState>) {
    state.collab.net.sfu.stop_all();
}

/// Stores the configured media server's API secret, encrypted for this Windows user. Never returned to a page.
#[tauri::command]
pub async fn collab_classroom_secret_set(
    state: State<'_, AppState>,
    secret: String,
) -> Result<(), String> {
    if secret.len() < 16 || secret.len() > 512 || secret.chars().any(char::is_control) {
        return Err(
            "The media server secret must be 16-512 characters without control characters.".into(),
        );
    }
    let protected = crate::secret::protect(&secret).map_err(|e| e.to_string())?;
    EditorSettingsRepository::new(state.db.pool())
        .set(SECRET_KEY, &protected)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn collab_classroom_secret_clear(state: State<'_, AppState>) -> Result<(), String> {
    EditorSettingsRepository::new(state.db.pool())
        .delete(SECRET_KEY)
        .await
        .map_err(|e| e.to_string())
}

/// What the media server itself reports for a hosted classroom room (no identities): how many are connected, may
/// publish, and publish audio now. The server's own view, so moderation can be checked where it is enforced.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct MediaRoomView {
    pub connected: usize,
    pub may_publish: usize,
    pub publishing_audio: usize,
}

#[tauri::command]
pub async fn collab_classroom_media_room(
    state: State<'_, AppState>,
    room_uid: String,
) -> Result<MediaRoomView, String> {
    if state.collab.net.hosting(&room_uid).is_none() {
        return Err("Only the hosting computer can read its media room.".into());
    }
    let server = server(&state).await?;
    let room = room_uid.clone();
    let list = tauri::async_runtime::spawn_blocking(move || {
        twirp::participants(&server.url, &server.api, &room)
    })
    .await
    .map_err(|e| e.to_string())??;
    Ok(MediaRoomView {
        connected: list.len(),
        may_publish: list.iter().filter(|(_, may, _)| *may).count(),
        publishing_audio: list.iter().map(|(_, _, audio)| *audio).sum(),
    })
}

#[cfg(test)]
#[path = "live_tests.rs"]
mod live_tests;
