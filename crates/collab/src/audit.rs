//! The Owner's canonical room events and their tamper-evident chain.
//!
//! Each event's hash is `SHA-256("openmind-collab:v1:audit\n" + canonical JSON)`, and the canonical JSON includes
//! the previous event's hash, so changing, removing or reordering a stored event breaks every later hash. The
//! Owner signs each hash with its collaboration identity, so a participant's copy can be checked against the
//! Owner's key. This is local tamper evidence, not a consensus system. The canonical form is a fixed-order struct
//! with metadata in a `BTreeMap` (sorted keys whatever `serde_json` features other crates enable).
//!
//! Exact CRDT updates are never in these events (they are stored separately); edit activity is summarised
//! ([`EventKind::EditsBatched`]).

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::error::{invalid, CollabError};
use crate::files::RelPath;
use crate::identity::{PeerIdentity, PublicKey, Signature};
use crate::ids::{FileId, MessageId, PeerId, RoomUid, SessionId};
use crate::permission::Role;

pub const GENESIS_HASH: &str = "0000000000000000000000000000000000000000000000000000000000000000";
const MAX_METADATA_ENTRIES: usize = 32;
const MAX_METADATA_KEY: usize = 64;
const MAX_METADATA_VALUE: usize = 512;

macro_rules! kinds {
    ($($variant:ident => $name:literal,)*) => {
        /// What happened.
        #[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
        pub enum EventKind {
            $(#[serde(rename = $name)] $variant,)*
        }

        impl EventKind {
            pub fn as_str(self) -> &'static str {
                match self {
                    $(EventKind::$variant => $name,)*
                }
            }

            pub fn parse(text: &str) -> Result<Self, CollabError> {
                match text {
                    $($name => Ok(EventKind::$variant),)*
                    _ => Err(invalid("event kind", format!("unknown kind \"{text}\""))),
                }
            }
        }
    };
}

kinds! {
    RoomCreated => "room.created",
    RoomRenamed => "room.renamed",
    RoomLocked => "room.locked",
    RoomUnlocked => "room.unlocked",
    ApprovalChanged => "room.approvalChanged",
    DefaultRoleChanged => "room.defaultRoleChanged",
    InviteRotated => "room.inviteRotated",
    RoomClosed => "room.closed",
    OwnershipTransferred => "room.ownershipTransferred",
    JoinRequested => "member.joinRequested",
    JoinApproved => "member.joinApproved",
    JoinDenied => "member.joinDenied",
    MemberJoined => "member.joined",
    MemberReconnected => "member.reconnected",
    MemberLeft => "member.left",
    MemberKicked => "member.kicked",
    MemberRemoved => "member.removed",
    MemberBanned => "member.banned",
    MemberUnbanned => "member.unbanned",
    RoleChanged => "member.roleChanged",
    PermissionsChanged => "member.permissionsChanged",
    SessionStarted => "session.started",
    SessionEnded => "session.ended",
    FileOpened => "file.opened",
    FileCreated => "file.created",
    FileRenamed => "file.renamed",
    FileDeleted => "file.deleted",
    EditsBatched => "file.edited",
    VoiceJoined => "voice.joined",
    VoiceLeft => "voice.left",
    VoiceMuted => "voice.muted",
    VoiceUnmuted => "voice.unmuted",
    VoiceForceMuted => "voice.forceMuted",
    VoiceForceUnmuted => "voice.forceUnmuted",
    HandRaised => "voice.handRaised",
    HandLowered => "voice.handLowered",
    VoiceModeChanged => "voice.modeChanged",
}

impl EventKind {
    /// Activity a caller records after authorizing it itself (files, edits, voice, leaving). Room control and
    /// membership events are produced only by the authority's own operations.
    pub fn is_activity(self) -> bool {
        use EventKind::*;
        matches!(
            self,
            FileOpened
                | FileCreated
                | FileRenamed
                | FileDeleted
                | EditsBatched
                | VoiceJoined
                | VoiceLeft
                | VoiceMuted
                | VoiceUnmuted
                | HandRaised
                | HandLowered
                | VoiceModeChanged
                | MemberLeft
        )
    }
}

/// An event before it is placed in the chain.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EventDraft {
    pub session: Option<SessionId>,
    pub actor: PeerId,
    pub actor_name: String,
    pub actor_role: Role,
    pub kind: EventKind,
    pub file: Option<FileId>,
    pub path: Option<RelPath>,
    pub metadata: BTreeMap<String, String>,
}

/// A canonical, chained room event.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AuditEvent {
    pub event_id: MessageId,
    pub room: RoomUid,
    pub seq: u64,
    pub at_ms: i64,
    pub session: Option<SessionId>,
    pub actor: PeerId,
    pub actor_name: String,
    pub actor_role: Role,
    pub kind: EventKind,
    pub file: Option<FileId>,
    pub path: Option<RelPath>,
    pub metadata: BTreeMap<String, String>,
    pub prev_hash: String,
    pub hash: String,
    pub signature: Option<Signature>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Canonical<'a> {
    v: u16,
    event_id: &'a MessageId,
    room: &'a RoomUid,
    seq: u64,
    at_ms: i64,
    session: &'a Option<SessionId>,
    actor: &'a PeerId,
    actor_name: &'a str,
    actor_role: Role,
    kind: EventKind,
    file: &'a Option<FileId>,
    path: &'a Option<RelPath>,
    metadata: &'a BTreeMap<String, String>,
    prev_hash: &'a str,
}

impl AuditEvent {
    /// The hash this event should have.
    pub fn computed_hash(&self) -> Result<String, CollabError> {
        let canonical = Canonical {
            v: 1,
            event_id: &self.event_id,
            room: &self.room,
            seq: self.seq,
            at_ms: self.at_ms,
            session: &self.session,
            actor: &self.actor,
            actor_name: &self.actor_name,
            actor_role: self.actor_role,
            kind: self.kind,
            file: &self.file,
            path: &self.path,
            metadata: &self.metadata,
            prev_hash: &self.prev_hash,
        };
        let json = serde_json::to_vec(&canonical)
            .map_err(|err| invalid("audit event", err.to_string()))?;
        let mut hasher = Sha256::new();
        hasher.update(b"openmind-collab:v1:audit\n");
        hasher.update(&json);
        Ok(hex::encode(hasher.finalize()))
    }
}

fn check_metadata(metadata: &BTreeMap<String, String>) -> Result<(), CollabError> {
    if metadata.len() > MAX_METADATA_ENTRIES
        || metadata
            .iter()
            .any(|(k, v)| k.len() > MAX_METADATA_KEY || v.chars().count() > MAX_METADATA_VALUE)
    {
        return Err(invalid("audit metadata", "too many or too long entries"));
    }
    Ok(())
}

/// Where the chain ends: the next sequence number and the last hash.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChainHead {
    pub next_seq: u64,
    pub last_hash: String,
}

impl ChainHead {
    pub fn genesis() -> Self {
        Self {
            next_seq: 1,
            last_hash: GENESIS_HASH.to_string(),
        }
    }
}

/// Appends events to one room's chain.
#[derive(Debug, Clone)]
pub struct AuditChain {
    room: RoomUid,
    head: ChainHead,
}

impl AuditChain {
    pub fn new(room: RoomUid, head: ChainHead) -> Self {
        Self { room, head }
    }

    pub fn head(&self) -> &ChainHead {
        &self.head
    }

    /// Places `draft` at the end of the chain, signed by the Owner.
    pub fn append(
        &mut self,
        draft: EventDraft,
        at_ms: i64,
        signer: &PeerIdentity,
    ) -> Result<AuditEvent, CollabError> {
        check_metadata(&draft.metadata)?;
        let mut event = AuditEvent {
            event_id: MessageId::random()?,
            room: self.room.clone(),
            seq: self.head.next_seq,
            at_ms,
            session: draft.session,
            actor: draft.actor,
            actor_name: draft.actor_name,
            actor_role: draft.actor_role,
            kind: draft.kind,
            file: draft.file,
            path: draft.path,
            metadata: draft.metadata,
            prev_hash: self.head.last_hash.clone(),
            hash: String::new(),
            signature: None,
        };
        event.hash = event.computed_hash()?;
        event.signature = Some(signer.sign("audit", event.hash.as_bytes()));
        self.head = ChainHead {
            next_seq: event.seq + 1,
            last_hash: event.hash.clone(),
        };
        Ok(event)
    }
}

/// Where a stored chain is broken.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ChainBreak {
    pub seq: u64,
    pub problem: &'static str,
}

/// Checks a run of consecutive events starting at `head` (sequence, links, hashes, and signatures when the
/// Owner's key is given).
pub fn verify_chain(
    events: &[AuditEvent],
    head: &ChainHead,
    owner_key: Option<&PublicKey>,
) -> Result<(), ChainBreak> {
    let mut expected = head.clone();
    for event in events {
        let fail = |problem| {
            Err(ChainBreak {
                seq: event.seq,
                problem,
            })
        };
        if event.seq != expected.next_seq {
            return fail("a sequence number is missing or repeated");
        }
        if event.prev_hash != expected.last_hash {
            return fail("the link to the previous event is broken");
        }
        if event.computed_hash().ok().as_deref() != Some(event.hash.as_str()) {
            return fail("the event was changed after it was recorded");
        }
        if let Some(key) = owner_key {
            let signed = event
                .signature
                .as_ref()
                .is_some_and(|sig| key.verify("audit", event.hash.as_bytes(), sig).is_ok());
            if !signed {
                return fail("the Owner's signature is missing or wrong");
            }
        }
        expected = ChainHead {
            next_seq: event.seq + 1,
            last_hash: event.hash.clone(),
        };
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn draft(identity: &PeerIdentity, kind: EventKind) -> EventDraft {
        EventDraft {
            session: None,
            actor: identity.peer_id(),
            actor_name: "Owner".into(),
            actor_role: Role::Owner,
            kind,
            file: None,
            path: None,
            metadata: BTreeMap::from([("name".to_string(), "Room".to_string())]),
        }
    }

    fn chain_of(n: usize) -> (PeerIdentity, Vec<AuditEvent>) {
        let owner = PeerIdentity::generate().expect("identity");
        let mut chain = AuditChain::new(RoomUid::random().expect("room"), ChainHead::genesis());
        let events = (0..n)
            .map(|i| {
                chain
                    .append(draft(&owner, EventKind::RoomRenamed), i as i64, &owner)
                    .expect("append")
            })
            .collect();
        (owner, events)
    }

    #[test]
    fn an_untouched_chain_verifies() {
        let (owner, events) = chain_of(5);
        assert_eq!(events[0].prev_hash, GENESIS_HASH);
        assert_eq!(events[4].seq, 5);
        assert!(verify_chain(&events, &ChainHead::genesis(), Some(&owner.public_key())).is_ok());
    }

    #[test]
    fn tampering_reordering_and_removal_are_detected() {
        let (owner, events) = chain_of(4);
        let key = owner.public_key();
        let mut changed = events.clone();
        changed[1].actor_name = "Someone else".into();
        assert_eq!(
            verify_chain(&changed, &ChainHead::genesis(), None).map_err(|b| b.seq),
            Err(2)
        );
        let mut removed = events.clone();
        removed.remove(1);
        assert!(verify_chain(&removed, &ChainHead::genesis(), None).is_err());
        let mut swapped = events.clone();
        swapped.swap(1, 2);
        assert!(verify_chain(&swapped, &ChainHead::genesis(), None).is_err());
        let mut rehashed = events.clone();
        rehashed[3].metadata.insert("x".into(), "y".into());
        rehashed[3].hash = rehashed[3].computed_hash().expect("hash");
        assert!(
            verify_chain(&rehashed, &ChainHead::genesis(), None).is_ok(),
            "the last link alone is not enough..."
        );
        assert!(
            verify_chain(&rehashed, &ChainHead::genesis(), Some(&key)).is_err(),
            "...but the signature catches it"
        );
    }

    #[test]
    fn metadata_is_bounded() {
        let owner = PeerIdentity::generate().expect("identity");
        let mut chain = AuditChain::new(RoomUid::random().expect("room"), ChainHead::genesis());
        let mut big = draft(&owner, EventKind::RoomRenamed);
        big.metadata.insert("k".into(), "v".repeat(600));
        assert!(chain.append(big, 0, &owner).is_err());
        assert_eq!(
            chain.head().next_seq,
            1,
            "a refused event doesn't advance the chain"
        );
    }

    #[test]
    fn kinds_round_trip() {
        for kind in [
            EventKind::RoomCreated,
            EventKind::EditsBatched,
            EventKind::VoiceForceMuted,
        ] {
            assert_eq!(EventKind::parse(kind.as_str()).expect("parse"), kind);
        }
        assert!(EventKind::MemberLeft.is_activity());
        assert!(!EventKind::RoleChanged.is_activity());
    }
}
