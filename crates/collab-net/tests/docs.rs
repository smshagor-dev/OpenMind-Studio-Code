//! Collaborative editing over real WebRTC (phase 6): the Owner's document host behind the network, participants with
//! Yjs-compatible `yrs` documents, on the local-network route (no relay, STUN or TURN) and on the Internet-relay route
//! — the same protocol on both.

mod common;

use std::sync::Arc;
use std::time::Duration;

use common::lan::*;
use common::*;
use openmind_collab::authority::Command;
use openmind_collab::crdt::CollabDoc;
use openmind_collab::permission::Role;
use openmind_collab::{FileId, MessageId, PeerIdentity};
use openmind_collab_net::participant::{JoinMode, Participant};
use openmind_collab_net::remote::{self, DocEvent, RemoteEvent, RemoteWorkspace};
use tokio::sync::mpsc;

struct Editor {
    remote: Arc<RemoteWorkspace>,
    events: mpsc::UnboundedReceiver<RemoteEvent>,
    doc: CollabDoc,
    file: FileId,
}

impl Editor {
    async fn open(participant: Participant, file: &FileId) -> Self {
        let (tx, events) = mpsc::unbounded_channel();
        let (remote, _task) = remote::spawn(
            participant,
            Arc::new(move |e| {
                let _ = tx.send(e);
            }),
        );
        let mut me = Self {
            remote,
            events,
            doc: CollabDoc::default(),
            file: file.clone(),
        };
        me.remote
            .subscribe(file.clone(), me.doc.state_vector())
            .expect("subscribe");
        let sync = me.next_doc(|e| matches!(e, DocEvent::Sync { .. })).await;
        let DocEvent::Sync { update, .. } = sync else {
            unreachable!()
        };
        me.doc.apply(&update).expect("initial sync");
        me
    }

    async fn next_doc(&mut self, want: impl Fn(&DocEvent) -> bool) -> DocEvent {
        tokio::time::timeout(WAIT, async {
            loop {
                match self.events.recv().await.expect("events") {
                    RemoteEvent::Doc(event) if want(&event) => return event,
                    RemoteEvent::Doc(DocEvent::Update { update, .. }) => {
                        let _ = self.doc.apply(&update);
                    }
                    _ => {}
                }
            }
        })
        .await
        .expect("a document event in time")
    }

    /// Edits locally and sends it; `Ok` when the Owner stored it, `Err(reason)` when it refused it.
    async fn edit(&mut self, text: &str) -> Result<(), String> {
        let update = self.doc.set_text(text).expect("a change");
        let frame = self
            .remote
            .send_update(self.file.clone(), MessageId::random().expect("id"), update)
            .expect("send");
        let answer = self
            .next_doc(|e| matches!(e, DocEvent::Acked { frame: f } | DocEvent::Rejected { frame: f, .. } if *f == frame))
            .await;
        match answer {
            DocEvent::Rejected { reason, .. } => Err(reason),
            _ => Ok(()),
        }
    }

    /// Applies what arrived until the text is `expected` (or fails after the wait).
    async fn until_text(&mut self, expected: &str) {
        let deadline = tokio::time::Instant::now() + WAIT;
        while self.doc.text() != expected {
            assert!(
                tokio::time::Instant::now() < deadline,
                "stuck at {:?}, want {expected:?}",
                self.doc.text()
            );
            if let Ok(Some(RemoteEvent::Doc(DocEvent::Update { update, .. }))) =
                tokio::time::timeout(Duration::from_millis(200), self.events.recv()).await
            {
                let _ = self.doc.apply(&update);
            }
        }
    }
}

async fn promote(world_authority: &MemoryAuthority, who: &PeerIdentity, role: Role) {
    world_authority
        .host_command(Command::ChangeRole {
            target: who.peer_id(),
            role,
        })
        .await;
}

async fn canonical(authority: &MemoryAuthority, file: &FileId) -> String {
    authority.docs.lock().await.text(file).expect("loaded")
}

/// Owner + two editors on the local network only.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn three_editors_converge_over_the_local_network() {
    let world = lan_world(free_udp_port()).await;
    world
        .authority
        .put("src/main.ts", b"let x = 1;\n".to_vec())
        .await;
    let file = world.authority.workspace.lock().await.id("src/main.ts");
    let (a_id, b_id) = (
        PeerIdentity::generate().expect("id"),
        PeerIdentity::generate().expect("id"),
    );
    let a = lan_join(
        &world,
        &a_id,
        JoinMode::Join,
        lan_only(world.discovery_port),
    )
    .await
    .expect("a");
    let b = lan_join(
        &world,
        &b_id,
        JoinMode::Join,
        lan_only(world.discovery_port),
    )
    .await
    .expect("b");
    promote(&world.authority, &a_id, Role::Editor).await;
    promote(&world.authority, &b_id, Role::Editor).await;
    let (mut a, mut b) = (
        Editor::open(a.participant, &file).await,
        Editor::open(b.participant, &file).await,
    );
    assert_eq!(a.doc.text(), "let x = 1;\n");
    // Concurrent edits at the same position, then one by the Owner.
    a.edit("let xa = 1;\n").await.expect("a stored");
    b.edit("let xb = 1;\n").await.expect("b stored");
    let owner_text = format!("// owner\n{}", canonical(&world.authority, &file).await);
    for (peer, body) in world.authority.owner_edit(&file, &owner_text).await {
        world.owner.send(peer, body);
    }
    let expected = canonical(&world.authority, &file).await;
    a.until_text(&expected).await;
    b.until_text(&expected).await;
    assert!(
        expected.starts_with("// owner\n") && expected.contains('a') && expected.contains('b'),
        "{expected}"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn the_same_protocol_works_through_the_internet_relay() {
    let world = world().await;
    world.authority.put("notes.md", b"# notes\n".to_vec()).await;
    let file = world.authority.workspace.lock().await.id("notes.md");
    let (id, participant) = join(&world).await;
    promote(&world.authority, &id, Role::Editor).await;
    let mut editor = Editor::open(participant, &file).await;
    editor
        .edit("# notes\nfrom the relay route\n")
        .await
        .expect("stored");
    assert_eq!(
        canonical(&world.authority, &file).await,
        "# notes\nfrom the relay route\n"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_viewer_is_refused_and_role_changes_apply_without_reconnecting() {
    let world = lan_world(free_udp_port()).await;
    world.authority.put("a.ts", b"abc".to_vec()).await;
    let file = world.authority.workspace.lock().await.id("a.ts");
    let me = PeerIdentity::generate().expect("id");
    let routed = lan_join(&world, &me, JoinMode::Join, lan_only(world.discovery_port))
        .await
        .expect("joined");
    let mut editor = Editor::open(routed.participant, &file).await; // a viewer may open and read
    let refused = editor.edit("abc VIEWER").await;
    assert!(
        refused.as_ref().is_err_and(|r| r.contains("file.write")),
        "{refused:?}"
    );
    assert_eq!(
        canonical(&world.authority, &file).await,
        "abc",
        "the canonical document is untouched"
    );

    promote(&world.authority, &me, Role::Editor).await;
    editor.doc = CollabDoc::restore(
        Some(
            &world
                .authority
                .docs
                .lock()
                .await
                .full_state(&file)
                .expect("state"),
        ),
        &[],
    )
    .expect("resync");
    editor
        .edit("abc EDITOR")
        .await
        .expect("an editor may write, same session");
    promote(&world.authority, &me, Role::Viewer).await;
    assert!(
        editor.edit("abc EDITOR DEMOTED").await.is_err(),
        "demoted: refused at once"
    );
    assert_eq!(canonical(&world.authority, &file).await, "abc EDITOR");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_large_paste_travels_in_pieces_and_arrives_whole() {
    let world = lan_world(free_udp_port()).await;
    world.authority.put("big.txt", b"start\n".to_vec()).await;
    let file = world.authority.workspace.lock().await.id("big.txt");
    let (a_id, b_id) = (
        PeerIdentity::generate().expect("id"),
        PeerIdentity::generate().expect("id"),
    );
    let a = lan_join(
        &world,
        &a_id,
        JoinMode::Join,
        lan_only(world.discovery_port),
    )
    .await
    .expect("a");
    let b = lan_join(
        &world,
        &b_id,
        JoinMode::Join,
        lan_only(world.discovery_port),
    )
    .await
    .expect("b");
    promote(&world.authority, &a_id, Role::Editor).await;
    let (mut a, mut b) = (
        Editor::open(a.participant, &file).await,
        Editor::open(b.participant, &file).await,
    );
    let paste: String = (0..12_000).map(|i| format!("pasted line {i}\n")).collect(); // ~200 KB, several chunks
    let big = format!("start\n{paste}");
    a.edit(&big).await.expect("a large paste is stored");
    assert_eq!(canonical(&world.authority, &file).await, big);
    b.until_text(&big).await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn forged_unopened_and_malformed_changes_are_refused() {
    let world = lan_world(free_udp_port()).await;
    world.authority.put("a.ts", b"abc".to_vec()).await;
    let file = world.authority.workspace.lock().await.id("a.ts");
    let me = PeerIdentity::generate().expect("id");
    let routed = lan_join(&world, &me, JoinMode::Join, lan_only(world.discovery_port))
        .await
        .expect("joined");
    promote(&world.authority, &me, Role::Editor).await;
    let mut editor = Editor::open(routed.participant, &file).await;
    let forged = FileId::random().expect("id");
    let update = CollabDoc::from_text("x").full_state();
    let frame = editor
        .remote
        .send_update(forged.clone(), MessageId::random().expect("id"), update)
        .expect("send");
    let answer = editor.next_doc(|e| matches!(e, DocEvent::Rejected { frame: f, .. } | DocEvent::Acked { frame: f } if *f == frame)).await;
    assert!(
        matches!(answer, DocEvent::Rejected { .. }),
        "an unknown or unopened file: {answer:?}"
    );
    let frame = editor
        .remote
        .send_update(
            file.clone(),
            MessageId::random().expect("id"),
            b"not yjs".to_vec(),
        )
        .expect("send");
    let answer = editor.next_doc(|e| matches!(e, DocEvent::Rejected { frame: f, .. } | DocEvent::Acked { frame: f } if *f == frame)).await;
    assert!(
        matches!(answer, DocEvent::Rejected { .. }),
        "malformed: {answer:?}"
    );
    editor.remote.subscribe(forged, vec![0]).expect("send");
    assert_eq!(canonical(&world.authority, &file).await, "abc");
    editor
        .edit("abc still works")
        .await
        .expect("the session is fine after refusals");
}
