//! The relay over real sockets: forwarding, expiry, restart and hostile input.

mod common;

use std::time::Duration;

use common::*;
use futures_util::{SinkExt, StreamExt};
use openmind_collab_net::owner::OwnerEvent;
use openmind_collab_net::signaling::WsSignaling;
use openmind_collab_net::transport::{SignalingConnector, SignalingEvent};
use openmind_collab_net::ConnectionState;
use openmind_collab_signal::{
    ClientMessage, ErrorCode, NegotiationId, RelayConfig, RelayMessage, Signal, SignalKind, Topic,
    SIGNAL_VERSION,
};
use tokio::sync::mpsc;
use tokio_tungstenite::tungstenite::Message;

async fn next(rx: &mut mpsc::Receiver<SignalingEvent>) -> SignalingEvent {
    tokio::time::timeout(WAIT, rx.recv())
        .await
        .expect("in time")
        .expect("event")
}

fn topic() -> Topic {
    Topic::parse(&"c".repeat(64)).expect("topic")
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn offers_answers_and_candidates_cross_the_relay() {
    let relay = start_relay(RelayConfig::default(), "127.0.0.1:0").await;
    let url = format!("ws://{}", relay.addr());
    let (owner, mut owner_rx) = WsSignaling::direct(&url).connect().await.expect("owner");
    let (guest, mut guest_rx) = WsSignaling::direct(&url).connect().await.expect("guest");
    owner
        .send(ClientMessage::Host {
            v: SIGNAL_VERSION,
            topic: topic(),
        })
        .expect("host");
    assert!(matches!(
        next(&mut owner_rx).await,
        SignalingEvent::Message(RelayMessage::Hosted { .. })
    ));
    guest
        .send(ClientMessage::Join {
            v: SIGNAL_VERSION,
            topic: topic(),
        })
        .expect("join");
    let SignalingEvent::Message(RelayMessage::Joined { host, slot }) = next(&mut guest_rx).await
    else {
        panic!("joined")
    };
    assert!(
        matches!(next(&mut owner_rx).await, SignalingEvent::Message(RelayMessage::PeerArrived { slot: s }) if s == slot)
    );
    let negotiation = NegotiationId::random().expect("id");
    for (seq, kind) in [
        (1, SignalKind::Offer { sdp: "v=0".into() }),
        (
            2,
            SignalKind::Candidate {
                candidate: "candidate:1 1 udp 1 127.0.0.1 9 typ host".into(),
            },
        ),
    ] {
        guest
            .send(ClientMessage::Signal {
                to: host.clone(),
                signal: Signal {
                    negotiation: negotiation.clone(),
                    seq,
                    kind: kind.clone(),
                },
            })
            .expect("signal");
        let SignalingEvent::Message(RelayMessage::Signal { from, signal }) =
            next(&mut owner_rx).await
        else {
            panic!("signal")
        };
        assert_eq!((from, signal.kind), (slot.clone(), kind));
    }
    owner
        .send(ClientMessage::Signal {
            to: slot.clone(),
            signal: Signal {
                negotiation,
                seq: 1,
                kind: SignalKind::Answer { sdp: "v=0".into() },
            },
        })
        .expect("answer");
    assert!(matches!(
        next(&mut guest_rx).await,
        SignalingEvent::Message(RelayMessage::Signal { .. })
    ));
    assert_eq!(relay.counts().topics, 1);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn unused_topics_expire() {
    let config = RelayConfig {
        topic_ttl: Duration::from_secs(1),
        ..RelayConfig::default()
    };
    let relay = start_relay(config, "127.0.0.1:0").await;
    let (link, mut rx) = WsSignaling::direct(&format!("ws://{}", relay.addr()))
        .connect()
        .await
        .expect("connect");
    link.send(ClientMessage::Host {
        v: SIGNAL_VERSION,
        topic: topic(),
    })
    .expect("host");
    assert!(matches!(
        next(&mut rx).await,
        SignalingEvent::Message(RelayMessage::Hosted { .. })
    ));
    assert_eq!(
        next(&mut rx).await,
        SignalingEvent::Message(RelayMessage::Expired)
    );
    assert_eq!(relay.counts().topics, 0);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn malformed_and_oversized_input_is_refused_and_the_relay_keeps_serving() {
    let relay = start_relay(RelayConfig::default(), "127.0.0.1:0").await;
    let url = format!("ws://{}", relay.addr());
    let (mut raw, _) = tokio_tungstenite::connect_async(&url).await.expect("raw");
    raw.send(Message::text("garbage")).await.expect("send");
    raw.send(Message::binary(vec![1, 2, 3]))
        .await
        .expect("send");
    raw.send(Message::text(r#"{"type":"host","v":7,"topic":"x"}"#))
        .await
        .expect("send");
    let mut errors = Vec::new();
    while let Some(Ok(message)) = tokio::time::timeout(WAIT, raw.next())
        .await
        .expect("in time")
    {
        match message {
            Message::Text(text) => {
                errors.push(RelayMessage::decode(text.as_str()).expect("relay message"))
            }
            Message::Close(_) => break,
            _ => {}
        }
    }
    assert_eq!(
        errors,
        vec![
            RelayMessage::Error {
                code: ErrorCode::Malformed
            };
            3
        ],
        "three strikes, then closed"
    );
    let (mut big, _) = tokio_tungstenite::connect_async(&url).await.expect("raw");
    let _ = big.send(Message::text("x".repeat(70 * 1024))).await;
    let closed = tokio::time::timeout(WAIT, async {
        loop {
            match big.next().await {
                None | Some(Err(_)) | Some(Ok(Message::Close(_))) => return true,
                _ => {}
            }
        }
    })
    .await;
    assert_eq!(closed, Ok(true), "an oversized message ends the connection");
    let (link, mut rx) = WsSignaling::direct(&url)
        .connect()
        .await
        .expect("still serving");
    link.send(ClientMessage::Host {
        v: SIGNAL_VERSION,
        topic: topic(),
    })
    .expect("host");
    assert!(matches!(
        next(&mut rx).await,
        SignalingEvent::Message(RelayMessage::Hosted { .. })
    ));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_relay_restart_leaves_sessions_up_and_the_owner_hosts_again() {
    let mut world = world().await;
    let (_identity, mut student) = join(&world).await;
    let addr = world.relay.as_ref().expect("relay").addr();
    world.relay.take().expect("relay").stop().await;
    wait_for(
        &mut world.events,
        |e| matches!(e, OwnerEvent::Signaling { state } if *state == ConnectionState::Reconnecting),
    )
    .await;
    // The negotiated connection doesn't need the relay.
    ping(&mut student, 11).await;
    world.relay = Some(start_relay(RelayConfig::default(), &addr.to_string()).await);
    wait_for(
        &mut world.events,
        |e| matches!(e, OwnerEvent::Signaling { state } if *state == ConnectionState::Connected),
    )
    .await;
    let (_other, mut newcomer) = join(&world).await;
    ping(&mut newcomer, 12).await;
    ping(&mut student, 13).await;
}
