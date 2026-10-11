//! What each member is told about the room: only what its own permissions entitle it to manage.

use super::*;
use crate::identity::PeerIdentity;
use crate::permission::{Overrides, PermissionSet};
use crate::testkit::{member, room, set, Cast};

fn with_waiting_and_banned(cast: &Cast) -> (RoomState, PeerId, PeerId) {
    let mut room = room(cast);
    let waiting = PeerIdentity::generate().expect("id");
    let banned = PeerIdentity::generate().expect("id");
    let mut w = member(&waiting, "Waiting", Role::Viewer);
    w.status = MemberStatus::Pending;
    let mut b = member(&banned, "Banned", Role::Viewer);
    b.status = MemberStatus::Banned;
    room.members.insert(waiting.peer_id(), w);
    room.members.insert(banned.peer_id(), b);
    (room, waiting.peer_id(), banned.peer_id())
}

fn statuses(view: &RoomView) -> Vec<MemberStatus> {
    let mut out: Vec<MemberStatus> = view.members.iter().map(|m| m.status).collect();
    out.sort_by_key(|s| s.as_str());
    out.dedup();
    out
}

#[test]
fn a_viewer_sees_the_active_members_and_its_own_standing_only() {
    let cast = Cast::new();
    let (room, ..) = with_waiting_and_banned(&cast);
    let view = RoomView::for_member(&room, &cast.viewer.peer_id(), |p| {
        *p == cast.owner.peer_id()
    })
    .expect("view");
    assert_eq!(statuses(&view), vec![MemberStatus::Active]);
    assert_eq!(view.members.len(), 4);
    assert!(view
        .members
        .iter()
        .all(|m| m.granted.is_none() && m.permissions.is_none()));
    assert_eq!(view.you.role, Role::Viewer);
    assert!(!view.you.permissions.contains(Permission::FileWrite));
    let owner = view
        .members
        .iter()
        .find(|m| m.peer == cast.owner.peer_id())
        .expect("owner");
    assert!(
        owner.online,
        "whoever the caller says is connected (the hosting user)"
    );
}

#[test]
fn an_admin_sees_waiting_members_but_not_banned_ones_or_overrides_by_default() {
    let cast = Cast::new();
    let (room, waiting, _banned) = with_waiting_and_banned(&cast);
    let view = RoomView::for_member(&room, &cast.admin.peer_id(), |p| *p == waiting).expect("view");
    assert_eq!(
        statuses(&view),
        vec![MemberStatus::Active, MemberStatus::Pending]
    );
    assert!(view.members.iter().all(|m| m.granted.is_none()));
}

#[test]
fn granted_management_permissions_widen_the_view() {
    let cast = Cast::new();
    let (mut room, ..) = with_waiting_and_banned(&cast);
    let grant = PermissionSet::of(&[Permission::MemberUnban, Permission::MemberManagePermissions]);
    set(&mut room, &cast.admin.peer_id(), |m| {
        m.overrides = Overrides {
            grant,
            deny: PermissionSet::EMPTY,
        }
    });
    let editor = cast.editor.peer_id();
    set(&mut room, &editor, |m| {
        m.overrides.deny = PermissionSet::of(&[Permission::FileWrite]);
    });
    let view = RoomView::for_member(&room, &cast.admin.peer_id(), |_| false).expect("view");
    assert!(statuses(&view).contains(&MemberStatus::Banned));
    let shown = view
        .members
        .iter()
        .find(|m| m.peer == editor)
        .expect("editor");
    assert_eq!(
        shown.denied,
        Some(PermissionSet::of(&[Permission::FileWrite]))
    );
    let effective = shown.permissions.expect("effective");
    assert!(
        !effective.contains(Permission::FileWrite),
        "the Owner's calculation, overrides applied"
    );
    assert!(effective.contains(Permission::FileRead));
}

#[test]
fn an_inactive_member_gets_no_view_and_views_round_trip_strictly() {
    let cast = Cast::new();
    let (room, waiting, banned) = with_waiting_and_banned(&cast);
    assert!(RoomView::for_member(&room, &waiting, |_| true).is_none());
    assert!(RoomView::for_member(&room, &banned, |_| true).is_none());
    let view = RoomView::for_member(&room, &cast.owner.peer_id(), |_| true).expect("view");
    assert!(view.validate().is_ok());
    let json = serde_json::to_value(&view).expect("json");
    let back: RoomView = serde_json::from_value(json.clone()).expect("parse");
    assert_eq!(back, view);
    let mut extra = json;
    extra["code"] = serde_json::json!("secret");
    assert!(
        serde_json::from_value::<RoomView>(extra).is_err(),
        "nothing unknown is accepted"
    );
}

#[test]
fn the_permission_model_lists_every_permission_once_with_its_group() {
    let model = permission_model();
    assert_eq!(model.permissions.len(), Permission::ALL.len());
    assert!(model
        .permissions
        .iter()
        .all(|p| p.name.starts_with(&format!("{}.", p.group))));
    assert!(model.owner_only.contains(Permission::RoomClose));
    let viewer = model
        .roles
        .iter()
        .find(|r| r.role == Role::Viewer)
        .expect("viewer");
    assert_eq!(viewer.defaults, Role::Viewer.defaults());
}
