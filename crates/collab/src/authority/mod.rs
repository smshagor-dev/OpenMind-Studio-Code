//! The Owner's authority over one room: the only code that changes a [`RoomState`]. Every change is
//! [`authorize`]d for the actor first, applied, and recorded as signed, chained [`AuditEvent`]s the caller
//! persists. Nothing here does I/O; the app persists the returned [`Outcome`] (and the networking layer delivers
//! it), which keeps this usable from a dedicated sidecar later.
//!
//! An [`Actor`] is either the hosting app's own user (no session; must be the identity hosting the room) or a
//! remote peer with the session it was admitted with — a frame from an older session is refused
//! ([`DenyReason::StaleSession`]), so a kicked, banned or reconnected peer's old connection can't act.

mod join;

use std::collections::{BTreeMap, HashMap};

use serde::{Deserialize, Serialize};

use crate::audit::{AuditChain, AuditEvent, ChainHead, EventDraft, EventKind};
use crate::authz::{authorize, Action, Denied, DenyReason};
use crate::code::RoomCode;
use crate::error::{invalid, CollabError};
use crate::files::RelPath;
use crate::identity::PeerIdentity;
use crate::ids::{FileId, PeerId, RoomUid, SessionId};
use crate::permission::{Overrides, Role};
use crate::room::{validate_display_name, validate_room_name, Member, MemberStatus, RoomState};

pub use join::JoinOutcome;

/// A change to the room or its members. Also the body of a remote `command` frame — it names *what* to do, never
/// who may do it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(
    tag = "command",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum Command {
    RenameRoom {
        name: String,
    },
    SetLocked {
        locked: bool,
    },
    SetApproval {
        required: bool,
    },
    SetDefaultRole {
        role: Role,
    },
    RotateInvite,
    CloseRoom,
    TransferOwnership {
        target: PeerId,
    },
    Approve {
        target: PeerId,
    },
    DenyJoin {
        target: PeerId,
    },
    Kick {
        target: PeerId,
    },
    Remove {
        target: PeerId,
    },
    Ban {
        target: PeerId,
    },
    Unban {
        target: PeerId,
    },
    ChangeRole {
        target: PeerId,
        role: Role,
    },
    SetOverrides {
        target: PeerId,
        overrides: Overrides,
    },
    ForceMute {
        target: PeerId,
        muted: bool,
    },
}

impl Command {
    pub fn action(&self) -> Action<'_> {
        match self {
            Command::RenameRoom { .. } => Action::RenameRoom,
            Command::SetLocked { .. } => Action::SetLocked,
            Command::SetApproval { .. } => Action::SetApproval,
            Command::SetDefaultRole { role } => Action::SetDefaultRole(*role),
            Command::RotateInvite => Action::RotateInvite,
            Command::CloseRoom => Action::CloseRoom,
            Command::TransferOwnership { target } => Action::TransferOwnership(target),
            Command::Approve { target } => Action::Approve(target),
            Command::DenyJoin { target } => Action::DenyJoin(target),
            Command::Kick { target } => Action::Kick(target),
            Command::Remove { target } => Action::Remove(target),
            Command::Ban { target } => Action::Ban(target),
            Command::Unban { target } => Action::Unban(target),
            Command::ChangeRole { target, role } => Action::ChangeRole(target, *role),
            Command::SetOverrides { target, overrides } => Action::SetOverrides(target, overrides),
            Command::ForceMute { target, .. } => Action::ForceMute(target),
        }
    }

    /// Field checks that don't need the room (run when a frame is decoded, again when executed).
    pub fn validate(&self) -> Result<(), CollabError> {
        if let Command::RenameRoom { name } = self {
            validate_room_name(name)?;
        }
        Ok(())
    }
}

/// Who is acting.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Actor {
    /// The user of the app hosting the room.
    Host(PeerId),
    /// A remote peer, with the session it was admitted with.
    Remote { peer: PeerId, session: SessionId },
}

impl Actor {
    pub fn peer(&self) -> &PeerId {
        match self {
            Actor::Host(peer) | Actor::Remote { peer, .. } => peer,
        }
    }

    fn session(&self) -> Option<SessionId> {
        match self {
            Actor::Host(_) => None,
            Actor::Remote { session, .. } => Some(session.clone()),
        }
    }
}

/// What an operation changed, for the caller to persist and deliver.
#[derive(Debug, Default)]
pub struct Outcome {
    pub events: Vec<AuditEvent>,
    /// A rotated Room Code (the caller stores it protected and shows it to the host only).
    pub new_invite: Option<RoomCode>,
    /// Sessions that started (admissions), with the role the peer was admitted with.
    pub started_sessions: Vec<(PeerId, SessionId, Role)>,
    /// Sessions that ended (their connections must be closed).
    pub ended_sessions: Vec<(PeerId, SessionId)>,
    /// Members whose stored record changed.
    pub changed_members: Vec<PeerId>,
    /// Whether the room's own settings changed.
    pub room_changed: bool,
}

/// One room's authority (held by the app hosting the room).
pub struct Authority {
    host: PeerIdentity,
    room: RoomState,
    invite: RoomCode,
    chain: AuditChain,
    sessions: HashMap<PeerId, SessionId>,
}

impl Authority {
    /// Creates a room owned by `host`.
    pub fn create(
        host: PeerIdentity,
        host_name: &str,
        room_name: &str,
        now_ms: i64,
    ) -> Result<(Self, Outcome), CollabError> {
        let name = validate_room_name(room_name)?;
        let display_name = validate_display_name(host_name)?;
        let invite = RoomCode::generate()?;
        let room_uid = RoomUid::random()?;
        let owner = Member {
            peer: host.peer_id(),
            public_key: host.public_key(),
            display_name,
            role: Role::Owner,
            overrides: Overrides::default(),
            status: MemberStatus::Active,
            force_muted: false,
            first_seen_ms: now_ms,
            last_seen_ms: now_ms,
        };
        let room = RoomState {
            room_uid: room_uid.clone(),
            name: name.clone(),
            owner: host.peer_id(),
            locked: false,
            approval_required: false,
            default_role: Role::Viewer,
            closed: false,
            invite_generation: 1,
            invite_hash: invite.invite_hash(),
            members: BTreeMap::from([(host.peer_id(), owner)]),
        };
        let mut authority = Self {
            room,
            invite,
            chain: AuditChain::new(room_uid, ChainHead::genesis()),
            sessions: HashMap::new(),
            host,
        };
        let mut outcome = Outcome {
            room_changed: true,
            changed_members: vec![authority.host.peer_id()],
            ..Outcome::default()
        };
        let actor = Actor::Host(authority.host.peer_id());
        authority.emit(
            &mut outcome,
            &actor,
            EventKind::RoomCreated,
            meta([("name", name)]),
            now_ms,
        )?;
        Ok((authority, outcome))
    }

    /// Restores a room from storage. The stored invite must match the stored hash and the host must be a member.
    pub fn restore(
        host: PeerIdentity,
        room: RoomState,
        invite: RoomCode,
        head: ChainHead,
    ) -> Result<Self, CollabError> {
        if invite.invite_hash() != room.invite_hash {
            return Err(invalid(
                "stored room",
                "the stored Room Code doesn't match its hash",
            ));
        }
        if room.member(&host.peer_id()).is_none() {
            return Err(invalid(
                "stored room",
                "this identity isn't a member of the room",
            ));
        }
        let chain = AuditChain::new(room.room_uid.clone(), head);
        Ok(Self {
            host,
            room,
            invite,
            chain,
            sessions: HashMap::new(),
        })
    }

    pub fn room(&self) -> &RoomState {
        &self.room
    }

    pub fn invite(&self) -> &RoomCode {
        &self.invite
    }

    pub fn host_identity(&self) -> &PeerIdentity {
        &self.host
    }

    pub fn chain_head(&self) -> &ChainHead {
        self.chain.head()
    }

    /// The session currently admitted for `peer`.
    pub fn session_of(&self, peer: &PeerId) -> Option<&SessionId> {
        self.sessions.get(peer)
    }

    /// Checks that `actor` may act at all (its session is current; a host actor is the host) and then `action`.
    pub fn authorize(&self, actor: &Actor, action: &Action<'_>) -> Result<(), Denied> {
        self.check_actor(actor)?;
        authorize(&self.room, actor.peer(), action)
    }

    fn check_actor(&self, actor: &Actor) -> Result<(), Denied> {
        let current = match actor {
            Actor::Host(peer) => *peer == self.host.peer_id(),
            Actor::Remote { peer, session } => {
                *peer != self.host.peer_id() && self.sessions.get(peer) == Some(session)
            }
        };
        if current {
            return Ok(());
        }
        Err(Denied {
            reason: match actor {
                Actor::Host(_) => DenyReason::NotHost,
                Actor::Remote { .. } => DenyReason::StaleSession,
            },
        })
    }

    /// Executes a room or membership change for `actor`.
    pub fn execute(
        &mut self,
        actor: &Actor,
        command: Command,
        now_ms: i64,
    ) -> Result<Outcome, CollabError> {
        command.validate()?;
        self.authorize(actor, &command.action())?;
        let mut outcome = Outcome::default();
        self.apply(actor, command, &mut outcome, now_ms)?;
        Ok(outcome)
    }

    fn apply(
        &mut self,
        actor: &Actor,
        command: Command,
        out: &mut Outcome,
        now: i64,
    ) -> Result<(), CollabError> {
        match command {
            Command::RenameRoom { name } => {
                let name = validate_room_name(&name)?;
                self.room.name = name.clone();
                self.room_event(
                    out,
                    actor,
                    EventKind::RoomRenamed,
                    meta([("name", name)]),
                    now,
                )
            }
            Command::SetLocked { locked } => {
                self.room.locked = locked;
                let kind = if locked {
                    EventKind::RoomLocked
                } else {
                    EventKind::RoomUnlocked
                };
                self.room_event(out, actor, kind, BTreeMap::new(), now)
            }
            Command::SetApproval { required } => {
                self.room.approval_required = required;
                let data = meta([("required", required.to_string())]);
                self.room_event(out, actor, EventKind::ApprovalChanged, data, now)
            }
            Command::SetDefaultRole { role } => {
                self.room.default_role = role;
                let data = meta([("role", role.as_str().to_string())]);
                self.room_event(out, actor, EventKind::DefaultRoleChanged, data, now)
            }
            Command::RotateInvite => self.rotate(actor, out, now),
            Command::CloseRoom => self.close(actor, out, now),
            Command::TransferOwnership { target } => self.transfer(actor, &target, out, now),
            other => self.apply_member(actor, other, out, now),
        }
    }

    fn apply_member(
        &mut self,
        actor: &Actor,
        command: Command,
        out: &mut Outcome,
        now: i64,
    ) -> Result<(), CollabError> {
        use MemberStatus as S;
        let (target, kind, data, end) = match command {
            Command::Approve { target } => {
                self.edit(&target, |m| m.status = S::Active);
                (target, EventKind::JoinApproved, BTreeMap::new(), false)
            }
            Command::DenyJoin { target } => {
                self.edit(&target, |m| m.status = S::Removed);
                (target, EventKind::JoinDenied, BTreeMap::new(), false)
            }
            Command::Kick { target } => {
                self.edit(&target, |m| m.status = S::Kicked);
                (target, EventKind::MemberKicked, BTreeMap::new(), true)
            }
            Command::Remove { target } => {
                let default_role = self.room.default_role;
                self.edit(&target, |m| {
                    m.status = S::Removed;
                    m.role = default_role;
                    m.overrides = Overrides::default();
                });
                (target, EventKind::MemberRemoved, BTreeMap::new(), true)
            }
            Command::Ban { target } => {
                self.edit(&target, |m| m.status = S::Banned);
                (target, EventKind::MemberBanned, BTreeMap::new(), true)
            }
            Command::Unban { target } => {
                self.edit(&target, |m| m.status = S::Removed);
                (target, EventKind::MemberUnbanned, BTreeMap::new(), false)
            }
            Command::ChangeRole { target, role } => {
                let from = self
                    .room
                    .member(&target)
                    .map(|m| m.role.as_str())
                    .unwrap_or("");
                let data = meta([
                    ("from", from.to_string()),
                    ("to", role.as_str().to_string()),
                ]);
                self.edit(&target, |m| m.role = role);
                (target, EventKind::RoleChanged, data, false)
            }
            Command::SetOverrides { target, overrides } => {
                let data = meta([
                    ("grant", overrides.grant.names().join(",")),
                    ("deny", overrides.deny.names().join(",")),
                ]);
                self.edit(&target, |m| m.overrides = overrides);
                (target, EventKind::PermissionsChanged, data, false)
            }
            Command::ForceMute { target, muted } => {
                self.edit(&target, |m| m.force_muted = muted);
                let kind = if muted {
                    EventKind::VoiceForceMuted
                } else {
                    EventKind::VoiceForceUnmuted
                };
                (target, kind, BTreeMap::new(), false)
            }
            _ => return Err(invalid("command", "not a member command")),
        };
        if end {
            self.end_session_of(&target, out);
        }
        out.changed_members.push(target.clone());
        let mut data = data;
        data.insert("target".into(), target.to_string());
        self.emit(out, actor, kind, data, now)
    }

    fn rotate(&mut self, actor: &Actor, out: &mut Outcome, now: i64) -> Result<(), CollabError> {
        let invite = RoomCode::generate()?;
        self.room.invite_hash = invite.invite_hash();
        self.room.invite_generation = self.room.invite_generation.saturating_add(1);
        self.invite = invite.clone();
        out.new_invite = Some(invite);
        let data = meta([("generation", self.room.invite_generation.to_string())]);
        self.room_event(out, actor, EventKind::InviteRotated, data, now)
    }

    fn close(&mut self, actor: &Actor, out: &mut Outcome, now: i64) -> Result<(), CollabError> {
        // Recorded before the room is marked closed, while the actor still has a role in an open room.
        self.room_event(out, actor, EventKind::RoomClosed, BTreeMap::new(), now)?;
        self.room.closed = true;
        let peers: Vec<PeerId> = self.sessions.keys().cloned().collect();
        for peer in peers {
            self.end_session_of(&peer, out);
        }
        Ok(())
    }

    fn transfer(
        &mut self,
        actor: &Actor,
        target: &PeerId,
        out: &mut Outcome,
        now: i64,
    ) -> Result<(), CollabError> {
        let from = self.room.owner.clone();
        let data = meta([("from", from.to_string()), ("to", target.to_string())]);
        self.room_event(out, actor, EventKind::OwnershipTransferred, data, now)?;
        self.edit(&from, |m| m.role = Role::Admin);
        self.edit(target, |m| {
            m.role = Role::Owner;
            m.overrides = Overrides::default();
        });
        self.room.owner = target.clone();
        out.changed_members.extend([from, target.clone()]);
        Ok(())
    }

    fn edit(&mut self, peer: &PeerId, change: impl FnOnce(&mut Member)) {
        if let Some(member) = self.room.members.get_mut(peer) {
            change(member);
        }
    }

    fn end_session_of(&mut self, peer: &PeerId, out: &mut Outcome) {
        if let Some(session) = self.sessions.remove(peer) {
            out.ended_sessions.push((peer.clone(), session));
        }
    }

    /// A peer's connection ended (left, dropped). Records the session end; the membership stays.
    pub fn disconnect(
        &mut self,
        peer: &PeerId,
        session: &SessionId,
        reason: &str,
        now_ms: i64,
    ) -> Result<Outcome, CollabError> {
        let mut out = Outcome::default();
        if self.sessions.get(peer) != Some(session) {
            return Ok(out);
        }
        self.end_session_of(peer, &mut out);
        self.edit(peer, |m| m.last_seen_ms = now_ms);
        out.changed_members.push(peer.clone());
        let actor = Actor::Remote {
            peer: peer.clone(),
            session: session.clone(),
        };
        let reason: String = reason.chars().take(120).collect();
        self.emit(
            &mut out,
            &actor,
            EventKind::SessionEnded,
            meta([("reason", reason)]),
            now_ms,
        )?;
        Ok(out)
    }

    /// Records activity the caller authorized itself (opening a file, an edit batch, voice, leaving).
    pub fn record_activity(
        &mut self,
        actor: &Actor,
        kind: EventKind,
        file: Option<(FileId, RelPath)>,
        metadata: BTreeMap<String, String>,
        now_ms: i64,
    ) -> Result<Outcome, CollabError> {
        if !kind.is_activity() {
            return Err(invalid(
                "activity",
                "this event is produced by the authority only",
            ));
        }
        self.check_actor(actor)?;
        let mut out = Outcome::default();
        let draft = self.draft(actor, kind, metadata, file);
        out.events
            .push(self.chain.append(draft, now_ms, &self.host)?);
        Ok(out)
    }

    fn room_event(
        &mut self,
        out: &mut Outcome,
        actor: &Actor,
        kind: EventKind,
        data: BTreeMap<String, String>,
        now: i64,
    ) -> Result<(), CollabError> {
        out.room_changed = true;
        self.emit(out, actor, kind, data, now)
    }

    fn emit(
        &mut self,
        out: &mut Outcome,
        actor: &Actor,
        kind: EventKind,
        data: BTreeMap<String, String>,
        now: i64,
    ) -> Result<(), CollabError> {
        let draft = self.draft(actor, kind, data, None);
        out.events.push(self.chain.append(draft, now, &self.host)?);
        Ok(())
    }

    fn draft(
        &self,
        actor: &Actor,
        kind: EventKind,
        metadata: BTreeMap<String, String>,
        file: Option<(FileId, RelPath)>,
    ) -> EventDraft {
        let member = self.room.member(actor.peer());
        let (file, path) = file.map_or((None, None), |(id, path)| (Some(id), Some(path)));
        EventDraft {
            session: actor.session(),
            actor: actor.peer().clone(),
            actor_name: member.map(|m| m.display_name.clone()).unwrap_or_default(),
            actor_role: member.map(|m| m.role).unwrap_or(Role::Viewer),
            kind,
            file,
            path,
            metadata,
        }
    }
}

fn meta<const N: usize>(entries: [(&str, String); N]) -> BTreeMap<String, String> {
    entries
        .into_iter()
        .map(|(k, v)| (k.to_string(), v))
        .collect()
}

#[cfg(test)]
mod tests;
