//! Local-network harness: an Owner whose only signaling is its own embedded rendezvous (no Internet relay, no STUN,
//! no TURN), discovery pointed at loopback so tests are deterministic on any machine.

use std::net::{IpAddr, Ipv4Addr, SocketAddr};
use std::sync::Arc;
use std::time::Duration;

use openmind_collab::authority::{Actor, JoinOutcome};
use openmind_collab::ids::Challenge;
use openmind_collab::manifest::ManifestSnapshot;
use openmind_collab::protocol::{Admission, Frame, Handshake};
use openmind_collab::transfer::{FileErrorCode, Snapshot};
use openmind_collab::{FileId, PeerId, PeerIdentity, RoomUid, SessionId};
use openmind_collab_net::ice::IceSetup;
use openmind_collab_net::lan::discover::DiscoveryConfig;
use openmind_collab_net::lan::host::{LanHost, LanHostConfig};
use openmind_collab_net::owner::{
    FrameOutcome, OwnerAuthority, OwnerEvent, OwnerNetwork, OwnerOptions,
};
use openmind_collab_net::participant::JoinMode;
use openmind_collab_net::relay::TurnRelay;
use openmind_collab_net::route::{self, LanOptions, RouteOptions, Routed};
use openmind_collab_net::signaling::multi::{MultiSignaling, Route};
use openmind_collab_net::signaling::WsSignaling;
use openmind_collab_net::stun::StunGatherer;
use openmind_collab_net::transport::BoxFuture;
use openmind_collab_net::{ConnectionRoute, NetError};
use openmind_collab_signal::Topic;
use tokio::sync::mpsc;

use super::{config, wait_for, MemoryAuthority};

pub const LOOPBACK: IpAddr = IpAddr::V4(Ipv4Addr::LOCALHOST);

/// A UDP port nothing listens on right now (each test gets its own discovery port).
pub fn free_udp_port() -> u16 {
    std::net::UdpSocket::bind("127.0.0.1:0")
        .and_then(|s| s.local_addr())
        .map(|a| a.port())
        .expect("port")
}

pub fn host_config(discovery_port: u16, mdns: bool) -> LanHostConfig {
    LanHostConfig {
        bind: LOOPBACK,
        preferred_port: None,
        discovery_port,
        mdns,
        announce_on: Some(vec![LOOPBACK]),
        refresh: Duration::from_millis(500),
    }
}

/// Discovery that only asks this computer (as a broadcast would reach it), without mDNS.
pub fn discovery(port: u16) -> DiscoveryConfig {
    DiscoveryConfig {
        window: Duration::from_millis(1200),
        mdns: false,
        mdns_on: Some(vec![LOOPBACK]),
        broadcast: true,
        broadcast_targets: Some(vec![SocketAddr::new(LOOPBACK, port)]),
    }
}

pub fn lan_only(port: u16) -> RouteOptions {
    RouteOptions {
        lan: Some(LanOptions {
            discovery: discovery(port),
            attempt_timeout: Duration::from_secs(8),
            ..LanOptions::default()
        }),
        internet: None,
    }
}

pub struct LanWorld {
    pub host: Option<LanHost>,
    pub owner: OwnerNetwork,
    pub events: mpsc::UnboundedReceiver<OwnerEvent>,
    pub authority: Arc<MemoryAuthority>,
    pub discovery_port: u16,
}

/// No STUN, no TURN and no bind address of its own: a local participant's connection must get its address from the
/// route to that participant.
fn owner_options() -> OwnerOptions {
    OwnerOptions {
        ice: IceSetup::default(),
        gatherer: Arc::new(StunGatherer::new(Vec::new())),
        relay: Arc::new(TurnRelay::new(Vec::new())),
        peer_connect_timeout: Duration::from_secs(10),
        handshake_timeout: Duration::from_secs(15),
    }
}

/// Hosts `authority`'s room on the local network only (plus `internet`, a relay URL, when given).
pub async fn lan_world_with(
    authority: Arc<dyn OwnerAuthority>,
    memory: Arc<MemoryAuthority>,
    discovery_port: u16,
    mdns: bool,
    internet: Option<&str>,
) -> LanWorld {
    lan_world_on(
        authority,
        memory,
        host_config(discovery_port, mdns),
        internet,
    )
    .await
}

/// As [`lan_world_with`] with a chosen host configuration. With an Internet relay the Owner binds to loopback like
/// the rest of the harness (an Internet-route peer otherwise takes the machine's default address).
pub async fn lan_world_on(
    authority: Arc<dyn OwnerAuthority>,
    memory: Arc<MemoryAuthority>,
    host: LanHostConfig,
    internet: Option<&str>,
) -> LanWorld {
    let discovery_port = host.discovery_port;
    let topic = authority.topic().await.expect("topic");
    let host = LanHost::start(topic.as_str(), host)
        .await
        .expect("lan host");
    let mut routes = vec![host.route().expect("route")];
    if let Some(url) = internet {
        routes.push(Route {
            route: ConnectionRoute::InternetRelay,
            connector: Arc::new(WsSignaling::direct(url)),
            lookup: None,
        });
    }
    let mut options = owner_options();
    if internet.is_some() {
        options.ice = super::ice();
    }
    let (owner, mut events) =
        OwnerNetwork::start(authority, Arc::new(MultiSignaling::new(routes)), options);
    wait_for(&mut events, |e| matches!(e, OwnerEvent::Signaling { state } if *state == openmind_collab_net::ConnectionState::Connected)).await;
    LanWorld {
        host: Some(host),
        owner,
        events,
        authority: memory,
        discovery_port,
    }
}

pub async fn lan_world(discovery_port: u16) -> LanWorld {
    let authority = MemoryAuthority::new();
    lan_world_with(authority.clone(), authority, discovery_port, false, None).await
}

pub async fn lan_join(
    world: &LanWorld,
    identity: &PeerIdentity,
    mode: JoinMode,
    options: RouteOptions,
) -> Result<Routed, NetError> {
    lan_join_report(world, identity, mode, options).await.0
}

/// [`lan_join`] with what the route found and tried (printed by tests when a join fails).
pub async fn lan_join_report(
    world: &LanWorld,
    identity: &PeerIdentity,
    mode: JoinMode,
    options: RouteOptions,
) -> (Result<Routed, NetError>, route::RouteReport) {
    let code = world.authority.code().await;
    route::connect_with_report(identity.clone(), config(code, mode), options).await
}

/// An impostor: its own room and Room Code, but announcing and hosting another room's signaling topic (as a machine
/// that learned the topic, without the code, could).
pub struct ForgedTopic {
    pub inner: Arc<MemoryAuthority>,
    pub topic: Topic,
}

impl OwnerAuthority for ForgedTopic {
    fn room_uid(&self) -> RoomUid {
        self.inner.room_uid()
    }
    fn topic(&self) -> BoxFuture<'_, Result<Topic, String>> {
        Box::pin(async move { Ok(self.topic.clone()) })
    }
    fn hello(
        &self,
        challenge: Challenge,
        bound: Challenge,
    ) -> BoxFuture<'_, Result<Handshake, String>> {
        self.inner.hello(challenge, bound)
    }
    fn admit(
        &self,
        request: Handshake,
        bound: Challenge,
    ) -> BoxFuture<'_, Result<JoinOutcome, String>> {
        self.inner.admit(request, bound)
    }
    fn admit_approved(&self, peer: PeerId) -> BoxFuture<'_, Result<Admission, String>> {
        self.inner.admit_approved(peer)
    }
    fn frame(&self, actor: Actor, frame: Frame) -> BoxFuture<'_, FrameOutcome> {
        self.inner.frame(actor, frame)
    }
    fn disconnected(&self, peer: PeerId, session: SessionId, reason: String) -> BoxFuture<'_, ()> {
        self.inner.disconnected(peer, session, reason)
    }
    fn manifest(&self, actor: Actor) -> BoxFuture<'_, Result<ManifestSnapshot, String>> {
        self.inner.manifest(actor)
    }
    fn open_file(
        &self,
        actor: Actor,
        file: FileId,
    ) -> BoxFuture<'_, Result<Snapshot, FileErrorCode>> {
        self.inner.open_file(actor, file)
    }
}
