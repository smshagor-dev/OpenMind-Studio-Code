//! Local-network discovery and its security: no Internet relay, no STUN, no TURN anywhere in these tests. Discovery is
//! pointed at loopback (as a broadcast would reach this computer) so the tests are deterministic on any machine.

mod common;

use std::net::SocketAddr;
use std::sync::Arc;
use std::time::Duration;

use common::lan::*;
use common::*;
use openmind_collab::authority::Command;
use openmind_collab::{PeerIdentity, RoomCode};
use openmind_collab_net::lan::broadcast;
use openmind_collab_net::lan::discover::discover;
use openmind_collab_net::lan::packet::Packet;
use openmind_collab_net::lan::DiscoveryTag;
use openmind_collab_net::owner::{OwnerAuthority, OwnerEvent};
use openmind_collab_net::participant::JoinMode;
use openmind_collab_net::route::{self, AttemptOutcome, LanOptions, RouteFailure, RouteOptions};
use openmind_collab_net::{ConnectionRoute, NetError};
use openmind_collab_signal::Topic;
use tokio::net::UdpSocket;

async fn tag_of(world: &LanWorld) -> DiscoveryTag {
    DiscoveryTag::for_topic(&world.authority.code().await.signaling_topic())
}

/// Sends one datagram to `to` and returns what comes back within `wait` (the raw bytes).
async fn ask(to: SocketAddr, bytes: &[u8], wait: Duration) -> Option<Vec<u8>> {
    let socket = UdpSocket::bind("127.0.0.1:0").await.expect("bind");
    socket.send_to(bytes, to).await.expect("send");
    let mut buf = [0u8; 2048];
    match tokio::time::timeout(wait, socket.recv_from(&mut buf)).await {
        Ok(Ok((n, _))) => Some(buf[..n].to_vec()),
        _ => None,
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_room_is_found_and_joined_with_no_relay_stun_or_turn() {
    let mut world = lan_world(free_udp_port()).await;
    let found = discover(&tag_of(&world).await, &discovery(world.discovery_port)).await;
    let port = world.host.as_ref().expect("host").port();
    assert_eq!(
        found.iter().map(|e| e.addr.port()).collect::<Vec<_>>(),
        vec![port],
        "exactly the Owner's rendezvous"
    );
    let identity = PeerIdentity::generate().expect("identity");
    let mut routed = lan_join(
        &world,
        &identity,
        JoinMode::Join,
        lan_only(world.discovery_port),
    )
    .await
    .expect("joined");
    assert_eq!(routed.route, ConnectionRoute::LocalLan);
    assert_eq!(routed.endpoint.map(|a| a.port()), Some(port));
    let admitted = wait_for(&mut world.events, |e| {
        matches!(e, OwnerEvent::Admitted { .. })
    })
    .await;
    assert!(
        matches!(
            admitted,
            OwnerEvent::Admitted {
                route: ConnectionRoute::LocalLan,
                ..
            }
        ),
        "{admitted:?}"
    );
    ping(&mut routed.participant, 7).await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn the_announcement_carries_no_code_topic_name_or_identity() {
    let world = lan_world(free_udp_port()).await;
    let code = world.authority.code().await;
    let tag = tag_of(&world).await;
    let query = Packet::query(&tag, &"ab".repeat(16)).encode();
    let to = SocketAddr::new(LOOPBACK, world.discovery_port);
    let answer = ask(to, &query, Duration::from_secs(2))
        .await
        .expect("an answer");
    let room = world.authority.room_uid();
    for bytes in [&query, &answer] {
        let text = String::from_utf8_lossy(bytes).to_lowercase();
        let display = code.display().to_lowercase();
        assert!(!text.contains(&display), "the Room Code: {text}");
        assert!(
            !text.contains(&display.replace('-', "")),
            "the Room Code without dashes: {text}"
        );
        assert!(
            !text.contains(&code.signaling_topic().to_lowercase()),
            "the topic: {text}"
        );
        assert!(
            !text.contains(&code.invite_hash().to_lowercase()),
            "the invite hash: {text}"
        );
        assert!(!text.contains(room.as_str()), "the room id: {text}");
        assert!(
            !text.contains("my project") && !text.contains("teacher"),
            "names: {text}"
        );
    }
    assert!(matches!(
        Packet::decode(&answer),
        Some(Packet::Answer { .. })
    ));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn other_rooms_guesses_and_malformed_or_oversized_queries_get_no_answer() {
    let world = lan_world(free_udp_port()).await;
    let to = SocketAddr::new(LOOPBACK, world.discovery_port);
    let guessed = DiscoveryTag::for_topic(&RoomCode::generate().expect("code").signaling_topic());
    let wait = Duration::from_millis(400);
    assert_eq!(
        ask(
            to,
            &Packet::query(&guessed, &"ab".repeat(16)).encode(),
            wait
        )
        .await,
        None,
        "another room"
    );
    assert_eq!(ask(to, b"{\"t\":\"query\"}", wait).await, None, "malformed");
    assert_eq!(ask(to, &vec![b'x'; 4000], wait).await, None, "oversized");
    let mut tagged = Packet::query(&tag_of(&world).await, &"ab".repeat(16)).encode();
    tagged.extend(std::iter::repeat_n(b' ', 600));
    assert_eq!(
        ask(to, &tagged, wait).await,
        None,
        "a valid query padded past the size limit"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn replayed_foreign_and_garbage_answers_are_ignored_and_duplicates_collapse() {
    // A fake "Owner" that answers every query with a stale nonce, another tag, garbage and an oversized packet.
    let fake = UdpSocket::bind("127.0.0.1:0").await.expect("bind");
    let fake_addr = fake.local_addr().expect("addr");
    let tag = DiscoveryTag::for_topic("room");
    let other = DiscoveryTag::for_topic("other");
    tokio::spawn(async move {
        let mut buf = [0u8; 1024];
        while let Ok((n, from)) = fake.recv_from(&mut buf).await {
            let Some(Packet::Query { nonce, .. }) = Packet::decode(&buf[..n]) else {
                continue;
            };
            let stale = Packet::answer(&tag, &"00".repeat(16), 4000, &"aa".repeat(8), 30).encode();
            let foreign = Packet::answer(&other, &nonce, 4001, &"bb".repeat(8), 30).encode();
            for bytes in [stale, foreign, b"garbage".to_vec(), vec![b'{'; 2000]] {
                let _ = fake.send_to(&bytes, from).await;
            }
        }
    });
    let tag = DiscoveryTag::for_topic("room");
    assert!(
        broadcast::query(&tag, &[fake_addr], Duration::from_millis(900))
            .await
            .expect("searched")
            .is_empty()
    );

    // The real responder reached through two targets (as a limited and a subnet broadcast both would): one endpoint.
    let world = lan_world(free_udp_port()).await;
    let to = SocketAddr::new(LOOPBACK, world.discovery_port);
    let found = broadcast::query(&tag_of(&world).await, &[to, to], Duration::from_millis(900))
        .await
        .expect("searched");
    assert_eq!(found.len(), 1, "{found:?}");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn several_owners_share_the_discovery_port_and_each_code_finds_its_own_room() {
    let port = free_udp_port();
    let a = lan_world(port).await;
    let b = lan_world(port).await;
    for world in [&a, &b] {
        let found = discover(&tag_of(world).await, &discovery(port)).await;
        let own = world.host.as_ref().expect("host").port();
        assert_eq!(
            found.iter().map(|e| e.addr.port()).collect::<Vec<_>>(),
            vec![own]
        );
    }
    let identity = PeerIdentity::generate().expect("identity");
    let routed = lan_join(&b, &identity, JoinMode::Join, lan_only(port))
        .await
        .expect("joined");
    assert_eq!(
        routed.participant.room(),
        &b.authority.room_uid(),
        "the room the code belongs to"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_stopped_owner_disappears_at_once() {
    let mut world = lan_world(free_udp_port()).await;
    let tag = tag_of(&world).await;
    let endpoint = SocketAddr::new(LOOPBACK, world.host.as_ref().expect("host").port());
    world.owner.stop();
    world.host.take().expect("host").stop().await;
    assert!(discover(&tag, &discovery(world.discovery_port))
        .await
        .is_empty());
    let identity = PeerIdentity::generate().expect("identity");
    let mut options = lan_only(world.discovery_port);
    if let Some(lan) = options.lan.as_mut() {
        lan.manual = Some(endpoint);
    }
    let failed = lan_join(&world, &identity, JoinMode::Join, options).await;
    assert!(
        matches!(failed, Err(NetError::NoRoute(_))),
        "{:?}",
        failed.err()
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn an_impostor_announcing_the_room_is_skipped_and_the_real_owner_is_joined() {
    let port = free_udp_port();
    let real = lan_world(port).await;
    let topic = Topic::parse(&real.authority.code().await.signaling_topic()).expect("topic");
    // The impostor knows the topic (not the code): it announces and hosts it with its own room and key.
    let impostor_room = MemoryAuthority::new();
    let forged = Arc::new(ForgedTopic {
        inner: impostor_room.clone(),
        topic,
    });
    let impostor = lan_world_with(forged, impostor_room, port, false, None).await;
    let fake_endpoint = SocketAddr::new(LOOPBACK, impostor.host.as_ref().expect("host").port());
    let identity = PeerIdentity::generate().expect("identity");
    let mut options = lan_only(port);
    if let Some(lan) = options.lan.as_mut() {
        lan.manual = Some(fake_endpoint); // tried first
    }
    let routed = lan_join(&real, &identity, JoinMode::Join, options)
        .await
        .expect("joined the real room");
    assert_eq!(routed.participant.room(), &real.authority.room_uid());
    assert_ne!(routed.endpoint, Some(fake_endpoint));
    assert!(
        impostor
            .authority
            .session_of(&identity.peer_id())
            .await
            .is_none(),
        "the impostor admitted nobody"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_wrong_code_a_changed_owner_key_and_a_banned_member_get_nothing() {
    let world = lan_world(free_udp_port()).await;
    let endpoint = SocketAddr::new(LOOPBACK, world.host.as_ref().expect("host").port());
    let identity = PeerIdentity::generate().expect("identity");
    // Wrong code: its tag isn't announced, and the typed-in address doesn't host its topic.
    let wrong = RoomCode::generate().expect("code");
    let options = RouteOptions {
        lan: Some(LanOptions {
            manual: Some(endpoint),
            discovery: discovery(world.discovery_port),
            ..LanOptions::default()
        }),
        internet: None,
    };
    let refused = route::connect(
        identity.clone(),
        config(wrong, JoinMode::Join),
        options.clone(),
    )
    .await;
    assert!(
        matches!(refused, Err(NetError::NoRoute(_))),
        "{:?}",
        refused.err()
    );

    // A first join pins the Owner's key; a rejoin expecting another key is refused before anything is sent.
    let routed = lan_join(
        &world,
        &identity,
        JoinMode::Join,
        lan_only(world.discovery_port),
    )
    .await
    .expect("joined");
    let room = routed.participant.room().clone();
    routed.participant.close();
    let other_key = PeerIdentity::generate().expect("identity").public_key();
    let pinned_wrong = JoinMode::Reconnect {
        room: room.clone(),
        owner_key: other_key,
    };
    assert!(lan_join(
        &world,
        &identity,
        pinned_wrong,
        lan_only(world.discovery_port)
    )
    .await
    .is_err());

    // Banned: the Owner refuses the member over the local network too.
    world
        .authority
        .host_command(Command::Ban {
            target: identity.peer_id(),
        })
        .await;
    let owner_key = *routed.participant.owner_key();
    let again = lan_join(
        &world,
        &identity,
        JoinMode::Reconnect { room, owner_key },
        lan_only(world.discovery_port),
    )
    .await;
    assert!(
        matches!(again, Err(NetError::Refused(_))),
        "{:?}",
        again.err()
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn after_a_rotation_the_new_code_finds_the_room_and_the_old_one_gets_nothing() {
    let mut world = lan_world(free_udp_port()).await;
    let member = PeerIdentity::generate().expect("identity");
    let mut stays = lan_join(
        &world,
        &member,
        JoinMode::Join,
        lan_only(world.discovery_port),
    )
    .await
    .expect("joined");
    let old = world.authority.code().await;
    let endpoint = SocketAddr::new(LOOPBACK, world.host.as_ref().expect("host").port());
    world.authority.host_command(Command::RotateInvite).await;
    // What the app does on a rotation: re-announce and re-register under the new topic.
    let new_topic = world.authority.code().await.signaling_topic();
    world.host.as_mut().expect("host").set_topic(&new_topic);
    world.owner.rehost();
    assert!(discover(
        &DiscoveryTag::for_topic(&old.signaling_topic()),
        &discovery(world.discovery_port)
    )
    .await
    .is_empty());
    let newcomer = PeerIdentity::generate().expect("identity");
    let joined = lan_join(
        &world,
        &newcomer,
        JoinMode::Join,
        lan_only(world.discovery_port),
    )
    .await;
    assert!(joined.is_ok(), "the new code works: {:?}", joined.err());
    ping(&mut stays.participant, 3).await; // a member connected before the rotation stays connected
    let identity = PeerIdentity::generate().expect("identity");
    let options = RouteOptions {
        lan: Some(LanOptions {
            manual: Some(endpoint),
            discovery: discovery(world.discovery_port),
            ..LanOptions::default()
        }),
        internet: None,
    };
    let stale = route::connect(identity, config(old, JoinMode::Join), options).await;
    assert!(stale.is_err(), "a rotated-away code gets no session");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_blocked_owner_fails_quickly_with_a_firewall_hint() {
    let world = lan_world(free_udp_port()).await;
    // 192.0.2.0/24 is reserved for documentation: packets to it go unanswered, like an Owner whose firewall drops them.
    let blocked: SocketAddr = "192.0.2.10:47732".parse().expect("addr");
    let identity = PeerIdentity::generate().expect("identity");
    let options = RouteOptions {
        lan: Some(LanOptions {
            manual: Some(blocked),
            discovery: discovery(free_udp_port()),
            ..LanOptions::default()
        }),
        internet: None,
    };
    let started = std::time::Instant::now();
    let code = world.authority.code().await;
    let (result, report) =
        route::connect_with_report(identity, config(code, JoinMode::Join), options).await;
    let took = started.elapsed();
    eprintln!("blocked endpoint gave up after {took:?}: {report:?}");
    assert!(
        matches!(result, Err(NetError::NoRoute(ref m)) if m.contains("Windows Firewall")),
        "{:?}",
        result.err()
    );
    assert_eq!(report.failure, Some(RouteFailure::Blocked));
    assert_eq!(
        report.attempts.first().map(|a| a.outcome),
        Some(AttemptOutcome::Unreachable)
    );
    assert!(took < Duration::from_secs(8), "gave up after {took:?}");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn an_unreachable_target_does_not_cut_discovery_short() {
    let world = lan_world(free_udp_port()).await;
    // A closed port first (answers with ICMP "port unreachable"), then the real Owner.
    let closed = SocketAddr::new(LOOPBACK, free_udp_port());
    let owner = SocketAddr::new(LOOPBACK, world.discovery_port);
    let found = broadcast::query(
        &tag_of(&world).await,
        &[closed, owner],
        Duration::from_millis(1200),
    )
    .await
    .expect("searched");
    assert_eq!(found.len(), 1, "{found:?}");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn hosting_registers_once_and_reports_no_problem() {
    let mut world = lan_world(free_udp_port()).await;
    tokio::time::sleep(Duration::from_millis(600)).await;
    while let Ok(event) = world.events.try_recv() {
        assert!(!matches!(event, OwnerEvent::Problem { .. }), "{event:?}");
    }
}
