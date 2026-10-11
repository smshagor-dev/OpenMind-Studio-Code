//! The wire protocol, version 1: JSON messages on WebRTC data channels.
//!
//! Before a session exists only [`Handshake`] messages are exchanged (the Owner's challenge, a join or reconnect
//! request, the answer). After admission every message is a [`Frame`]: protocol version, message id, session id,
//! sequence number, logical channel and body. [`Frame::decode`] refuses oversized input before parsing, unknown
//! fields, a different version, a body on the wrong channel, and any field over its limit; ids, paths, keys,
//! permissions and roles are validated by their own types while parsing. A frame carries **no** role or permission
//! — the Owner looks those up for the authenticated session — and the receiver runs [`crate::replay::ReplayGuard`]
//! on it before acting.
//!
//! JSON (with base64 for binary CRDT/awareness payloads) is chosen for v1 for inspectability; a binary encoding
//! can come as protocol v2 without changing the authority.

use base64::engine::general_purpose::STANDARD as BASE64;
use base64::Engine as _;
use serde::{Deserialize, Serialize};

use crate::authority::Command;
use crate::error::{invalid, CollabError};
use crate::files::{FileKind, RelPath};
use crate::identity::{PeerIdentity, PublicKey, Signature};
use crate::ids::{Challenge, FileId, MessageId, PeerId, RoomUid, SessionId, TransferId};
use crate::manifest::{ManifestEntry, MAX_PAGES, MAX_PAGE_ENTRIES};
use crate::permission::{PermissionSet, Role};
use crate::transfer::{FileErrorCode, FileMeta, CHUNK_BYTES};

pub const PROTOCOL_VERSION: u16 = 1;
/// Largest encoded message accepted (checked before parsing).
pub const MAX_FRAME_BYTES: usize = 4 * 1024 * 1024;
pub const MAX_UPDATE_BYTES: usize = 2 * 1024 * 1024;
pub const MAX_AWARENESS_BYTES: usize = 16 * 1024;
pub const MAX_SIGNAL_CHARS: usize = 64 * 1024;
pub const MAX_REASON_CHARS: usize = 200;

/// Binary data, base64 on the wire.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(try_from = "String", into = "String")]
pub struct Bytes(pub Vec<u8>);

impl TryFrom<String> for Bytes {
    type Error = CollabError;
    fn try_from(text: String) -> Result<Self, Self::Error> {
        // A reassembled document sync can be larger than one frame (`SyncChunk`); frames themselves stay checked.
        if text.len() > crate::crdt::MAX_SYNC_BYTES.div_ceil(3) * 4 + 4 {
            return Err(invalid("binary payload", "too large"));
        }
        BASE64
            .decode(text)
            .map(Bytes)
            .map_err(|_| invalid("binary payload", "not base64"))
    }
}

impl From<Bytes> for String {
    fn from(bytes: Bytes) -> String {
        BASE64.encode(bytes.0)
    }
}

/// The logical data channels; each has its own WebRTC data channel. Voice *media* is not here — it travels as
/// WebRTC media tracks; only its signaling and moderation use `control`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Channel {
    /// Reliable, ordered: room control, moderation, voice signaling, acknowledgements.
    Control,
    /// Reliable, ordered: CRDT updates.
    Sync,
    /// Reliable, ordered: file tree and file content requests.
    Files,
    /// Low latency, losses acceptable: cursors, selections, active file.
    Awareness,
}

impl Channel {
    pub fn label(self) -> &'static str {
        match self {
            Channel::Control => "openmind-control",
            Channel::Sync => "openmind-sync",
            Channel::Files => "openmind-files",
            Channel::Awareness => "openmind-awareness",
        }
    }

    /// Whether the channel must deliver every message in order.
    pub fn reliable(self) -> bool {
        !matches!(self, Channel::Awareness)
    }
}

/// Why a collaborative document closed.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum DocClosedReason {
    /// The file was deleted (or became hidden); changes to it are refused.
    Deleted,
    /// It isn't available to this member (unknown, not shared, or no permission to read it).
    Unavailable,
    /// Too large, or not text: it stays a read-only snapshot.
    NotEditable,
}

/// A session message's content.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(
    tag = "type",
    content = "data",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum Body {
    /// Owner -> peer: the message was accepted (and, for a write, persisted).
    Ack {
        of: MessageId,
    },
    /// Owner -> peer: the message was refused, with a short reason.
    Reject {
        of: MessageId,
        reason: String,
    },
    Leave,
    Command {
        command: Command,
    },
    /// One collaborative-text change of `file`, either way. `id` identifies the change itself (not the frame): a
    /// resend after a reconnect carries the same id, and the Owner stores and forwards it only once.
    YjsUpdate {
        file: FileId,
        id: MessageId,
        update: Bytes,
    },
    /// Participant -> Owner: open `file` for collaborative editing; `state_vector` says what this side already has
    /// (answered with `DocSync`, then live `YjsUpdate`s).
    YjsStateRequest {
        file: FileId,
        state_vector: Bytes,
    },
    /// Owner -> participant: what the participant was missing, and the Owner's state vector (so the participant can
    /// send back what the Owner lacks after an offline stretch).
    DocSync {
        file: FileId,
        state_vector: Bytes,
        update: Bytes,
    },
    /// Participant -> Owner: no more updates for `file` (its tab closed).
    DocUnsubscribe {
        file: FileId,
    },
    /// Owner -> participant: the document can't be edited together any more.
    DocClosed {
        file: FileId,
        reason: DocClosedReason,
    },
    /// Owner -> participant: whether this member may change files right now (follows role and permission changes
    /// at once; the Owner still checks every update itself).
    Access {
        write: bool,
    },
    /// A piece of a `openmind-sync` message too large for one data channel message; the pieces of `id`, in order,
    /// rebuild the message, whose SHA-256 is `sha256`.
    SyncChunk {
        id: TransferId,
        index: u32,
        count: u32,
        sha256: String,
        data: Bytes,
    },
    /// Participant -> Owner: the shared tree, please (answered with `ManifestPage`s).
    ManifestRequest,
    /// Owner -> participant: one page of manifest `version` (`pages` in all; any order).
    ManifestPage {
        version: u64,
        page: u32,
        pages: u32,
        root: String,
        entries: Vec<ManifestEntry>,
    },
    /// Owner -> participant: what changed from `base` to `version`.
    TreeDelta {
        base: u64,
        version: u64,
        upserts: Vec<ManifestEntry>,
        removed: Vec<FileId>,
    },
    /// Owner -> participant: too much changed for a delta; request the manifest again.
    TreeReset {
        version: u64,
    },
    /// Participant -> Owner: send this file (the participant names the transfer).
    FileRequest {
        file: FileId,
        transfer: TransferId,
    },
    FileMeta {
        meta: FileMeta,
    },
    FileChunk {
        transfer: TransferId,
        index: u32,
        data: Bytes,
    },
    FileComplete {
        transfer: TransferId,
    },
    /// Either side: stop this transfer.
    FileCancel {
        transfer: TransferId,
    },
    FileError {
        transfer: TransferId,
        code: FileErrorCode,
    },
    FileCreate {
        path: RelPath,
        kind: FileKind,
    },
    FileRename {
        file: FileId,
        to: RelPath,
    },
    FileDelete {
        file: FileId,
    },
    Awareness {
        state: Bytes,
    },
    /// Participant/Owner: this member's presence (latest-value; a lost one is replaced by the next).
    Presence {
        state: crate::presence::PresenceState,
    },
    /// Owner -> participant: another member's presence, naming the peer of the session it came on.
    PeerPresence {
        peer: PeerId,
        state: crate::presence::PresenceState,
    },
    /// Owner -> participant: a member left (or its session ended): its cursor and markers go at once.
    PresenceGone {
        peer: PeerId,
    },
    /// Owner -> participant: the members, their roles and who is online (from the room's membership).
    Roster {
        members: Vec<crate::presence::RosterEntry>,
    },
    /// Owner -> participant: the room and the members as this member may manage them (phase 8).
    RoomView {
        view: crate::roomview::RoomView,
    },
    /// Participant -> Owner: this member's own voice state (phase 9).
    VoiceState {
        state: crate::voice::VoiceSelf,
    },
    /// Participant -> Owner: WebRTC negotiation for voice, for the member `to` (relayed only between two members of
    /// the call).
    VoiceSignal {
        to: PeerId,
        signal: crate::voice::VoiceSignal,
    },
    /// Owner -> participant: a negotiation message from `from` (the authenticated sender).
    VoicePeerSignal {
        from: PeerId,
        signal: crate::voice::VoiceSignal,
    },
    /// Owner -> participant: who is in the voice call (moderation and permissions from the room), and how the call
    /// carries media (peer to peer, or classroom through a media server; phase 11).
    VoiceRoster {
        members: Vec<crate::voice::VoiceMember>,
        #[serde(default)]
        mode: crate::sfu::VoiceMode,
    },
    /// Participant -> Owner: how to carry this member's call media (asked when it joins voice; phase 11). Answered with
    /// [`Body::VoiceMedia`] naming this frame, or `Reject`.
    VoiceMediaRequest,
    /// Owner -> participant: the answer to a [`Body::VoiceMediaRequest`] — peer to peer, or a media server address with
    /// a token for this member only.
    VoiceMedia {
        of: MessageId,
        media: crate::sfu::VoiceMediaGrant,
    },
    /// Liveness/latency check; the other side answers with the same nonce.
    Ping {
        nonce: u64,
    },
    Pong {
        nonce: u64,
    },
}

impl Body {
    pub fn channel(&self) -> Channel {
        match self {
            Body::YjsUpdate { .. }
            | Body::YjsStateRequest { .. }
            | Body::DocSync { .. }
            | Body::DocUnsubscribe { .. }
            | Body::DocClosed { .. }
            | Body::SyncChunk { .. } => Channel::Sync,
            Body::FileRequest { .. }
            | Body::ManifestRequest
            | Body::ManifestPage { .. }
            | Body::TreeDelta { .. }
            | Body::TreeReset { .. }
            | Body::FileMeta { .. }
            | Body::FileChunk { .. }
            | Body::FileComplete { .. }
            | Body::FileCancel { .. }
            | Body::FileError { .. }
            | Body::FileCreate { .. }
            | Body::FileRename { .. }
            | Body::FileDelete { .. } => Channel::Files,
            Body::Awareness { .. } | Body::Presence { .. } | Body::PeerPresence { .. } => {
                Channel::Awareness
            }
            Body::Ack { .. }
            | Body::Reject { .. }
            | Body::Leave
            | Body::Command { .. }
            | Body::VoiceState { .. }
            | Body::VoiceSignal { .. }
            | Body::VoicePeerSignal { .. }
            | Body::VoiceRoster { .. }
            | Body::VoiceMediaRequest
            | Body::VoiceMedia { .. }
            | Body::Ping { .. }
            | Body::Access { .. }
            | Body::PresenceGone { .. }
            | Body::Roster { .. }
            | Body::RoomView { .. }
            | Body::Pong { .. } => Channel::Control,
        }
    }

    /// Checks a message rebuilt from chunks (the same rules as a frame's body).
    pub(crate) fn validate_inner(&self) -> Result<(), CollabError> {
        self.validate()
    }

    fn validate(&self) -> Result<(), CollabError> {
        let limit = |what: &'static str, len: usize, max: usize| {
            if len > max {
                Err(invalid(what, format!("at most {max}")))
            } else {
                Ok(())
            }
        };
        match self {
            Body::YjsUpdate { update, .. } => {
                limit("CRDT update", update.0.len(), MAX_UPDATE_BYTES)
            }
            Body::YjsStateRequest { state_vector, .. } => {
                limit("state vector", state_vector.0.len(), MAX_AWARENESS_BYTES)
            }
            Body::DocSync {
                state_vector,
                update,
                ..
            } => {
                limit("state vector", state_vector.0.len(), MAX_AWARENESS_BYTES)?;
                limit("document sync", update.0.len(), crate::crdt::MAX_SYNC_BYTES)
            }
            Body::SyncChunk {
                index,
                count,
                sha256,
                data,
                ..
            } => {
                limit("sync chunk", data.0.len(), crate::sync_chunk::CHUNK_BYTES)?;
                limit(
                    "sync chunks",
                    *count as usize,
                    crate::sync_chunk::MAX_CHUNKS,
                )?;
                if *count == 0 || index >= count || sha256.len() != 64 {
                    return Err(invalid("sync chunk", "its numbers or checksum are invalid"));
                }
                Ok(())
            }
            Body::Awareness { state } => {
                limit("awareness state", state.0.len(), MAX_AWARENESS_BYTES)
            }
            Body::Presence { state } | Body::PeerPresence { state, .. } => state.validate(),
            Body::Roster { members } => {
                limit("roster", members.len(), crate::presence::MAX_ROSTER)?;
                members
                    .iter()
                    .try_for_each(crate::presence::RosterEntry::validate)
            }
            Body::RoomView { view } => view.validate(),
            Body::Reject { reason, .. } => {
                limit("reason", reason.chars().count(), MAX_REASON_CHARS)
            }
            Body::VoiceSignal { signal, .. } | Body::VoicePeerSignal { signal, .. } => {
                signal.validate()
            }
            Body::VoiceRoster { members, .. } => limit(
                "voice roster",
                members.len(),
                crate::voice::MAX_SFU_VOICE_MEMBERS,
            ),
            Body::VoiceMedia { media, .. } => media.validate(),
            Body::Command { command } => command.validate(),
            Body::ManifestPage {
                page,
                pages,
                root,
                entries,
                ..
            } => {
                limit("manifest page entries", entries.len(), MAX_PAGE_ENTRIES)?;
                limit("manifest pages", *pages as usize, MAX_PAGES as usize)?;
                limit("workspace name", root.chars().count(), 255)?;
                if page >= pages {
                    return Err(invalid("manifest page", "page number out of range"));
                }
                entries.iter().try_for_each(ManifestEntry::validate)
            }
            Body::TreeDelta {
                upserts, removed, ..
            } => {
                limit("delta entries", upserts.len(), MAX_PAGE_ENTRIES)?;
                limit("removed entries", removed.len(), MAX_PAGE_ENTRIES)?;
                upserts.iter().try_for_each(ManifestEntry::validate)
            }
            Body::FileChunk { data, .. } => limit("file chunk", data.0.len(), CHUNK_BYTES),
            _ => Ok(()),
        }
    }
}

/// One message of an authenticated session.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Frame {
    pub v: u16,
    pub id: MessageId,
    pub session: SessionId,
    pub seq: u64,
    pub channel: Channel,
    pub body: Body,
}

impl Frame {
    pub fn new(session: SessionId, seq: u64, body: Body) -> Result<Self, CollabError> {
        Ok(Self {
            v: PROTOCOL_VERSION,
            id: MessageId::random()?,
            session,
            seq,
            channel: body.channel(),
            body,
        })
    }

    pub fn encode(&self) -> Result<Vec<u8>, CollabError> {
        let bytes = serde_json::to_vec(self).map_err(|err| invalid("frame", err.to_string()))?;
        check_size(bytes.len())?;
        Ok(bytes)
    }

    /// Parses and validates a received frame.
    pub fn decode(bytes: &[u8]) -> Result<Self, CollabError> {
        check_size(bytes.len())?;
        let frame: Frame =
            serde_json::from_slice(bytes).map_err(|err| invalid("frame", err.to_string()))?;
        if frame.v != PROTOCOL_VERSION {
            return Err(invalid(
                "frame",
                format!("protocol version {} isn't supported", frame.v),
            ));
        }
        if frame.body.channel() != frame.channel {
            return Err(invalid(
                "frame",
                "the message was sent on the wrong channel",
            ));
        }
        frame.body.validate()?;
        Ok(frame)
    }
}

fn check_size(len: usize) -> Result<(), CollabError> {
    if len > MAX_FRAME_BYTES {
        return Err(invalid(
            "frame",
            format!("larger than {MAX_FRAME_BYTES} bytes"),
        ));
    }
    Ok(())
}

/// A request to join with the Room Code. The peer signs it with its identity key and proves the code with an HMAC
/// over the Owner's fresh challenge; the code itself never travels.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct JoinRequest {
    pub room: RoomUid,
    pub public_key: PublicKey,
    pub display_name: String,
    pub challenge: Challenge,
    pub proof: String,
    pub signature: Signature,
}

impl JoinRequest {
    pub fn signed_payload(
        room: &RoomUid,
        public_key: &PublicKey,
        display_name: &str,
        challenge: &Challenge,
        proof: &str,
    ) -> Vec<u8> {
        format!(
            "{room}\n{}\n{challenge}\n{proof}\n{display_name}",
            public_key.peer_id()
        )
        .into_bytes()
    }

    /// What a joining peer sends, built from the code it was given.
    pub fn create(
        identity: &PeerIdentity,
        code: &crate::code::RoomCode,
        room: &RoomUid,
        challenge: &Challenge,
        display_name: &str,
    ) -> Self {
        let public_key = identity.public_key();
        let proof = code.join_proof(room, &identity.peer_id(), challenge.as_str());
        let payload = Self::signed_payload(room, &public_key, display_name, challenge, &proof);
        Self {
            room: room.clone(),
            public_key,
            display_name: display_name.to_string(),
            challenge: challenge.clone(),
            proof,
            signature: identity.sign("join", &payload),
        }
    }

    pub fn verify_signature(&self) -> Result<(), CollabError> {
        let payload = Self::signed_payload(
            &self.room,
            &self.public_key,
            &self.display_name,
            &self.challenge,
            &self.proof,
        );
        self.public_key.verify("join", &payload, &self.signature)
    }
}

/// A returning member's request: proves the key (no Room Code needed while the membership is Active).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ReconnectRequest {
    pub room: RoomUid,
    pub public_key: PublicKey,
    pub challenge: Challenge,
    pub signature: Signature,
}

impl ReconnectRequest {
    fn payload(room: &RoomUid, peer: &PeerId, challenge: &Challenge) -> Vec<u8> {
        format!("{room}\n{peer}\n{challenge}").into_bytes()
    }

    pub fn create(identity: &PeerIdentity, room: &RoomUid, challenge: &Challenge) -> Self {
        let payload = Self::payload(room, &identity.peer_id(), challenge);
        Self {
            room: room.clone(),
            public_key: identity.public_key(),
            challenge: challenge.clone(),
            signature: identity.sign("reconnect", &payload),
        }
    }

    pub fn verify_signature(&self) -> Result<(), CollabError> {
        let payload = Self::payload(&self.room, &self.public_key.peer_id(), &self.challenge);
        self.public_key
            .verify("reconnect", &payload, &self.signature)
    }
}

/// What an admitted peer is told: its session and what it may do (informational — the Owner enforces).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Admission {
    pub session: SessionId,
    pub peer: PeerId,
    pub role: Role,
    pub permissions: PermissionSet,
    pub room_name: String,
    pub owner: PeerId,
}

/// Why a join or reconnect was refused (told to the peer; never which part of a proof was wrong beyond this).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Refusal {
    WrongRoom,
    WrongChallenge,
    BadSignature,
    InvalidInvite,
    InvalidName,
    Banned,
    Locked,
    Closed,
    Full,
    NotAMember,
    /// A moderator turned the join request down.
    Denied,
}

/// The messages exchanged before a session exists.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(
    tag = "type",
    content = "data",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum Handshake {
    /// Owner -> peer, first message on a new connection. `owner_proof` (Room Code HMAC) and `signature` (Owner
    /// key) are over the challenge *bound* to both DTLS fingerprints (see [`crate::binding`]).
    Challenge {
        v: u16,
        room: RoomUid,
        owner_key: PublicKey,
        challenge: Challenge,
        owner_proof: String,
        signature: Signature,
    },
    Join(JoinRequest),
    Reconnect(ReconnectRequest),
    Admitted(Admission),
    /// Waiting for a moderator's approval.
    Pending,
    Refused {
        refusal: Refusal,
    },
}

impl Handshake {
    pub fn decode(bytes: &[u8]) -> Result<Self, CollabError> {
        if bytes.len() > 64 * 1024 {
            return Err(invalid("handshake", "too large"));
        }
        serde_json::from_slice(bytes).map_err(|err| invalid("handshake", err.to_string()))
    }

    pub fn encode(&self) -> Result<Vec<u8>, CollabError> {
        serde_json::to_vec(self).map_err(|err| invalid("handshake", err.to_string()))
    }
}

#[cfg(test)]
#[path = "protocol_tests.rs"]
mod tests;
