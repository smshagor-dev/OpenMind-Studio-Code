//! How a window's voice call carries media (phase 10; classroom mode, phase 11). Peer to peer, the WebView's
//! `RTCPeerConnection` needs the STUN and TURN servers, and for TURN the user name and password; in classroom mode it
//! needs the media server's address and a token for this member. These are the only voice credentials that leave Rust,
//! and they are handed over only:
//! - to the editor window that holds the room's call (the window that joined it; `VoiceRuntime::claim`), when it
//!   builds its media connections — not with the roster snapshot any window may read;
//! - on an Internet route: a room reached over the local network gets no ICE server at all (host candidates only, no
//!   Internet, STUN or TURN);
//! - read from the DPAPI-protected store at that moment (`turn_login`), never kept here, never logged;
//! - for a media token: minted by the room's Owner after its own checks (`sfu::grant`), valid 120 s, never stored.
//!
//! Extension pages are sandboxed frames without the app's IPC, and the extension host is a separate process: neither
//! can call this command. The page code puts the configuration into the connections and keeps it nowhere else.

use std::fmt;

use openmind_collab::sfu::VoiceMediaGrant;
use openmind_collab::Actor;
use openmind_collab_net::ConnectionRoute;
use serde::Serialize;
use tauri::State;

use crate::app_state::AppState;

/// One `RTCIceServer`.
#[derive(Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IceServerView {
    pub urls: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub username: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub credential: Option<String>,
}

impl fmt::Debug for IceServerView {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("IceServerView")
            .field("urls", &self.urls)
            .field("username", &self.username)
            .field("credential", &self.credential.as_ref().map(|_| "****"))
            .finish()
    }
}

/// What a call's `RTCPeerConnection`s are built with.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VoiceIce {
    pub ice_servers: Vec<IceServerView>,
    /// `all`, or `relay` in debug builds' relay-only test mode (Internet routes only).
    pub ice_transport_policy: &'static str,
}

/// The configuration for a call: nothing on the local network; STUN, and TURN with its login when one is saved.
pub(crate) fn plan(
    local: bool,
    stun: Vec<String>,
    turn: Vec<String>,
    login: Option<(String, String)>,
    relay_only: bool,
) -> VoiceIce {
    if local {
        return VoiceIce {
            ice_servers: Vec::new(),
            ice_transport_policy: "all",
        };
    }
    let mut ice_servers = Vec::new();
    if !stun.is_empty() {
        ice_servers.push(IceServerView {
            urls: stun,
            username: None,
            credential: None,
        });
    }
    if let (false, Some((username, credential))) = (turn.is_empty(), login) {
        ice_servers.push(IceServerView {
            urls: turn,
            username: Some(username),
            credential: Some(credential),
        });
    }
    VoiceIce {
        ice_servers,
        ice_transport_policy: if relay_only { "relay" } else { "all" },
    }
}

/// The ICE configuration for a peer-to-peer call in `room_uid` (read at this moment).
async fn ice_for(state: &AppState, room_uid: &str) -> VoiceIce {
    let local = state.collab.net.route_of(room_uid) == Some(ConnectionRoute::LocalLan);
    let config = super::read_config(state);
    let login = if local || config.turn_urls.is_empty() {
        None
    } else {
        match super::turn_login::StoredTurnLogin::new(state).read().await {
            Ok(login) => login.map(|l| (l.username, l.password)),
            Err(err) => {
                tracing::warn!(%err, "the stored TURN password can't be read for voice");
                None
            }
        }
    };
    let relay_only =
        super::net::debug_ice_policy() == openmind_collab_net::ice::IcePolicy::RelayOnly;
    plan(local, config.stun_urls, config.turn_urls, login, relay_only)
}

/// How this window's call carries media: peer to peer with its ICE configuration, or classroom with the media server's
/// address and this member's token (phase 11). `Debug` never shows a credential.
#[derive(Clone, PartialEq, Eq, Serialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum VoiceMediaView {
    P2p {
        #[serde(flatten)]
        ice: VoiceIce,
    },
    Sfu {
        url: String,
        token: String,
        expires_ms: i64,
    },
}

impl fmt::Debug for VoiceMediaView {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            VoiceMediaView::P2p { ice } => f.debug_struct("P2p").field("ice", ice).finish(),
            VoiceMediaView::Sfu { url, .. } => f
                .debug_struct("Sfu")
                .field("url", url)
                .field("token", &"****")
                .finish(),
        }
    }
}

/// How the call this window holds in `room_uid` carries media. Answered only to the editor window that holds the call;
/// the room's Owner decides (for a joined room it is asked over the room connection).
#[tauri::command]
pub async fn collab_voice_media(
    window: tauri::Window,
    state: State<'_, AppState>,
    room_uid: String,
) -> Result<VoiceMediaView, String> {
    let label = window.label();
    let editor = crate::windows::is_main(label) || crate::windows::is_editor_window_extra(label);
    let holder = state.collab.net.voice.window(&room_uid);
    if !editor || holder.as_deref() != Some(label) {
        return Err("Voice isn't open for this room in this window.".into());
    }
    let grant = if state.collab.net.hosting(&room_uid).is_some() {
        let me = Actor::Host(state.collab.identity(&state.db).await?.peer_id());
        super::sfu::grant(&state, &room_uid, &me).await?
    } else {
        super::net_voice::request_media(&state, &room_uid).await?
    };
    grant.validate().map_err(|e| e.to_string())?;
    Ok(match grant {
        VoiceMediaGrant::P2p => VoiceMediaView::P2p {
            ice: ice_for(&state, &room_uid).await,
        },
        VoiceMediaGrant::Sfu {
            url,
            token,
            expires_ms,
        } => VoiceMediaView::Sfu {
            url,
            token: token.0,
            expires_ms,
        },
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn stun() -> Vec<String> {
        vec!["stun:stun.example.org:3478".into()]
    }

    fn turn() -> Vec<String> {
        vec![
            "turn:turn.example.org:3478?transport=udp".into(),
            "turns:turn.example.org:443?transport=tcp".into(),
        ]
    }

    fn login() -> Option<(String, String)> {
        Some(("class-7".into(), "hunter2".into()))
    }

    #[test]
    fn the_local_network_gets_no_server_and_no_password() {
        let ice = plan(true, stun(), turn(), login(), true);
        assert!(ice.ice_servers.is_empty());
        assert_eq!(
            ice.ice_transport_policy, "all",
            "never relay-only on the LAN"
        );
        assert!(!serde_json::to_string(&ice)
            .expect("json")
            .contains("hunter2"));
    }

    #[test]
    fn internet_routes_get_stun_and_turn_with_the_login() {
        let ice = plan(false, stun(), turn(), login(), false);
        assert_eq!(ice.ice_servers.len(), 2);
        let json = serde_json::to_value(&ice).expect("json");
        assert_eq!(json["iceServers"][0], serde_json::json!({ "urls": stun() }));
        assert_eq!(json["iceServers"][1]["urls"], serde_json::json!(turn()));
        assert_eq!(json["iceServers"][1]["username"], "class-7");
        assert_eq!(json["iceServers"][1]["credential"], "hunter2");
        assert_eq!(json["iceTransportPolicy"], "all");
        assert!(!format!("{ice:?}").contains("hunter2"), "Debug hides it");
    }

    #[test]
    fn turn_without_a_login_is_left_out_and_relay_mode_is_explicit() {
        let ice = plan(false, stun(), turn(), None, false);
        assert_eq!(ice.ice_servers.len(), 1);
        assert_eq!(
            plan(false, Vec::new(), turn(), login(), true).ice_transport_policy,
            "relay"
        );
    }
}
