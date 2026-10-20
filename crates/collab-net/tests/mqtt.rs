//! Owner + participant meeting through the built-in public MQTT brokers (real Internet; ignored by default):
//! `cargo test -p openmind-collab-net --test mqtt -- --ignored`. WebRTC stays on loopback; only signaling goes out.

mod common;

use std::sync::Arc;
use std::time::Duration;

use common::*;
use openmind_collab::PeerIdentity;
use openmind_collab_net::owner::{OwnerEvent, OwnerNetwork, OwnerOptions};
use openmind_collab_net::participant::{self, JoinMode};
use openmind_collab_net::relay::TurnRelay;
use openmind_collab_net::signaling::mqtt::{public_brokers, MqttSignaling, PUBLIC_BROKERS};
use openmind_collab_net::stun::StunGatherer;
use openmind_collab_net::{ConnectionState, NetError};

fn options() -> OwnerOptions {
    OwnerOptions {
        ice: ice(),
        gatherer: Arc::new(StunGatherer::new(Vec::new())),
        relay: Arc::new(TurnRelay::new(Vec::new())),
        peer_connect_timeout: Duration::from_secs(20),
        handshake_timeout: Duration::from_secs(30),
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
#[ignore = "uses the public MQTT brokers on the Internet"]
async fn a_room_code_is_enough_through_the_public_brokers() {
    let authority = MemoryAuthority::new();
    let (owner, mut events) =
        OwnerNetwork::start(authority.clone(), Arc::new(public_brokers()), options());
    wait_for(
        &mut events,
        |e| matches!(e, OwnerEvent::Signaling { state } if *state == ConnectionState::Connected),
    )
    .await;
    let identity = PeerIdentity::generate().expect("identity");
    let mut config = config(authority.code().await, JoinMode::Join);
    config.handshake_timeout = Duration::from_secs(30);
    let mut student = participant::connect(identity, config, Arc::new(public_brokers()))
        .await
        .expect("joined through a broker");
    ping(&mut student, 7).await;
    owner.stop();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
#[ignore = "uses the public MQTT brokers on the Internet"]
async fn each_broker_carries_a_room_on_its_own() {
    for url in PUBLIC_BROKERS {
        let authority = MemoryAuthority::new();
        let (owner, mut events) = OwnerNetwork::start(
            authority.clone(),
            Arc::new(MqttSignaling::direct(url)),
            options(),
        );
        wait_for(&mut events, |e| {
            matches!(e, OwnerEvent::Signaling { state } if *state == ConnectionState::Connected)
        })
        .await;
        let identity = PeerIdentity::generate().expect("identity");
        let mut student = participant::connect(
            identity,
            config(authority.code().await, JoinMode::Join),
            Arc::new(MqttSignaling::direct(url)),
        )
        .await
        .unwrap_or_else(|e| panic!("{url}: {e}"));
        ping(&mut student, 1).await;
        owner.stop();
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
#[ignore = "uses the public MQTT brokers on the Internet"]
async fn a_code_nobody_hosts_is_reported_as_no_room() {
    let authority = MemoryAuthority::new();
    let identity = PeerIdentity::generate().expect("identity");
    let mut config = config(authority.code().await, JoinMode::Join);
    config.handshake_timeout = Duration::from_secs(30);
    let result = participant::connect(identity, config, Arc::new(public_brokers())).await;
    assert!(
        matches!(
            result,
            Err(NetError::Relay(openmind_collab_signal::ErrorCode::NoHost))
        ),
        "{:?}",
        result.err()
    );
}
