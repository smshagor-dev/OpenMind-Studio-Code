//! The app's network paths end to end, without a window: an Owner machine database behind the real `CollabRuntime`,
//! a participant machine database, a real relay and real WebRTC on loopback.

use std::sync::Arc;
use std::time::Duration;

use openmind_collab::audit::{verify_chain, ChainHead};
use openmind_collab::authority::{Command, JoinOutcome};
use openmind_collab::ids::Challenge;
use openmind_collab::manifest::ManifestSnapshot;
use openmind_collab::permission::Role;
use openmind_collab::protocol::{Admission, Body, Frame, Handshake};
use openmind_collab::transfer::{FileErrorCode, Snapshot};
use openmind_collab::{Actor, FileId, PeerId, PeerIdentity, RoomCode, RoomUid, SessionId};
use openmind_collab_net::ice::IceSetup;
use openmind_collab_net::owner::{
    FrameOutcome, OwnerAuthority, OwnerEvent, OwnerNetwork, OwnerOptions,
};
use openmind_collab_net::participant::{self, JoinMode, ParticipantConfig, ParticipantEvent};
use openmind_collab_net::relay::TurnRelay;
use openmind_collab_net::signaling::WsSignaling;
use openmind_collab_net::stun::StunGatherer;
use openmind_collab_net::transport::BoxFuture;
use openmind_collab_net::ConnectionState;
use openmind_collab_signal::{Relay, RelayConfig, Topic};
use openmind_db::collab::{logs, members, rooms, sessions};
use openmind_db::Db;

use super::super::host::{CollabRuntime, NewHostedRoom};
use super::super::persist;

pub(super) const WAIT: Duration = Duration::from_secs(20);

/// The same calls `AppAuthority` makes, over a runtime and a database instead of the Tauri app.
pub(super) struct RuntimeAuthority {
    pub(super) runtime: Arc<CollabRuntime>,
    pub(super) db: Db,
    pub(super) room: RoomUid,
}

impl OwnerAuthority for RuntimeAuthority {
    fn room_uid(&self) -> RoomUid {
        self.room.clone()
    }
    fn topic(&self) -> BoxFuture<'_, Result<Topic, String>> {
        Box::pin(async move {
            Topic::parse(&self.runtime.topic(&self.db, self.room.as_str(), 10).await?)
        })
    }
    fn hello(
        &self,
        challenge: Challenge,
        bound: Challenge,
    ) -> BoxFuture<'_, Result<Handshake, String>> {
        Box::pin(
            self.runtime
                .hello(&self.db, self.room.as_str(), challenge, bound, 11),
        )
    }
    fn admit(
        &self,
        request: Handshake,
        bound: Challenge,
    ) -> BoxFuture<'_, Result<JoinOutcome, String>> {
        Box::pin(
            self.runtime
                .admit(&self.db, self.room.as_str(), request, bound, 12),
        )
    }
    fn admit_approved(&self, peer: PeerId) -> BoxFuture<'_, Result<Admission, String>> {
        Box::pin(
            self.runtime
                .admit_approved(&self.db, self.room.as_str(), peer, 13),
        )
    }
    fn frame(&self, actor: Actor, frame: Frame) -> BoxFuture<'_, FrameOutcome> {
        Box::pin(async move {
            self.runtime
                .remote_frame(&self.db, self.room.as_str(), actor, frame, 14)
                .await
                .0
        })
    }
    fn disconnected(&self, peer: PeerId, session: SessionId, reason: String) -> BoxFuture<'_, ()> {
        Box::pin(async move {
            let _ = self
                .runtime
                .disconnected(&self.db, self.room.as_str(), peer, session, reason, 15)
                .await;
        })
    }
    fn manifest(&self, actor: Actor) -> BoxFuture<'_, Result<ManifestSnapshot, String>> {
        Box::pin(
            self.runtime
                .manifest(&self.db, self.room.as_str(), actor, 16),
        )
    }
    fn open_file(
        &self,
        actor: Actor,
        file: FileId,
    ) -> BoxFuture<'_, Result<Snapshot, FileErrorCode>> {
        Box::pin(self.runtime.open_file(self.room.as_str(), actor, file))
    }
}

fn ice() -> IceSetup {
    IceSetup {
        bind_ip: Some("127.0.0.1".parse().expect("ip")),
        ..IceSetup::default()
    }
}

pub(super) async fn wait_owner(
    events: &mut tokio::sync::mpsc::UnboundedReceiver<OwnerEvent>,
    f: impl Fn(&OwnerEvent) -> bool,
) {
    tokio::time::timeout(WAIT, async {
        while let Some(event) = events.recv().await {
            if f(&event) {
                return;
            }
        }
    })
    .await
    .expect("owner event in time");
}

async fn answer(
    student: &mut participant::Participant,
    id: &openmind_collab::MessageId,
) -> Result<(), String> {
    tokio::time::timeout(WAIT, async {
        loop {
            match student.next_event().await.expect("events") {
                ParticipantEvent::Frame(Frame {
                    body: Body::Ack { of },
                    ..
                }) if of == *id => return Ok(()),
                ParticipantEvent::Frame(Frame {
                    body: Body::Reject { of, reason },
                    ..
                }) if of == *id => return Err(reason),
                _ => {}
            }
        }
    })
    .await
    .expect("answer in time")
}

#[test]
fn a_remote_participant_is_persisted_authorized_and_audited_on_both_machines() {
    tauri::async_runtime::block_on(async {
        let (owner_dir, guest_dir) = (
            tempfile::tempdir().expect("dir"),
            tempfile::tempdir().expect("dir"),
        );
        let owner_db = Db::connect(&owner_dir.path().join("owner.db"))
            .await
            .expect("db");
        let guest_db = Db::connect(&guest_dir.path().join("guest.db"))
            .await
            .expect("db");
        let runtime = Arc::new(CollabRuntime::default());
        let new = NewHostedRoom {
            name: "Physics",
            display_name: "Teacher",
            workspace_path: "C:/w",
            workspace_name: "w",
        };
        let created = runtime.create_room(&owner_db, &new, 1).await.expect("room");
        let room = RoomUid::parse(&created.room_uid).expect("uid");
        let relay = Relay::start("127.0.0.1:0".parse().expect("addr"), RelayConfig::default())
            .await
            .expect("relay");
        let url = format!("ws://{}", relay.addr());
        let authority = Arc::new(RuntimeAuthority {
            runtime: runtime.clone(),
            db: owner_db.clone(),
            room: room.clone(),
        });
        let options = OwnerOptions {
            ice: ice(),
            gatherer: Arc::new(StunGatherer::new(Vec::new())),
            relay: Arc::new(TurnRelay::new(Vec::new())),
            peer_connect_timeout: Duration::from_secs(10),
            handshake_timeout: Duration::from_secs(15),
        };
        let (owner, mut events) =
            OwnerNetwork::start(authority, Arc::new(WsSignaling::direct(&url)), options);
        // The participant can only find the room once the Owner is registered with the relay.
        wait_owner(&mut events, |e| {
            matches!(
                e,
                OwnerEvent::Signaling {
                    state: ConnectionState::Connected
                }
            )
        })
        .await;

        let code = RoomCode::parse(&created.code).expect("code");
        let guest = PeerIdentity::generate().expect("identity");
        let config = ParticipantConfig {
            code: code.clone(),
            display_name: "Student".into(),
            mode: JoinMode::Join,
            ice: ice(),
            gatherer: Arc::new(StunGatherer::new(Vec::new())),
            relay: Arc::new(TurnRelay::new(Vec::new())),
            handshake_timeout: WAIT,
            approval_timeout: WAIT,
            on_pending: None,
        };
        let mut student =
            participant::connect(guest.clone(), config, Arc::new(WsSignaling::direct(&url)))
                .await
                .expect("joined");
        super::remember(&guest_db, &student, &code)
            .await
            .expect("participant history");

        // Owner machine: the member and session are stored.
        let row = rooms::get_by_uid(owner_db.pool(), room.as_str())
            .await
            .expect("get")
            .expect("row");
        let people = members::list(owner_db.pool(), row.id)
            .await
            .expect("members");
        assert!(people.iter().any(|m| m.peer == guest.peer_id().as_str()
            && m.status == "active"
            && m.role == "viewer"));
        assert_eq!(
            sessions::list(owner_db.pool(), row.id, 10)
                .await
                .expect("sessions")
                .len(),
            1
        );

        // Authorization happens in the authority for the authenticated session.
        let id = student
            .send(Body::Command {
                command: Command::SetLocked { locked: true },
            })
            .expect("send");
        assert!(answer(&mut student, &id)
            .await
            .expect_err("viewer")
            .contains("room.lock"));
        runtime
            .run_command(
                &owner_db,
                room.as_str(),
                Command::ChangeRole {
                    target: guest.peer_id(),
                    role: Role::Admin,
                },
                20,
            )
            .await
            .expect("promote");
        let id = student
            .send(Body::Command {
                command: Command::SetLocked { locked: true },
            })
            .expect("send");
        assert_eq!(answer(&mut student, &id).await, Ok(()));
        assert!(
            rooms::get_by_uid(owner_db.pool(), room.as_str())
                .await
                .expect("get")
                .expect("row")
                .locked
        );

        // Leaving is detected and recorded; the whole history verifies with the host's key.
        student.close();
        wait_owner(&mut events, |e| matches!(e, OwnerEvent::Left { .. })).await;
        let ended = sessions::list(owner_db.pool(), row.id, 10)
            .await
            .expect("sessions");
        assert!(ended[0].ended_at.is_some());
        let stored = logs::list_after(owner_db.pool(), row.id, 0, 100)
            .await
            .expect("logs");
        let parsed: Vec<_> = stored
            .iter()
            .map(|r| persist::event_of(r, &room).expect("event"))
            .collect();
        let key = runtime
            .identity(&owner_db)
            .await
            .expect("identity")
            .public_key();
        assert!(verify_chain(&parsed, &ChainHead::genesis(), Some(&key)).is_ok());
        let kinds: Vec<&str> = stored.iter().map(|r| r.kind.as_str()).collect();
        for kind in [
            "member.joined",
            "session.started",
            "member.roleChanged",
            "room.locked",
            "session.ended",
        ] {
            assert!(kinds.contains(&kind), "{kind} in {kinds:?}");
        }

        // Participant machine: the joined room, the pinned Owner key, the protected code and its own session.
        let joined = rooms::get_by_uid(guest_db.pool(), room.as_str())
            .await
            .expect("get")
            .expect("row");
        assert_eq!(
            (joined.relation.as_str(), joined.local_role.as_str()),
            ("joined", "viewer")
        );
        assert_eq!(joined.owner_public_key, key.to_text());
        assert!(!joined
            .invite_secret
            .clone()
            .unwrap_or_default()
            .contains(&created.code[3..]));
        assert_eq!(
            sessions::list(guest_db.pool(), joined.id, 10)
                .await
                .expect("sessions")
                .len(),
            1
        );
        owner.stop();
        relay.stop().await;
    });
}

type RemoteEvents = tokio::sync::mpsc::UnboundedReceiver<openmind_collab_net::remote::RemoteEvent>;

/// Hosts `created` on a fresh loopback relay and joins it as a viewer that follows the shared workspace.
async fn host_and_join(
    runtime: &Arc<CollabRuntime>,
    db: &Db,
    created: &super::super::host::CreatedRoom,
) -> (
    OwnerNetwork,
    Relay,
    Arc<openmind_collab_net::remote::RemoteWorkspace>,
    RemoteEvents,
) {
    let relay = Relay::start("127.0.0.1:0".parse().expect("addr"), RelayConfig::default())
        .await
        .expect("relay");
    let url = format!("ws://{}", relay.addr());
    let room = RoomUid::parse(&created.room_uid).expect("uid");
    let authority = Arc::new(RuntimeAuthority {
        runtime: runtime.clone(),
        db: db.clone(),
        room,
    });
    let options = OwnerOptions {
        ice: ice(),
        gatherer: Arc::new(StunGatherer::new(Vec::new())),
        relay: Arc::new(TurnRelay::new(Vec::new())),
        peer_connect_timeout: Duration::from_secs(10),
        handshake_timeout: Duration::from_secs(15),
    };
    let (owner, mut events) =
        OwnerNetwork::start(authority, Arc::new(WsSignaling::direct(&url)), options);
    let registered = |e: &OwnerEvent| {
        matches!(
            e,
            OwnerEvent::Signaling {
                state: ConnectionState::Connected
            }
        )
    };
    wait_owner(&mut events, registered).await;
    let config = ParticipantConfig {
        code: RoomCode::parse(&created.code).expect("code"),
        display_name: "Student".into(),
        mode: JoinMode::Join,
        ice: ice(),
        gatherer: Arc::new(StunGatherer::new(Vec::new())),
        relay: Arc::new(TurnRelay::new(Vec::new())),
        handshake_timeout: WAIT,
        approval_timeout: WAIT,
        on_pending: None,
    };
    let guest = PeerIdentity::generate().expect("identity");
    let student = participant::connect(guest, config, Arc::new(WsSignaling::direct(&url)))
        .await
        .expect("joined");
    let (tx, rx) = tokio::sync::mpsc::unbounded_channel();
    let (workspace, _task) = openmind_collab_net::remote::spawn(
        student,
        Arc::new(move |e| {
            let _ = tx.send(e);
        }),
    );
    (owner, relay, workspace, rx)
}

/// A folder with a multi-chunk source file (returned) and a secret that must never be shared.
pub(super) fn shared_folder(parent: &std::path::Path) -> (std::path::PathBuf, String) {
    let ws = parent.join("My Project");
    std::fs::create_dir_all(ws.join("src")).expect("mkdir");
    let big: String = (0..40_000)
        .map(|i| {
            format!(
                "line {i}
"
            )
        })
        .collect();
    std::fs::write(ws.join("src/main.ts"), &big).expect("write");
    std::fs::write(ws.join(".env"), "SECRET=1").expect("write");
    (ws, big)
}

/// Phase 5 end to end: the real share code (crawl, privacy floor, stored ids, snapshots) behind real WebRTC. The
/// participant gets the tree without any file content, fetches one file verified, and follows a rename the way the
/// watcher reports it (`net_share::drain` does exactly `refresh_share` + `tree_changed`).
#[test]
fn a_participant_browses_fetches_and_follows_the_owners_real_folder() {
    use openmind_collab::RelPath;
    use openmind_collab_net::remote::RemoteEvent;
    tauri::async_runtime::block_on(async {
        let dir = tempfile::tempdir().expect("dir");
        let (ws, big) = shared_folder(dir.path());
        let db = Db::connect(&dir.path().join("owner.db")).await.expect("db");
        let runtime = Arc::new(CollabRuntime::default());
        let path = ws.to_string_lossy().into_owned();
        let new = NewHostedRoom {
            name: "R",
            display_name: "Owner",
            workspace_path: &path,
            workspace_name: "My Project",
        };
        let created = runtime.create_room(&db, &new, 1).await.expect("room");
        runtime
            .refresh_share(&db, &created.room_uid, Vec::new(), 2)
            .await
            .expect("share");
        let (owner, relay, workspace, mut rx) = host_and_join(&runtime, &db, &created).await;

        until(&mut rx, |e| matches!(e, RemoteEvent::TreeReady { .. })).await;
        let mut paths: Vec<String> =
            workspace.tree(|t| t.entries().values().map(|e| e.path.to_string()).collect());
        paths.sort();
        assert_eq!(
            paths,
            ["src", "src/main.ts"],
            "no secret, and nothing downloaded yet"
        );
        assert_eq!(workspace.files().active(), 0);
        let main = workspace
            .tree(|t| {
                t.entries()
                    .values()
                    .find(|e| e.path.as_str() == "src/main.ts")
                    .map(|e| e.id.clone())
            })
            .expect("main");
        let received = workspace.fetch(main.clone()).await.expect("fetched");
        assert_eq!(
            received.bytes,
            big.as_bytes(),
            "a multi-chunk file arrives whole"
        );
        assert!(received.text);

        std::fs::rename(ws.join("src"), ws.join("app")).expect("rename");
        let renames = vec![(
            RelPath::parse("src").expect("p"),
            RelPath::parse("app").expect("p"),
        )];
        let change = runtime
            .refresh_share(&db, &created.room_uid, renames, 3)
            .await
            .expect("refresh");
        owner.tree_changed(change.expect("a delta"));
        until(&mut rx, |e| matches!(e, RemoteEvent::TreeDelta { .. })).await;
        let moved = workspace.tree(|t| t.get(&main).map(|e| e.path.to_string()));
        assert_eq!(
            moved.as_deref(),
            Some("app/main.ts"),
            "the same file id, at its new path"
        );
        assert_eq!(
            workspace.fetch(main).await.expect("again").bytes,
            big.as_bytes()
        );
        owner.stop();
        relay.stop().await;
    });
}

pub(super) async fn until(
    rx: &mut RemoteEvents,
    want: fn(&openmind_collab_net::remote::RemoteEvent) -> bool,
) {
    tokio::time::timeout(WAIT, async {
        while let Some(event) = rx.recv().await {
            if want(&event) {
                return;
            }
        }
    })
    .await
    .expect("remote event in time");
}
