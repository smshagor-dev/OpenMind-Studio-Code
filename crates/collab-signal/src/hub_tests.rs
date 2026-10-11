//! The hub's rules without sockets.

use super::*;
use crate::proto::{NegotiationId, SignalKind, SIGNAL_VERSION};

struct Peer {
    slot: Slot,
    inbox: mpsc::Receiver<RelayMessage>,
}

fn peer(hub: &mut Hub) -> Peer {
    let (tx, inbox) = mpsc::channel(64);
    Peer {
        slot: hub.connect(tx).expect("slot"),
        inbox,
    }
}

fn topic(byte: &str) -> Topic {
    Topic::parse(&byte.repeat(64)).expect("topic")
}

fn signal() -> Signal {
    Signal {
        negotiation: NegotiationId::random().expect("id"),
        seq: 1,
        kind: SignalKind::Offer { sdp: "v=0".into() },
    }
}

fn drain(peer: &mut Peer) -> Vec<RelayMessage> {
    std::iter::from_fn(|| peer.inbox.try_recv().ok()).collect()
}

#[test]
fn host_join_and_forward_in_a_star() {
    let mut hub = Hub::new(RelayConfig::default());
    let now = Instant::now();
    let (mut owner, mut a, mut b) = (peer(&mut hub), peer(&mut hub), peer(&mut hub));
    hub.handle(
        &owner.slot,
        ClientMessage::Host {
            v: SIGNAL_VERSION,
            topic: topic("a"),
        },
        now,
    );
    hub.handle(
        &a.slot,
        ClientMessage::Join {
            v: SIGNAL_VERSION,
            topic: topic("a"),
        },
        now,
    );
    hub.handle(
        &b.slot,
        ClientMessage::Join {
            v: SIGNAL_VERSION,
            topic: topic("a"),
        },
        now,
    );
    assert!(matches!(
        drain(&mut owner)[..],
        [
            RelayMessage::Hosted { .. },
            RelayMessage::PeerArrived { .. },
            RelayMessage::PeerArrived { .. }
        ]
    ));
    assert!(matches!(drain(&mut a)[..], [RelayMessage::Joined { .. }]));
    drain(&mut b);
    hub.handle(
        &a.slot,
        ClientMessage::Signal {
            to: owner.slot.clone(),
            signal: signal(),
        },
        now,
    );
    assert!(
        matches!(&drain(&mut owner)[..], [RelayMessage::Signal { from, .. }] if *from == a.slot)
    );
    hub.handle(
        &owner.slot,
        ClientMessage::Signal {
            to: b.slot.clone(),
            signal: signal(),
        },
        now,
    );
    assert_eq!(drain(&mut b).len(), 1);
    // Participants never reach each other.
    hub.handle(
        &a.slot,
        ClientMessage::Signal {
            to: b.slot.clone(),
            signal: signal(),
        },
        now,
    );
    assert_eq!(
        drain(&mut a),
        vec![RelayMessage::Error {
            code: ErrorCode::UnknownPeer
        }]
    );
    assert!(drain(&mut b).is_empty());
}

#[test]
fn topics_are_exclusive_and_need_a_host() {
    let mut hub = Hub::new(RelayConfig::default());
    let now = Instant::now();
    let (mut first, mut second, mut early) = (peer(&mut hub), peer(&mut hub), peer(&mut hub));
    hub.handle(
        &early.slot,
        ClientMessage::Join {
            v: SIGNAL_VERSION,
            topic: topic("b"),
        },
        now,
    );
    assert_eq!(
        drain(&mut early),
        vec![RelayMessage::Error {
            code: ErrorCode::NoHost
        }]
    );
    hub.handle(
        &first.slot,
        ClientMessage::Host {
            v: SIGNAL_VERSION,
            topic: topic("b"),
        },
        now,
    );
    hub.handle(
        &second.slot,
        ClientMessage::Host {
            v: SIGNAL_VERSION,
            topic: topic("b"),
        },
        now,
    );
    assert_eq!(
        drain(&mut second),
        vec![RelayMessage::Error {
            code: ErrorCode::TopicTaken
        }]
    );
    hub.handle(
        &first.slot,
        ClientMessage::Host {
            v: SIGNAL_VERSION,
            topic: topic("c"),
        },
        now,
    );
    assert!(drain(&mut first).contains(&RelayMessage::Error {
        code: ErrorCode::AlreadyRegistered
    }));
    // Signals across topics are refused.
    let mut other = peer(&mut hub);
    hub.handle(
        &other.slot,
        ClientMessage::Signal {
            to: first.slot.clone(),
            signal: signal(),
        },
        now,
    );
    assert_eq!(
        drain(&mut other),
        vec![RelayMessage::Error {
            code: ErrorCode::NotInTopic
        }]
    );
}

#[test]
fn unused_topics_expire_and_renewals_keep_them() {
    let config = RelayConfig {
        topic_ttl: Duration::from_secs(10),
        ..RelayConfig::default()
    };
    let mut hub = Hub::new(config);
    let start = Instant::now();
    let (mut kept, mut idle) = (peer(&mut hub), peer(&mut hub));
    hub.handle(
        &kept.slot,
        ClientMessage::Host {
            v: SIGNAL_VERSION,
            topic: topic("d"),
        },
        start,
    );
    hub.handle(
        &idle.slot,
        ClientMessage::Host {
            v: SIGNAL_VERSION,
            topic: topic("e"),
        },
        start,
    );
    hub.handle(
        &kept.slot,
        ClientMessage::Renew,
        start + Duration::from_secs(8),
    );
    assert_eq!(hub.sweep(start + Duration::from_secs(11)), 1);
    assert!(drain(&mut idle).contains(&RelayMessage::Expired));
    assert!(!drain(&mut kept).contains(&RelayMessage::Expired));
    assert_eq!(hub.counts().topics, 1);
    // The expired host can host again.
    hub.handle(
        &idle.slot,
        ClientMessage::Host {
            v: SIGNAL_VERSION,
            topic: topic("e"),
        },
        start + Duration::from_secs(12),
    );
    assert!(matches!(
        drain(&mut idle)[..],
        [RelayMessage::Hosted { .. }]
    ));
}

#[test]
fn a_leaving_host_ends_the_topic_and_participants_are_told() {
    let mut hub = Hub::new(RelayConfig::default());
    let now = Instant::now();
    let (owner, mut a) = (peer(&mut hub), peer(&mut hub));
    hub.handle(
        &owner.slot,
        ClientMessage::Host {
            v: SIGNAL_VERSION,
            topic: topic("f"),
        },
        now,
    );
    hub.handle(
        &a.slot,
        ClientMessage::Join {
            v: SIGNAL_VERSION,
            topic: topic("f"),
        },
        now,
    );
    drain(&mut a);
    hub.disconnect(&owner.slot);
    assert_eq!(
        drain(&mut a),
        vec![RelayMessage::PeerLeft {
            slot: owner.slot.clone()
        }]
    );
    assert_eq!(
        hub.counts(),
        HubCounts {
            connections: 1,
            topics: 0
        }
    );
}

#[test]
fn limits_are_enforced() {
    let config = RelayConfig {
        max_peers_per_topic: 1,
        max_connections: 3,
        ..RelayConfig::default()
    };
    let mut hub = Hub::new(config);
    let now = Instant::now();
    let (owner, a, mut b) = (peer(&mut hub), peer(&mut hub), peer(&mut hub));
    let (tx, _rx) = mpsc::channel(1);
    assert!(hub.connect(tx).is_none(), "relay full");
    hub.handle(
        &owner.slot,
        ClientMessage::Host {
            v: SIGNAL_VERSION,
            topic: topic("1"),
        },
        now,
    );
    hub.handle(
        &a.slot,
        ClientMessage::Join {
            v: SIGNAL_VERSION,
            topic: topic("1"),
        },
        now,
    );
    hub.handle(
        &b.slot,
        ClientMessage::Join {
            v: SIGNAL_VERSION,
            topic: topic("1"),
        },
        now,
    );
    assert_eq!(
        drain(&mut b),
        vec![RelayMessage::Error {
            code: ErrorCode::TopicFull
        }]
    );
}

#[test]
fn an_embedded_relay_lets_only_this_computer_host_and_knows_where_peers_are() {
    let config = RelayConfig {
        loopback_hosts_only: true,
        max_topics: 1,
        ..RelayConfig::default()
    };
    let mut hub = Hub::new(config);
    let now = Instant::now();
    let connect = |hub: &mut Hub, addr: &str| {
        let (tx, inbox) = mpsc::channel(64);
        let remote: std::net::SocketAddr = addr.parse().expect("addr");
        Peer {
            slot: hub.connect_from(tx, Some(remote)).expect("slot"),
            inbox,
        }
    };
    let mut stranger = connect(&mut hub, "192.168.1.50:5000");
    let host = |topic| ClientMessage::Host {
        v: SIGNAL_VERSION,
        topic,
    };
    hub.handle(&stranger.slot, host(topic("a")), now);
    assert_eq!(
        drain(&mut stranger),
        vec![RelayMessage::Error {
            code: ErrorCode::RelayFull
        }],
        "another machine can't host here"
    );
    let mut owner = connect(&mut hub, "127.0.0.1:6000");
    hub.handle(&owner.slot, host(topic("a")), now);
    assert!(matches!(
        drain(&mut owner).as_slice(),
        [RelayMessage::Hosted { .. }]
    ));
    let mut unknown = peer(&mut hub); // an in-memory connection: origin unknown, treated as remote
    hub.handle(&unknown.slot, host(topic("b")), now);
    assert!(matches!(
        drain(&mut unknown).as_slice(),
        [RelayMessage::Error { .. }]
    ));
    let mut guest = connect(&mut hub, "192.168.1.50:5001");
    hub.handle(
        &guest.slot,
        ClientMessage::Join {
            v: SIGNAL_VERSION,
            topic: topic("a"),
        },
        now,
    );
    assert!(
        matches!(drain(&mut guest).as_slice(), [RelayMessage::Joined { .. }]),
        "joining from the network is fine"
    );
    assert_eq!(
        hub.remote_of(&guest.slot),
        Some("192.168.1.50:5001".parse().expect("addr"))
    );
}
