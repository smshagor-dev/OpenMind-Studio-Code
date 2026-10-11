//! Test fixtures shared by the crate's unit tests: a room with one member of each role.

use std::collections::BTreeMap;

use crate::identity::PeerIdentity;
use crate::ids::{PeerId, RoomUid};
use crate::permission::{Overrides, Role};
use crate::room::{Member, MemberStatus, RoomState};

pub struct Cast {
    pub owner: PeerIdentity,
    pub admin: PeerIdentity,
    pub editor: PeerIdentity,
    pub viewer: PeerIdentity,
}

impl Cast {
    pub fn new() -> Self {
        let make = || PeerIdentity::generate().expect("identity");
        Self {
            owner: make(),
            admin: make(),
            editor: make(),
            viewer: make(),
        }
    }
}

pub fn member(identity: &PeerIdentity, name: &str, role: Role) -> Member {
    Member {
        peer: identity.peer_id(),
        public_key: identity.public_key(),
        display_name: name.into(),
        role,
        overrides: Overrides::default(),
        status: MemberStatus::Active,
        force_muted: false,
        first_seen_ms: 1,
        last_seen_ms: 1,
    }
}

/// A room with the cast as Active members.
pub fn room(cast: &Cast) -> RoomState {
    let mut members = BTreeMap::new();
    for (identity, name, role) in [
        (&cast.owner, "Owner", Role::Owner),
        (&cast.admin, "Admin", Role::Admin),
        (&cast.editor, "Editor", Role::Editor),
        (&cast.viewer, "Viewer", Role::Viewer),
    ] {
        members.insert(identity.peer_id(), member(identity, name, role));
    }
    RoomState {
        room_uid: RoomUid::random().expect("room"),
        name: "Test room".into(),
        owner: cast.owner.peer_id(),
        locked: false,
        approval_required: false,
        default_role: Role::Viewer,
        closed: false,
        invite_generation: 1,
        invite_hash: "0".repeat(64),
        members,
    }
}

pub fn set(room: &mut RoomState, peer: &PeerId, change: impl FnOnce(&mut Member)) {
    change(room.members.get_mut(peer).expect("member"));
}
