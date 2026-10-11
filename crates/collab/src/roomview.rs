//! What a connected member is told about the room and its members (Milestone 24, phase 8), built by the Owner from
//! the authoritative [`RoomState`] **for that member**: everything it shows is something the member's own permissions
//! entitle it to manage, so a member's management UI is fed without ever seeing more than it may act on.
//!
//! - Everyone: the room's name and settings, the Owner, active members with their role and connection, and its own
//!   role and effective permissions (what its UI may offer; the Owner still checks every command).
//! - `member.approve`: members waiting for approval.
//! - `member.ban` / `member.unban`: banned members.
//! - `member.managePermissions`: each listed member's overrides and effective permissions.
//!
//! Nothing secret is in it: no Room Code, key, fingerprint, path or machine identity — members are named by their
//! peer id (a hash of their public key) and the name they chose.

use serde::{Deserialize, Serialize};

use crate::error::{invalid, CollabError};
use crate::ids::PeerId;
use crate::permission::{Permission, PermissionSet, Role};
use crate::presence::MAX_NAME_CHARS;
use crate::room::{MemberStatus, RoomState};

/// Members one view may list.
pub const MAX_VIEW_MEMBERS: usize = 256;

/// A member's own standing.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ViewSelf {
    pub role: Role,
    pub permissions: PermissionSet,
}

/// One member as the receiving member may see it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ViewMember {
    pub peer: PeerId,
    pub display_name: String,
    pub role: Role,
    pub status: MemberStatus,
    pub online: bool,
    /// Only for a receiver that may manage permissions.
    #[serde(default)]
    pub granted: Option<PermissionSet>,
    #[serde(default)]
    pub denied: Option<PermissionSet>,
    /// Role defaults with the overrides applied, as the Owner computes them (only with the overrides).
    #[serde(default)]
    pub permissions: Option<PermissionSet>,
}

/// The room as one member sees it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RoomView {
    pub name: String,
    pub owner: PeerId,
    pub locked: bool,
    pub approval_required: bool,
    pub default_role: Role,
    pub closed: bool,
    pub you: ViewSelf,
    pub members: Vec<ViewMember>,
}

impl RoomView {
    /// The view of `room` for `viewer` (`None` when the viewer isn't an active member). `online` says who is
    /// connected now (the hosting user included — after an ownership transfer that is no longer the Owner).
    pub fn for_member(
        room: &RoomState,
        viewer: &PeerId,
        online: impl Fn(&PeerId) -> bool,
    ) -> Option<Self> {
        let me = room
            .member(viewer)
            .filter(|m| m.status == MemberStatus::Active)?;
        let mine = me.permissions();
        let can = |p: Permission| mine.contains(p);
        let details = can(Permission::MemberManagePermissions);
        let members = room
            .members
            .values()
            .filter(|m| match m.status {
                MemberStatus::Active => true,
                MemberStatus::Pending => can(Permission::MemberApprove),
                MemberStatus::Banned => can(Permission::MemberBan) || can(Permission::MemberUnban),
                MemberStatus::Kicked | MemberStatus::Removed => false,
            })
            .take(MAX_VIEW_MEMBERS)
            .map(|m| ViewMember {
                peer: m.peer.clone(),
                display_name: m.display_name.chars().take(MAX_NAME_CHARS).collect(),
                role: m.role,
                status: m.status,
                online: online(&m.peer),
                granted: details.then_some(m.overrides.grant),
                denied: details.then_some(m.overrides.deny),
                permissions: details.then(|| m.permissions()),
            })
            .collect();
        Some(Self {
            name: room.name.clone(),
            owner: room.owner.clone(),
            locked: room.locked,
            approval_required: room.approval_required,
            default_role: room.default_role,
            closed: room.closed,
            you: ViewSelf {
                role: me.role,
                permissions: mine,
            },
            members,
        })
    }

    pub fn validate(&self) -> Result<(), CollabError> {
        if self.members.len() > MAX_VIEW_MEMBERS {
            return Err(invalid("room view", "too many members"));
        }
        crate::room::validate_room_name(&self.name)?;
        for member in &self.members {
            let name = &member.display_name;
            if name.chars().count() > MAX_NAME_CHARS || name.chars().any(char::is_control) {
                return Err(invalid("room view", "a display name is malformed"));
            }
        }
        Ok(())
    }
}

/// The permission model as data, for a management UI: every permission in the backend's order with its group, each
/// role's defaults, and what only the Owner can hold. The UI reads this instead of keeping its own list.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PermissionModel {
    pub permissions: Vec<PermissionInfo>,
    pub roles: Vec<RoleDefaults>,
    pub owner_only: PermissionSet,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PermissionInfo {
    pub name: &'static str,
    /// The part before the dot: `room`, `member`, `file`, `voice`.
    pub group: &'static str,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RoleDefaults {
    pub role: Role,
    pub defaults: PermissionSet,
}

pub fn permission_model() -> PermissionModel {
    PermissionModel {
        permissions: Permission::ALL
            .iter()
            .map(|p| PermissionInfo {
                name: p.as_str(),
                group: p.as_str().split('.').next().unwrap_or_default(),
            })
            .collect(),
        roles: [Role::Viewer, Role::Editor, Role::Admin, Role::Owner]
            .into_iter()
            .map(|role| RoleDefaults {
                role,
                defaults: role.defaults(),
            })
            .collect(),
        owner_only: crate::permission::owner_only(),
    }
}

#[cfg(test)]
#[path = "roomview_tests.rs"]
mod tests;
