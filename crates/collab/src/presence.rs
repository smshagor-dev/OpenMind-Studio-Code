//! Who is where, right now (Milestone 24, phase 7): presence is ephemeral — never stored, never canonical, carried on
//! the low-latency `openmind-awareness` channel (unordered, losses acceptable) and replaced by the next state.
//!
//! What a member says about itself is deliberately narrow ([`PresenceState`]): the file it has active, its cursor and
//! selection in that file as Yjs *relative* positions (they survive concurrent edits), whether it is typing, and a
//! sequence number. Nothing else is accepted (`deny_unknown_fields`: a packet that also claims a role or another
//! identity is dropped whole). Who sent it is never read from the packet: the Owner relays each state as a
//! `PeerPresence` naming the peer of the authenticated session it arrived on, and roles reach members only in the
//! Owner's [`RosterEntry`] list, built from the room's membership. Voice (phase 9) can add its own fields here later.

use std::collections::HashMap;

use serde::{Deserialize, Serialize};

use crate::error::{invalid, CollabError};
use crate::ids::{FileId, PeerId};
use crate::permission::Role;
use crate::protocol::Bytes;

/// An encoded Yjs relative position is a few dozen bytes; anything longer isn't one.
pub const MAX_POSITION_BYTES: usize = 96;
pub const MAX_NAME_CHARS: usize = 64;
/// Members one roster may list.
pub const MAX_ROSTER: usize = 512;

/// A cursor and selection in the active file (`anchor` == `head`: no selection).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CursorState {
    pub anchor: Bytes,
    pub head: Bytes,
}

/// What a member says about itself.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PresenceState {
    /// Rises with every state a member sends; an older one arriving late is dropped.
    pub seq: u64,
    /// The shared file it has active (none: not in a shared file).
    pub active: Option<FileId>,
    /// Its cursor in `active` (only there).
    pub cursor: Option<CursorState>,
    pub typing: bool,
}

impl PresenceState {
    pub fn validate(&self) -> Result<(), CollabError> {
        if let Some(cursor) = &self.cursor {
            if self.active.is_none() {
                return Err(invalid("presence", "a cursor needs an active file"));
            }
            if cursor.anchor.0.is_empty()
                || cursor.head.0.is_empty()
                || cursor.anchor.0.len() > MAX_POSITION_BYTES
                || cursor.head.0.len() > MAX_POSITION_BYTES
            {
                return Err(invalid("presence", "a cursor position is malformed"));
            }
        }
        Ok(())
    }
}

/// One member as the Owner lists it (from the room's membership, never from presence).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RosterEntry {
    pub peer: PeerId,
    pub display_name: String,
    pub role: Role,
    pub online: bool,
}

impl RosterEntry {
    pub fn validate(&self) -> Result<(), CollabError> {
        if self.display_name.chars().count() > MAX_NAME_CHARS
            || self.display_name.chars().any(char::is_control)
        {
            return Err(invalid("roster", "a display name is malformed"));
        }
        Ok(())
    }
}

/// The Owner's view of members' latest presence: drops what is older than what it already has.
#[derive(Default)]
pub struct PresenceBoard {
    latest: HashMap<PeerId, PresenceState>,
}

impl PresenceBoard {
    /// Takes a member's state; `false` (drop it) when it is not newer than the last one from that member.
    pub fn accept(&mut self, peer: &PeerId, state: &PresenceState) -> bool {
        if self
            .latest
            .get(peer)
            .is_some_and(|last| last.seq >= state.seq)
        {
            return false;
        }
        self.latest.insert(peer.clone(), state.clone());
        true
    }

    /// A member left or reconnected on a new session: its old state is gone.
    pub fn forget(&mut self, peer: &PeerId) -> bool {
        self.latest.remove(peer).is_some()
    }

    /// The states to send someone who just joined.
    pub fn all(&self) -> Vec<(PeerId, PresenceState)> {
        self.latest
            .iter()
            .map(|(p, s)| (p.clone(), s.clone()))
            .collect()
    }

    /// A file was deleted or hidden: nobody is in it any more.
    pub fn file_gone(&mut self, file: &FileId) -> Vec<(PeerId, PresenceState)> {
        let mut changed = Vec::new();
        for (peer, state) in &mut self.latest {
            if state.active.as_ref() == Some(file) {
                state.active = None;
                state.cursor = None;
                state.typing = false;
                changed.push((peer.clone(), state.clone()));
            }
        }
        changed
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn peer() -> PeerId {
        crate::PeerIdentity::generate().expect("identity").peer_id()
    }

    fn state(seq: u64) -> PresenceState {
        PresenceState {
            seq,
            active: Some(FileId::random().expect("id")),
            cursor: None,
            typing: false,
        }
    }

    #[test]
    fn older_states_are_dropped_and_newer_ones_kept() {
        let mut board = PresenceBoard::default();
        let a = peer();
        assert!(board.accept(&a, &state(2)));
        assert!(!board.accept(&a, &state(1)), "arrived late");
        assert!(!board.accept(&a, &state(2)), "a duplicate");
        assert!(board.accept(&a, &state(3)));
        assert!(board.forget(&a));
        assert!(board.accept(&a, &state(1)), "a fresh session starts again");
    }

    #[test]
    fn claims_beyond_the_narrow_shape_are_refused() {
        let json = r#"{"seq":1,"active":null,"cursor":null,"typing":false,"role":"owner"}"#;
        assert!(
            serde_json::from_str::<PresenceState>(json).is_err(),
            "a role claim invalidates the whole packet"
        );
        let json = r#"{"seq":1,"active":null,"cursor":null,"typing":false,"peer":"x"}"#;
        assert!(
            serde_json::from_str::<PresenceState>(json).is_err(),
            "so does an identity claim"
        );
        let cursor_without_file = PresenceState {
            seq: 1,
            active: None,
            cursor: Some(CursorState {
                anchor: Bytes(vec![1]),
                head: Bytes(vec![1]),
            }),
            typing: false,
        };
        assert!(cursor_without_file.validate().is_err());
        let mut huge = state(1);
        huge.cursor = Some(CursorState {
            anchor: Bytes(vec![0; MAX_POSITION_BYTES + 1]),
            head: Bytes(vec![1]),
        });
        assert!(huge.validate().is_err());
        let name = RosterEntry {
            peer: peer(),
            display_name: "a\u{0007}".into(),
            role: Role::Viewer,
            online: true,
        };
        assert!(name.validate().is_err());
    }

    #[test]
    fn a_deleted_file_clears_everyone_in_it() {
        let mut board = PresenceBoard::default();
        let (a, b) = (peer(), peer());
        let mut in_file = state(1);
        in_file.cursor = Some(CursorState {
            anchor: Bytes(vec![1]),
            head: Bytes(vec![1]),
        });
        let file = in_file.active.clone().expect("file");
        board.accept(&a, &in_file);
        board.accept(&b, &state(1));
        let cleared = board.file_gone(&file);
        assert_eq!(cleared.len(), 1);
        assert_eq!(cleared[0].1.active, None);
        assert_eq!(cleared[0].1.cursor, None);
    }
}
