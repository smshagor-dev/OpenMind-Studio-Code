//! A member's room connection drops while voice (peer to peer or classroom) is going on (Milestone 24 stabilization).
//! The rule: **no grace period**. The Owner is the voice authority; when a member's room session ends, that member is
//! out of the call at once (and so off a classroom media server, which follows the call), its old session can't act or
//! get a media token any more, and everything after a reconnect goes through the room's checks again — whatever
//! changed meanwhile (permissions, a ban, the room closing) applies.

use openmind_collab::permission::{Overrides, Permission, PermissionSet, Role};
use openmind_collab::sfu::VoiceMode;
use openmind_collab::voice::VoiceSelf;
use openmind_collab::{Actor, Command, PeerId};

use super::super::docs::tests::{block, world, World};

fn peer(actor: &Actor) -> PeerId {
    match actor {
        Actor::Remote { peer, .. } | Actor::Host(peer) => peer.clone(),
    }
}

fn session(actor: &Actor) -> openmind_collab::SessionId {
    match actor {
        Actor::Remote { session, .. } => session.clone(),
        Actor::Host(_) => panic!("a remote member"),
    }
}

fn join(w: &World, actor: &Actor, muted: bool) -> Result<bool, String> {
    let s = VoiceSelf {
        joined: true,
        muted,
        speaking: false,
        hand_raised: false,
    };
    block(w.runtime.voice_state(&w.db, &w.room, actor.clone(), s, 70))
}

/// What the network layer does when a member's connection ends (`net_authority` → `disconnected` + `member_left`).
fn connection_lost(w: &World, actor: &Actor, now: i64) {
    block(w.runtime.disconnected(
        &w.db,
        &w.room,
        peer(actor),
        session(actor),
        "network".into(),
        now,
    ))
    .expect("disconnected");
    block(w.runtime.voice_left(&w.room, &peer(actor)));
}

fn in_call(w: &World, actor: &Actor) -> bool {
    block(w.runtime.voice_roster(&w.room))
        .iter()
        .any(|m| m.peer == peer(actor))
}

fn media(w: &World, actor: &Actor) -> Result<(VoiceMode, bool), String> {
    block(w.runtime.voice_media_check(&w.room, actor))
}

fn command(w: &World, command: Command) {
    block(w.runtime.run_command(&w.db, &w.room, command, 90)).expect("command");
}

/// A classroom call with an Editor speaking; returns its identity and session.
fn classroom_with_speaker(w: &World) -> (openmind_collab::PeerIdentity, Actor) {
    block(w.runtime.voice_set_mode(&w.db, &w.room, VoiceMode::Sfu, 60)).expect("mode");
    let (who, editor) = w.member_with_identity(Role::Editor);
    join(w, &editor, false).expect("joined");
    assert_eq!(media(w, &editor), Ok((VoiceMode::Sfu, true)));
    (who, editor)
}

#[test]
fn a_dropped_room_connection_ends_the_members_voice_at_once_and_a_reconnect_starts_clean() {
    for outage_secs in [2, 3_600] {
        let w = world(&[("a.txt", b"x")]);
        let (who, editor) = classroom_with_speaker(&w);
        connection_lost(&w, &editor, 100);
        // No grace: out of the call, so the media server (which follows the call) drops it too.
        assert!(!in_call(&w, &editor));
        let (_, on_server) = block(w.runtime.voice_media_members(&w.room));
        assert!(on_server.iter().all(|(p, _)| p != &peer(&editor)));
        assert!(media(&w, &editor).is_err(), "the old session gets no token");
        assert!(
            join(&w, &editor, false).is_err(),
            "nor can it rejoin the call"
        );
        // A reconnect after a short or a long outage: a fresh session, the call joined afresh.
        let again = w.reconnect(&who, 100 + outage_secs).expect("reconnected");
        assert_ne!(session(&again), session(&editor));
        assert!(!in_call(&w, &again), "not put back in the call by itself");
        assert_eq!(join(&w, &again, false), Ok(true));
        assert_eq!(media(&w, &again), Ok((VoiceMode::Sfu, true)));
        assert!(media(&w, &editor).is_err(), "the old session stays dead");
    }
}

#[test]
fn what_changes_during_the_outage_applies_after_the_reconnect() {
    let w = world(&[("a.txt", b"x")]);
    let (who, editor) = classroom_with_speaker(&w);
    connection_lost(&w, &editor, 100);
    let deny = Overrides {
        grant: PermissionSet::EMPTY,
        deny: PermissionSet::of(&[Permission::VoiceSpeak]),
    };
    command(
        &w,
        Command::SetOverrides {
            target: peer(&editor),
            overrides: deny,
        },
    );
    let again = w.reconnect(&who, 200).expect("reconnected");
    assert!(join(&w, &again, false)
        .expect_err("listen-only now")
        .contains("may not speak"));
    assert_eq!(join(&w, &again, true), Ok(true));
    assert_eq!(
        media(&w, &again),
        Ok((VoiceMode::Sfu, false)),
        "a token without the microphone"
    );

    // Losing voice.join meanwhile: back in the room, but not in the call.
    let (who2, other) = w.member_with_identity(Role::Editor);
    join(&w, &other, false).expect("joined");
    connection_lost(&w, &other, 300);
    let no_join = Overrides {
        grant: PermissionSet::EMPTY,
        deny: PermissionSet::of(&[Permission::VoiceJoin]),
    };
    command(
        &w,
        Command::SetOverrides {
            target: peer(&other),
            overrides: no_join,
        },
    );
    let back = w.reconnect(&who2, 400).expect("still a member");
    assert!(join(&w, &back, true).is_err());
    assert!(media(&w, &back).is_err());
}

#[test]
fn a_member_banned_or_a_room_closed_during_the_outage_never_gets_back_into_the_call() {
    let w = world(&[("a.txt", b"x")]);
    let (who, editor) = classroom_with_speaker(&w);
    let (who2, viewer) = w.member_with_identity(Role::Viewer);
    join(&w, &viewer, true).expect("listening");
    connection_lost(&w, &editor, 100);
    connection_lost(&w, &viewer, 100);
    command(
        &w,
        Command::Ban {
            target: peer(&editor),
        },
    );
    assert!(w.reconnect(&who, 200).is_err(), "banned: no new session");
    assert!(media(&w, &editor).is_err());

    command(&w, Command::CloseRoom);
    assert!(w.reconnect(&who2, 300).is_err(), "closed: no new session");
    assert!(block(w.runtime.voice_roster(&w.room)).is_empty());
    let (_, on_server) = block(w.runtime.voice_media_members(&w.room));
    assert!(on_server.is_empty(), "nobody is left on the media server");
}
