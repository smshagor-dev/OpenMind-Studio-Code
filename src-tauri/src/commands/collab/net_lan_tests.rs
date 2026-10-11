//! The app's local-network paths end to end (Milestone 24, phases 5.1/5.2), without a window: the real `CollabRuntime`
//! and machine database behind an Owner whose only signaling is its own embedded rendezvous — no signaling server, no
//! STUN, no TURN — and participants that find it by discovery on loopback.

use std::sync::Arc;
use std::time::Duration;

use openmind_collab::audit::{verify_chain, ChainHead};
use openmind_collab::{Actor, PeerIdentity, RoomCode, RoomUid};
use openmind_collab_net::ice::IceSetup;
use openmind_collab_net::owner::{OwnerEvent, OwnerNetwork, OwnerOptions};
use openmind_collab_net::participant::{JoinMode, ParticipantConfig};
use openmind_collab_net::relay::TurnRelay;
use openmind_collab_net::stun::StunGatherer;
use openmind_collab_net::ConnectionState;
use openmind_db::collab::{logs, members, rooms};
use openmind_db::Db;

use super::super::host::{CollabRuntime, CreatedRoom, NewHostedRoom};
use super::super::persist;
use super::tests::{shared_folder, until, wait_owner, RuntimeAuthority, WAIT};

/// The room's whole audit chain verifies with `key`.
async fn assert_history_verifies(db: &Db, room: &RoomUid, key: &openmind_collab::PublicKey) {
    let row = rooms::get_by_uid(db.pool(), room.as_str())
        .await
        .expect("get")
        .expect("row");
    let stored = logs::list_after(db.pool(), row.id, 0, 200)
        .await
        .expect("logs");
    let parsed: Vec<_> = stored
        .iter()
        .map(|r| persist::event_of(r, room).expect("event"))
        .collect();
    assert!(verify_chain(&parsed, &ChainHead::genesis(), Some(key)).is_ok());
}

fn main_ts_id(
    manifest: &openmind_collab::manifest::ManifestSnapshot,
) -> Option<openmind_collab::FileId> {
    manifest
        .entries
        .values()
        .find(|e| e.path.as_str() == "src/main.ts")
        .map(|e| e.id.clone())
}

type LanOwner = (OwnerNetwork, openmind_collab_net::lan::host::LanHost, u16);

/// Hosts `created` on the local network only: its own rendezvous on loopback, discovery on a fresh port, an Owner with
/// no signaling server, STUN, TURN or bind address of its own.
pub(super) async fn host_on_lan(
    runtime: &Arc<CollabRuntime>,
    db: &Db,
    created: &CreatedRoom,
) -> LanOwner {
    use openmind_collab_net::lan::host::{LanHost, LanHostConfig};
    use openmind_collab_net::signaling::multi::MultiSignaling;
    let topic = runtime
        .topic(db, &created.room_uid, 3)
        .await
        .expect("topic");
    let discovery_port = std::net::UdpSocket::bind("127.0.0.1:0")
        .and_then(|s| s.local_addr())
        .expect("port")
        .port();
    let loopback: std::net::IpAddr = "127.0.0.1".parse().expect("ip");
    let config = LanHostConfig {
        bind: loopback,
        preferred_port: None,
        discovery_port,
        mdns: false,
        announce_on: Some(vec![loopback]),
        ..LanHostConfig::default()
    };
    let lan = LanHost::start(&topic, config).await.expect("lan host");
    let room = RoomUid::parse(&created.room_uid).expect("uid");
    let authority = Arc::new(RuntimeAuthority {
        runtime: runtime.clone(),
        db: db.clone(),
        room,
    });
    let options = OwnerOptions {
        ice: IceSetup::default(),
        gatherer: Arc::new(StunGatherer::new(Vec::new())),
        relay: Arc::new(TurnRelay::new(Vec::new())),
        peer_connect_timeout: Duration::from_secs(10),
        handshake_timeout: Duration::from_secs(15),
    };
    let signaling = Arc::new(MultiSignaling::new(vec![lan.route().expect("route")]));
    let (owner, mut events) = OwnerNetwork::start(authority, signaling, options);
    let up = |e: &OwnerEvent| {
        matches!(
            e,
            OwnerEvent::Signaling {
                state: ConnectionState::Connected
            }
        )
    };
    wait_owner(&mut events, up).await;
    (owner, lan, discovery_port)
}

/// A first-time participant that looks for the room on the local network only (discovery asks loopback).
pub(super) fn lan_participant(
    created: &CreatedRoom,
    discovery_port: u16,
) -> (ParticipantConfig, openmind_collab_net::route::RouteOptions) {
    use openmind_collab_net::lan::discover::DiscoveryConfig;
    use openmind_collab_net::route::{LanOptions, RouteOptions};
    let target = std::net::SocketAddr::from(([127, 0, 0, 1], discovery_port));
    let discovery = DiscoveryConfig {
        mdns: false,
        broadcast_targets: Some(vec![target]),
        ..DiscoveryConfig::default()
    };
    let config = ParticipantConfig {
        code: RoomCode::parse(&created.code).expect("code"),
        display_name: "Student".into(),
        mode: JoinMode::Join,
        ice: IceSetup::default(),
        gatherer: Arc::new(StunGatherer::new(Vec::new())),
        relay: Arc::new(TurnRelay::new(Vec::new())),
        handshake_timeout: WAIT,
        approval_timeout: WAIT,
        on_pending: None,
    };
    let options = RouteOptions {
        lan: Some(LanOptions {
            discovery,
            ..LanOptions::default()
        }),
        internet: None,
    };
    (config, options)
}

/// Phase 5.1: the same room through the local network only — no signaling server, no STUN, no TURN configured. The
/// real runtime and database admit and persist the participant, and the real share code serves its folder.
#[test]
fn the_real_room_works_over_the_local_network_with_nothing_on_the_internet() {
    use openmind_collab_net::route;
    use openmind_collab_net::ConnectionRoute;
    tauri::async_runtime::block_on(async {
        let dir = tempfile::tempdir().expect("dir");
        let (ws, big) = shared_folder(dir.path());
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
        let (owner, lan, discovery_port) = host_on_lan(&runtime, &db, &created).await;

        let (config, options) = lan_participant(&created, discovery_port);
        let guest = PeerIdentity::generate().expect("identity");
        let routed = route::connect(guest.clone(), config, options)
            .await
            .expect("joined over the local network");
        assert_eq!(routed.route, ConnectionRoute::LocalLan);
        let row = rooms::get_by_uid(db.pool(), &created.room_uid)
            .await
            .expect("get")
            .expect("row");
        let people = members::list(db.pool(), row.id).await.expect("members");
        assert!(
            people
                .iter()
                .any(|m| m.peer == guest.peer_id().as_str() && m.status == "active"),
            "persisted like any member"
        );

        let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel();
        let (workspace, _task) = openmind_collab_net::remote::spawn(
            routed.participant,
            Arc::new(move |e| {
                let _ = tx.send(e);
            }),
        );
        until(&mut rx, |e| {
            matches!(
                e,
                openmind_collab_net::remote::RemoteEvent::TreeReady { .. }
            )
        })
        .await;
        let main = workspace
            .tree(|t| {
                t.entries()
                    .values()
                    .find(|e| e.path.as_str() == "src/main.ts")
                    .map(|e| e.id.clone())
            })
            .expect("main");
        assert!(workspace.tree(|t| !t.entries().values().any(|e| e.name == ".env")));
        assert_eq!(
            workspace.fetch(main).await.expect("fetched").bytes,
            big.as_bytes()
        );
        owner.stop();
        lan.stop().await;
    });
}

/// Phase 5.2 (Owner restart): the app closes and opens again on the same database. The room is hosted again on the
/// local network; a member rejoins with the key it pinned, gets a fresh session, finds the same file ids, and the room's
/// audit chain still verifies with the same Owner key.
#[test]
fn an_owner_restart_keeps_the_room_its_ids_and_its_history() {
    use openmind_collab_net::route;
    tauri::async_runtime::block_on(async {
        let dir = tempfile::tempdir().expect("dir");
        let (ws, _) = shared_folder(dir.path());
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
        let host = Actor::Host(runtime.identity(&db).await.expect("identity").peer_id());
        let before = main_ts_id(
            &runtime
                .manifest(&db, &created.room_uid, host.clone(), 3)
                .await
                .expect("manifest"),
        );
        let (owner, lan, port) = host_on_lan(&runtime, &db, &created).await;
        let guest = PeerIdentity::generate().expect("identity");
        let (config, options) = lan_participant(&created, port);
        let first = route::connect(guest.clone(), config, options)
            .await
            .expect("joined");
        let (room, owner_key) = (
            first.participant.room().clone(),
            *first.participant.owner_key(),
        );
        let old_session = first.participant.admission().session.clone();
        first.participant.close();
        owner.stop();
        lan.stop().await;

        let restarted = Arc::new(CollabRuntime::default()); // a new app process on the same database
        let (owner, lan, port) = host_on_lan(&restarted, &db, &created).await;
        let (mut config, options) = lan_participant(&created, port);
        config.mode = JoinMode::Reconnect {
            room: room.clone(),
            owner_key,
        };
        let again = route::connect(guest, config, options)
            .await
            .expect("rejoined the restarted Owner");
        assert_ne!(
            again.participant.admission().session,
            old_session,
            "a fresh session"
        );
        let after = main_ts_id(
            &restarted
                .manifest(&db, &created.room_uid, host, 5)
                .await
                .expect("manifest"),
        );
        assert_eq!(after, before, "the same file id after the restart");
        let key = restarted
            .identity(&db)
            .await
            .expect("identity")
            .public_key();
        assert_eq!(key, owner_key, "the same Owner identity");
        assert_history_verifies(&db, &room, &key).await;
        owner.stop();
        lan.stop().await;
    });
}
