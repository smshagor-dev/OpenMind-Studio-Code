//! The one place that decides whether a peer may do something in a room. The transport guard (before a remote
//! frame is acted on) and the Rust filesystem authority (before the workspace is touched) both call
//! [`authorize`], so the rules can't drift apart.
//!
//! The actor is the peer the session was *authenticated* as; its role and permissions are looked up in the Owner's
//! [`RoomState`]. A role or permission claimed in a message is never an input here — there is no parameter for it.
//!
//! Rules beyond "has the permission": nobody acts on themselves through moderation, role or permission changes;
//! a moderator acts only on lower ranks (the Owner on everyone else); a role can only be given below the giver's
//! own rank and never Owner (ownership moves only through the explicit transfer); a grant can't contain a
//! permission the giver lacks (no escalation) or an Owner-only one; a force-muted member can't speak.

use std::fmt;

use serde::Serialize;

use crate::ids::PeerId;
use crate::permission::{owner_only, Overrides, Permission, Role};
use crate::room::{Member, MemberStatus, RoomState};

/// Something a peer wants to do.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Action<'a> {
    ReadFile,
    WriteFile,
    CreateFile,
    RenameFile,
    DeleteFile,
    RenameRoom,
    SetLocked,
    SetApproval,
    SetDefaultRole(Role),
    RotateInvite,
    CloseRoom,
    TransferOwnership(&'a PeerId),
    Approve(&'a PeerId),
    DenyJoin(&'a PeerId),
    Kick(&'a PeerId),
    Remove(&'a PeerId),
    Ban(&'a PeerId),
    Unban(&'a PeerId),
    ChangeRole(&'a PeerId, Role),
    SetOverrides(&'a PeerId, &'a Overrides),
    VoiceJoin,
    VoiceSpeak,
    VoiceMuteSelf,
    ForceMute(&'a PeerId),
}

impl Action<'_> {
    /// The permission the action needs.
    pub fn required(&self) -> Permission {
        use Permission as P;
        match self {
            Action::ReadFile => P::FileRead,
            Action::WriteFile => P::FileWrite,
            Action::CreateFile => P::FileCreate,
            Action::RenameFile => P::FileRename,
            Action::DeleteFile => P::FileDelete,
            Action::RenameRoom | Action::SetApproval | Action::SetDefaultRole(_) => P::RoomManage,
            Action::SetLocked => P::RoomLock,
            Action::RotateInvite => P::RoomRotateInvite,
            Action::CloseRoom => P::RoomClose,
            Action::TransferOwnership(_) => P::RoomTransferOwnership,
            Action::Approve(_) | Action::DenyJoin(_) => P::MemberApprove,
            Action::Kick(_) => P::MemberKick,
            Action::Remove(_) => P::MemberRemove,
            Action::Ban(_) => P::MemberBan,
            Action::Unban(_) => P::MemberUnban,
            Action::ChangeRole(..) => P::MemberChangeRole,
            Action::SetOverrides(..) => P::MemberManagePermissions,
            Action::VoiceJoin => P::VoiceJoin,
            Action::VoiceSpeak => P::VoiceSpeak,
            Action::VoiceMuteSelf => P::VoiceMuteSelf,
            Action::ForceMute(_) => P::VoiceForceMute,
        }
    }
}

/// Why an action was refused.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase", tag = "reason")]
pub enum DenyReason {
    RoomClosed,
    NotAMember,
    NotActive,
    MissingPermission {
        permission: Permission,
    },
    SelfTarget,
    UnknownTarget,
    TargetOutranks,
    TargetNotActive,
    TargetNotPending,
    TargetNotBanned,
    AlreadyBanned,
    RoleNotAssignable,
    EscalatingGrant,
    OwnerOnlyPermission,
    ForceMuted,
    /// The message came on a session that is no longer current (an old connection, a replay, a kicked peer).
    StaleSession,
    /// Only the user of the app hosting the room can act without a session.
    NotHost,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub struct Denied {
    #[serde(flatten)]
    pub reason: DenyReason,
}

impl fmt::Display for Denied {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        let text = match self.reason {
            DenyReason::RoomClosed => "the room is closed",
            DenyReason::NotAMember => "you are not a member of this room",
            DenyReason::NotActive => "your membership is not active",
            DenyReason::MissingPermission { permission } => {
                return write!(f, "the permission \"{}\" is required", permission.as_str())
            }
            DenyReason::SelfTarget => "you can't do this to yourself",
            DenyReason::UnknownTarget => "that member isn't in this room",
            DenyReason::TargetOutranks => "that member's role is equal to or above yours",
            DenyReason::TargetNotActive => "that member isn't active",
            DenyReason::TargetNotPending => "that member isn't waiting for approval",
            DenyReason::TargetNotBanned => "that member isn't banned",
            DenyReason::AlreadyBanned => "that member is already banned",
            DenyReason::RoleNotAssignable => {
                "that role is equal to or above yours (ownership moves only by transfer)"
            }
            DenyReason::EscalatingGrant => "you can't grant a permission you don't have",
            DenyReason::OwnerOnlyPermission => "that permission belongs to the Owner only",
            DenyReason::ForceMuted => "a moderator has muted you",
            DenyReason::StaleSession => "this connection is no longer valid; reconnect",
            DenyReason::NotHost => "only the hosting user can do this without a session",
        };
        f.write_str(text)
    }
}

fn deny<T>(reason: DenyReason) -> Result<T, Denied> {
    Err(Denied { reason })
}

/// Decides whether `actor` may perform `action` in `room` right now.
pub fn authorize(room: &RoomState, actor: &PeerId, action: &Action<'_>) -> Result<(), Denied> {
    if room.closed {
        return deny(DenyReason::RoomClosed);
    }
    let Some(member) = room.member(actor) else {
        return deny(DenyReason::NotAMember);
    };
    if member.status != MemberStatus::Active {
        return deny(DenyReason::NotActive);
    }
    let permission = action.required();
    if !member.permissions().contains(permission) {
        return deny(DenyReason::MissingPermission { permission });
    }
    check_targets(room, member, action)
}

fn check_targets(room: &RoomState, actor: &Member, action: &Action<'_>) -> Result<(), Denied> {
    let statuses = |target: &PeerId, allowed: &[MemberStatus], reason| {
        let member = managed_target(room, actor, target)?;
        if allowed.contains(&member.status) {
            Ok(member)
        } else {
            deny(reason)
        }
    };
    use MemberStatus as S;
    match action {
        Action::Approve(t) | Action::DenyJoin(t) => {
            statuses(t, &[S::Pending], DenyReason::TargetNotPending).map(drop)
        }
        Action::Kick(t) | Action::ForceMute(t) => {
            statuses(t, &[S::Active], DenyReason::TargetNotActive).map(drop)
        }
        Action::Remove(t) => statuses(
            t,
            &[S::Active, S::Pending, S::Kicked],
            DenyReason::TargetNotActive,
        )
        .map(drop),
        Action::Ban(t) => statuses(
            t,
            &[S::Active, S::Pending, S::Kicked, S::Removed],
            DenyReason::AlreadyBanned,
        )
        .map(drop),
        Action::Unban(t) => statuses(t, &[S::Banned], DenyReason::TargetNotBanned).map(drop),
        Action::ChangeRole(t, role) => {
            statuses(t, &[S::Active, S::Pending], DenyReason::TargetNotActive)?;
            assignable(actor, *role)
        }
        Action::SetOverrides(t, overrides) => {
            statuses(t, &[S::Active, S::Pending], DenyReason::TargetNotActive)?;
            grantable(actor, overrides)
        }
        Action::TransferOwnership(t) => {
            statuses(t, &[S::Active], DenyReason::TargetNotActive).map(drop)
        }
        Action::SetDefaultRole(role) => match role {
            Role::Viewer | Role::Editor => Ok(()),
            _ => deny(DenyReason::RoleNotAssignable),
        },
        Action::VoiceSpeak if actor.force_muted => deny(DenyReason::ForceMuted),
        _ => Ok(()),
    }
}

/// The target of a moderation action: someone else, in the room, ranked below the actor (the Owner outranks all).
fn managed_target<'r>(
    room: &'r RoomState,
    actor: &Member,
    target: &PeerId,
) -> Result<&'r Member, Denied> {
    if *target == actor.peer {
        return deny(DenyReason::SelfTarget);
    }
    let Some(member) = room.member(target) else {
        return deny(DenyReason::UnknownTarget);
    };
    if member.role.rank() >= actor.role.rank() {
        return deny(DenyReason::TargetOutranks);
    }
    Ok(member)
}

fn assignable(actor: &Member, role: Role) -> Result<(), Denied> {
    if role == Role::Owner || role.rank() >= actor.role.rank() {
        return deny(DenyReason::RoleNotAssignable);
    }
    Ok(())
}

fn grantable(actor: &Member, overrides: &Overrides) -> Result<(), Denied> {
    if overrides.grant.minus(owner_only()) != overrides.grant {
        return deny(DenyReason::OwnerOnlyPermission);
    }
    if !overrides.grant.is_subset_of(actor.permissions()) {
        return deny(DenyReason::EscalatingGrant);
    }
    Ok(())
}

#[cfg(test)]
#[path = "authz_tests.rs"]
mod tests;
