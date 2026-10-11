//! The Owner's view of a room: its settings and its members. This is the only source of a peer's role and
//! permissions; nothing a peer sends can change it except through [`crate::authority::Authority`], which asks
//! [`crate::authz::authorize`] first.

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};

use crate::error::{invalid, CollabError};
use crate::identity::PublicKey;
use crate::ids::{PeerId, RoomUid};
use crate::permission::{effective, Overrides, PermissionSet, Role};

pub const MAX_DISPLAY_NAME_CHARS: usize = 64;
pub const MAX_ROOM_NAME_CHARS: usize = 80;
/// Members a room keeps (pending, banned and removed ones included).
pub const MAX_MEMBERS: usize = 500;

/// Where a member stands. Online/offline is presence, not status.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum MemberStatus {
    /// Asked to join a room that requires approval.
    Pending,
    Active,
    /// Disconnected by a moderator; can come back with the current Room Code.
    Kicked,
    /// Membership revoked (role and overrides reset); can come back with the current Room Code as a new member.
    Removed,
    /// Refused even with a valid Room Code until unbanned.
    Banned,
}

impl MemberStatus {
    pub fn as_str(self) -> &'static str {
        match self {
            MemberStatus::Pending => "pending",
            MemberStatus::Active => "active",
            MemberStatus::Kicked => "kicked",
            MemberStatus::Removed => "removed",
            MemberStatus::Banned => "banned",
        }
    }

    pub fn parse(text: &str) -> Result<Self, CollabError> {
        match text {
            "pending" => Ok(MemberStatus::Pending),
            "active" => Ok(MemberStatus::Active),
            "kicked" => Ok(MemberStatus::Kicked),
            "removed" => Ok(MemberStatus::Removed),
            "banned" => Ok(MemberStatus::Banned),
            _ => Err(invalid(
                "member status",
                format!("unknown status \"{text}\""),
            )),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Member {
    pub peer: PeerId,
    pub public_key: PublicKey,
    /// What the member calls themselves. Not an identity: two members can share one.
    pub display_name: String,
    pub role: Role,
    pub overrides: Overrides,
    pub status: MemberStatus,
    /// Muted by a moderator; speaking is refused until lifted.
    pub force_muted: bool,
    pub first_seen_ms: i64,
    pub last_seen_ms: i64,
}

impl Member {
    pub fn permissions(&self) -> PermissionSet {
        effective(self.role, &self.overrides)
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RoomState {
    pub room_uid: RoomUid,
    pub name: String,
    pub owner: PeerId,
    pub locked: bool,
    pub approval_required: bool,
    /// The role a newly admitted member gets (Viewer or Editor).
    pub default_role: Role,
    pub closed: bool,
    /// Rises with every rotation of the Room Code.
    pub invite_generation: u32,
    pub invite_hash: String,
    pub members: BTreeMap<PeerId, Member>,
}

impl RoomState {
    pub fn member(&self, peer: &PeerId) -> Option<&Member> {
        self.members.get(peer)
    }

    /// The member, only while Active.
    pub fn active_member(&self, peer: &PeerId) -> Option<&Member> {
        self.members
            .get(peer)
            .filter(|m| m.status == MemberStatus::Active)
    }

    /// What `peer` may do now: nothing unless an Active member of an open room.
    pub fn permissions_of(&self, peer: &PeerId) -> PermissionSet {
        if self.closed {
            return PermissionSet::EMPTY;
        }
        self.active_member(peer)
            .map(Member::permissions)
            .unwrap_or(PermissionSet::EMPTY)
    }
}

fn check_text(what: &'static str, text: &str, max: usize) -> Result<String, CollabError> {
    let trimmed = text.trim();
    if trimmed.is_empty() {
        return Err(invalid(what, "it can't be empty"));
    }
    if trimmed.chars().count() > max {
        return Err(invalid(what, format!("at most {max} characters")));
    }
    if trimmed
        .chars()
        .any(|c| c.is_control() || matches!(c, '\u{202a}'..='\u{202e}' | '\u{2066}'..='\u{2069}'))
    {
        return Err(invalid(
            what,
            "it contains control or direction-override characters",
        ));
    }
    Ok(trimmed.to_string())
}

/// A display name, trimmed; control and bidi-override characters refused (they could disguise one name as another).
pub fn validate_display_name(name: &str) -> Result<String, CollabError> {
    check_text("display name", name, MAX_DISPLAY_NAME_CHARS)
}

pub fn validate_room_name(name: &str) -> Result<String, CollabError> {
    check_text("room name", name, MAX_ROOM_NAME_CHARS)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn names_are_trimmed_and_checked() {
        assert_eq!(validate_display_name("  Shagor ").expect("ok"), "Shagor");
        assert!(validate_display_name("").is_err());
        assert!(validate_display_name("a\u{0007}b").is_err());
        assert!(validate_display_name("evil\u{202e}nimda").is_err());
        assert!(validate_display_name(&"x".repeat(65)).is_err());
        assert!(validate_room_name("Physics class").is_ok());
    }

    #[test]
    fn statuses_round_trip() {
        for status in [
            MemberStatus::Pending,
            MemberStatus::Active,
            MemberStatus::Kicked,
            MemberStatus::Removed,
            MemberStatus::Banned,
        ] {
            assert_eq!(MemberStatus::parse(status.as_str()).expect("parse"), status);
        }
    }
}
