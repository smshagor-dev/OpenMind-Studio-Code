//! Classroom voice through a media server (Milestone 24, phase 11): pure rules, no I/O.
//!
//! The OpenMind room stays authoritative — membership, roles, permissions, bans, approvals, history and code
//! collaboration never involve the media server. For a room in classroom mode, the Owner hands each member a short-lived
//! token for one media room. The media server (LiveKit) only learns two opaque names:
//! - [`media_room`]: derived from the room's id, never its Room Code or name;
//! - [`media_identity`]: derived from the room's id and the member's authenticated peer id, so it differs per room and
//!   reveals no key, machine or profile.
//!
//! Tokens are HS256 JWTs in LiveKit's grant format, signed by the Owner with the media server's API secret, which never
//! leaves the Owner's computer. A member's token grants exactly: join that room, subscribe, and — only when OpenMind
//! lets it speak — publish the microphone (no camera, screen or data).

use std::fmt;

use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::error::{invalid, CollabError};
use crate::hmac::hmac_sha256;
use crate::ids::PeerId;

/// How long a member's media token is valid for joining. Short on purpose: a token can't be withdrawn, so this bounds
/// how long one obtained before a kick or ban could still be used (the Owner removes a connected member from the media
/// room at once either way). The media server refreshes a connected member's token itself; a new join asks again.
pub const TOKEN_TTL_SECS: i64 = 120;
/// The longest media server address accepted.
pub const MAX_URL_CHARS: usize = 512;
/// A media token is a few hundred bytes; anything far above isn't one.
pub const MAX_TOKEN_BYTES: usize = 4096;

fn digest_hex(label: &str, parts: &[&str], len: usize) -> String {
    let mut hasher = Sha256::new();
    hasher.update(b"openmind-sfu:v1:");
    hasher.update(label.as_bytes());
    for part in parts {
        hasher.update(b"\n");
        hasher.update(part.as_bytes());
    }
    let mut out = hex::encode(hasher.finalize());
    out.truncate(len);
    out
}

/// The media room of an OpenMind room (opaque; the same for every member).
pub fn media_room(room_uid: &str) -> String {
    format!("om-{}", digest_hex("room", &[room_uid], 24))
}

/// A member's identity in the media room (opaque; different in every room).
pub fn media_identity(room_uid: &str, peer: &PeerId) -> String {
    format!(
        "p-{}",
        digest_hex("identity", &[room_uid, peer.as_str()], 24)
    )
}

/// Text that is a credential: serialized as-is, never shown by `Debug`.
#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(transparent)]
pub struct SecretText(pub String);

impl fmt::Debug for SecretText {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("****")
    }
}

/// How a room's voice call carries its media.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum VoiceMode {
    /// Every member connects to every other (Phase 9): small calls, no server.
    #[default]
    P2p,
    /// Every member connects to a media server (classroom).
    Sfu,
}

/// What a member needs to carry its call's media, as the Owner grants it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum VoiceMediaGrant {
    /// Peer to peer: the ICE configuration is local (each computer's own STUN/TURN settings).
    P2p,
    /// The media server's address and a token for this member only.
    Sfu {
        url: String,
        token: SecretText,
        expires_ms: i64,
    },
}

impl VoiceMediaGrant {
    pub fn validate(&self) -> Result<(), CollabError> {
        let VoiceMediaGrant::Sfu { url, token, .. } = self else {
            return Ok(());
        };
        if url.chars().count() > MAX_URL_CHARS
            || !(url.starts_with("ws://") || url.starts_with("wss://"))
        {
            return Err(invalid(
                "media server address",
                "must be ws:// or wss:// and short",
            ));
        }
        if token.0.is_empty() || token.0.len() > MAX_TOKEN_BYTES || !token.0.is_ascii() {
            return Err(invalid("media token", "malformed"));
        }
        Ok(())
    }
}

/// LiveKit's grant block, limited to what OpenMind uses.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VideoGrant {
    pub room: String,
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub room_join: bool,
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub room_admin: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub can_publish: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub can_subscribe: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub can_publish_data: Option<bool>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub can_publish_sources: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub can_update_own_metadata: Option<bool>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Claims {
    pub iss: String,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub sub: String,
    pub nbf: i64,
    pub exp: i64,
    pub video: VideoGrant,
}

/// The media server's API key and secret (the secret never leaves the Owner's computer).
#[derive(Clone, PartialEq, Eq)]
pub struct ApiKey {
    pub key: String,
    pub secret: String,
}

impl fmt::Debug for ApiKey {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("ApiKey")
            .field("key", &self.key)
            .field("secret", &"****")
            .finish()
    }
}

fn sign(api: &ApiKey, claims: &Claims) -> Result<String, CollabError> {
    let header = URL_SAFE_NO_PAD.encode(br#"{"alg":"HS256","typ":"JWT"}"#);
    let payload = serde_json::to_vec(claims).map_err(|e| invalid("media token", e.to_string()))?;
    let signing_input = format!("{header}.{}", URL_SAFE_NO_PAD.encode(payload));
    let signature = hmac_sha256(api.secret.as_bytes(), signing_input.as_bytes());
    Ok(format!(
        "{signing_input}.{}",
        URL_SAFE_NO_PAD.encode(signature)
    ))
}

/// A member's token: join `room`, subscribe, publish the microphone only if `can_publish`.
pub fn member_token(
    api: &ApiKey,
    room_uid: &str,
    peer: &PeerId,
    can_publish: bool,
    now_secs: i64,
) -> Result<String, CollabError> {
    let claims = Claims {
        iss: api.key.clone(),
        sub: media_identity(room_uid, peer),
        nbf: now_secs - 5,
        exp: now_secs + TOKEN_TTL_SECS,
        video: VideoGrant {
            room: media_room(room_uid),
            room_join: true,
            room_admin: false,
            can_publish: Some(can_publish),
            can_subscribe: Some(true),
            can_publish_data: Some(false),
            can_publish_sources: if can_publish {
                vec!["microphone".into()]
            } else {
                Vec::new()
            },
            can_update_own_metadata: Some(false),
        },
    };
    sign(api, &claims)
}

/// The Owner's own token for managing one media room (updating permissions, removing members). Never sent anywhere
/// but to the media server.
pub fn admin_token(api: &ApiKey, room_uid: &str, now_secs: i64) -> Result<String, CollabError> {
    let claims = Claims {
        iss: api.key.clone(),
        sub: String::new(),
        nbf: now_secs - 5,
        exp: now_secs + 60,
        video: VideoGrant {
            room: media_room(room_uid),
            room_join: false,
            room_admin: true,
            can_publish: None,
            can_subscribe: None,
            can_publish_data: None,
            can_publish_sources: Vec::new(),
            can_update_own_metadata: None,
        },
    };
    sign(api, &claims)
}

/// Checks a token's signature and time window (as the media server does) and returns its claims.
pub fn verify(token: &str, secret: &str, now_secs: i64) -> Result<Claims, CollabError> {
    let bad = || invalid("media token", "invalid");
    let mut parts = token.split('.');
    let (Some(header), Some(payload), Some(signature), None) =
        (parts.next(), parts.next(), parts.next(), parts.next())
    else {
        return Err(bad());
    };
    let expected = hmac_sha256(secret.as_bytes(), format!("{header}.{payload}").as_bytes());
    let given = URL_SAFE_NO_PAD.decode(signature).map_err(|_| bad())?;
    if given.as_slice() != expected.as_slice() {
        return Err(bad());
    }
    let claims: Claims =
        serde_json::from_slice(&URL_SAFE_NO_PAD.decode(payload).map_err(|_| bad())?)
            .map_err(|_| bad())?;
    if now_secs < claims.nbf || now_secs >= claims.exp {
        return Err(invalid("media token", "expired"));
    }
    Ok(claims)
}

#[cfg(test)]
#[path = "sfu_tests.rs"]
mod tests;
