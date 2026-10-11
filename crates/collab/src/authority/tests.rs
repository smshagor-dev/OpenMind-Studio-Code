//! The Owner's authority, including what a malicious peer tries.

use super::*;
use crate::audit::verify_chain;
use crate::ids::Challenge;
use crate::protocol::{JoinRequest, ReconnectRequest, Refusal};

const NOW: i64 = 1_000;

struct Fixture {
    authority: Authority,
    events: Vec<AuditEvent>,
}

impl Fixture {
    fn new() -> Self {
        let host = PeerIdentity::generate().expect("identity");
        let (authority, outcome) =
            Authority::create(host, "Teacher", "Physics", NOW).expect("create");
        Self {
            authority,
            events: outcome.events,
        }
    }

    fn host(&self) -> Actor {
        Actor::Host(self.authority.host_identity().peer_id())
    }

    fn keep(&mut self, outcome: Outcome) -> Outcome {
        self.events.extend(outcome.events.iter().cloned());
        outcome
    }

    fn request(&self, who: &PeerIdentity, name: &str) -> (JoinRequest, Challenge) {
        let challenge = Authority::new_challenge().expect("challenge");
        let code = self.authority.invite().clone();
        let room = self.authority.room().room_uid.clone();
        (
            JoinRequest::create(who, &code, &room, &challenge, name),
            challenge,
        )
    }

    /// Joins `who`; returns the actor for its session.
    fn join(&mut self, who: &PeerIdentity) -> Actor {
        let (request, challenge) = self.request(who, "Student");
        let (result, outcome) = self
            .authority
            .join(&request, &challenge, NOW)
            .expect("join");
        self.keep(outcome);
        match result {
            JoinOutcome::Admitted(admission) => Actor::Remote {
                peer: admission.peer,
                session: admission.session,
            },
            other => panic!("expected admission, got {other:?}"),
        }
    }

    fn run(&mut self, actor: &Actor, command: Command) -> Result<Outcome, CollabError> {
        let outcome = self.authority.execute(actor, command, NOW)?;
        Ok(self.keep(outcome))
    }

    fn promote(&mut self, actor: &Actor, role: Role) {
        let host = self.host();
        self.run(
            &host,
            Command::ChangeRole {
                target: actor.peer().clone(),
                role,
            },
        )
        .expect("role");
    }
}

fn identity() -> PeerIdentity {
    PeerIdentity::generate().expect("identity")
}

fn refusal(result: (JoinOutcome, Outcome)) -> Refusal {
    match result.0 {
        JoinOutcome::Refused(refusal) => refusal,
        other => panic!("expected a refusal, got {other:?}"),
    }
}

fn denied(result: Result<Outcome, CollabError>) -> DenyReason {
    match result {
        Err(CollabError::Denied(denied)) => denied.reason,
        other => panic!("expected a denial, got {other:?}"),
    }
}

#[test]
fn a_new_room_has_its_owner_and_a_verifiable_first_event() {
    let fx = Fixture::new();
    let room = fx.authority.room();
    assert_eq!(room.members.len(), 1);
    assert_eq!(room.member(&room.owner).map(|m| m.role), Some(Role::Owner));
    assert_eq!(fx.events[0].kind, EventKind::RoomCreated);
    assert_eq!(room.invite_hash, fx.authority.invite().invite_hash());
}

#[test]
fn a_join_with_the_code_admits_with_the_default_role() {
    let mut fx = Fixture::new();
    let student = identity();
    let actor = fx.join(&student);
    let member = fx.authority.room().member(actor.peer()).expect("member");
    assert_eq!(
        (member.role, member.status),
        (Role::Viewer, MemberStatus::Active)
    );
    assert!(fx.authority.authorize(&actor, &Action::ReadFile).is_ok());
    assert!(fx.authority.authorize(&actor, &Action::WriteFile).is_err());
    let kinds: Vec<EventKind> = fx.events.iter().map(|e| e.kind).collect();
    assert_eq!(
        kinds,
        [
            EventKind::RoomCreated,
            EventKind::MemberJoined,
            EventKind::SessionStarted
        ]
    );
}

#[test]
fn forged_replayed_and_wrong_code_joins_are_refused() {
    let mut fx = Fixture::new();
    let mallory = identity();
    let victim = identity();
    let (mut request, challenge) = fx.request(&mallory, "Mallory");
    // A different challenge than the one this connection was given (a recorded request replayed).
    let other = Authority::new_challenge().expect("challenge");
    assert_eq!(
        refusal(fx.authority.join(&request, &other, NOW).expect("join")),
        Refusal::WrongChallenge
    );
    // Changing anything signed breaks the signature.
    request.display_name = "Teacher".into();
    assert_eq!(
        refusal(fx.authority.join(&request, &challenge, NOW).expect("join")),
        Refusal::BadSignature
    );
    // Claiming someone else's key (peer id spoofing) breaks the signature too.
    let (mut spoof, challenge) = fx.request(&mallory, "Mallory");
    spoof.public_key = victim.public_key();
    assert_eq!(
        refusal(fx.authority.join(&spoof, &challenge, NOW).expect("join")),
        Refusal::BadSignature
    );
    // A guessed code fails the proof.
    let challenge = Authority::new_challenge().expect("challenge");
    let wrong = crate::code::RoomCode::generate().expect("code");
    let room = fx.authority.room().room_uid.clone();
    let guess = JoinRequest::create(&mallory, &wrong, &room, &challenge, "Mallory");
    assert_eq!(
        refusal(fx.authority.join(&guess, &challenge, NOW).expect("join")),
        Refusal::InvalidInvite
    );
    assert_eq!(
        fx.authority.room().members.len(),
        1,
        "no refused peer was added"
    );
}

#[test]
fn a_rotated_code_refuses_the_old_one_and_keeps_the_room() {
    let mut fx = Fixture::new();
    let old = fx.authority.invite().clone();
    let room = fx.authority.room().room_uid.clone();
    let host = fx.host();
    let outcome = fx.run(&host, Command::RotateInvite).expect("rotate");
    let new = outcome.new_invite.expect("new code");
    assert_ne!(new, old);
    assert_eq!(fx.authority.room().room_uid, room);
    assert_eq!(fx.authority.room().invite_generation, 2);
    let late = identity();
    let challenge = Authority::new_challenge().expect("challenge");
    let stale = JoinRequest::create(&late, &old, &room, &challenge, "Late");
    assert_eq!(
        refusal(fx.authority.join(&stale, &challenge, NOW).expect("join")),
        Refusal::InvalidInvite
    );
    fx.join(&late);
}

#[test]
fn approval_lock_ban_and_close_gate_joins() {
    let mut fx = Fixture::new();
    let host = fx.host();
    fx.run(&host, Command::SetApproval { required: true })
        .expect("approval");
    let waiting = identity();
    let (request, challenge) = fx.request(&waiting, "Waiting");
    let (result, outcome) = fx.authority.join(&request, &challenge, NOW).expect("join");
    fx.keep(outcome);
    assert_eq!(result, JoinOutcome::Pending);
    let peer = waiting.peer_id();
    fx.run(
        &host,
        Command::Approve {
            target: peer.clone(),
        },
    )
    .expect("approve");
    let (admission, outcome) = fx.authority.admit_approved(&peer, NOW).expect("admit");
    fx.keep(outcome);
    assert_eq!(admission.role, Role::Viewer);

    fx.run(&host, Command::SetApproval { required: false })
        .expect("approval");
    fx.run(&host, Command::SetLocked { locked: true })
        .expect("lock");
    let (request, challenge) = fx.request(&identity(), "Locked out");
    assert_eq!(
        refusal(fx.authority.join(&request, &challenge, NOW).expect("join")),
        Refusal::Locked
    );
    fx.run(&host, Command::SetLocked { locked: false })
        .expect("unlock");

    fx.run(
        &host,
        Command::Ban {
            target: peer.clone(),
        },
    )
    .expect("ban");
    let (request, challenge) = fx.request(&waiting, "Waiting");
    assert_eq!(
        refusal(fx.authority.join(&request, &challenge, NOW).expect("join")),
        Refusal::Banned
    );
    fx.run(&host, Command::CloseRoom).expect("close");
    let (request, challenge) = fx.request(&identity(), "Too late");
    assert_eq!(
        refusal(fx.authority.join(&request, &challenge, NOW).expect("join")),
        Refusal::Closed
    );
    assert_eq!(
        denied(fx.run(&host, Command::SetLocked { locked: true })),
        DenyReason::RoomClosed
    );
}

#[test]
fn a_viewer_can_not_moderate_or_promote_itself() {
    let mut fx = Fixture::new();
    let viewer = fx.join(&identity());
    let other = fx.join(&identity());
    let me = viewer.peer().clone();
    for command in [
        Command::ChangeRole {
            target: me.clone(),
            role: Role::Editor,
        },
        Command::ChangeRole {
            target: me.clone(),
            role: Role::Owner,
        },
        Command::SetOverrides {
            target: me.clone(),
            overrides: Overrides {
                grant: crate::PermissionSet::all(),
                deny: crate::PermissionSet::EMPTY,
            },
        },
        Command::Kick {
            target: other.peer().clone(),
        },
        Command::RotateInvite,
        Command::CloseRoom,
        Command::TransferOwnership { target: me.clone() },
    ] {
        assert!(
            matches!(
                denied(fx.run(&viewer, command.clone())),
                DenyReason::MissingPermission { .. }
            ),
            "{command:?}"
        );
    }
    assert_eq!(
        fx.authority.room().member(&me).map(|m| m.role),
        Some(Role::Viewer)
    );
}

#[test]
fn a_remote_peer_can_not_act_as_the_host_or_with_an_old_session() {
    let mut fx = Fixture::new();
    let student = identity();
    let first = fx.join(&student);
    assert_eq!(
        denied(fx.run(&Actor::Host(student.peer_id()), Command::RotateInvite)),
        DenyReason::NotHost
    );
    let owner = fx.authority.room().owner.clone();
    let fake = Actor::Remote {
        peer: owner,
        session: SessionId::random().expect("session"),
    };
    assert_eq!(
        denied(fx.run(&fake, Command::RotateInvite)),
        DenyReason::StaleSession
    );
    // Reconnecting supersedes the first session: frames on it no longer count.
    let challenge = Authority::new_challenge().expect("challenge");
    let room = fx.authority.room().room_uid.clone();
    let again = ReconnectRequest::create(&student, &room, &challenge);
    let (result, outcome) = fx
        .authority
        .reconnect(&again, &challenge, NOW)
        .expect("reconnect");
    fx.keep(outcome);
    assert!(matches!(result, JoinOutcome::Admitted(_)));
    assert_eq!(
        fx.authority
            .authorize(&first, &Action::ReadFile)
            .map_err(|d| d.reason),
        Err(DenyReason::StaleSession)
    );
    // A recorded reconnect can't be replayed on a new connection.
    let fresh = Authority::new_challenge().expect("challenge");
    assert_eq!(
        refusal(
            fx.authority
                .reconnect(&again, &fresh, NOW)
                .expect("reconnect")
        ),
        Refusal::WrongChallenge
    );
}

#[test]
fn permission_changes_apply_to_the_live_session() {
    let mut fx = Fixture::new();
    let student = fx.join(&identity());
    assert!(fx
        .authority
        .authorize(&student, &Action::WriteFile)
        .is_err());
    fx.promote(&student, Role::Editor);
    assert!(
        fx.authority.authorize(&student, &Action::WriteFile).is_ok(),
        "no reconnect needed"
    );
    fx.promote(&student, Role::Viewer);
    assert!(
        fx.authority
            .authorize(&student, &Action::WriteFile)
            .is_err(),
        "demoted while editing"
    );
}

#[test]
fn kicked_and_removed_members_lose_their_session_and_come_back_differently() {
    let mut fx = Fixture::new();
    let host = fx.host();
    let student = identity();
    let actor = fx.join(&student);
    fx.promote(&actor, Role::Editor);
    let outcome = fx
        .run(
            &host,
            Command::Kick {
                target: student.peer_id(),
            },
        )
        .expect("kick");
    assert_eq!(outcome.ended_sessions.len(), 1);
    assert_eq!(
        fx.authority
            .authorize(&actor, &Action::ReadFile)
            .map_err(|d| d.reason),
        Err(DenyReason::StaleSession)
    );
    let challenge = Authority::new_challenge().expect("challenge");
    let room = fx.authority.room().room_uid.clone();
    let reconnect = ReconnectRequest::create(&student, &room, &challenge);
    assert_eq!(
        refusal(
            fx.authority
                .reconnect(&reconnect, &challenge, NOW)
                .expect("reconnect")
        ),
        Refusal::NotAMember
    );
    let back = fx.join(&student);
    assert_eq!(
        fx.authority.room().member(back.peer()).map(|m| m.role),
        Some(Role::Editor),
        "a kick keeps the role"
    );
    fx.run(
        &host,
        Command::Remove {
            target: student.peer_id(),
        },
    )
    .expect("remove");
    let back = fx.join(&student);
    assert_eq!(
        fx.authority.room().member(back.peer()).map(|m| m.role),
        Some(Role::Viewer),
        "removal resets it"
    );
}

#[test]
fn an_admin_demoted_mid_moderation_loses_the_power() {
    let mut fx = Fixture::new();
    let admin = fx.join(&identity());
    let viewer = fx.join(&identity());
    fx.promote(&admin, Role::Admin);
    fx.run(
        &admin,
        Command::ForceMute {
            target: viewer.peer().clone(),
            muted: true,
        },
    )
    .expect("mute");
    fx.promote(&admin, Role::Editor);
    assert!(matches!(
        denied(fx.run(
            &admin,
            Command::Kick {
                target: viewer.peer().clone()
            }
        )),
        DenyReason::MissingPermission { .. }
    ));
}

#[test]
fn ownership_moves_only_by_transfer() {
    let mut fx = Fixture::new();
    let host = fx.host();
    let heir = fx.join(&identity());
    fx.run(
        &host,
        Command::TransferOwnership {
            target: heir.peer().clone(),
        },
    )
    .expect("transfer");
    let room = fx.authority.room();
    assert_eq!(room.owner, *heir.peer());
    assert_eq!(room.member(heir.peer()).map(|m| m.role), Some(Role::Owner));
    assert_eq!(room.member(host.peer()).map(|m| m.role), Some(Role::Admin));
    assert!(matches!(
        denied(fx.run(&host, Command::CloseRoom)),
        DenyReason::MissingPermission { .. }
    ));
}

#[test]
fn activity_is_recorded_only_for_activity_kinds_and_current_actors() {
    let mut fx = Fixture::new();
    let student = fx.join(&identity());
    let file = (
        FileId::random().expect("id"),
        RelPath::parse("src/main.ts").expect("path"),
    );
    let outcome = fx
        .authority
        .record_activity(
            &student,
            EventKind::FileOpened,
            Some(file),
            BTreeMap::new(),
            NOW,
        )
        .expect("record");
    fx.keep(outcome);
    assert!(fx
        .authority
        .record_activity(&student, EventKind::RoleChanged, None, BTreeMap::new(), NOW)
        .is_err());
    let stale = Actor::Remote {
        peer: student.peer().clone(),
        session: SessionId::random().expect("session"),
    };
    assert!(fx
        .authority
        .record_activity(&stale, EventKind::FileOpened, None, BTreeMap::new(), NOW)
        .is_err());
}

#[test]
fn the_whole_history_verifies_and_restores() {
    let mut fx = Fixture::new();
    let host = fx.host();
    let student = fx.join(&identity());
    fx.run(
        &host,
        Command::RenameRoom {
            name: "Physics 101".into(),
        },
    )
    .expect("rename");
    let peer = student.peer().clone();
    let session = fx.authority.session_of(&peer).cloned().expect("session");
    let outcome = fx
        .authority
        .disconnect(&peer, &session, "network lost", NOW)
        .expect("disconnect");
    fx.keep(outcome);
    let key = fx.authority.host_identity().public_key();
    assert!(verify_chain(&fx.events, &ChainHead::genesis(), Some(&key)).is_ok());

    let identity = fx.authority.host_identity().clone();
    let restored = Authority::restore(
        identity.clone(),
        fx.authority.room().clone(),
        fx.authority.invite().clone(),
        fx.authority.chain_head().clone(),
    )
    .expect("restore");
    assert_eq!(restored.chain_head().next_seq, fx.events.len() as u64 + 1);
    assert!(
        restored.session_of(&peer).is_none(),
        "sessions never survive a restart"
    );
    let wrong = crate::code::RoomCode::generate().expect("code");
    assert!(Authority::restore(
        identity,
        fx.authority.room().clone(),
        wrong,
        ChainHead::genesis()
    )
    .is_err());
}

#[test]
fn approving_denying_and_closing_are_recorded_in_the_history() {
    let mut fx = Fixture::new();
    let host = fx.host();
    fx.run(&host, Command::SetApproval { required: true })
        .expect("approval");
    let (yes, no) = (identity(), identity());
    for who in [&yes, &no] {
        let (request, challenge) = fx.request(who, "Waiting");
        let (result, outcome) = fx.authority.join(&request, &challenge, NOW).expect("join");
        fx.keep(outcome);
        assert_eq!(result, JoinOutcome::Pending);
    }
    fx.run(
        &host,
        Command::Approve {
            target: yes.peer_id(),
        },
    )
    .expect("approve");
    fx.run(
        &host,
        Command::DenyJoin {
            target: no.peer_id(),
        },
    )
    .expect("deny");
    fx.run(&host, Command::CloseRoom).expect("close");
    let kinds: Vec<EventKind> = fx.events.iter().map(|e| e.kind).collect();
    for kind in [
        EventKind::JoinRequested,
        EventKind::JoinApproved,
        EventKind::JoinDenied,
        EventKind::RoomClosed,
    ] {
        assert!(kinds.contains(&kind), "{kind:?} missing");
    }
}
