//! Collaborative documents against a real machine database and real temporary workspaces: opening, authorized and
//! idempotent changes, storage and recovery (snapshot + updates), the disk baseline, deletes, hidden and binary files.

use std::path::{Path, PathBuf};

use openmind_collab::authority::{Command, JoinOutcome};
use openmind_collab::crdt::CollabDoc;
use openmind_collab::permission::Role;
use openmind_collab::protocol::{Body, Bytes, DocClosedReason, Handshake};
use openmind_collab::{Actor, FileId, JoinRequest, MessageId, PeerIdentity, RoomCode, RoomUid};
use openmind_collab_net::owner::FrameOutcome;
use openmind_db::Db;

use super::super::{CollabRuntime, NewHostedRoom};
use super::OwnerDocEvent;

pub(crate) fn block<F: std::future::Future>(f: F) -> F::Output {
    tauri::async_runtime::block_on(f)
}

pub(crate) struct World {
    _dir: tempfile::TempDir,
    pub(crate) db: Db,
    pub(crate) runtime: CollabRuntime,
    pub(crate) ws: PathBuf,
    pub(crate) room: String,
    code: String,
}

pub(crate) fn world(files: &[(&str, &[u8])]) -> World {
    let dir = tempfile::tempdir().expect("tempdir");
    let db = block(Db::connect(&dir.path().join("owner.db"))).expect("db");
    let ws = dir.path().join("My Project");
    for (rel, bytes) in files {
        let path = ws.join(rel);
        std::fs::create_dir_all(path.parent().expect("parent")).expect("mkdir");
        std::fs::write(path, bytes).expect("write");
    }
    let runtime = CollabRuntime::default();
    let path = ws.to_string_lossy().into_owned();
    let new = NewHostedRoom {
        name: "Docs",
        display_name: "Owner",
        workspace_path: &path,
        workspace_name: "My Project",
    };
    let created = block(runtime.create_room(&db, &new, 1)).expect("room");
    let w = World {
        _dir: dir,
        db,
        runtime,
        ws,
        room: created.room_uid,
        code: created.code,
    };
    w.share();
    w
}

impl World {
    fn share(&self) {
        block(
            self.runtime
                .refresh_share(&self.db, &self.room, Vec::new(), 2),
        )
        .expect("share");
    }

    pub(crate) fn member(&self, role: Role) -> Actor {
        self.member_with_identity(role).1
    }

    /// A new member and its identity (to reconnect it later with a signed request).
    pub(crate) fn member_with_identity(&self, role: Role) -> (PeerIdentity, Actor) {
        let who = PeerIdentity::generate().expect("identity");
        let bound = openmind_collab::Authority::new_challenge().expect("challenge");
        let uid = RoomUid::parse(&self.room).expect("uid");
        let code = RoomCode::parse(&self.code).expect("code");
        let request = Handshake::Join(JoinRequest::create(&who, &code, &uid, &bound, "Member"));
        let JoinOutcome::Admitted(admission) =
            block(self.runtime.admit(&self.db, &self.room, request, bound, 3)).expect("admit")
        else {
            panic!("not admitted")
        };
        if role != Role::Viewer {
            self.role(&who.peer_id(), role);
        }
        let actor = Actor::Remote {
            peer: who.peer_id(),
            session: admission.session,
        };
        (who, actor)
    }

    /// A known member's signed reconnect on a new connection: its new session, or why the room refused it.
    pub(crate) fn reconnect(&self, who: &PeerIdentity, now: i64) -> Result<Actor, String> {
        let bound = openmind_collab::Authority::new_challenge().expect("challenge");
        let uid = RoomUid::parse(&self.room).expect("uid");
        let request =
            Handshake::Reconnect(openmind_collab::ReconnectRequest::create(who, &uid, &bound));
        match block(
            self.runtime
                .admit(&self.db, &self.room, request, bound, now),
        )? {
            JoinOutcome::Admitted(admission) => Ok(Actor::Remote {
                peer: who.peer_id(),
                session: admission.session,
            }),
            other => Err(format!("not admitted: {other:?}")),
        }
    }

    pub(crate) fn role(&self, peer: &openmind_collab::PeerId, role: Role) {
        block(self.runtime.run_command(
            &self.db,
            &self.room,
            Command::ChangeRole {
                target: peer.clone(),
                role,
            },
            4,
        ))
        .expect("role");
    }

    pub(crate) fn id(&self, path: &str) -> FileId {
        let host = Actor::Host(
            block(self.runtime.identity(&self.db))
                .expect("identity")
                .peer_id(),
        );
        let manifest =
            block(self.runtime.manifest(&self.db, &self.room, host, 5)).expect("manifest");
        manifest
            .entries
            .values()
            .find(|e| e.path.as_str() == path)
            .map(|e| e.id.clone())
            .expect("shared")
    }

    fn frame(&self, actor: &Actor, body: Body) -> (FrameOutcome, Vec<OwnerDocEvent>) {
        block(
            self.runtime
                .doc_frame(&self.db, &self.room, actor.clone(), body, 6),
        )
    }

    /// Opens `file` as `actor`; the participant's synced copy.
    pub(crate) fn open(&self, actor: &Actor, file: &FileId) -> CollabDoc {
        let mine = CollabDoc::default();
        let (outcome, _) = self.frame(
            actor,
            Body::YjsStateRequest {
                file: file.clone(),
                state_vector: Bytes(mine.state_vector()),
            },
        );
        let FrameOutcome::Reply(messages) = outcome else {
            panic!("{outcome:?}")
        };
        let Some(Body::DocSync { update, .. }) = messages.first().map(|(_, b)| b.clone()) else {
            panic!("{messages:?}")
        };
        mine.apply(&update.0).expect("sync");
        mine
    }

    fn send(&self, actor: &Actor, file: &FileId, id: MessageId, update: Vec<u8>) -> FrameOutcome {
        self.frame(
            actor,
            Body::YjsUpdate {
                file: file.clone(),
                id,
                update: Bytes(update),
            },
        )
        .0
    }

    fn stored_updates(&self) -> i64 {
        block(
            sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM collab_crdt_updates")
                .fetch_one(self.db.pool()),
        )
        .expect("count")
    }
}

fn write(path: &Path, text: &str) {
    std::fs::write(path, text).expect("write");
}

#[test]
fn an_editors_change_is_stored_once_forwarded_and_handed_to_the_owners_editor() {
    let w = world(&[("src/a.ts", b"let x = 1;\n")]);
    let file = w.id("src/a.ts");
    let (a, b) = (w.member(Role::Editor), w.member(Role::Editor));
    let doc_a = w.open(&a, &file);
    let (outcome, events) = w.frame(
        &b,
        Body::YjsStateRequest {
            file: file.clone(),
            state_vector: Bytes(CollabDoc::default().state_vector()),
        },
    );
    assert!(matches!(outcome, FrameOutcome::Reply(_)));
    assert!(events.is_empty(), "the document was already active");
    let before = w.stored_updates();
    let update = doc_a.set_text("let x = 2;\n").expect("edit");
    let id = MessageId::random().expect("id");
    let FrameOutcome::Reply(forward) = w.send(&a, &file, id.clone(), update.clone()) else {
        panic!("refused")
    };
    assert_eq!(forward.len(), 1, "to the other editor");
    assert_eq!(w.stored_updates(), before + 1);
    // The same change again (a reconnect): nothing new stored or sent.
    assert_eq!(
        w.send(&a, &file, id, update),
        FrameOutcome::Reply(Vec::new())
    );
    assert_eq!(w.stored_updates(), before + 1);
}

#[test]
fn the_first_open_activates_the_owners_editor_on_the_real_path() {
    let w = world(&[("src/a.ts", b"x")]);
    let file = w.id("src/a.ts");
    let a = w.member(Role::Viewer);
    let (_, events) = w.frame(
        &a,
        Body::YjsStateRequest {
            file: file.clone(),
            state_vector: Bytes(CollabDoc::default().state_vector()),
        },
    );
    let [OwnerDocEvent::Active { file: active, path }] = events.as_slice() else {
        panic!("{events:?}")
    };
    assert_eq!(active, &file);
    assert!(path.ends_with("src/a.ts") || path.ends_with("src\\a.ts"));
}

#[test]
fn a_viewer_is_refused_until_promoted_without_reconnecting() {
    let w = world(&[("a.ts", b"abc")]);
    let file = w.id("a.ts");
    let viewer = w.member(Role::Viewer);
    let doc = w.open(&viewer, &file);
    let update = doc.set_text("abc!").expect("edit");
    let refused = w.send(
        &viewer,
        &file,
        MessageId::random().expect("id"),
        update.clone(),
    );
    assert!(
        matches!(&refused, FrameOutcome::Rejected(r) if r.contains("file.write")),
        "{refused:?}"
    );
    let before = w.stored_updates();
    let Actor::Remote { peer, .. } = &viewer else {
        unreachable!()
    };
    w.role(peer, Role::Editor);
    assert!(matches!(
        w.send(&viewer, &file, MessageId::random().expect("id"), update),
        FrameOutcome::Reply(_)
    ));
    assert_eq!(w.stored_updates(), before + 1);
    w.role(peer, Role::Viewer);
    let later = doc.set_text("abc!?").expect("edit");
    assert!(
        matches!(
            w.send(&viewer, &file, MessageId::random().expect("id"), later),
            FrameOutcome::Rejected(_)
        ),
        "demoted at once"
    );
}

#[test]
fn unsaved_accepted_changes_survive_a_restart_but_an_outside_edit_wins() {
    let w = world(&[("a.ts", b"one\n")]);
    let file = w.id("a.ts");
    let editor = w.member(Role::Editor);
    let doc = w.open(&editor, &file);
    let update = doc.set_text("one\ntwo\n").expect("edit");
    assert!(matches!(
        w.send(&editor, &file, MessageId::random().expect("id"), update),
        FrameOutcome::Reply(_)
    ));
    // Restart: a fresh runtime on the same database; the file on disk was never saved by the Owner.
    let restarted = World {
        runtime: CollabRuntime::default(),
        ..w
    };
    restarted.share();
    let again = restarted.member(Role::Editor);
    assert_eq!(
        restarted.open(&again, &file).text(),
        "one\ntwo\n",
        "the stored change wins over the unchanged file"
    );
    // Edited outside the room while nobody had it open: the disk wins, as an Owner change everyone receives.
    let restarted = World {
        runtime: CollabRuntime::default(),
        ..restarted
    };
    write(&restarted.ws.join("a.ts"), "outside\n");
    restarted.share();
    let third = restarted.member(Role::Editor);
    assert_eq!(restarted.open(&third, &file).text(), "outside\n");
}

#[test]
fn resuming_hosting_hands_unsaved_accepted_changes_back_to_the_owners_editor() {
    let w = world(&[("a.ts", b"one\n"), ("b.ts", b"same\n")]);
    let (changed, untouched) = (w.id("a.ts"), w.id("b.ts"));
    let editor = w.member(Role::Editor);
    let update = w
        .open(&editor, &changed)
        .set_text("one\ntwo\n")
        .expect("edit");
    assert!(matches!(
        w.send(&editor, &changed, MessageId::random().expect("id"), update),
        FrameOutcome::Reply(_)
    ));
    w.open(&editor, &untouched); // opened, never changed: nothing to recover
                                 // The Owner's app ended without saving (a crash); hosting resumes on the same database.
    let restarted = World {
        runtime: CollabRuntime::default(),
        ..w
    };
    restarted.share();
    let events = block(
        restarted
            .runtime
            .docs_recover(&restarted.db, &restarted.room, 50),
    );
    let [OwnerDocEvent::Active { file, path }] = events.as_slice() else {
        panic!("{events:?}")
    };
    assert_eq!(file, &changed);
    assert!(path.ends_with("a.ts"));
    let state =
        block(restarted.runtime.owner_doc_state(&restarted.room, &changed)).expect("loaded");
    let doc = CollabDoc::restore(None, &[state]).expect("doc");
    assert_eq!(
        doc.text(),
        "one\ntwo\n",
        "the Owner's editor gets the accepted text"
    );
    assert!(
        block(
            restarted
                .runtime
                .owner_doc_state(&restarted.room, &untouched)
        )
        .is_none(),
        "a document that matches its file stays unloaded"
    );
    assert!(
        block(
            restarted
                .runtime
                .docs_recover(&restarted.db, &restarted.room, 51)
        )
        .is_empty(),
        "already handed over: not again"
    );
}

#[test]
fn deleted_hidden_forged_and_binary_files_can_not_be_edited() {
    let w = world(&[
        ("a.ts", b"abc"),
        (".env", b"SECRET=1"),
        ("logo.png", &[0x89, b'P', b'N', b'G', 0, 0, 1]),
    ]);
    let file = w.id("a.ts");
    let editor = w.member(Role::Editor);
    let doc = w.open(&editor, &file);
    let closed = |outcome: FrameOutcome| match outcome {
        FrameOutcome::Reply(m) => m.iter().find_map(|(_, b)| match b {
            Body::DocClosed { reason, .. } => Some(*reason),
            _ => None,
        }),
        _ => None,
    };
    let forged = FileId::random().expect("id");
    let (outcome, _) = w.frame(
        &editor,
        Body::YjsStateRequest {
            file: forged.clone(),
            state_vector: Bytes(vec![0]),
        },
    );
    assert_eq!(
        closed(outcome),
        Some(DocClosedReason::Unavailable),
        "unknown or hidden look the same"
    );
    let png = w.id("logo.png");
    let (outcome, _) = w.frame(
        &editor,
        Body::YjsStateRequest {
            file: png,
            state_vector: Bytes(vec![0]),
        },
    );
    assert_eq!(closed(outcome), Some(DocClosedReason::NotEditable));
    assert!(matches!(
        w.send(
            &editor,
            &forged,
            MessageId::random().expect("id"),
            doc.set_text("x").expect("e")
        ),
        FrameOutcome::Rejected(_)
    ));

    std::fs::remove_file(w.ws.join("a.ts")).expect("delete");
    let change = block(w.runtime.refresh_share(&w.db, &w.room, Vec::new(), 7))
        .expect("refresh")
        .expect("delta");
    let openmind_collab_net::owner::TreeChange::Delta { removed, .. } = change else {
        panic!("delta")
    };
    let (send, events) = block(w.runtime.docs_after_share(&w.db, &w.room, &removed, 8));
    assert!(send.iter().any(|(_, b)| matches!(
        b,
        Body::DocClosed {
            reason: DocClosedReason::Deleted,
            ..
        }
    )));
    assert!(events.contains(&OwnerDocEvent::Closed { file: file.clone() }));
    let late = w.send(
        &editor,
        &file,
        MessageId::random().expect("id"),
        doc.set_text("late").expect("e"),
    );
    assert!(
        matches!(late, FrameOutcome::Rejected(_)),
        "a late change to a deleted file"
    );
    assert!(!w.ws.join("a.ts").exists(), "nothing recreated the file");
}

#[test]
fn strangers_stale_sessions_other_rooms_bad_state_vectors_and_oversized_updates_fail_safely() {
    let w = world(&[("a.ts", b"abc")]);
    let file = w.id("a.ts");
    let editor = w.member(Role::Editor);
    let doc = w.open(&editor, &file);
    let unavailable = |outcome: FrameOutcome| matches!(outcome, FrameOutcome::Reply(m) if m.iter().any(|(_, b)| matches!(b, Body::DocClosed { reason: DocClosedReason::Unavailable, .. })));
    // Not a member at all, or a member's old session: nothing opens, nothing changes.
    let stranger = Actor::Remote {
        peer: PeerIdentity::generate().expect("id").peer_id(),
        session: openmind_collab::SessionId::random().expect("s"),
    };
    assert!(unavailable(
        w.frame(
            &stranger,
            Body::YjsStateRequest {
                file: file.clone(),
                state_vector: Bytes(vec![0])
            }
        )
        .0
    ));
    let Actor::Remote { peer, .. } = &editor else {
        unreachable!()
    };
    let stale = Actor::Remote {
        peer: peer.clone(),
        session: openmind_collab::SessionId::random().expect("s"),
    };
    let update = doc.set_text("abc stale").expect("edit");
    assert!(matches!(
        w.send(&stale, &file, MessageId::random().expect("id"), update),
        FrameOutcome::Rejected(_)
    ));
    // A file id of another room is unknown here.
    let other = world(&[("a.ts", b"zzz")]);
    let foreign = other.id("a.ts");
    assert!(unavailable(
        w.frame(
            &editor,
            Body::YjsStateRequest {
                file: foreign,
                state_vector: Bytes(vec![0])
            }
        )
        .0
    ));
    // A malformed state vector and an oversized update are refused without touching the document.
    let (bad_sv, _) = w.frame(
        &editor,
        Body::YjsStateRequest {
            file: file.clone(),
            state_vector: Bytes(vec![0xFF; 9]),
        },
    );
    assert!(matches!(bad_sv, FrameOutcome::Rejected(_)), "{bad_sv:?}");
    let huge = vec![0u8; openmind_collab::protocol::MAX_UPDATE_BYTES + 1];
    assert!(matches!(
        w.send(&editor, &file, MessageId::random().expect("id"), huge),
        FrameOutcome::Rejected(_)
    ));
    assert_eq!(
        CollabDoc::restore(
            Some(&block(w.runtime.owner_doc_state(&w.room, &file)).expect("state")),
            &[]
        )
        .expect("doc")
        .text(),
        "abc"
    );
}
