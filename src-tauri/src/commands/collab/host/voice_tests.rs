//! The voice call on the Owner's machine against a real database: who may join and speak, live permission changes and
//! force mute, the capacity, how negotiation is routed (never for someone outside the call or on an old session), and
//! what reaches the room's history.

use openmind_collab::permission::{Overrides, Permission, PermissionSet, Role};
use openmind_collab::protocol::Body;
use openmind_collab::sfu::VoiceMode;
use openmind_collab::voice::{VoiceSelf, VoiceSignal, MAX_VOICE_MEMBERS};
use openmind_collab::{Actor, Command, PeerId, SessionId};
use openmind_collab_net::owner::FrameOutcome;
use openmind_db::collab::{logs, rooms};

use super::super::docs::tests::{block, world, World};

fn peer(actor: &Actor) -> PeerId {
    match actor {
        Actor::Remote { peer, .. } | Actor::Host(peer) => peer.clone(),
    }
}

fn joined(muted: bool) -> VoiceSelf {
    VoiceSelf {
        joined: true,
        muted,
        speaking: false,
        hand_raised: false,
    }
}

fn state(w: &World, actor: &Actor, s: VoiceSelf) -> Result<bool, String> {
    block(w.runtime.voice_state(&w.db, &w.room, actor.clone(), s, 70))
}

fn command(w: &World, command: Command) -> bool {
    block(w.runtime.run_command(&w.db, &w.room, command, 71))
        .expect("command")
        .voice_changed
}

fn offer() -> VoiceSignal {
    VoiceSignal::Offer { sdp: "v=0".into() }
}

#[test]
fn viewers_listen_editors_speak_and_permission_changes_apply_at_once() {
    let w = world(&[("a.txt", b"x")]);
    let (viewer, editor) = (w.member(Role::Viewer), w.member(Role::Editor));
    assert_eq!(state(&w, &viewer, joined(true)), Ok(true));
    assert!(state(&w, &viewer, joined(false))
        .expect_err("listen-only")
        .contains("may not speak"));
    assert_eq!(state(&w, &editor, joined(false)), Ok(true));
    // Granting voice.speak lets the viewer unmute without reconnecting.
    let grant = Overrides {
        grant: PermissionSet::of(&[Permission::VoiceSpeak]),
        deny: PermissionSet::EMPTY,
    };
    command(
        &w,
        Command::SetOverrides {
            target: peer(&viewer),
            overrides: grant,
        },
    );
    assert_eq!(state(&w, &viewer, joined(false)), Ok(true));
    // Revoking voice.speak from a speaking editor mutes it at once.
    let revoke = Overrides {
        grant: PermissionSet::EMPTY,
        deny: PermissionSet::of(&[Permission::VoiceSpeak]),
    };
    assert!(command(
        &w,
        Command::SetOverrides {
            target: peer(&editor),
            overrides: revoke
        }
    ));
    let roster = block(w.runtime.voice_roster(&w.room));
    let ed = roster
        .iter()
        .find(|m| m.peer == peer(&editor))
        .expect("editor");
    assert!(ed.muted && !ed.can_speak);
    // Denying voice.join takes a member out of the call.
    let out = Overrides {
        grant: PermissionSet::EMPTY,
        deny: PermissionSet::of(&[Permission::VoiceJoin]),
    };
    assert!(command(
        &w,
        Command::SetOverrides {
            target: peer(&viewer),
            overrides: out
        }
    ));
    assert!(block(w.runtime.voice_roster(&w.room))
        .iter()
        .all(|m| m.peer != peer(&viewer)));
    assert!(state(&w, &viewer, joined(true))
        .expect_err("denied")
        .contains("voice.join"));
}

#[test]
fn force_mute_is_the_moderators_and_holds_until_lifted() {
    let w = world(&[("a.txt", b"x")]);
    let (editor, other) = (w.member(Role::Editor), w.member(Role::Editor));
    state(&w, &editor, joined(false)).expect("speaking");
    assert!(command(
        &w,
        Command::ForceMute {
            target: peer(&editor),
            muted: true
        }
    ));
    let roster = block(w.runtime.voice_roster(&w.room));
    assert!(roster[0].force_muted && roster[0].muted && !roster[0].can_speak);
    assert!(
        state(&w, &editor, joined(false)).is_err(),
        "can't unmute while force-muted"
    );
    // An editor can't force-mute anyone (voice.forceMute is a moderator's).
    let unauthorized = block(
        w.runtime.remote_frame(
            &w.db,
            &w.room,
            other.clone(),
            openmind_collab::protocol::Frame::new(
                SessionId::random().expect("s"),
                1,
                Body::Command {
                    command: Command::ForceMute {
                        target: peer(&editor),
                        muted: false,
                    },
                },
            )
            .expect("frame"),
            72,
        ),
    );
    assert!(matches!(unauthorized.0, FrameOutcome::Rejected(_)));
    command(
        &w,
        Command::ForceMute {
            target: peer(&editor),
            muted: false,
        },
    );
    assert_eq!(state(&w, &editor, joined(false)), Ok(true));
}

#[test]
fn the_call_is_capped_and_old_sessions_are_refused() {
    let w = world(&[("a.txt", b"x")]);
    let members: Vec<Actor> = (0..=MAX_VOICE_MEMBERS)
        .map(|_| w.member(Role::Editor))
        .collect();
    for m in &members[..MAX_VOICE_MEMBERS] {
        state(&w, m, joined(true)).expect("joined");
    }
    let last = &members[MAX_VOICE_MEMBERS];
    assert!(state(&w, last, joined(true))
        .expect_err("full")
        .contains("full"));
    let stale = Actor::Remote {
        peer: peer(&members[0]),
        session: SessionId::random().expect("s"),
    };
    assert!(
        state(&w, &stale, VoiceSelf::default()).is_err(),
        "an old session can't leave for it either"
    );
    assert!(block(w.runtime.voice_left(&w.room, &peer(&members[0]))));
    assert_eq!(state(&w, last, joined(true)), Ok(true));
}

#[test]
fn negotiation_goes_only_between_members_of_the_call_under_the_real_sender() {
    let w = world(&[("a.txt", b"x")]);
    let (a, b, outsider) = (
        w.member(Role::Editor),
        w.member(Role::Editor),
        w.member(Role::Editor),
    );
    state(&w, &a, joined(true)).expect("a");
    state(&w, &b, joined(true)).expect("b");
    let frame = |actor: &Actor, to: &PeerId| {
        block(
            w.runtime
                .voice_signal_frame(&w.db, &w.room, actor.clone(), to.clone(), offer()),
        )
    };
    let (outcome, _) = frame(&a, &peer(&b));
    assert_eq!(
        outcome,
        FrameOutcome::Relay(vec![(
            peer(&b),
            Body::VoicePeerSignal {
                from: peer(&a),
                signal: offer()
            }
        )])
    );
    assert_eq!(
        frame(&a, &peer(&outsider)).0,
        FrameOutcome::Dropped,
        "a member outside the call"
    );
    assert_eq!(
        frame(&outsider, &peer(&a)).0,
        FrameOutcome::Dropped,
        "a sender outside the call"
    );
    assert_eq!(frame(&a, &peer(&a)).0, FrameOutcome::Dropped, "oneself");
    let stale = Actor::Remote {
        peer: peer(&a),
        session: SessionId::random().expect("s"),
    };
    assert_eq!(
        frame(&stale, &peer(&b)).0,
        FrameOutcome::Dropped,
        "an old session"
    );
    let stranger = openmind_collab::PeerIdentity::generate()
        .expect("id")
        .peer_id();
    assert_eq!(
        frame(&a, &stranger).0,
        FrameOutcome::Dropped,
        "not even a member"
    );
    // The hosting user in the call: its messages come to this computer's window, not the network.
    let host = Actor::Host(block(w.runtime.identity(&w.db)).expect("id").peer_id());
    state(&w, &host, joined(true)).expect("host joins");
    let (outcome, effects) = frame(&a, &peer(&host));
    assert_eq!(outcome, FrameOutcome::Relay(Vec::new()));
    assert_eq!(effects.voice_to_host, Some((peer(&a), offer())));
}

#[test]
fn joining_and_leaving_are_in_the_history_but_mutes_are_not() {
    let w = world(&[("a.txt", b"x")]);
    let a = w.member(Role::Editor);
    state(&w, &a, joined(false)).expect("join");
    state(&w, &a, joined(true)).expect("mute");
    state(&w, &a, VoiceSelf::default()).expect("leave");
    let row = block(rooms::get_by_uid(w.db.pool(), &w.room))
        .expect("get")
        .expect("row");
    let kinds: Vec<String> = block(logs::list_after(w.db.pool(), row.id, 0, 500))
        .expect("logs")
        .into_iter()
        .map(|l| l.kind)
        .collect();
    assert!(kinds.contains(&"voice.joined".to_string()), "{kinds:?}");
    assert!(kinds.contains(&"voice.left".to_string()));
    assert!(!kinds
        .iter()
        .any(|k| k == "voice.muted" || k == "voice.unmuted"));
}

fn media(w: &World, actor: &Actor) -> Result<(VoiceMode, bool), String> {
    block(w.runtime.voice_media_check(&w.room, actor))
}

#[test]
fn media_is_granted_only_to_current_members_already_in_the_call() {
    let w = world(&[("a.txt", b"x")]);
    let (viewer, editor) = (w.member(Role::Viewer), w.member(Role::Editor));
    assert!(
        media(&w, &editor).is_err(),
        "not in the call yet: no media server token"
    );
    state(&w, &viewer, joined(true)).expect("viewer joins");
    state(&w, &editor, joined(true)).expect("editor joins");
    assert_eq!(
        media(&w, &viewer),
        Ok((VoiceMode::P2p, false)),
        "listen-only"
    );
    assert_eq!(media(&w, &editor), Ok((VoiceMode::P2p, true)));
    // Force mute takes publishing away; an old session gets nothing.
    command(
        &w,
        Command::ForceMute {
            target: peer(&editor),
            muted: true,
        },
    );
    assert_eq!(media(&w, &editor), Ok((VoiceMode::P2p, false)));
    let stale = Actor::Remote {
        peer: peer(&editor),
        session: SessionId::random().expect("s"),
    };
    assert!(media(&w, &stale).is_err());
    // A kicked or banned member gets no token.
    command(
        &w,
        Command::Kick {
            target: peer(&editor),
        },
    );
    assert!(media(&w, &editor).is_err());
    command(
        &w,
        Command::Ban {
            target: peer(&viewer),
        },
    );
    assert!(media(&w, &viewer).is_err());
}

#[test]
fn the_voice_mode_changes_only_while_the_call_is_empty() {
    let w = world(&[("a.txt", b"x")]);
    assert_eq!(
        block(w.runtime.voice_set_mode(&w.db, &w.room, VoiceMode::Sfu, 80)),
        Ok(true)
    );
    assert_eq!(
        block(w.runtime.voice_set_mode(&w.db, &w.room, VoiceMode::Sfu, 80)),
        Ok(false)
    );
    // Classroom mode takes more than the peer-to-peer limit.
    let members: Vec<Actor> = (0..=MAX_VOICE_MEMBERS)
        .map(|_| w.member(Role::Editor))
        .collect();
    for m in &members {
        state(&w, m, joined(true)).expect("joined a classroom call");
    }
    assert!(block(w.runtime.voice_set_mode(&w.db, &w.room, VoiceMode::P2p, 81)).is_err());
    let (mode, call) = block(w.runtime.voice_media_members(&w.room));
    assert_eq!((mode, call.len()), (VoiceMode::Sfu, MAX_VOICE_MEMBERS + 1));
    // Hosting stopped: the call ends (and the mode can change again once hosting resumes).
    assert!(block(w.runtime.voice_reset(&w.room)));
    assert!(block(w.runtime.voice_roster(&w.room)).is_empty());
    assert!(
        !block(w.runtime.voice_reset(&w.room)),
        "nobody left to remove"
    );
    assert_eq!(
        block(w.runtime.voice_set_mode(&w.db, &w.room, VoiceMode::P2p, 81)),
        Ok(true)
    );
    // Each real change is in the room's history (as the Owner's); a no-op or a refused change is not.
    let row = block(rooms::get_by_uid(w.db.pool(), &w.room))
        .expect("get")
        .expect("row");
    let modes: Vec<String> = block(logs::list_after(w.db.pool(), row.id, 0, 1000))
        .expect("logs")
        .into_iter()
        .filter(|l| l.kind == "voice.modeChanged")
        .map(|l| l.metadata)
        .collect();
    assert_eq!(modes.len(), 2, "{modes:?}");
    assert!(
        modes[0].contains("sfu") && modes[1].contains("p2p"),
        "{modes:?}"
    );
}
