//! Room management on the Owner's machine (Milestone 24, phase 8): what each connected member is told about the room
//! (a [`RoomView`] filtered by that member's own permissions) and what a peer waiting for approval hears when it is
//! turned down. Every decision itself is the authority's ([`openmind_collab::Authority::execute`]).

use openmind_collab::protocol::Refusal;
use openmind_collab::room::{MemberStatus, RoomState};
use openmind_collab::roomview::RoomView;
use openmind_collab::{Command, PeerId};

use super::CollabRuntime;

/// A command that turns down a peer still waiting for approval: the refusal it is told before its connection closes.
pub(super) fn refusal(room: &RoomState, command: &Command) -> Option<(PeerId, Refusal)> {
    let (target, refusal) = match command {
        Command::DenyJoin { target } | Command::Remove { target } => (target, Refusal::Denied),
        Command::Ban { target } => (target, Refusal::Banned),
        _ => return None,
    };
    room.member(target)
        .filter(|m| m.status == MemberStatus::Pending)
        .map(|_| (target.clone(), refusal))
}

impl CollabRuntime {
    /// The room as `peer` may see it (`None`: not hosted here, or `peer` isn't an active member).
    pub async fn room_view(&self, room: &str, peer: &PeerId) -> Option<RoomView> {
        let rooms = self.rooms.lock().await;
        let authority = &rooms.get(room)?.authority;
        let host = authority.host_identity().peer_id();
        RoomView::for_member(authority.room(), peer, |p| {
            *p == host || authority.session_of(p).is_some()
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use openmind_collab::identity::PeerIdentity;
    use openmind_collab::permission::Role;
    use openmind_collab::room::Member;

    fn room_with(status: MemberStatus) -> (RoomState, PeerId) {
        let owner = PeerIdentity::generate().expect("id");
        let other = PeerIdentity::generate().expect("id");
        let member = |id: &PeerIdentity, role, status| Member {
            peer: id.peer_id(),
            public_key: id.public_key(),
            display_name: "x".into(),
            role,
            overrides: Default::default(),
            status,
            force_muted: false,
            first_seen_ms: 0,
            last_seen_ms: 0,
        };
        let members = [
            (
                owner.peer_id(),
                member(&owner, Role::Owner, MemberStatus::Active),
            ),
            (other.peer_id(), member(&other, Role::Viewer, status)),
        ]
        .into_iter()
        .collect();
        let room = RoomState {
            room_uid: openmind_collab::RoomUid::random().expect("uid"),
            name: "R".into(),
            owner: owner.peer_id(),
            locked: false,
            approval_required: true,
            default_role: Role::Viewer,
            closed: false,
            invite_generation: 1,
            invite_hash: String::new(),
            members,
        };
        (room, other.peer_id())
    }

    #[test]
    fn only_a_waiting_peer_is_told_it_was_turned_down() {
        let (room, peer) = room_with(MemberStatus::Pending);
        let deny = Command::DenyJoin {
            target: peer.clone(),
        };
        assert_eq!(refusal(&room, &deny), Some((peer.clone(), Refusal::Denied)));
        let ban = Command::Ban {
            target: peer.clone(),
        };
        assert_eq!(refusal(&room, &ban), Some((peer.clone(), Refusal::Banned)));
        let kick = Command::Kick {
            target: peer.clone(),
        };
        assert_eq!(refusal(&room, &kick), None);
        let (active, peer) = room_with(MemberStatus::Active);
        assert_eq!(
            refusal(&active, &Command::Ban { target: peer }),
            None,
            "a session ends instead"
        );
    }
}

#[cfg(test)]
#[path = "manage_tests.rs"]
mod audit_tests;
