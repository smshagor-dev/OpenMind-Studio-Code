//! Sessions over the local network: the unchanged Phase 5 workspace sharing, reconnecting with a fresh session, and
//! how the local route and the Internet relay combine (the same room on both).

mod common;

use std::sync::Arc;
use std::time::Duration;

use common::lan::*;
use common::*;
use openmind_collab::transfer::CHUNK_BYTES;
use openmind_collab::PeerIdentity;
use openmind_collab_net::lan::discover::discover;
use openmind_collab_net::lan::DiscoveryTag;
use openmind_collab_net::owner::TreeChange;
use openmind_collab_net::participant::JoinMode;
use openmind_collab_net::remote::{self, RemoteEvent};
use openmind_collab_net::route::{LanOptions, RouteOptions};
use openmind_collab_net::signaling::WsSignaling;
use openmind_collab_net::ConnectionRoute;
use openmind_collab_signal::RelayConfig;
use tokio::sync::mpsc;

async fn until(
    events: &mut mpsc::UnboundedReceiver<RemoteEvent>,
    f: impl Fn(&RemoteEvent) -> bool,
) {
    tokio::time::timeout(WAIT, async {
        while let Some(event) = events.recv().await {
            if f(&event) {
                return;
            }
        }
    })
    .await
    .expect("remote event in time");
}

fn bytes(len: usize) -> Vec<u8> {
    (0..len).map(|i| (i * 13 % 251) as u8).collect()
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn the_shared_workspace_works_unchanged_over_the_local_network() {
    let world = lan_world(free_udp_port()).await;
    let big = bytes(3 * CHUNK_BYTES + 17);
    world
        .authority
        .put_many(&[
            ("src/main.ts", b"let x = 1;".to_vec()),
            ("data/big.bin", big.clone()),
            (".env", b"SECRET=1".to_vec()),
        ])
        .await;
    let identity = PeerIdentity::generate().expect("identity");
    let routed = lan_join(
        &world,
        &identity,
        JoinMode::Join,
        lan_only(world.discovery_port),
    )
    .await
    .expect("joined");
    assert_eq!(routed.route, ConnectionRoute::LocalLan);
    let (tx, mut events) = mpsc::unbounded_channel();
    let (workspace, _task) = remote::spawn(
        routed.participant,
        Arc::new(move |e| {
            let _ = tx.send(e);
        }),
    );
    until(&mut events, |e| matches!(e, RemoteEvent::TreeReady { .. })).await;
    let mut paths: Vec<String> =
        workspace.tree(|t| t.entries().values().map(|e| e.path.to_string()).collect());
    paths.sort();
    assert_eq!(
        paths,
        ["data", "data/big.bin", "src", "src/main.ts"],
        "no secret, no content yet"
    );
    assert_eq!(workspace.files().active(), 0);

    let main = world.authority.workspace.lock().await.id("src/main.ts");
    assert_eq!(
        workspace.fetch(main.clone()).await.expect("text").bytes,
        b"let x = 1;"
    );
    let big_id = world.authority.workspace.lock().await.id("data/big.bin");
    let received = workspace.fetch(big_id.clone()).await.expect("multi-chunk");
    assert_eq!(received.bytes, big);

    // A rename keeps the id; a delete makes it unavailable.
    let before = world.authority.workspace.lock().await.snapshot();
    {
        let mut ws = world.authority.workspace.lock().await;
        let id = ws.id("src/main.ts");
        ws.table
            .rename(
                &id,
                openmind_collab::RelPath::parse("src/app.ts").expect("path"),
            )
            .expect("rename");
        if let Some(text) = ws.contents.remove("src/main.ts") {
            ws.contents.insert("src/app.ts".into(), text);
        }
        ws.version += 1;
    }
    let after = world.authority.workspace.lock().await.snapshot();
    let (upserts, removed) = openmind_collab::manifest::diff(&before.entries, &after.entries);
    world.owner.tree_changed(TreeChange::Delta {
        base: before.version,
        version: after.version,
        upserts,
        removed,
    });
    until(&mut events, |e| matches!(e, RemoteEvent::TreeDelta { .. })).await;
    assert_eq!(
        workspace
            .tree(|t| t.get(&main).map(|e| e.path.to_string()))
            .as_deref(),
        Some("src/app.ts")
    );
    let base = after.version;
    world.owner.tree_changed(TreeChange::Delta {
        base,
        version: base + 1,
        upserts: Vec::new(),
        removed: vec![big_id.clone()],
    });
    until(&mut events, |e| matches!(e, RemoteEvent::TreeDelta { .. })).await;
    assert!(workspace.tree(|t| t.get(&big_id).is_none()));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_dropped_connection_comes_back_over_the_known_address_with_a_fresh_session() {
    let world = lan_world(free_udp_port()).await;
    let identity = PeerIdentity::generate().expect("identity");
    let first = lan_join(
        &world,
        &identity,
        JoinMode::Join,
        lan_only(world.discovery_port),
    )
    .await
    .expect("joined");
    let (room, owner_key, endpoint) = (
        first.participant.room().clone(),
        *first.participant.owner_key(),
        first.endpoint,
    );
    let old_session = first.participant.admission().session.clone();
    first.participant.close();
    // Discovery is pointed nowhere: only the remembered address can work.
    let options = RouteOptions {
        lan: Some(LanOptions {
            known: endpoint,
            discovery: discovery(free_udp_port()),
            ..LanOptions::default()
        }),
        internet: None,
    };
    let again = lan_join(
        &world,
        &identity,
        JoinMode::Reconnect {
            room: room.clone(),
            owner_key,
        },
        options,
    )
    .await
    .expect("back");
    assert_eq!(again.route, ConnectionRoute::LocalLan);
    assert_ne!(
        again.participant.admission().session,
        old_session,
        "never the old session"
    );
    again.participant.close();
    // A stale remembered address (the Owner moved): discovery finds the current one.
    let options = RouteOptions {
        lan: Some(LanOptions {
            known: Some("127.0.0.1:9".parse().expect("addr")),
            discovery: discovery(world.discovery_port),
            ..LanOptions::default()
        }),
        internet: None,
    };
    let (rediscovered, report) = lan_join_report(
        &world,
        &identity,
        JoinMode::Reconnect { room, owner_key },
        options,
    )
    .await;
    // On a failure, the report says what discovery found or why it couldn't search (not just the last error).
    let rediscovered = rediscovered.unwrap_or_else(|err| {
        panic!(
            "rediscovered: {err}
{report:#?}"
        )
    });
    assert_eq!(rediscovered.endpoint, endpoint);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn the_local_network_is_preferred_and_the_internet_relay_still_works_for_the_same_room() {
    let internet = start_relay(RelayConfig::default(), "127.0.0.1:0").await;
    let url = format!("ws://{}", internet.addr());
    let authority = MemoryAuthority::new();
    let world = lan_world_with(
        authority.clone(),
        authority,
        free_udp_port(),
        false,
        Some(&url),
    )
    .await;
    let both = RouteOptions {
        internet: Some(Arc::new(WsSignaling::direct(&url))),
        ..lan_only(world.discovery_port)
    };
    let identity = PeerIdentity::generate().expect("identity");
    let local = lan_join(&world, &identity, JoinMode::Join, both)
        .await
        .expect("joined");
    assert_eq!(
        local.route,
        ConnectionRoute::LocalLan,
        "same network: the local route, even with the Internet up"
    );
    let other = PeerIdentity::generate().expect("identity");
    let elsewhere = RouteOptions {
        lan: Some(LanOptions {
            discovery: discovery(free_udp_port()),
            ..LanOptions::default()
        }),
        internet: Some(Arc::new(WsSignaling::direct(&url))),
    };
    let remote = lan_join(&world, &other, JoinMode::Join, elsewhere)
        .await
        .expect("joined through the relay");
    assert_eq!(
        remote.route,
        ConnectionRoute::InternetRelay,
        "not found locally: the Internet relay"
    );
    assert_eq!(
        remote.participant.room(),
        local.participant.room(),
        "one room, two routes"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn an_unreachable_internet_relay_does_not_stop_local_hosting() {
    let dead = format!("ws://127.0.0.1:{}", free_udp_port()); // nothing listens there
    let authority = MemoryAuthority::new();
    let world = lan_world_with(
        authority.clone(),
        authority,
        free_udp_port(),
        false,
        Some(&dead),
    )
    .await;
    let identity = PeerIdentity::generate().expect("identity");
    let routed = lan_join(
        &world,
        &identity,
        JoinMode::Join,
        lan_only(world.discovery_port),
    )
    .await
    .expect("joined");
    assert_eq!(routed.route, ConnectionRoute::LocalLan);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn mdns_finds_the_room_on_this_computers_real_interfaces() {
    let interfaces: Vec<std::net::IpAddr> = openmind_collab_net::lan::netif::current()
        .iter()
        .flat_map(|i| i.ipv4.iter().map(|(ip, _)| std::net::IpAddr::V4(*ip)))
        .collect();
    if interfaces.is_empty() {
        eprintln!("no usable network interface on this machine; mDNS not exercised");
        return;
    }
    let port = free_udp_port();
    let authority = MemoryAuthority::new();
    let mut host = host_config(port, true);
    (host.bind, host.announce_on) = (std::net::IpAddr::V4(std::net::Ipv4Addr::UNSPECIFIED), None);
    let world = lan_world_on(authority.clone(), authority, host, None).await;
    let tag = DiscoveryTag::for_topic(&world.authority.code().await.signaling_topic());
    let mut config = discovery(port);
    (config.broadcast, config.mdns, config.mdns_on, config.window) =
        (false, true, None, Duration::from_secs(5));
    let found = discover(&tag, &config).await;
    let own = world.host.as_ref().expect("host").port();
    assert!(!found.is_empty(), "mDNS found nothing on {interfaces:?}");
    assert!(
        found
            .iter()
            .all(|e| e.addr.port() == own && interfaces.contains(&e.addr.ip())),
        "{found:?}"
    );
    // And a participant joins through the mDNS answer alone (a real interface address, not loopback).
    let identity = PeerIdentity::generate().expect("identity");
    let options = RouteOptions {
        lan: Some(LanOptions {
            discovery: config,
            ..LanOptions::default()
        }),
        internet: None,
    };
    let routed = lan_join(&world, &identity, JoinMode::Join, options)
        .await
        .expect("joined over mDNS");
    assert_eq!(routed.route, ConnectionRoute::LocalLan);
    assert!(routed.endpoint.is_some_and(|a| !a.ip().is_loopback()));
}
