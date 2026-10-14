//! Presence on the Owner's machine against a real database and workspace: what is relayed, to whom and under which
//! name; stale, forged and foreign states; the roster's roles; leaving and deleted files.

use openmind_collab::permission::Role;
use openmind_collab::presence::{CursorState, PresenceState};
use openmind_collab::protocol::{Body, Bytes};
use openmind_collab::{Actor, FileId, SessionId};
use openmind_collab_net::owner::FrameOutcome;

use super::super::docs::tests::{block, world, World};

fn state(seq: u64, file: Option<&FileId>) -> PresenceState {
    PresenceState {
        seq,
        active: file.cloned(),
        cursor: file.map(|_| CursorState {
            anchor: Bytes(vec![1, 2, 3]),
            head: Bytes(vec![1, 2, 4]),
        }),
        typing: false,
    }
}

fn send(w: &World, actor: &Actor, s: PresenceState) -> FrameOutcome {
    block(w.runtime.presence_frame(&w.room, actor.clone(), s)).0
}

fn peer(actor: &Actor) -> openmind_collab::PeerId {
    match actor {
        Actor::Remote { peer, .. } | Actor::Host(peer) => peer.clone(),
    }
}

#[test]
fn a_state_goes_to_the_other_members_under_the_senders_authenticated_peer() {
    let w = world(&[("src/a.ts", b"let x = 1;\n")]);
    let file = w.id("src/a.ts");
    let (a, b, c) = (
        w.member(Role::Editor),
        w.member(Role::Viewer),
        w.member(Role::Viewer),
    );
    let (outcome, notice) = block(w.runtime.presence_frame(
        &w.room,
        a.clone(),
        state(1, Some(&file)),
    ));
    let FrameOutcome::Relay(messages) = outcome else {
        panic!("{outcome:?}")
    };
    let mut to: Vec<_> = messages.iter().map(|(p, _)| p.clone()).collect();
    to.sort();
    let mut expected = vec![peer(&b), peer(&c)];
    expected.sort();
    assert_eq!(to, expected, "everyone but the sender");
    for (_, body) in &messages {
        let Body::PeerPresence { peer: named, .. } = body else {
            panic!("{body:?}")
        };
        assert_eq!(*named, peer(&a));
    }
    let notice = notice.expect("the Owner's windows hear it");
    assert!(notice
        .active_path
        .expect("path")
        .ends_with("src/a.ts".replace('/', std::path::MAIN_SEPARATOR_STR)));
}

#[test]
fn older_or_repeated_states_are_dropped() {
    let w = world(&[("a.txt", b"x")]);
    let file = w.id("a.txt");
    let (a, _b) = (w.member(Role::Viewer), w.member(Role::Viewer));
    assert!(matches!(
        send(&w, &a, state(5, Some(&file))),
        FrameOutcome::Relay(_)
    ));
    assert_eq!(send(&w, &a, state(5, None)), FrameOutcome::Dropped);
    assert_eq!(send(&w, &a, state(4, None)), FrameOutcome::Dropped);
    assert!(matches!(
        send(&w, &a, state(6, None)),
        FrameOutcome::Relay(_)
    ));
}

#[test]
fn a_file_that_isnt_the_rooms_and_an_old_session_are_dropped() {
    let w = world(&[("a.txt", b"x")]);
    let a = w.member(Role::Editor);
    let foreign = FileId::random().expect("id");
    assert_eq!(
        send(&w, &a, state(1, Some(&foreign))),
        FrameOutcome::Dropped
    );
    let stale = Actor::Remote {
        peer: peer(&a),
        session: SessionId::random().expect("session"),
    };
    assert_eq!(
        send(&w, &stale, state(2, None)),
        FrameOutcome::Dropped,
        "not the current session"
    );
    let host = Actor::Host(peer(&a));
    assert_eq!(
        send(&w, &host, state(3, None)),
        FrameOutcome::Dropped,
        "only remote actors send frames"
    );
}

#[test]
fn the_roster_takes_roles_from_the_membership_and_marks_who_is_online() {
    let w = world(&[("a.txt", b"x")]);
    let a = w.member(Role::Viewer);
    w.role(&peer(&a), Role::Editor);
    let roster = block(w.runtime.roster(&w.room));
    assert_eq!(roster.len(), 2, "the Owner and the member");
    let entry = roster.iter().find(|e| e.peer == peer(&a)).expect("member");
    assert_eq!(entry.role, Role::Editor);
    assert!(entry.online);
    assert_eq!(entry.display_name, "Member");
    let owner = roster.iter().find(|e| e.peer != peer(&a)).expect("owner");
    assert_eq!(owner.role, Role::Owner);
    assert!(owner.online);
    // A presence state has no role or peer field to claim anything with.
    let claim = r#"{"seq":1,"active":null,"cursor":null,"typing":false,"role":"owner"}"#;
    assert!(serde_json::from_str::<PresenceState>(claim).is_err());
}

#[test]
fn leaving_and_deleting_a_file_clear_presence_for_everyone() {
    let w = world(&[("a.txt", b"x"), ("b.txt", b"y")]);
    let file = w.id("a.txt");
    let (a, b) = (w.member(Role::Viewer), w.member(Role::Viewer));
    assert!(matches!(
        send(&w, &a, state(1, Some(&file))),
        FrameOutcome::Relay(_)
    ));
    let gone = block(w.runtime.presence_file_gone(&w.room, &file));
    assert_eq!(gone.len(), 1);
    let Body::PeerPresence { state: cleared, .. } = &gone[0].1 else {
        panic!("{gone:?}")
    };
    assert!(cleared.active.is_none() && cleared.cursor.is_none());
    assert_eq!(gone[0].0, peer(&b));
    let told = block(w.runtime.presence_gone(&w.room, &peer(&a)));
    assert_eq!(
        told,
        vec![(peer(&b), Body::PresenceGone { peer: peer(&a) })]
    );
    assert!(block(w.runtime.presence_states(&w.room)).is_empty());
}

#[test]
fn the_owners_presence_reaches_every_member_and_newcomers_get_the_current_states() {
    let w = world(&[("a.txt", b"x")]);
    let file = w.id("a.txt");
    let (a, b) = (w.member(Role::Viewer), w.member(Role::Viewer));
    let out = block(
        w.runtime
            .owner_presence(&w.db, &w.room, state(1, Some(&file))),
    );
    assert_eq!(out.len(), 2);
    let foreign = FileId::random().expect("id");
    assert!(block(
        w.runtime
            .owner_presence(&w.db, &w.room, state(2, Some(&foreign)))
    )
    .is_empty());
    assert!(matches!(
        send(&w, &a, state(1, None)),
        FrameOutcome::Relay(_)
    ));
    let states = block(w.runtime.presence_states(&w.room));
    assert_eq!(states.len(), 2, "the Owner's and a's");
    let _ = b;
}

#[test]
fn the_owners_editor_path_resolves_to_the_shared_file_and_nothing_else() {
    let w = world(&[("src/a.ts", b"x")]);
    let file = w.id("src/a.ts");
    let path = w.ws.join("src").join("a.ts");
    assert_eq!(block(w.runtime.file_at(&w.db, &w.room, &path)), Some(file));
    let upper = std::path::PathBuf::from(path.to_string_lossy().to_uppercase());
    if cfg!(windows) {
        assert!(
            block(w.runtime.file_at(&w.db, &w.room, &upper)).is_some(),
            "Windows paths ignore case"
        );
    }
    let outside = w.ws.parent().expect("parent").join("elsewhere.ts");
    assert_eq!(block(w.runtime.file_at(&w.db, &w.room, &outside)), None);
    assert_eq!(
        block(w.runtime.file_at(&w.db, &w.room, &w.ws.join("src"))),
        None,
        "a folder isn't a file"
    );
}

/// The editor may know a file by its 8.3 short spelling (`C:\Users\RUNNER~1\...`, as in GitHub's runners' %TEMP%) while
/// the share's root is the long one: still the same shared file. A short spelling outside the share still matches nothing.
#[cfg(windows)]
#[test]
fn a_short_spelling_of_a_shared_file_is_still_that_file() {
    let w = world(&[("A Long Folder Name/a.ts", b"x")]);
    let file = w.id("A Long Folder Name/a.ts");
    let path = w.ws.join("A Long Folder Name").join("a.ts");
    let Some(short) = crate::test_paths::short_spelling(&path) else {
        eprintln!("this volume makes no 8.3 short names: nothing to compare");
        return;
    };
    assert_ne!(short, path, "two spellings");
    assert_eq!(block(w.runtime.file_at(&w.db, &w.room, &short)), Some(file));
    let outside =
        w.ws.parent()
            .expect("parent")
            .join("Another Long Folder Name");
    std::fs::create_dir_all(&outside).expect("outside");
    std::fs::write(outside.join("b.ts"), b"y").expect("b");
    let outside_short = crate::test_paths::short_spelling(&outside.join("b.ts")).expect("short");
    assert_eq!(
        block(w.runtime.file_at(&w.db, &w.room, &outside_short)),
        None
    );
}

#[test]
fn a_folder_is_never_an_active_file() {
    let w = world(&[("src/a.ts", b"x")]);
    let folder = w.id("src");
    let (a, _b) = (w.member(Role::Viewer), w.member(Role::Viewer));
    let mut s = state(1, Some(&folder));
    s.cursor = None;
    assert_eq!(send(&w, &a, s), FrameOutcome::Dropped);
}

#[test]
fn a_rename_keeps_a_members_presence_and_moves_its_path() {
    use openmind_collab::files::RelPath;
    let w = world(&[("src/a.ts", b"x")]);
    let file = w.id("src/a.ts");
    let (a, _b) = (w.member(Role::Viewer), w.member(Role::Viewer));
    assert!(matches!(
        send(&w, &a, state(1, Some(&file))),
        FrameOutcome::Relay(_)
    ));
    std::fs::rename(w.ws.join("src"), w.ws.join("app")).expect("rename");
    let renames = vec![(
        RelPath::parse("src").expect("rel"),
        RelPath::parse("app").expect("rel"),
    )];
    block(w.runtime.refresh_share(&w.db, &w.room, renames, 9)).expect("refresh");
    let states = block(w.runtime.presence_states(&w.room));
    assert_eq!(states[0].1.active, Some(file.clone()), "the same file id");
    let path = block(w.runtime.file_path(&w.db, &w.room, &file)).expect("path");
    assert!(path.ends_with(std::path::Path::new("app").join("a.ts")));
    // The member's next state still names a file of the room.
    assert!(matches!(
        send(&w, &a, state(2, Some(&file))),
        FrameOutcome::Relay(_)
    ));
}

#[test]
fn after_an_ownership_transfer_the_hosting_user_still_shows_online() {
    let w = world(&[("a.txt", b"x")]);
    let a = w.member(Role::Editor);
    let host = block(w.runtime.identity(&w.db))
        .expect("identity")
        .peer_id();
    block(w.runtime.run_command(
        &w.db,
        &w.room,
        openmind_collab::Command::TransferOwnership { target: peer(&a) },
        60,
    ))
    .expect("transfer");
    let roster = block(w.runtime.roster(&w.room));
    let hosting = roster.iter().find(|e| e.peer == host).expect("host");
    assert_eq!(hosting.role, Role::Admin);
    assert!(
        hosting.online,
        "the hosting user is connected though no longer the Owner"
    );
    let view = block(w.runtime.room_view(&w.room, &peer(&a))).expect("view");
    assert_eq!(view.you.role, Role::Owner);
    assert!(view.members.iter().any(|m| m.peer == host && m.online));
}
