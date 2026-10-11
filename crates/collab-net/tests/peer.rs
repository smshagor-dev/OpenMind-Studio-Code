//! Two `str0m` peers wired to each other in-process (signals passed by hand): ICE restart and time limits.

mod common;

use std::time::Duration;

use common::{ice, WAIT};
use openmind_collab::protocol::Channel;
use openmind_collab_net::peer::{self, PeerConfig, PeerHandle, PeerRole};
use openmind_collab_net::relay::TurnRelay;
use openmind_collab_net::stun::StunGatherer;
use openmind_collab_net::transport::{DataChannelTransport, PeerEvent, PeerTransport};
use openmind_collab_net::ConnectionState;
use openmind_collab_signal::SignalKind;
use tokio::sync::mpsc::UnboundedReceiver;

async fn start(role: PeerRole, timeout: Duration) -> (PeerHandle, UnboundedReceiver<PeerEvent>) {
    let mut config = PeerConfig::new(role);
    config.connect_timeout = timeout;
    peer::start(
        config,
        &ice(),
        &StunGatherer::new(Vec::new()),
        std::sync::Arc::new(TurnRelay::new(Vec::new())),
    )
    .await
    .expect("peer")
}

/// Pumps signals between the two peers until `until` is seen on the answerer's side; returns that event.
async fn pump(
    a: (&PeerHandle, &mut UnboundedReceiver<PeerEvent>),
    b: (&PeerHandle, &mut UnboundedReceiver<PeerEvent>),
    until: impl Fn(&PeerEvent) -> bool,
) -> PeerEvent {
    tokio::time::timeout(WAIT, async {
        loop {
            tokio::select! {
                Some(event) = a.1.recv() => if let PeerEvent::LocalSignal(kind) = event { b.0.remote_signal(kind).expect("to b"); },
                Some(event) = b.1.recv() => match event {
                    PeerEvent::LocalSignal(kind) => a.0.remote_signal(kind).expect("to a"),
                    other if until(&other) => return other,
                    _ => {}
                },
            }
        }
    })
    .await
    .expect("in time")
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn an_ice_restart_renegotiates_without_dropping_the_channels() {
    let (offerer, mut offerer_rx) = start(PeerRole::Offerer, Duration::from_secs(10)).await;
    let (answerer, mut answerer_rx) = start(PeerRole::Answerer, Duration::from_secs(10)).await;
    pump(
        (&offerer, &mut offerer_rx),
        (&answerer, &mut answerer_rx),
        |e| matches!(e, PeerEvent::ChannelOpen(Channel::Control)),
    )
    .await;
    offerer
        .send(Channel::Control, b"before".to_vec())
        .expect("send");
    let before = pump(
        (&offerer, &mut offerer_rx),
        (&answerer, &mut answerer_rx),
        |e| matches!(e, PeerEvent::Data { .. }),
    )
    .await;
    assert_eq!(
        before,
        PeerEvent::Data {
            channel: Channel::Control,
            data: b"before".to_vec()
        }
    );
    offerer.ice_restart().expect("restart");
    assert!(
        answerer.ice_restart().is_err(),
        "only the offering side restarts"
    );
    // The restart's offer/answer go through the pump; data keeps flowing on the same channels.
    offerer
        .send(Channel::Files, b"after".to_vec())
        .expect("send");
    let after = pump(
        (&offerer, &mut offerer_rx),
        (&answerer, &mut answerer_rx),
        |e| matches!(e, PeerEvent::Data { .. }),
    )
    .await;
    assert_eq!(
        after,
        PeerEvent::Data {
            channel: Channel::Files,
            data: b"after".to_vec()
        }
    );
    assert_eq!(offerer.state(), ConnectionState::Connected);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_connection_without_an_answer_fails_at_its_time_limit() {
    let (offerer, mut events) = start(PeerRole::Offerer, Duration::from_millis(800)).await;
    let failed = tokio::time::timeout(WAIT, async {
        loop {
            if let Some(PeerEvent::State(ConnectionState::Failed)) = events.recv().await {
                return true;
            }
        }
    })
    .await;
    assert_eq!(failed, Ok(true));
    assert_eq!(offerer.state(), ConnectionState::Failed);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn malformed_remote_signals_are_refused_without_harm() {
    let (answerer, mut events) = start(PeerRole::Answerer, Duration::from_secs(5)).await;
    for kind in [
        SignalKind::Offer {
            sdp: "not sdp".into(),
        },
        SignalKind::Answer { sdp: "v=0".into() },
        SignalKind::Candidate {
            candidate: "candidate:garbage".into(),
        },
    ] {
        answerer.remote_signal(kind).expect("queued");
    }
    tokio::time::sleep(Duration::from_millis(200)).await;
    assert_eq!(
        answerer.state(),
        ConnectionState::Signaling,
        "still waiting for a real offer"
    );
    while let Ok(event) = events.try_recv() {
        assert!(
            !matches!(event, PeerEvent::LocalSignal(_)),
            "nothing was answered: {event:?}"
        );
    }
    answerer.close();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_message_near_the_limit_crosses() {
    let (offerer, mut offerer_rx) = start(PeerRole::Offerer, Duration::from_secs(10)).await;
    let (answerer, mut answerer_rx) = start(PeerRole::Answerer, Duration::from_secs(10)).await;
    pump(
        (&offerer, &mut offerer_rx),
        (&answerer, &mut answerer_rx),
        |e| matches!(e, PeerEvent::ChannelOpen(Channel::Files)),
    )
    .await;
    for size in [90 * 1024, 110 * 1024, 119 * 1024] {
        offerer.send(Channel::Files, vec![7; size]).expect("send");
        let got = pump(
            (&offerer, &mut offerer_rx),
            (&answerer, &mut answerer_rx),
            |e| matches!(e, PeerEvent::Data { .. }),
        )
        .await;
        assert!(
            matches!(got, PeerEvent::Data { data, .. } if data.len() == size),
            "{size}"
        );
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_bulk_sender_waits_for_the_channel_to_drain() {
    let (offerer, mut offerer_rx) = start(PeerRole::Offerer, Duration::from_secs(10)).await;
    let (answerer, mut answerer_rx) = start(PeerRole::Answerer, Duration::from_secs(10)).await;
    pump(
        (&offerer, &mut offerer_rx),
        (&answerer, &mut answerer_rx),
        |e| matches!(e, PeerEvent::ChannelOpen(Channel::Files)),
    )
    .await;
    const HIGH: usize = 512 * 1024;
    const PIECE: usize = 64 * 1024;
    const PIECES: usize = 128; // 8 MB
    let sender = offerer.clone();
    let producer = tokio::spawn(async move {
        let mut most = 0;
        for i in 0..PIECES {
            sender
                .writable(Channel::Files, HIGH)
                .await
                .expect("writable");
            sender
                .send(Channel::Files, vec![(i % 251) as u8; PIECE])
                .expect("send");
            most = most.max(sender.buffered(Channel::Files));
        }
        most
    });
    let mut received = 0;
    tokio::time::timeout(WAIT * 2, async {
        while received < PIECES {
            match answerer_rx.recv().await.expect("events") {
                PeerEvent::Data {
                    channel: Channel::Files,
                    data,
                } => {
                    assert_eq!(data[0], (received % 251) as u8, "in order");
                    received += 1;
                }
                PeerEvent::LocalSignal(kind) => offerer.remote_signal(kind).expect("signal"),
                _ => {}
            }
        }
    })
    .await
    .expect("everything arrived");
    let most = producer.await.expect("producer");
    // Bounded, not exact: the driver publishes its figures once per turn, so a sender can be one turn's worth of
    // messages (plus SCTP framing) ahead. Without the gate all 8 MB would be queued at once.
    assert!(most <= HIGH + 256 * 1024, "buffered at most {most} bytes");
}
