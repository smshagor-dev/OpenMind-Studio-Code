//! Voice in a room (Milestone 24, phase 9): who is in the voice call, muted, speaking, with a raised hand — ephemeral
//! state the Owner keeps in memory, never stored — and the WebRTC negotiation messages members exchange through the
//! Owner. Voice *media* never comes here: it flows directly between the members' WebViews.
//!
//! A member reports only [`VoiceSelf`] about itself. What it may do comes from the room's membership: `voice.join` to be
//! in the call, `voice.speak` (and not force-muted by a moderator) to be unmuted. The Owner refuses a state that breaks
//! those rules, and [`VoiceBoard::enforce`] mutes or removes members the moment a permission or a moderation changes.

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};

use crate::error::{invalid, CollabError};
use crate::ids::PeerId;
use crate::permission::Permission;
use crate::room::{MemberStatus, RoomState};
use crate::sfu::VoiceMode;

/// Members in one peer-to-peer voice call at most: a full mesh of WebRTC connections (each member sends its audio to
/// every other) stays practical up to about this size. Larger classes use classroom mode (a media server).
pub const MAX_VOICE_MEMBERS: usize = 6;
/// Members in one classroom (media server) call at most — a hard ceiling for what OpenMind sends around (the roster),
/// not a promise: the size a deployment supports is measured on its server and network (`collaboration-classroom.md`).
pub const MAX_SFU_VOICE_MEMBERS: usize = 60;
/// An SDP for one audio track is a few KB; anything far above isn't one.
pub const MAX_SDP_BYTES: usize = 32 * 1024;
pub const MAX_CANDIDATE_BYTES: usize = 1024;
const MAX_MID_BYTES: usize = 64;

/// What a member says about its own voice.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct VoiceSelf {
    pub joined: bool,
    pub muted: bool,
    pub speaking: bool,
    pub hand_raised: bool,
}

/// A voice member as the Owner tells everyone (moderation and permissions from the room, the rest as reported).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct VoiceMember {
    pub peer: PeerId,
    pub muted: bool,
    pub speaking: bool,
    pub hand_raised: bool,
    /// A moderator muted this member: it can't unmute until the moderator lifts it.
    pub force_muted: bool,
    /// May speak now (`voice.speak` and not force-muted); otherwise it is listen-only.
    pub can_speak: bool,
}

/// One WebRTC negotiation message between two voice members (relayed by the Owner, opaque to it beyond its size).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum VoiceSignal {
    Offer {
        sdp: String,
    },
    Answer {
        sdp: String,
    },
    Candidate {
        candidate: String,
        sdp_mid: Option<String>,
        sdp_m_line_index: Option<u16>,
    },
    /// The sender closed its connection to the receiver.
    Close,
}

impl VoiceSignal {
    pub fn validate(&self) -> Result<(), CollabError> {
        let over = |what: &str, len: usize, max: usize| {
            if len > max {
                Err(invalid("voice signal", format!("{what} is too large")))
            } else {
                Ok(())
            }
        };
        match self {
            VoiceSignal::Offer { sdp } | VoiceSignal::Answer { sdp } => {
                over("SDP", sdp.len(), MAX_SDP_BYTES)
            }
            VoiceSignal::Candidate {
                candidate, sdp_mid, ..
            } => {
                over("candidate", candidate.len(), MAX_CANDIDATE_BYTES)?;
                over(
                    "media id",
                    sdp_mid.as_ref().map_or(0, String::len),
                    MAX_MID_BYTES,
                )
            }
            VoiceSignal::Close => Ok(()),
        }
    }
}

/// Why a voice state was refused.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum VoiceRefusal {
    NotAllowed,
    Full,
    MayNotSpeak,
}

impl VoiceRefusal {
    pub fn text(self) -> &'static str {
        match self {
            VoiceRefusal::NotAllowed => "the permission \"voice.join\" is required",
            VoiceRefusal::Full => "the voice call is full",
            VoiceRefusal::MayNotSpeak => "you may not speak in this room right now",
        }
    }
}

/// What a state change did.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum VoiceChange {
    Joined,
    Left,
    Updated,
    Unchanged,
}

fn may(room: &RoomState, peer: &PeerId, permission: Permission) -> bool {
    room.member(peer)
        .is_some_and(|m| m.status == MemberStatus::Active && m.permissions().contains(permission))
}

fn may_speak(room: &RoomState, peer: &PeerId) -> bool {
    may(room, peer, Permission::VoiceSpeak) && room.member(peer).is_some_and(|m| !m.force_muted)
}

/// The Owner's view of the voice call.
#[derive(Debug, Default)]
pub struct VoiceBoard {
    members: BTreeMap<PeerId, VoiceSelf>,
    mode: VoiceMode,
}

/// Why the call's mode can't change now.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct CallInProgress;

impl VoiceBoard {
    pub fn mode(&self) -> VoiceMode {
        self.mode
    }

    /// The most members this call takes in its mode.
    pub fn capacity(&self) -> usize {
        match self.mode {
            VoiceMode::P2p => MAX_VOICE_MEMBERS,
            VoiceMode::Sfu => MAX_SFU_VOICE_MEMBERS,
        }
    }

    /// Changes how the call carries media. Refused while anyone is in the call: a running call keeps its transport
    /// until it ends (switching under it would drop or duplicate everyone's audio).
    pub fn set_mode(&mut self, mode: VoiceMode) -> Result<bool, CallInProgress> {
        if mode == self.mode {
            return Ok(false);
        }
        if !self.members.is_empty() {
            return Err(CallInProgress);
        }
        self.mode = mode;
        Ok(true)
    }

    /// A member's own report. A listen-only member's report is refused when it unmutes; one that only says "muted" is
    /// always fine.
    pub fn update(
        &mut self,
        room: &RoomState,
        peer: &PeerId,
        state: VoiceSelf,
    ) -> Result<VoiceChange, VoiceRefusal> {
        if !state.joined {
            return Ok(if self.leave(peer) {
                VoiceChange::Left
            } else {
                VoiceChange::Unchanged
            });
        }
        if !may(room, peer, Permission::VoiceJoin) {
            return Err(VoiceRefusal::NotAllowed);
        }
        if !state.muted && !may_speak(room, peer) {
            return Err(VoiceRefusal::MayNotSpeak);
        }
        let known = self.members.get(peer).copied();
        if known.is_none() && self.members.len() >= self.capacity() {
            return Err(VoiceRefusal::Full);
        }
        // Speaking while muted isn't a thing the others should see.
        let state = VoiceSelf {
            speaking: state.speaking && !state.muted,
            ..state
        };
        self.members.insert(peer.clone(), state);
        Ok(match known {
            None => VoiceChange::Joined,
            Some(old) if old == state => VoiceChange::Unchanged,
            Some(_) => VoiceChange::Updated,
        })
    }

    pub fn leave(&mut self, peer: &PeerId) -> bool {
        self.members.remove(peer).is_some()
    }

    pub fn clear(&mut self) {
        self.members.clear();
    }

    pub fn contains(&self, peer: &PeerId) -> bool {
        self.members.contains_key(peer)
    }

    pub fn len(&self) -> usize {
        self.members.len()
    }

    pub fn is_empty(&self) -> bool {
        self.members.is_empty()
    }

    /// Applies the room's current rules: members who lost `voice.join` (or left the room) are out, members who may not
    /// speak are muted. The peers that left (for the audit history) — and whether anything changed at all.
    pub fn enforce(&mut self, room: &RoomState) -> (Vec<PeerId>, bool) {
        let gone: Vec<PeerId> = self
            .members
            .keys()
            .filter(|p| !may(room, p, Permission::VoiceJoin))
            .cloned()
            .collect();
        for peer in &gone {
            self.members.remove(peer);
        }
        let mut changed = !gone.is_empty();
        for (peer, state) in &mut self.members {
            if !state.muted && !may_speak(room, peer) {
                state.muted = true;
                state.speaking = false;
                changed = true;
            }
        }
        (gone, changed)
    }

    /// Whether two members may negotiate a voice connection: both are in the call, and they are different members.
    pub fn may_signal(&self, from: &PeerId, to: &PeerId) -> bool {
        from != to && self.contains(from) && self.contains(to)
    }

    /// Everyone in the call, as the Owner tells the room.
    pub fn roster(&self, room: &RoomState) -> Vec<VoiceMember> {
        self.members
            .iter()
            .map(|(peer, state)| VoiceMember {
                peer: peer.clone(),
                muted: state.muted,
                speaking: state.speaking,
                hand_raised: state.hand_raised,
                force_muted: room.member(peer).is_some_and(|m| m.force_muted),
                can_speak: may_speak(room, peer),
            })
            .collect()
    }
}

#[cfg(test)]
#[path = "voice_tests.rs"]
mod tests;
