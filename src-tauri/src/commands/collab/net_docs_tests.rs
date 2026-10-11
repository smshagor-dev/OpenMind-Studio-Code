//! Collaborative editing end to end in the app (phase 6): the real `CollabRuntime` and machine database on the Owner,
//! a real folder, real WebRTC on the local-network route (no signaling server, STUN or TURN), participants with
//! Yjs-compatible documents. Also measures what normal use costs (printed with `--nocapture`).

use std::sync::Arc;
use std::time::{Duration, Instant};

use openmind_collab::authority::Command;
use openmind_collab::crdt::CollabDoc;
use openmind_collab::permission::Role;
use openmind_collab::{Actor, FileId, MessageId, PeerIdentity};
use openmind_collab_net::participant::{JoinMode, Participant};
use openmind_collab_net::remote::{self, DocEvent, RemoteEvent, RemoteWorkspace};
use openmind_collab_net::route;
use openmind_db::Db;
use tokio::sync::mpsc;

use super::super::host::{CollabRuntime, CreatedRoom, NewHostedRoom};
use super::lan_tests::{host_on_lan, lan_participant};
use super::tests::WAIT;

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
        let DocEvent::Sync { update, .. } = me.next(|e| matches!(e, DocEvent::Sync { .. })).await
        else {
            unreachable!()
        };
        me.doc.apply(&update).expect("sync");
        me
    }

    async fn next(&mut self, want: impl Fn(&DocEvent) -> bool) -> DocEvent {
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

    async fn edit(&mut self, text: &str) {
        let update = self.doc.set_text(text).expect("a change");
        let frame = self
            .remote
            .send_update(self.file.clone(), MessageId::random().expect("id"), update)
            .expect("send");
        let answer = self.next(|e| matches!(e, DocEvent::Acked { frame: f } | DocEvent::Rejected { frame: f, .. } if *f == frame)).await;
        assert!(matches!(answer, DocEvent::Acked { .. }), "{answer:?}");
    }

    async fn until(&mut self, expected: &str) {
        let deadline = tokio::time::Instant::now() + WAIT;
        while self.doc.text() != expected {
            assert!(
                tokio::time::Instant::now() < deadline,
                "stuck at {:?}",
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

struct Room {
    _dir: tempfile::TempDir,
    db: Db,
    runtime: Arc<CollabRuntime>,
    created: CreatedRoom,
}

async fn room() -> Room {
    let dir = tempfile::tempdir().expect("dir");
    let ws = dir.path().join("My Project");
    std::fs::create_dir_all(ws.join("src")).expect("mkdir");
    std::fs::write(ws.join("src/main.ts"), "let x = 1;\n").expect("write");
    let db = Db::connect(&dir.path().join("owner.db")).await.expect("db");
    let runtime = Arc::new(CollabRuntime::default());
    let path = ws.to_string_lossy().into_owned();
    let new = NewHostedRoom {
        name: "Lab",
        display_name: "Teacher",
        workspace_path: &path,
        workspace_name: "My Project",
    };
    let created = runtime.create_room(&db, &new, 1).await.expect("room");
    runtime
        .refresh_share(&db, &created.room_uid, Vec::new(), 2)
        .await
        .expect("share");
    Room {
        _dir: dir,
        db,
        runtime,
        created,
    }
}

impl Room {
    async fn file(&self) -> FileId {
        let host = Actor::Host(
            self.runtime
                .identity(&self.db)
                .await
                .expect("identity")
                .peer_id(),
        );
        let manifest = self
            .runtime
            .manifest(&self.db, &self.created.room_uid, host, 3)
            .await
            .expect("manifest");
        manifest
            .entries
            .values()
            .find(|e| e.path.as_str() == "src/main.ts")
            .map(|e| e.id.clone())
            .expect("file")
    }

    async fn editor(&self, port: u16, mode: Option<JoinMode>) -> (PeerIdentity, Participant) {
        let who = PeerIdentity::generate().expect("identity");
        let (mut config, options) = lan_participant(&self.created, port);
        if let Some(mode) = mode {
            config.mode = mode;
        }
        let routed = route::connect(who.clone(), config, options)
            .await
            .expect("joined over the local network");
        let target = who.peer_id();
        self.runtime
            .run_command(
                &self.db,
                &self.created.room_uid,
                Command::ChangeRole {
                    target,
                    role: Role::Editor,
                },
                4,
            )
            .await
            .expect("role");
        (who, routed.participant)
    }

    async fn canonical(&self, file: &FileId) -> String {
        let state = self
            .runtime
            .owner_doc_state(&self.created.room_uid, file)
            .await
            .expect("loaded");
        CollabDoc::restore(Some(&state), &[]).expect("state").text()
    }

    async fn stored(&self) -> i64 {
        sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM collab_crdt_updates")
            .fetch_one(self.db.pool())
            .await
            .expect("count")
    }
}

#[test]
fn three_editors_converge_on_a_real_file_over_the_local_network_and_it_is_stored() {
    tauri::async_runtime::block_on(async {
        let r = room().await;
        let file = r.file().await;
        let (owner, lan, port) = host_on_lan(&r.runtime, &r.db, &r.created).await;
        let started = Instant::now();
        let (_, a) = r.editor(port, None).await;
        let mut a = Editor::open(a, &file).await;
        println!(
            "[measure] join + first document sync over the local network: {} ms",
            started.elapsed().as_millis()
        );
        let (_, b) = r.editor(port, None).await;
        let mut b = Editor::open(b, &file).await;
        a.edit("let xa = 1;\n").await;
        b.edit("let xb = 1;\n").await;
        // The Owner's own editor (what `collab_doc_owner_update` does), forwarded to both participants.
        let owner_doc = CollabDoc::restore(
            Some(
                &r.runtime
                    .owner_doc_state(&r.created.room_uid, &file)
                    .await
                    .expect("state"),
            ),
            &[],
        )
        .expect("copy");
        let owner_update = owner_doc
            .set_text(&format!("// owner\n{}", owner_doc.text()))
            .expect("owner edit");
        for (peer, body) in r
            .runtime
            .owner_doc_update(&r.db, &r.created.room_uid, &file, owner_update, 5)
            .await
            .expect("owner")
        {
            owner.send(peer, body);
        }
        let expected = r.canonical(&file).await;
        a.until(&expected).await;
        b.until(&expected).await;
        assert!(
            expected.starts_with("// owner\n") && expected.contains('a') && expected.contains('b'),
            "{expected}"
        );
        assert!(r.stored().await >= 3, "every accepted change is stored");

        // Typing: 100 single-character changes, each acknowledged after it was stored.
        let started = Instant::now();
        let mut text = a.doc.text();
        for i in 0..100 {
            text.push(char::from(b'a' + (i % 26) as u8));
            a.edit(&text).await;
        }
        let per_key = started.elapsed().as_secs_f64() * 1000.0 / 100.0;
        println!(
            "[measure] typing: {per_key:.1} ms per keystroke from send to stored acknowledgement"
        );
        b.until(&r.canonical(&file).await).await;
        let started = Instant::now();
        let paste: String = (0..12_000).map(|i| format!("pasted line {i}\n")).collect();
        a.edit(&format!("{text}{paste}")).await;
        println!(
            "[measure] a 200 KB paste (sent in pieces): {} ms to stored",
            started.elapsed().as_millis()
        );
        b.until(&r.canonical(&file).await).await;
        owner.stop();
        lan.stop().await;
    });
}

#[test]
fn accepted_changes_come_back_after_an_owner_restart_and_a_fresh_session() {
    tauri::async_runtime::block_on(async {
        let r = room().await;
        let file = r.file().await;
        let (owner, lan, port) = host_on_lan(&r.runtime, &r.db, &r.created).await;
        let (who, participant) = r.editor(port, None).await;
        let (room_uid, owner_key) = (participant.room().clone(), *participant.owner_key());
        let mut a = Editor::open(participant, &file).await;
        a.edit("let x = 1;\n// unsaved by the Owner\n").await;
        a.remote.sender().close();
        owner.stop();
        lan.stop().await;

        // A new app process on the same database; the file on disk still holds the old text (nobody saved).
        let restarted = Room {
            runtime: Arc::new(CollabRuntime::default()),
            ..r
        };
        restarted
            .runtime
            .refresh_share(&restarted.db, &restarted.created.room_uid, Vec::new(), 6)
            .await
            .expect("share");
        let (owner, lan, port) =
            host_on_lan(&restarted.runtime, &restarted.db, &restarted.created).await;
        let started = Instant::now();
        let (mut config, options) = lan_participant(&restarted.created, port);
        config.mode = JoinMode::Reconnect {
            room: room_uid,
            owner_key,
        };
        let back = route::connect(who, config, options)
            .await
            .expect("rejoined")
            .participant;
        let a = Editor::open(back, &file).await;
        println!(
            "[measure] reopen after a restart (snapshot + updates recovered): {} ms",
            started.elapsed().as_millis()
        );
        assert_eq!(
            a.doc.text(),
            "let x = 1;\n// unsaved by the Owner\n",
            "recovered from storage, not reverted to disk"
        );
        owner.stop();
        lan.stop().await;
    });
}
