//! Authorization rules, including what a malicious client tries.

use super::*;
use crate::identity::PeerIdentity;
use crate::permission::PermissionSet;
use crate::testkit::{room, set, Cast};

fn reason(result: Result<(), Denied>) -> DenyReason {
    result.expect_err("expected a refusal").reason
}

fn missing(permission: Permission) -> DenyReason {
    DenyReason::MissingPermission { permission }
}

#[test]
fn a_viewer_can_read_but_never_change_files() {
    let cast = Cast::new();
    let room = room(&cast);
    let viewer = cast.viewer.peer_id();
    assert!(authorize(&room, &viewer, &Action::ReadFile).is_ok());
    for (action, permission) in [
        (Action::WriteFile, Permission::FileWrite),
        (Action::CreateFile, Permission::FileCreate),
        (Action::RenameFile, Permission::FileRename),
        (Action::DeleteFile, Permission::FileDelete),
    ] {
        assert_eq!(
            reason(authorize(&room, &viewer, &action)),
            missing(permission)
        );
    }
}

#[test]
fn a_viewer_can_not_manage_anyone_or_themselves() {
    let cast = Cast::new();
    let room = room(&cast);
    let viewer = cast.viewer.peer_id();
    let editor = cast.editor.peer_id();
    let grant_all = Overrides {
        grant: PermissionSet::all(),
        deny: PermissionSet::EMPTY,
    };
    for action in [
        Action::ChangeRole(&viewer, Role::Editor),
        Action::ChangeRole(&viewer, Role::Owner),
        Action::SetOverrides(&viewer, &grant_all),
        Action::ChangeRole(&editor, Role::Viewer),
        Action::Kick(&editor),
        Action::Ban(&editor),
        Action::SetLocked,
        Action::RotateInvite,
        Action::CloseRoom,
        Action::TransferOwnership(&viewer),
    ] {
        assert!(
            matches!(
                reason(authorize(&room, &viewer, &action)),
                DenyReason::MissingPermission { .. }
            ),
            "{action:?}"
        );
    }
}

#[test]
fn a_non_member_or_unknown_key_gets_nothing() {
    let cast = Cast::new();
    let room = room(&cast);
    let stranger = PeerIdentity::generate().expect("identity").peer_id();
    assert_eq!(
        reason(authorize(&room, &stranger, &Action::ReadFile)),
        DenyReason::NotAMember
    );
}

#[test]
fn inactive_members_and_closed_rooms_get_nothing() {
    let cast = Cast::new();
    let mut room = room(&cast);
    let editor = cast.editor.peer_id();
    for status in [
        MemberStatus::Pending,
        MemberStatus::Kicked,
        MemberStatus::Removed,
        MemberStatus::Banned,
    ] {
        set(&mut room, &editor, |m| m.status = status);
        assert_eq!(
            reason(authorize(&room, &editor, &Action::ReadFile)),
            DenyReason::NotActive
        );
    }
    room.closed = true;
    let owner = cast.owner.peer_id();
    assert_eq!(
        reason(authorize(&room, &owner, &Action::ReadFile)),
        DenyReason::RoomClosed
    );
}

#[test]
fn editor_restrictions_follow_overrides() {
    let cast = Cast::new();
    let mut room = room(&cast);
    let editor = cast.editor.peer_id();
    assert!(authorize(&room, &editor, &Action::WriteFile).is_ok());
    assert_eq!(
        reason(authorize(&room, &editor, &Action::DeleteFile)),
        missing(Permission::FileDelete)
    );
    set(&mut room, &editor, |m| {
        m.overrides.grant = PermissionSet::of(&[Permission::FileDelete]);
        m.overrides.deny = PermissionSet::of(&[Permission::FileCreate]);
    });
    assert!(authorize(&room, &editor, &Action::DeleteFile).is_ok());
    assert_eq!(
        reason(authorize(&room, &editor, &Action::CreateFile)),
        missing(Permission::FileCreate)
    );
    let viewer = cast.viewer.peer_id();
    assert_eq!(
        reason(authorize(&room, &editor, &Action::Kick(&viewer))),
        missing(Permission::MemberKick)
    );
}

#[test]
fn moderators_act_only_below_their_rank() {
    let cast = Cast::new();
    let mut room = room(&cast);
    let (owner, admin, editor) = (
        cast.owner.peer_id(),
        cast.admin.peer_id(),
        cast.editor.peer_id(),
    );
    assert!(authorize(&room, &admin, &Action::Kick(&editor)).is_ok());
    assert_eq!(
        reason(authorize(&room, &admin, &Action::Kick(&owner))),
        DenyReason::TargetOutranks
    );
    assert_eq!(
        reason(authorize(&room, &admin, &Action::Kick(&admin))),
        DenyReason::SelfTarget
    );
    // A second Admin can't kick the first one.
    let other = PeerIdentity::generate().expect("identity");
    room.members.insert(
        other.peer_id(),
        crate::testkit::member(&other, "Admin 2", Role::Admin),
    );
    assert_eq!(
        reason(authorize(&room, &other.peer_id(), &Action::Kick(&admin))),
        DenyReason::TargetOutranks
    );
    assert!(authorize(&room, &owner, &Action::Kick(&admin)).is_ok());
    assert_eq!(
        reason(authorize(&room, &owner, &Action::Kick(&owner))),
        DenyReason::SelfTarget
    );
}

#[test]
fn admins_need_explicit_grants_for_roles_and_bans() {
    let cast = Cast::new();
    let mut room = room(&cast);
    let (admin, viewer) = (cast.admin.peer_id(), cast.viewer.peer_id());
    assert_eq!(
        reason(authorize(
            &room,
            &admin,
            &Action::ChangeRole(&viewer, Role::Editor)
        )),
        missing(Permission::MemberChangeRole)
    );
    assert_eq!(
        reason(authorize(&room, &admin, &Action::Ban(&viewer))),
        missing(Permission::MemberBan)
    );
    set(&mut room, &admin, |m| {
        m.overrides.grant =
            PermissionSet::of(&[Permission::MemberChangeRole, Permission::MemberBan]);
    });
    assert!(authorize(&room, &admin, &Action::ChangeRole(&viewer, Role::Editor)).is_ok());
    assert!(authorize(&room, &admin, &Action::Ban(&viewer)).is_ok());
    assert_eq!(
        reason(authorize(
            &room,
            &admin,
            &Action::ChangeRole(&viewer, Role::Admin)
        )),
        DenyReason::RoleNotAssignable
    );
}

#[test]
fn nobody_can_be_made_owner_except_by_transfer() {
    let cast = Cast::new();
    let room = room(&cast);
    let (owner, admin) = (cast.owner.peer_id(), cast.admin.peer_id());
    assert_eq!(
        reason(authorize(
            &room,
            &owner,
            &Action::ChangeRole(&admin, Role::Owner)
        )),
        DenyReason::RoleNotAssignable
    );
    assert!(authorize(&room, &owner, &Action::ChangeRole(&admin, Role::Viewer)).is_ok());
    assert!(authorize(&room, &owner, &Action::TransferOwnership(&admin)).is_ok());
    assert_eq!(
        reason(authorize(&room, &admin, &Action::TransferOwnership(&admin))),
        missing(Permission::RoomTransferOwnership)
    );
}

#[test]
fn grants_can_not_escalate_or_include_owner_only_permissions() {
    let cast = Cast::new();
    let mut room = room(&cast);
    let (owner, admin, editor) = (
        cast.owner.peer_id(),
        cast.admin.peer_id(),
        cast.editor.peer_id(),
    );
    set(&mut room, &admin, |m| {
        m.overrides.grant = PermissionSet::of(&[Permission::MemberManagePermissions])
    });
    let ok = Overrides {
        grant: PermissionSet::of(&[Permission::FileDelete]),
        deny: PermissionSet::EMPTY,
    };
    assert!(authorize(&room, &admin, &Action::SetOverrides(&editor, &ok)).is_ok());
    let escalate = Overrides {
        grant: PermissionSet::of(&[Permission::MemberBan]),
        deny: PermissionSet::EMPTY,
    };
    assert_eq!(
        reason(authorize(
            &room,
            &admin,
            &Action::SetOverrides(&editor, &escalate)
        )),
        DenyReason::EscalatingGrant
    );
    let owner_only = Overrides {
        grant: PermissionSet::of(&[Permission::RoomClose]),
        deny: PermissionSet::EMPTY,
    };
    assert_eq!(
        reason(authorize(
            &room,
            &owner,
            &Action::SetOverrides(&admin, &owner_only)
        )),
        DenyReason::OwnerOnlyPermission
    );
    assert_eq!(
        reason(authorize(&room, &admin, &Action::SetOverrides(&admin, &ok))),
        DenyReason::SelfTarget
    );
}

#[test]
fn a_demoted_admin_loses_management_at_once() {
    let cast = Cast::new();
    let mut room = room(&cast);
    let (admin, viewer) = (cast.admin.peer_id(), cast.viewer.peer_id());
    assert!(authorize(&room, &admin, &Action::Kick(&viewer)).is_ok());
    set(&mut room, &admin, |m| m.role = Role::Editor);
    assert_eq!(
        reason(authorize(&room, &admin, &Action::Kick(&viewer))),
        missing(Permission::MemberKick)
    );
}

#[test]
fn target_status_rules() {
    let cast = Cast::new();
    let mut room = room(&cast);
    let (owner, viewer) = (cast.owner.peer_id(), cast.viewer.peer_id());
    assert_eq!(
        reason(authorize(&room, &owner, &Action::Approve(&viewer))),
        DenyReason::TargetNotPending
    );
    assert_eq!(
        reason(authorize(&room, &owner, &Action::Unban(&viewer))),
        DenyReason::TargetNotBanned
    );
    set(&mut room, &viewer, |m| m.status = MemberStatus::Banned);
    assert_eq!(
        reason(authorize(&room, &owner, &Action::Ban(&viewer))),
        DenyReason::AlreadyBanned
    );
    assert!(authorize(&room, &owner, &Action::Unban(&viewer)).is_ok());
    let ghost = PeerIdentity::generate().expect("identity").peer_id();
    assert_eq!(
        reason(authorize(&room, &owner, &Action::Kick(&ghost))),
        DenyReason::UnknownTarget
    );
}

#[test]
fn voice_rules() {
    let cast = Cast::new();
    let mut room = room(&cast);
    let (admin, editor, viewer) = (
        cast.admin.peer_id(),
        cast.editor.peer_id(),
        cast.viewer.peer_id(),
    );
    assert!(authorize(&room, &viewer, &Action::VoiceJoin).is_ok());
    assert_eq!(
        reason(authorize(&room, &viewer, &Action::VoiceSpeak)),
        missing(Permission::VoiceSpeak)
    );
    set(&mut room, &viewer, |m| {
        m.overrides.grant = PermissionSet::of(&[Permission::VoiceSpeak])
    });
    assert!(authorize(&room, &viewer, &Action::VoiceSpeak).is_ok());
    assert!(authorize(&room, &admin, &Action::ForceMute(&editor)).is_ok());
    set(&mut room, &editor, |m| m.force_muted = true);
    assert_eq!(
        reason(authorize(&room, &editor, &Action::VoiceSpeak)),
        DenyReason::ForceMuted
    );
    assert_eq!(
        reason(authorize(&room, &editor, &Action::ForceMute(&admin))),
        missing(Permission::VoiceForceMute)
    );
}

#[test]
fn default_role_is_limited_to_viewer_or_editor() {
    let cast = Cast::new();
    let room = room(&cast);
    let owner = cast.owner.peer_id();
    assert!(authorize(&room, &owner, &Action::SetDefaultRole(Role::Editor)).is_ok());
    assert_eq!(
        reason(authorize(
            &room,
            &owner,
            &Action::SetDefaultRole(Role::Admin)
        )),
        DenyReason::RoleNotAssignable
    );
}
