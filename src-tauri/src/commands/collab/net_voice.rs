//! Voice between the network and the windows (Milestone 24, phase 9). The windows hold the microphone and the WebRTC
//! media connections; this side only authorizes and relays the call's state and negotiation (`collab:voice` events to
//! the windows, the room's control channel between computers). Nothing here touches audio.
//!
//! - **One voice window per room** on a computer: the window that joined the call receives its negotiation; another
//!   window of the same computer is refused (it would be a second, conflicting set of media connections).
//! - **ICE** (`net_voice_ice`): a room reached over the local network negotiates with no ICE server at all (host
//!   candidates only: no Internet, STUN or TURN involved); otherwise the configured STUN and TURN servers are offered,
//!   TURN with its login, only to the window that holds the call.

use std::collections::HashMap;
use std::sync::Mutex;

use openmind_collab::protocol::Body;
use openmind_collab::sfu::{VoiceMediaGrant, VoiceMode};
use openmind_collab::voice::{VoiceMember, VoiceSelf, VoiceSignal, MAX_VOICE_MEMBERS};
use openmind_collab::{Actor, PeerId};
use openmind_collab_net::remote::VoiceEvent;
use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, State};

use super::net::NetEvent;
use crate::app_state::AppState;

pub const VOICE_EVENT: &str = "collab:voice";

#[derive(Debug, Clone, Serialize)]
#[serde(
    rename_all = "camelCase",
    tag = "kind",
    rename_all_fields = "camelCase"
)]
pub enum VoiceOut {
    Roster {
        members: Vec<VoiceMember>,
        mode: VoiceMode,
    },
    Signal {
        from: PeerId,
        signal: VoiceSignal,
    },
    /// The connection to the room ended: the call is gone for this computer.
    Reset,
}

/// A media request waiting for its Owner's answer (by the request frame's id).
type GrantWait = tokio::sync::oneshot::Sender<Result<VoiceMediaGrant, String>>;

/// This computer's voice: which window holds each room's call, the last roster (and mode) a joined room's Owner sent,
/// and media requests waiting for an answer.
#[derive(Default)]
pub struct VoiceRuntime {
    windows: Mutex<HashMap<String, String>>,
    rosters: Mutex<HashMap<String, (Vec<VoiceMember>, VoiceMode)>>,
    grants: Mutex<HashMap<String, GrantWait>>,
}

fn lock<T>(m: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    m.lock().unwrap_or_else(std::sync::PoisonError::into_inner)
}

impl VoiceRuntime {
    /// A refusal that answers a waiting media request: `true` when it did.
    pub fn media_rejected(&self, event: &openmind_collab_net::remote::DocEvent) -> bool {
        let openmind_collab_net::remote::DocEvent::Rejected { frame, reason } = event else {
            return false;
        };
        match lock(&self.grants).remove(frame.as_str()) {
            Some(wait) => {
                let _ = wait.send(Err(reason.clone()));
                true
            }
            None => false,
        }
    }

    /// The rooms whose call `window` holds.
    fn held_by(&self, window: &str) -> Vec<String> {
        lock(&self.windows)
            .iter()
            .filter(|(_, w)| w.as_str() == window)
            .map(|(room, _)| room.clone())
            .collect()
    }

    pub(crate) fn window(&self, room: &str) -> Option<String> {
        lock(&self.windows).get(room).cloned()
    }

    /// Claims (joined) or releases (left) the room's call for `window`; refused when another window holds it.
    fn claim(&self, room: &str, window: &str, joined: bool) -> Result<(), String> {
        let mut windows = lock(&self.windows);
        match windows.get(room) {
            Some(holder) if holder != window => {
                Err("Voice is already open in another window of this computer.".into())
            }
            _ => {
                if joined {
                    windows.insert(room.to_string(), window.to_string());
                } else {
                    windows.remove(room);
                }
                Ok(())
            }
        }
    }
}

fn emit(app: &AppHandle, room: &str, side: &'static str, event: VoiceOut) {
    let _ = app.emit(
        VOICE_EVENT,
        NetEvent {
            room_uid: room,
            side,
            event,
        },
    );
}

/// A negotiation message for this computer's call: only the window that holds it hears it.
fn deliver(app: &AppHandle, room: &str, side: &'static str, from: PeerId, signal: VoiceSignal) {
    let Some(state) = app.try_state::<AppState>() else {
        return;
    };
    if let Some(window) = state.collab.net.voice.window(room) {
        let event = VoiceOut::Signal { from, signal };
        let _ = app.emit_to(
            window.as_str(),
            VOICE_EVENT,
            NetEvent {
                room_uid: room,
                side,
                event,
            },
        );
    }
}

// ---- Owner side ----------------------------------------------------------------------------------------------

/// The call changed: everyone connected and this computer's windows hear the new roster.
pub async fn broadcast(app: &AppHandle, room: &str) {
    let Some(state) = app.try_state::<AppState>() else {
        return;
    };
    let members = state.collab.voice_roster(room).await;
    let mode = state.collab.voice_mode(room).await;
    let messages = state
        .collab
        .access_list(room)
        .await
        .into_iter()
        .map(|(peer, _)| {
            (
                peer,
                Body::VoiceRoster {
                    members: members.clone(),
                    mode,
                },
            )
        })
        .collect();
    super::net_docs::send_all(app, room, messages);
    emit(app, room, "host", VoiceOut::Roster { members, mode });
    // Classroom mode: the media server follows the call (publishing permissions, removals).
    super::sfu::enforce::sync(app, room).await;
}

/// A participant's negotiation for this computer's own user.
pub fn to_host(app: &AppHandle, room: &str, from: PeerId, signal: VoiceSignal) {
    deliver(app, room, "host", from, signal);
}

/// A member's connection ended: it is out of the call.
pub async fn member_left(app: &AppHandle, room: &str, peer: &PeerId) {
    let Some(state) = app.try_state::<AppState>() else {
        return;
    };
    if state.collab.voice_left(room, peer).await {
        broadcast(app, room).await;
    }
}

// ---- Participant side ----------------------------------------------------------------------------------------

pub fn on_remote_voice(app: &AppHandle, room: &str, event: VoiceEvent) {
    let Some(state) = app.try_state::<AppState>() else {
        return;
    };
    match event {
        VoiceEvent::Roster { members, mode } => {
            lock(&state.collab.net.voice.rosters).insert(room.to_string(), (members.clone(), mode));
            emit(app, room, "participant", VoiceOut::Roster { members, mode });
        }
        VoiceEvent::Media { of, media } => {
            if let Some(wait) = lock(&state.collab.net.voice.grants).remove(of.as_str()) {
                let _ = wait.send(Ok(media));
            }
        }
        VoiceEvent::Signal { from, signal } => deliver(app, room, "participant", from, signal),
    }
}

/// The connection to a joined room ended: no call any more (a new session negotiates afresh).
pub fn connection_ended(app: &AppHandle, room: &str) {
    if let Some(state) = app.try_state::<AppState>() {
        lock(&state.collab.net.voice.rosters).remove(room);
        lock(&state.collab.net.voice.windows).remove(room);
    }
    emit(app, room, "participant", VoiceOut::Reset);
}

/// A window closed: the calls it held are left.
pub fn window_closed(app: &AppHandle, window: &str) {
    let Some(state) = app.try_state::<AppState>() else {
        return;
    };
    for room in state.collab.net.voice.held_by(window) {
        let (app, window) = (app.clone(), window.to_string());
        tauri::async_runtime::spawn(async move {
            let state = app.state::<AppState>();
            let _ = set_state(&app, &state, &window, &room, VoiceSelf::default()).await;
        });
    }
}

async fn set_state(
    app: &AppHandle,
    state: &AppState,
    window: &str,
    room: &str,
    voice: VoiceSelf,
) -> Result<(), String> {
    state.collab.net.voice.claim(room, window, voice.joined)?;
    let result = if state.collab.net.hosting(room).is_some() {
        let host = Actor::Host(state.collab.identity(&state.db).await?.peer_id());
        let changed = state
            .collab
            .voice_state(&state.db, room, host, voice, super::now_ms())
            .await;
        if let Ok(true) = changed {
            broadcast(app, room).await;
        }
        changed.map(drop)
    } else {
        super::net_manage::send_and_wait(state, room, Body::VoiceState { state: voice }).await
    };
    if result.is_err() && voice.joined {
        // Refused: this window doesn't hold the call.
        let _ = state.collab.net.voice.claim(room, window, false);
    }
    result
}

// ---- Commands ------------------------------------------------------------------------------------------------

/// This window's voice state in a room (join, leave, mute, speaking, hand). The room's Owner decides.
#[tauri::command]
pub async fn collab_voice_state(
    window: tauri::Window,
    app: AppHandle,
    state: State<'_, AppState>,
    room_uid: String,
    voice: VoiceSelf,
) -> Result<(), String> {
    set_state(&app, &state, window.label(), &room_uid, voice).await
}

/// A negotiation message for another member of the call (relayed by the Owner; dropped unless both are in the call).
#[tauri::command]
pub async fn collab_voice_signal(
    window: tauri::Window,
    state: State<'_, AppState>,
    room_uid: String,
    to: PeerId,
    signal: VoiceSignal,
) -> Result<(), String> {
    signal.validate().map_err(|e| e.to_string())?;
    if state.collab.net.voice.window(&room_uid).as_deref() != Some(window.label()) {
        return Err("This window isn't in the room's voice call.".into());
    }
    if let Some(network) = state.collab.net.hosting(&room_uid) {
        let host = Actor::Host(state.collab.identity(&state.db).await?.peer_id());
        let from = state
            .collab
            .voice_route(&room_uid, &host, &to)
            .await
            .ok_or("That member isn't in the voice call.")?;
        network.send(to, Body::VoicePeerSignal { from, signal });
        return Ok(());
    }
    let sender = state
        .collab
        .net
        .joined(&room_uid)
        .ok_or("You are not connected to this room.")?;
    sender
        .send(Body::VoiceSignal { to, signal })
        .map(drop)
        .map_err(|e| e.to_string())
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VoiceSnapshot {
    pub me: PeerId,
    pub members: Vec<VoiceMember>,
    /// The most people this call takes in its mode.
    pub capacity: usize,
    pub mode: VoiceMode,
}

fn capacity(mode: VoiceMode) -> usize {
    match mode {
        VoiceMode::P2p => MAX_VOICE_MEMBERS,
        VoiceMode::Sfu => openmind_collab::voice::MAX_SFU_VOICE_MEMBERS,
    }
}

/// The call as it is now, for a window that opens later (how to carry media is `collab_voice_media`).
#[tauri::command]
pub async fn collab_voice_snapshot(
    state: State<'_, AppState>,
    room_uid: String,
) -> Result<VoiceSnapshot, String> {
    let me = state.collab.identity(&state.db).await?.peer_id();
    let hosting = state.collab.net.hosting(&room_uid).is_some();
    let (members, mode) = if hosting {
        (
            state.collab.voice_roster(&room_uid).await,
            state.collab.voice_mode(&room_uid).await,
        )
    } else {
        lock(&state.collab.net.voice.rosters)
            .get(&room_uid)
            .cloned()
            .unwrap_or_default()
    };
    Ok(VoiceSnapshot {
        me,
        members,
        capacity: capacity(mode),
        mode,
    })
}

/// How long a media request waits for the Owner's answer.
const MEDIA_WAIT: std::time::Duration = std::time::Duration::from_secs(15);

/// A member asks its room's Owner how to carry its call's media (a grant or the Owner's refusal).
pub async fn request_media(state: &AppState, room: &str) -> Result<VoiceMediaGrant, String> {
    let sender = state
        .collab
        .net
        .joined(room)
        .ok_or("You are not connected to this room.")?;
    let (answer, wait) = tokio::sync::oneshot::channel();
    // Registered before sending, so an answer can't arrive first.
    let id = {
        let mut grants = lock(&state.collab.net.voice.grants);
        let id = sender
            .send(Body::VoiceMediaRequest)
            .map_err(|e| e.to_string())?;
        grants.insert(id.to_string(), answer);
        id
    };
    let result = tokio::time::timeout(MEDIA_WAIT, wait).await;
    lock(&state.collab.net.voice.grants).remove(id.as_str());
    match result {
        Ok(Ok(answer)) => answer,
        Ok(Err(_)) | Err(_) => Err("The room didn't answer the voice request. Try again.".into()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn one_window_holds_a_rooms_call() {
        let voice = VoiceRuntime::default();
        assert!(voice.claim("r", "main", true).is_ok());
        assert!(voice.claim("r", "window-2", true).is_err());
        assert!(
            voice.claim("r", "window-2", false).is_err(),
            "only the holder leaves"
        );
        assert!(voice.claim("r", "main", false).is_ok());
        assert!(voice.claim("r", "window-2", true).is_ok());
        assert_eq!(voice.window("r").as_deref(), Some("window-2"));
    }

    #[test]
    fn a_reloaded_window_gives_up_exactly_the_calls_it_held() {
        let voice = VoiceRuntime::default();
        voice.claim("lab", "main", true).expect("lab");
        voice.claim("class", "main", true).expect("class");
        voice.claim("other", "window-2", true).expect("other");
        let mut held = voice.held_by("main");
        held.sort();
        assert_eq!(held, ["class", "lab"]);
        // Leaving them (what the reload does through `set_state`) frees them for the new page.
        for room in &held {
            voice.claim(room, "main", false).expect("left");
        }
        assert!(voice.held_by("main").is_empty());
        assert_eq!(
            voice.window("other").as_deref(),
            Some("window-2"),
            "another window's call is untouched"
        );
        assert!(
            voice.claim("lab", "main", true).is_ok(),
            "the reloaded page can join again"
        );
    }
}
