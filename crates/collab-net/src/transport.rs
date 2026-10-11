//! The interfaces the rest of OpenMind depends on. Nothing outside the `peer` module names `str0m`, and nothing
//! outside `signaling`/`stun`/`relay` knows how candidates are found or relayed — so TURN over TCP/TLS, another WebRTC
//! engine or another rendezvous can replace an implementation without touching the collaboration protocol.

use std::future::Future;
use std::net::SocketAddr;
use std::pin::Pin;
use std::sync::Arc;

use openmind_collab::protocol::Channel;
use openmind_collab_signal::{ClientMessage, RelayMessage, SignalKind};
use serde::Serialize;
use tokio::sync::mpsc;

use crate::error::NetError;
use crate::state::ConnectionState;

pub type BoxFuture<'a, T> = Pin<Box<dyn Future<Output = T> + Send + 'a>>;

/// What arrives from the signaling relay.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SignalingEvent {
    Message(RelayMessage),
    /// The relay link ended (relay restart, network loss, the relay closing it).
    Closed {
        reason: String,
    },
}

/// An open link to a signaling relay.
pub trait SignalingTransport: Send + Sync {
    fn send(&self, message: ClientMessage) -> Result<(), NetError>;
    fn close(&self);
    /// Which route a participant's slot arrived on, and where its signaling came from when that is known (an Owner's
    /// own local rendezvous knows each participant's address). `None` for an ordinary relay link.
    fn route_of(
        &self,
        _slot: &openmind_collab_signal::Slot,
    ) -> Option<(crate::state::ConnectionRoute, Option<SocketAddr>)> {
        None
    }
}

/// An open signaling link and what arrives on it.
pub type SignalingLink = (Arc<dyn SignalingTransport>, mpsc::Receiver<SignalingEvent>);

/// Opens signaling links (one per call).
pub trait SignalingConnector: Send + Sync {
    fn connect(&self) -> BoxFuture<'_, Result<SignalingLink, NetError>>;
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum CandidateKind {
    Host,
    ServerReflexive,
    Relayed,
}

/// A local ICE candidate: where the other side can reach us, and the socket address it is based on.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct LocalCandidate {
    pub kind: CandidateKind,
    pub addr: SocketAddr,
    pub base: SocketAddr,
}

/// Finds the local candidates of a socket before negotiation starts (host addresses, STUN-mapped addresses).
pub trait CandidateGatherer: Send + Sync {
    fn gather<'a>(
        &'a self,
        socket: &'a tokio::net::UdpSocket,
    ) -> BoxFuture<'a, Vec<LocalCandidate>>;
}

/// How the connection to the TURN server is made (the relayed leg to peers is always UDP).
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum RelayProtocol {
    Udp,
    Tcp,
    Tls,
}

/// What a relay hands the WebRTC engine.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RelayEvent {
    /// A packet a peer sent to the relayed address.
    Data { peer: SocketAddr, data: Vec<u8> },
    /// Something went wrong that doesn't end the relay (a peer permission was refused).
    Problem(crate::turn::TurnFailure),
    /// The allocation ended (lost connection, refresh failure); nothing more will arrive.
    Ended(crate::turn::TurnFailure),
}

/// The WebRTC engine's end of a running allocation. Packets are sent and received with UDP semantics (a full queue
/// drops). Dropping it releases the allocation on the server.
#[derive(Debug)]
pub struct RelayLink {
    outbound: mpsc::Sender<(SocketAddr, Vec<u8>)>,
    inbound: mpsc::Receiver<RelayEvent>,
}

impl RelayLink {
    pub fn new(
        outbound: mpsc::Sender<(SocketAddr, Vec<u8>)>,
        inbound: mpsc::Receiver<RelayEvent>,
    ) -> Self {
        Self { outbound, inbound }
    }

    /// Queues a packet for `peer`; `false` when the relay is gone.
    pub fn send(&self, peer: SocketAddr, data: Vec<u8>) -> bool {
        match self.outbound.try_send((peer, data)) {
            Ok(()) | Err(mpsc::error::TrySendError::Full(_)) => true,
            Err(mpsc::error::TrySendError::Closed(_)) => false,
        }
    }

    /// The next event (`None` once the relay task is gone). Cancel-safe.
    pub async fn recv(&mut self) -> Option<RelayEvent> {
        self.inbound.recv().await
    }
}

/// A relayed address obtained from a TURN server, the local address its traffic leaves from, how the server is
/// reached, and the running relay.
#[derive(Debug)]
pub struct RelayAllocation {
    pub relayed: SocketAddr,
    pub local: SocketAddr,
    pub protocol: RelayProtocol,
    pub link: RelayLink,
}

/// Which kind of path a peer connection's traffic takes (the ICE pair it selected), without any address.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum IcePath {
    /// To the other side's host address (same LAN, or a directly reachable machine).
    Direct,
    /// To an address discovered with STUN (through a NAT, still peer to peer).
    Stun,
    TurnUdp,
    TurnTcp,
    TurnTls,
}

impl IcePath {
    pub fn relayed(protocol: RelayProtocol) -> Self {
        match protocol {
            RelayProtocol::Udp => IcePath::TurnUdp,
            RelayProtocol::Tcp => IcePath::TurnTcp,
            RelayProtocol::Tls => IcePath::TurnTls,
        }
    }
}

/// Whether TURN relaying can be used, and why not.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase", tag = "status")]
pub enum RelayStatus {
    NotConfigured,
    Unavailable {
        servers: Vec<String>,
        reason: String,
    },
    Available {
        servers: Vec<String>,
    },
}

/// Supplies relayed candidates (TURN). Kept apart from the peer engine so allocation over UDP, TCP or TLS on 443
/// can be provided by any implementation.
pub trait RelayProvider: Send + Sync {
    fn status(&self) -> RelayStatus;
    fn allocate(&self) -> BoxFuture<'_, Result<RelayAllocation, NetError>>;
}

/// What a peer connection reports.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PeerEvent {
    /// A signal to send to the other side through the relay.
    LocalSignal(SignalKind),
    State(ConnectionState),
    /// DTLS is up: this side's and the other side's certificate fingerprints (for handshake binding).
    Secured {
        local_fingerprint: String,
        remote_fingerprint: String,
    },
    ChannelOpen(Channel),
    /// The kind of path the connection's traffic now takes (reported when it is first known and when it changes).
    Path(IcePath),
    Data {
        channel: Channel,
        data: Vec<u8>,
    },
}

/// Sends application messages on the logical data channels.
pub trait DataChannelTransport: Send + Sync {
    fn send(&self, channel: Channel, data: Vec<u8>) -> Result<(), NetError>;
    /// Bytes sent on `channel` and not yet handed to the network (queued here or in the SCTP send buffer).
    fn buffered(&self, channel: Channel) -> usize;
    /// Waits until fewer than `below` bytes are buffered on `channel` (backpressure for bulk senders).
    fn writable(&self, channel: Channel, below: usize) -> BoxFuture<'_, Result<(), NetError>>;
}

/// One WebRTC peer connection.
pub trait PeerTransport: DataChannelTransport {
    /// A signal received from the other side through the relay.
    fn remote_signal(&self, signal: SignalKind) -> Result<(), NetError>;
    /// Starts an ICE restart (offering side only): a new offer is reported as a [`PeerEvent::LocalSignal`].
    fn ice_restart(&self) -> Result<(), NetError>;
    fn state(&self) -> ConnectionState;
    fn close(&self);
}
