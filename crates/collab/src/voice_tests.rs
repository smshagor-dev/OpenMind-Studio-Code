//! The voice call's rules: permissions, force mute, capacity, live permission changes and signal limits.

use super::*;
use crate::identity::PeerIdentity;
use crate::permission::{Overrides, PermissionSet};
use crate::sfu::VoiceMode;
use crate::testkit::{member, room, set, Cast};

fn joined(muted: bool) -> VoiceSelf {
    VoiceSelf {
        joined: true,
        muted,
        speaking: !muted,
        hand_raised: false,
    }
}

#[test]
fn joining_and_speaking_follow_the_members_permissions() {
    let cast = Cast::new();
    let mut room = room(&cast);
    let mut board = VoiceBoard::default();
    let viewer = cast.viewer.peer_id();
    // Viewer defaults: voice.join yes, voice.speak no — listen-only.
    assert_eq!(
        board.update(&room, &viewer, joined(true)),
        Ok(VoiceChange::Joined)
    );
    assert_eq!(
        board.update(&room, &viewer, joined(false)),
        Err(VoiceRefusal::MayNotSpeak)
    );
    let roster = board.roster(&room);
    assert!(!roster[0].can_speak && roster[0].muted);
    // Granted voice.speak: may unmute, without rejoining anything.
    set(&mut room, &viewer, |m| {
        m.overrides = Overrides {
            grant: PermissionSet::of(&[Permission::VoiceSpeak]),
            deny: PermissionSet::EMPTY,
        }
    });
    assert_eq!(
        board.update(&room, &viewer, joined(false)),
        Ok(VoiceChange::Updated)
    );
    // voice.join denied: can't be in the call at all.
    let editor = cast.editor.peer_id();
    set(&mut room, &editor, |m| {
        m.overrides.deny = PermissionSet::of(&[Permission::VoiceJoin])
    });
    assert_eq!(
        board.update(&room, &editor, joined(true)),
        Err(VoiceRefusal::NotAllowed)
    );
}

#[test]
fn a_force_muted_member_cannot_unmute_and_enforce_mutes_it_at_once() {
    let cast = Cast::new();
    let mut room = room(&cast);
    let mut board = VoiceBoard::default();
    let editor = cast.editor.peer_id();
    assert_eq!(
        board.update(&room, &editor, joined(false)),
        Ok(VoiceChange::Joined)
    );
    set(&mut room, &editor, |m| m.force_muted = true);
    let (gone, changed) = board.enforce(&room);
    assert!(gone.is_empty() && changed);
    let roster = board.roster(&room);
    assert!(
        roster[0].muted && !roster[0].speaking && roster[0].force_muted && !roster[0].can_speak
    );
    assert_eq!(
        board.update(&room, &editor, joined(false)),
        Err(VoiceRefusal::MayNotSpeak)
    );
    assert_eq!(
        board.update(&room, &editor, joined(true)),
        Ok(VoiceChange::Unchanged)
    );
    // A revoked voice.join takes the member out of the call.
    set(&mut room, &editor, |m| {
        m.overrides.deny = PermissionSet::of(&[Permission::VoiceJoin])
    });
    assert_eq!(board.enforce(&room), (vec![editor.clone()], true));
    assert!(!board.contains(&editor));
}

#[test]
fn the_call_is_capped_and_leaving_frees_a_place() {
    let cast = Cast::new();
    let mut room = room(&cast);
    let mut board = VoiceBoard::default();
    let mut peers = Vec::new();
    for i in 0..MAX_VOICE_MEMBERS + 1 {
        let id = PeerIdentity::generate().expect("id");
        room.members.insert(
            id.peer_id(),
            member(&id, &format!("m{i}"), crate::permission::Role::Editor),
        );
        peers.push(id.peer_id());
    }
    for peer in &peers[..MAX_VOICE_MEMBERS] {
        assert_eq!(
            board.update(&room, peer, joined(true)),
            Ok(VoiceChange::Joined)
        );
    }
    let last = &peers[MAX_VOICE_MEMBERS];
    assert_eq!(
        board.update(&room, last, joined(true)),
        Err(VoiceRefusal::Full)
    );
    let leaving = VoiceSelf::default();
    assert_eq!(
        board.update(&room, &peers[0], leaving),
        Ok(VoiceChange::Left)
    );
    assert_eq!(
        board.update(&room, last, joined(true)),
        Ok(VoiceChange::Joined)
    );
}

#[test]
fn only_two_different_members_of_the_call_may_negotiate() {
    let cast = Cast::new();
    let room = room(&cast);
    let mut board = VoiceBoard::default();
    let (a, b, c) = (
        cast.editor.peer_id(),
        cast.admin.peer_id(),
        cast.viewer.peer_id(),
    );
    board.update(&room, &a, joined(true)).expect("a");
    board.update(&room, &b, joined(true)).expect("b");
    assert!(board.may_signal(&a, &b));
    assert!(!board.may_signal(&a, &a));
    assert!(!board.may_signal(&a, &c), "not in the call");
    assert!(!board.may_signal(&c, &a));
}

#[test]
fn signals_are_typed_and_bounded() {
    assert!(VoiceSignal::Offer { sdp: "v=0".into() }.validate().is_ok());
    assert!(VoiceSignal::Offer {
        sdp: "x".repeat(MAX_SDP_BYTES + 1)
    }
    .validate()
    .is_err());
    let big = VoiceSignal::Candidate {
        candidate: "x".repeat(MAX_CANDIDATE_BYTES + 1),
        sdp_mid: None,
        sdp_m_line_index: Some(0),
    };
    assert!(big.validate().is_err());
    let json = r#"{"kind":"offer","sdp":"v=0","audio":"raw"}"#;
    assert!(
        serde_json::from_str::<VoiceSignal>(json).is_err(),
        "nothing unknown is accepted"
    );
    let state =
        r#"{"joined":true,"muted":false,"speaking":false,"handRaised":false,"role":"owner"}"#;
    assert!(serde_json::from_str::<VoiceSelf>(state).is_err());
}

#[test]
fn classroom_mode_takes_a_larger_call_and_the_mode_never_changes_under_a_running_call() {
    let cast = Cast::new();
    let mut room = room(&cast);
    let mut board = VoiceBoard::default();
    assert_eq!(
        (board.mode(), board.capacity()),
        (VoiceMode::P2p, MAX_VOICE_MEMBERS)
    );
    let mut peers = Vec::new();
    for i in 0..MAX_VOICE_MEMBERS + 4 {
        let id = PeerIdentity::generate().expect("id");
        room.members.insert(
            id.peer_id(),
            member(&id, &format!("s{i}"), crate::permission::Role::Viewer),
        );
        peers.push(id.peer_id());
    }
    assert_eq!(board.set_mode(VoiceMode::Sfu), Ok(true));
    assert_eq!(board.capacity(), MAX_SFU_VOICE_MEMBERS);
    for peer in &peers {
        assert_eq!(
            board.update(&room, peer, joined(true)),
            Ok(VoiceChange::Joined)
        );
    }
    assert_eq!(
        board.len(),
        MAX_VOICE_MEMBERS + 4,
        "more than a peer-to-peer call holds"
    );
    // Switching while people are in the call is refused; the call keeps its transport until it ends.
    assert_eq!(board.set_mode(VoiceMode::P2p), Err(CallInProgress));
    assert_eq!(board.set_mode(VoiceMode::Sfu), Ok(false), "no change");
    board.clear();
    assert_eq!(board.set_mode(VoiceMode::P2p), Ok(true));
    // Listen-only stays listen-only in classroom mode too.
    let viewer = cast.viewer.peer_id();
    board.set_mode(VoiceMode::Sfu).expect("empty call");
    assert_eq!(
        board.update(&room, &viewer, joined(false)),
        Err(VoiceRefusal::MayNotSpeak)
    );
}
