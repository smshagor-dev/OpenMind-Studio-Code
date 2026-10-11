//! The Owner side: hosts the room's signaling topic, answers each participant's offer with a peer connection, runs
//! the handshake and passes every admitted frame through the [`crate::gate`] to the [`OwnerAuthority`].
//!
//! Network input never changes room state here. The authority — implemented by the app over
//! `openmind_collab::Authority` and the machine database — decides joins (with the challenge bound to the
//! connection's DTLS fingerprints), runs `authorize` for every frame and records disconnects. The relay link can
//! drop and come back (it is re-hosted with backoff) without disturbing connected participants.

mod link;
mod run;
pub mod serve;

use std::sync::Arc;
use std::time::Duration;

use openmind_collab::authority::JoinOutcome;
use openmind_collab::manifest::{ManifestEntry, ManifestSnapshot};
use openmind_collab::protocol::{Admission, Body, Frame, Handshake};
use openmind_collab::transfer::{FileErrorCode, Snapshot};
use openmind_collab::{Actor, FileId, PeerId, RoomUid, SessionId};
use openmind_collab_signal::Topic;
use serde::Serialize;
use tokio::sync::mpsc;

use crate::ice::IceSetup;
use crate::state::ConnectionState;
use crate::transport::{BoxFuture, CandidateGatherer, RelayProvider, SignalingConnector};

/// What the authority decided about one frame.
#[derive(Debug, Clone, PartialEq)]
pub enum FrameOutcome {
    Accepted,
    Rejected(String),
    /// Accepted, and these messages go to these participants (a document sync, a change forwarded to the others).
    Reply(Vec<(PeerId, Body)>),
    /// Nothing to acknowledge (latest-value data such as presence); these messages go out.
    Relay(Vec<(PeerId, Body)>),
    /// Ignored without an answer (a stale or invalid presence state).
    Dropped,
}

/// The room's authority as the network sees it. Every call is made only after the gate's checks.
pub trait OwnerAuthority: Send + Sync + 'static {
    fn room_uid(&self) -> RoomUid;
    /// The signaling topic of the current Room Code.
    fn topic(&self) -> BoxFuture<'_, Result<Topic, String>>;
    /// The Owner's first handshake message for a connection: proofs over `bound`.
    fn hello(
        &self,
        challenge: openmind_collab::ids::Challenge,
        bound: openmind_collab::ids::Challenge,
    ) -> BoxFuture<'_, Result<Handshake, String>>;
    /// A join or reconnect request answering the bound challenge (persisted by the app).
    fn admit(
        &self,
        request: Handshake,
        bound: openmind_collab::ids::Challenge,
    ) -> BoxFuture<'_, Result<JoinOutcome, String>>;
    /// A waiting member a moderator approved, admitted on its open connection.
    fn admit_approved(&self, peer: PeerId) -> BoxFuture<'_, Result<Admission, String>>;
    /// An admitted frame (the authority authorizes it for `actor`).
    fn frame(&self, actor: Actor, frame: Frame) -> BoxFuture<'_, FrameOutcome>;
    fn disconnected(&self, peer: PeerId, session: SessionId, reason: String) -> BoxFuture<'_, ()>;
    /// The current shared manifest, for `actor` (authorized as a read).
    fn manifest(&self, actor: Actor) -> BoxFuture<'_, Result<ManifestSnapshot, String>>;
    /// One file's bytes as one consistent snapshot, for `actor` (authorized, privacy- and path-checked). Unknown,
    /// deleted and hidden files all answer `Unavailable`.
    fn open_file(
        &self,
        actor: Actor,
        file: FileId,
    ) -> BoxFuture<'_, Result<Snapshot, FileErrorCode>>;
}

/// A change of the shared tree, pushed to every admitted participant.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum TreeChange {
    Delta {
        base: u64,
        version: u64,
        upserts: Vec<ManifestEntry>,
        removed: Vec<FileId>,
    },
    /// Too much changed (or the watcher overflowed): participants fetch the manifest again.
    Reset { version: u64 },
}

/// What the Owner network reports (transient; durable room state stays in the app's canonical state).
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase", tag = "kind")]
pub enum OwnerEvent {
    Signaling {
        state: ConnectionState,
    },
    Link {
        slot: String,
        state: ConnectionState,
    },
    Admitted {
        slot: String,
        peer: PeerId,
        session: SessionId,
        /// How this participant reached the room.
        route: crate::state::ConnectionRoute,
    },
    Pending {
        slot: String,
        peer: PeerId,
    },
    /// The kind of path a participant's connection takes (direct, STUN, or a TURN relay); never an address.
    Path {
        slot: String,
        path: crate::transport::IcePath,
    },
    Left {
        peer: PeerId,
        session: SessionId,
        reason: String,
    },
    Problem {
        message: String,
    },
}

#[derive(Debug)]
pub(crate) enum OwnerCommand {
    Approved(PeerId),
    Close(PeerId),
    /// Tell a peer waiting for approval that it won't be admitted, then close its connection.
    Refuse(PeerId, openmind_collab::protocol::Refusal),
    Tree(TreeChange),
    /// A message for one admitted participant (from the Owner's side: its own edit, an access change, a closed
    /// document).
    Send(PeerId, Body),
    /// Register on signaling again (the Room Code changed, so its topic did); peer links are untouched.
    Rehost,
    Stop,
}

#[derive(Clone)]
pub struct OwnerOptions {
    pub ice: IceSetup,
    pub gatherer: Arc<dyn CandidateGatherer>,
    pub relay: Arc<dyn RelayProvider>,
    pub peer_connect_timeout: Duration,
    pub handshake_timeout: Duration,
}

/// The peer options for one participant: one who arrived over the Owner's local rendezvous gets a connection bound to
/// the interface facing them (the system's route to their address), host candidates only — no STUN request and no
/// TURN allocation leaves the computer for a local-network connection.
pub(crate) fn lan_options(
    options: &OwnerOptions,
    route: Option<(crate::state::ConnectionRoute, Option<std::net::SocketAddr>)>,
) -> OwnerOptions {
    let Some((crate::state::ConnectionRoute::LocalLan, Some(remote))) = route else {
        return options.clone();
    };
    let mut lan = options.clone();
    lan.ice.bind_ip = crate::lan::netif::route_ip(remote.ip()).or(lan.ice.bind_ip);
    lan.ice.stun.clear();
    lan.ice.turn.clear();
    lan.ice.policy = crate::ice::IcePolicy::All;
    lan.gatherer = Arc::new(crate::stun::StunGatherer::new(Vec::new()));
    lan.relay = Arc::new(crate::relay::TurnRelay::new(Vec::new()));
    lan
}

/// A running Owner network for one room.
#[derive(Clone)]
pub struct OwnerNetwork {
    commands: mpsc::UnboundedSender<OwnerCommand>,
    room: RoomUid,
}

impl OwnerNetwork {
    pub fn start(
        authority: Arc<dyn OwnerAuthority>,
        signaling: Arc<dyn SignalingConnector>,
        options: OwnerOptions,
    ) -> (OwnerNetwork, mpsc::UnboundedReceiver<OwnerEvent>) {
        let (commands, command_rx) = mpsc::unbounded_channel();
        let (events, event_rx) = mpsc::unbounded_channel();
        let room = authority.room_uid();
        tokio::spawn(run::Hosting::new(authority, signaling, options, events).run(command_rx));
        (OwnerNetwork { commands, room }, event_rx)
    }

    pub fn room(&self) -> &RoomUid {
        &self.room
    }

    /// A moderator approved `peer`: admit it on its waiting connection.
    pub fn approved(&self, peer: PeerId) {
        let _ = self.commands.send(OwnerCommand::Approved(peer));
    }

    /// A peer waiting for approval was turned down (denied, removed or banned): it is told why, then its
    /// connection closes.
    pub fn refuse(&self, peer: PeerId, refusal: openmind_collab::protocol::Refusal) {
        let _ = self.commands.send(OwnerCommand::Refuse(peer, refusal));
    }

    /// Closes `peer`'s connection (kicked, banned, removed, room closed).
    pub fn close_peer(&self, peer: PeerId) {
        let _ = self.commands.send(OwnerCommand::Close(peer));
    }

    /// Pushes a change of the shared tree to every admitted participant (transfers of removed files stop).
    pub fn tree_changed(&self, change: TreeChange) {
        let _ = self.commands.send(OwnerCommand::Tree(change));
    }

    /// Sends `body` to the admitted participant `peer` (dropped if it isn't connected).
    pub fn send(&self, peer: PeerId, body: Body) {
        let _ = self.commands.send(OwnerCommand::Send(peer, body));
    }

    /// Re-registers the room on every signaling route under its current topic (after a Room Code rotation).
    /// Connected participants stay connected: their peer links don't use signaling.
    pub fn rehost(&self) {
        let _ = self.commands.send(OwnerCommand::Rehost);
    }

    pub fn stop(&self) {
        let _ = self.commands.send(OwnerCommand::Stop);
    }

    pub fn is_running(&self) -> bool {
        !self.commands.is_closed()
    }
}
