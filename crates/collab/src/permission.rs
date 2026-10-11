//! Roles and granular permissions. A role is only a set of default permissions; what a member may do is
//! `(role defaults ∪ granted) − denied`, computed by [`effective`]. The Owner always has everything and the two
//! Owner-only permissions (closing the room, transferring ownership) can never be granted to anyone else.
//!
//! Defaults (decisions recorded here so the UI and the docs say the same):
//! - **Admin**: lock, rotate the invite, approve and kick, voice moderation, and all file permissions. Removing,
//!   banning, unbanning, changing roles and editing permissions are *not* defaults: the Owner grants them explicitly.
//! - **Editor**: read, write, create and rename files, voice. Deleting files is granted separately.
//! - **Viewer**: read files, join voice and listen. Speaking is granted per member (classroom default).

use serde::{Deserialize, Serialize};

use crate::error::{invalid, CollabError};

macro_rules! permissions {
    ($($variant:ident => $name:literal,)*) => {
        /// One granular permission. The wire and database name is the dotted form (`file.write`).
        #[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
        pub enum Permission {
            $(#[serde(rename = $name)] $variant,)*
        }

        impl Permission {
            pub const ALL: &'static [Permission] = &[$(Permission::$variant,)*];

            pub fn as_str(self) -> &'static str {
                match self {
                    $(Permission::$variant => $name,)*
                }
            }

            pub fn parse(text: &str) -> Result<Self, CollabError> {
                match text {
                    $($name => Ok(Permission::$variant),)*
                    _ => Err(invalid("permission", format!("unknown permission \"{text}\""))),
                }
            }
        }
    };
}

permissions! {
    RoomManage => "room.manage",
    RoomClose => "room.close",
    RoomLock => "room.lock",
    RoomRotateInvite => "room.rotateInvite",
    RoomTransferOwnership => "room.transferOwnership",
    MemberApprove => "member.approve",
    MemberRemove => "member.remove",
    MemberKick => "member.kick",
    MemberBan => "member.ban",
    MemberUnban => "member.unban",
    MemberChangeRole => "member.changeRole",
    MemberManagePermissions => "member.managePermissions",
    FileRead => "file.read",
    FileWrite => "file.write",
    FileCreate => "file.create",
    FileRename => "file.rename",
    FileDelete => "file.delete",
    VoiceJoin => "voice.join",
    VoiceSpeak => "voice.speak",
    VoiceMuteSelf => "voice.muteSelf",
    VoiceManageMembers => "voice.manageMembers",
    VoiceForceMute => "voice.forceMute",
}

impl Permission {
    fn bit(self) -> u32 {
        1 << (self as u32)
    }
}

/// A set of permissions. Serialized as the sorted list of their names (stable whatever order the enum has).
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Hash)]
pub struct PermissionSet(u32);

impl PermissionSet {
    pub const EMPTY: PermissionSet = PermissionSet(0);

    pub fn of(permissions: &[Permission]) -> Self {
        permissions.iter().fold(Self::EMPTY, |set, p| set.with(*p))
    }

    pub fn all() -> Self {
        Self::of(Permission::ALL)
    }

    pub fn with(self, permission: Permission) -> Self {
        Self(self.0 | permission.bit())
    }

    pub fn contains(self, permission: Permission) -> bool {
        self.0 & permission.bit() != 0
    }

    pub fn union(self, other: Self) -> Self {
        Self(self.0 | other.0)
    }

    pub fn minus(self, other: Self) -> Self {
        Self(self.0 & !other.0)
    }

    pub fn is_subset_of(self, other: Self) -> bool {
        self.0 & !other.0 == 0
    }

    pub fn is_empty(self) -> bool {
        self.0 == 0
    }

    pub fn iter(self) -> impl Iterator<Item = Permission> {
        Permission::ALL
            .iter()
            .copied()
            .filter(move |p| self.contains(*p))
    }

    pub fn names(self) -> Vec<&'static str> {
        let mut names: Vec<&'static str> = self.iter().map(Permission::as_str).collect();
        names.sort_unstable();
        names
    }

    /// Parses a list of names (an unknown name is refused, so a stored or received set can't be guessed at).
    pub fn parse_names<S: AsRef<str>>(names: &[S]) -> Result<Self, CollabError> {
        names.iter().try_fold(Self::EMPTY, |set, name| {
            Ok(set.with(Permission::parse(name.as_ref())?))
        })
    }
}

impl Serialize for PermissionSet {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        self.names().serialize(serializer)
    }
}

impl<'de> Deserialize<'de> for PermissionSet {
    fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        let names = Vec::<String>::deserialize(deserializer)?;
        if names.len() > Permission::ALL.len() * 2 {
            return Err(serde::de::Error::custom("too many permissions"));
        }
        Self::parse_names(&names).map_err(serde::de::Error::custom)
    }
}

/// Permissions only the Owner can ever hold.
pub fn owner_only() -> PermissionSet {
    PermissionSet::of(&[Permission::RoomClose, Permission::RoomTransferOwnership])
}

/// A role. Higher ranks manage lower ones; nobody manages their own rank or above.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Role {
    Viewer,
    Editor,
    Admin,
    Owner,
}

impl Role {
    pub fn rank(self) -> u8 {
        self as u8
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Role::Viewer => "viewer",
            Role::Editor => "editor",
            Role::Admin => "admin",
            Role::Owner => "owner",
        }
    }

    pub fn parse(text: &str) -> Result<Self, CollabError> {
        match text {
            "viewer" => Ok(Role::Viewer),
            "editor" => Ok(Role::Editor),
            "admin" => Ok(Role::Admin),
            "owner" => Ok(Role::Owner),
            _ => Err(invalid("role", format!("unknown role \"{text}\""))),
        }
    }

    /// The role's default permissions (see the module documentation).
    pub fn defaults(self) -> PermissionSet {
        use Permission::*;
        let files = [FileRead, FileWrite, FileCreate, FileRename, FileDelete];
        let voice = [VoiceJoin, VoiceSpeak, VoiceMuteSelf];
        match self {
            Role::Owner => PermissionSet::all(),
            Role::Admin => PermissionSet::of(&files)
                .union(PermissionSet::of(&voice))
                .union(PermissionSet::of(&[
                    RoomLock,
                    RoomRotateInvite,
                    MemberApprove,
                    MemberKick,
                    VoiceManageMembers,
                    VoiceForceMute,
                ])),
            Role::Editor => PermissionSet::of(&[FileRead, FileWrite, FileCreate, FileRename])
                .union(PermissionSet::of(&voice)),
            Role::Viewer => PermissionSet::of(&[FileRead, VoiceJoin, VoiceMuteSelf]),
        }
    }
}

/// A member's adjustments to their role's defaults.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Overrides {
    #[serde(default)]
    pub grant: PermissionSet,
    #[serde(default)]
    pub deny: PermissionSet,
}

impl Overrides {
    pub fn is_empty(&self) -> bool {
        self.grant.is_empty() && self.deny.is_empty()
    }
}

/// What a member with `role` and `overrides` may do. The Owner keeps everything; nobody else gets an Owner-only
/// permission, whatever the overrides say.
pub fn effective(role: Role, overrides: &Overrides) -> PermissionSet {
    if role == Role::Owner {
        return PermissionSet::all();
    }
    role.defaults()
        .union(overrides.grant)
        .minus(overrides.deny)
        .minus(owner_only())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn names_round_trip_and_unknown_names_fail() {
        for p in Permission::ALL {
            assert_eq!(Permission::parse(p.as_str()).expect("parse"), *p);
        }
        assert!(Permission::parse("file.everything").is_err());
        let set = PermissionSet::of(&[Permission::FileWrite, Permission::FileRead]);
        let json = serde_json::to_string(&set).expect("serialize");
        assert_eq!(json, r#"["file.read","file.write"]"#);
        assert_eq!(
            serde_json::from_str::<PermissionSet>(&json).expect("parse"),
            set
        );
        assert!(serde_json::from_str::<PermissionSet>(r#"["root"]"#).is_err());
    }

    #[test]
    fn role_defaults_follow_the_documented_rules() {
        assert!(Role::Viewer.defaults().contains(Permission::FileRead));
        assert!(!Role::Viewer.defaults().contains(Permission::FileWrite));
        assert!(!Role::Viewer.defaults().contains(Permission::VoiceSpeak));
        assert!(Role::Editor.defaults().contains(Permission::FileWrite));
        assert!(!Role::Editor.defaults().contains(Permission::FileDelete));
        assert!(!Role::Admin
            .defaults()
            .contains(Permission::MemberChangeRole));
        assert!(!Role::Admin.defaults().contains(Permission::RoomClose));
        assert_eq!(Role::Owner.defaults(), PermissionSet::all());
        assert!(Role::Viewer < Role::Editor && Role::Admin < Role::Owner);
    }

    #[test]
    fn overrides_grant_and_deny_but_never_owner_only() {
        let editor_a = Overrides {
            grant: PermissionSet::EMPTY,
            deny: PermissionSet::of(&[Permission::FileDelete]),
        };
        assert!(!effective(Role::Editor, &editor_a).contains(Permission::FileDelete));
        let viewer = Overrides {
            grant: PermissionSet::of(&[Permission::VoiceSpeak, Permission::RoomClose]),
            deny: PermissionSet::EMPTY,
        };
        let set = effective(Role::Viewer, &viewer);
        assert!(set.contains(Permission::VoiceSpeak));
        assert!(!set.contains(Permission::RoomClose));
        assert!(!set.contains(Permission::FileWrite));
        let deny_all = Overrides {
            grant: PermissionSet::EMPTY,
            deny: PermissionSet::all(),
        };
        assert_eq!(effective(Role::Owner, &deny_all), PermissionSet::all());
    }
}
