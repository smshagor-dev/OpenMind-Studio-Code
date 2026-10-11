//! The participant side: reach the Owner through the relay, open the peer connection (this side offers the four
//! channels), check that the other side really is the room's Owner (its proofs are bound to this connection's DTLS
//! fingerprints; a first join also needs its Room Code proof, a reconnect its pinned key), then answer the bound
//! challenge with a join or reconnect request. Once admitted the relay link is closed: the session no longer depends
//! on it.

use std::sync::{Arc, Mutex};
use std::time::Duration;

use openmind_collab::binding::verify_owner_hello;
use openmind_collab::protocol::{
    Admission, Body, Channel, Frame, Handshake, JoinRequest, ReconnectRequest,
};
use openmind_collab::replay::SequenceCounter;
use openmind_collab::{MessageId, PeerIdentity, PublicKey, RoomCode, RoomUid};
use openmind_collab_signal::{
    ClientMessage, NegotiationId, RelayMessage, Signal, SignalKind, Slot, Topic, SIGNAL_VERSION,
};
use tokio::sync::mpsc;

use crate::error::NetError;
use crate::gate::{Inbound, InboundGate};
use crate::ice::IceSetup;
use crate::peer::{PeerConfig, PeerHandle, PeerRole};
use crate::state::ConnectionState;
use crate::transport::{
    CandidateGatherer, DataChannelTransport, PeerEvent, PeerTransport, RelayProvider,
    SignalingConnector, SignalingEvent, SignalingTransport,
};

/// Joining for the first time (with the Room Code) or coming back (key-based, with the Owner key pinned earlier).
#[derive(Debug, Clone)]
pub enum JoinMode {
    Join,
    Reconnect { room: RoomUid, owner_key: PublicKey },
}

#[derive(Clone)]
pub struct ParticipantConfig {
    /// Needed in both modes: its signaling topic is where the Owner listens.
    pub code: RoomCode,
    pub display_name: String,
    pub mode: JoinMode,
    pub ice: IceSetup,
    pub gatherer: Arc<dyn CandidateGatherer>,
    pub relay: Arc<dyn RelayProvider>,
    pub handshake_timeout: Duration,
    pub approval_timeout: Duration,
    /// Called when the Owner says the join waits for a moderator's approval (for progress text).
    pub on_pending: Option<Arc<dyn Fn() + Send + Sync>>,
}

/// What an admitted session reports.
#[derive(Debug, Clone, PartialEq)]
pub enum ParticipantEvent {
    Frame(Frame),
    State(ConnectionState),
    /// A message from the Owner failed the gate (it is dropped).
    Invalid(String),
    /// The kind of path the connection takes (direct, STUN, or a TURN relay); never an address.
    Path(crate::transport::IcePath),
}

/// An admitted participant session.
pub struct Participant {
    peer: PeerHandle,
    admission: Admission,
    owner_key: PublicKey,
    room: RoomUid,
    seq: Arc<Mutex<SequenceCounter>>,
    events: mpsc::UnboundedReceiver<ParticipantEvent>,
}

impl Participant {
    pub fn admission(&self) -> &Admission {
        &self.admission
    }

    pub fn owner_key(&self) -> &PublicKey {
        &self.owner_key
    }

    pub fn room(&self) -> &RoomUid {
        &self.room
    }

    pub fn state(&self) -> ConnectionState {
        self.peer.state()
    }

    /// Sends a frame of this session; returns its message id.
    pub fn send(&self, body: Body) -> Result<MessageId, NetError> {
        self.sender().send(body)
    }

    /// A handle that can send and close while another task reads the events.
    pub fn sender(&self) -> ParticipantSender {
        ParticipantSender {
            peer: self.peer.clone(),
            session: self.admission.session.clone(),
            seq: self.seq.clone(),
        }
    }

    /// Sends raw bytes on a channel (tests of the Owner's validation).
    pub fn send_raw(&self, channel: Channel, bytes: Vec<u8>) -> Result<(), NetError> {
        self.peer.send(channel, bytes)
    }

    pub async fn next_event(&mut self) -> Option<ParticipantEvent> {
        self.events.recv().await
    }

    pub fn close(&self) {
        self.peer.close();
    }
}

/// Sends frames of an admitted session (cloneable).
#[derive(Clone)]
pub struct ParticipantSender {
    peer: PeerHandle,
    session: openmind_collab::SessionId,
    seq: Arc<Mutex<SequenceCounter>>,
}

impl ParticipantSender {
    pub fn send(&self, body: Body) -> Result<MessageId, NetError> {
        let seq = self.seq.lock().map_err(|_| NetError::Closed)?.advance();
        let frame = Frame::new(self.session.clone(), seq, body)
            .map_err(|e| NetError::Protocol(e.to_string()))?;
        let bytes = frame
            .encode()
            .map_err(|e| NetError::Protocol(e.to_string()))?;
        self.peer.send(frame.channel, bytes)?;
        Ok(frame.id)
    }

    pub fn state(&self) -> ConnectionState {
        self.peer.state()
    }

    pub fn close(&self) {
        self.peer.close();
    }
}

struct Negotiation {
    relay: Arc<dyn SignalingTransport>,
    relay_rx: mpsc::Receiver<SignalingEvent>,
    host: Slot,
    local: NegotiationId,
    local_seq: u64,
    remote: Option<(NegotiationId, u64)>,
}

impl Negotiation {
    fn send(&mut self, kind: SignalKind) {
        self.local_seq += 1;
        let signal = Signal {
            negotiation: self.local.clone(),
            seq: self.local_seq,
            kind,
        };
        let _ = self.relay.send(ClientMessage::Signal {
            to: self.host.clone(),
            signal,
        });
    }

    /// Whether a signal from the Owner is new (the first fixes its negotiation; duplicates and stale ones drop).
    fn accept(&mut self, signal: &Signal) -> bool {
        match &mut self.remote {
            Some((negotiation, seq)) if *negotiation == signal.negotiation => {
                if signal.seq <= *seq {
                    return false;
                }
                *seq = signal.seq;
                true
            }
            Some(_) => false,
            None => {
                self.remote = Some((signal.negotiation.clone(), signal.seq));
                true
            }
        }
    }
}

async fn reach_owner(
    connector: &dyn SignalingConnector,
    code: &RoomCode,
    timeout: Duration,
) -> Result<Negotiation, NetError> {
    let (relay, mut relay_rx) = connector.connect().await?;
    let topic = Topic::parse(&code.signaling_topic()).map_err(NetError::Protocol)?;
    relay.send(ClientMessage::Join {
        v: SIGNAL_VERSION,
        topic,
    })?;
    let host = tokio::time::timeout(timeout, async {
        loop {
            match relay_rx.recv().await {
                Some(SignalingEvent::Message(RelayMessage::Joined { host, .. })) => {
                    return Ok(host)
                }
                Some(SignalingEvent::Message(RelayMessage::Error { code })) => {
                    return Err(NetError::Relay(code))
                }
                Some(SignalingEvent::Closed { reason }) => return Err(NetError::Signaling(reason)),
                None => return Err(NetError::Closed),
                Some(_) => {}
            }
        }
    })
    .await
    .map_err(|_| NetError::Timeout("waiting for the signaling relay"))??;
    let local = NegotiationId::random().map_err(NetError::Protocol)?;
    Ok(Negotiation {
        relay,
        relay_rx,
        host,
        local,
        local_seq: 0,
        remote: None,
    })
}

/// Joins (or rejoins) the room as `identity`.
pub async fn connect(
    identity: PeerIdentity,
    config: ParticipantConfig,
    connector: Arc<dyn SignalingConnector>,
) -> Result<Participant, NetError> {
    let mut negotiation =
        reach_owner(connector.as_ref(), &config.code, config.handshake_timeout).await?;
    let (peer, mut peer_rx) = crate::peer::start(
        PeerConfig::new(PeerRole::Offerer),
        &config.ice,
        config.gatherer.as_ref(),
        config.relay.clone(),
    )
    .await?;
    let handshake = Handshaking {
        identity: &identity,
        config: &config,
        fingerprints: None,
        path: None,
        deadline: tokio::time::Instant::now() + config.handshake_timeout,
    };
    let result = handshake.run(&peer, &mut peer_rx, &mut negotiation).await;
    negotiation.relay.close();
    let (admission, owner_key, room, path) = match result {
        Ok(done) => done,
        Err(err) => {
            peer.close();
            return Err(err);
        }
    };
    let (events, receiver) = mpsc::unbounded_channel();
    if let Some(path) = path {
        let _ = events.send(ParticipantEvent::Path(path));
    }
    let mut gate = InboundGate::default();
    gate.admit(owner_key.peer_id(), admission.session.clone());
    tokio::spawn(forward(peer_rx, gate, events));
    Ok(Participant {
        peer,
        admission,
        owner_key,
        room,
        seq: Arc::new(Mutex::new(SequenceCounter::default())),
        events: receiver,
    })
}

async fn forward(
    mut peer_rx: mpsc::UnboundedReceiver<PeerEvent>,
    mut gate: InboundGate,
    events: mpsc::UnboundedSender<ParticipantEvent>,
) {
    while let Some(event) = peer_rx.recv().await {
        let out = match event {
            PeerEvent::Data { channel, data } => match gate.accept(channel, &data) {
                Ok(Inbound::Frame(frame)) => ParticipantEvent::Frame(frame),
                Ok(Inbound::Handshake(_)) => continue,
                Err(err) => ParticipantEvent::Invalid(err.reason()),
            },
            PeerEvent::State(state) => ParticipantEvent::State(state),
            PeerEvent::Path(path) => ParticipantEvent::Path(path),
            _ => continue,
        };
        if events.send(out).is_err() {
            break;
        }
    }
}

struct Handshaking<'a> {
    identity: &'a PeerIdentity,
    config: &'a ParticipantConfig,
    fingerprints: Option<(String, String)>,
    /// The path the connection took while joining (reported once the session starts).
    path: Option<crate::transport::IcePath>,
    deadline: tokio::time::Instant,
}

type Done = (
    Admission,
    PublicKey,
    RoomUid,
    Option<crate::transport::IcePath>,
);

impl Handshaking<'_> {
    async fn run(
        mut self,
        peer: &PeerHandle,
        peer_rx: &mut mpsc::UnboundedReceiver<PeerEvent>,
        n: &mut Negotiation,
    ) -> Result<Done, NetError> {
        let mut owner: Option<(PublicKey, RoomUid)> = None;
        loop {
            tokio::select! {
                _ = tokio::time::sleep_until(self.deadline) => return Err(NetError::Timeout("joining the room")),
                event = n.relay_rx.recv() => match event {
                    Some(SignalingEvent::Message(RelayMessage::Signal { from, signal })) if from == n.host && n.accept(&signal) => {
                        let _ = peer.remote_signal(signal.kind);
                    }
                    Some(SignalingEvent::Message(RelayMessage::PeerLeft { slot })) if slot == n.host && self.fingerprints.is_none() => {
                        return Err(NetError::Signaling("the Owner left before the connection was made".into()));
                    }
                    _ => {}
                },
                event = peer_rx.recv() => match event.ok_or(NetError::Closed)? {
                    PeerEvent::LocalSignal(kind) => n.send(kind),
                    PeerEvent::Secured { local_fingerprint, remote_fingerprint } => self.fingerprints = Some((local_fingerprint, remote_fingerprint)),
                    PeerEvent::State(state) if state.is_finished() => return Err(NetError::Rtc(format!("the connection ended ({state:?})"))),
                    PeerEvent::Path(path) => self.path = Some(path),
                    PeerEvent::Data { channel: Channel::Control, data } => {
                        let message = Handshake::decode(&data).map_err(|e| NetError::Protocol(e.to_string()))?;
                        if let Some(done) = self.answer(peer, message, &mut owner)? {
                            return Ok(done);
                        }
                    }
                    _ => {}
                },
            }
        }
    }

    /// Handles one handshake message from the Owner; `Some` once admitted.
    fn answer(
        &mut self,
        peer: &PeerHandle,
        message: Handshake,
        owner: &mut Option<(PublicKey, RoomUid)>,
    ) -> Result<Option<Done>, NetError> {
        match message {
            Handshake::Challenge { .. } => {
                let (local, remote) = self
                    .fingerprints
                    .clone()
                    .ok_or_else(|| NetError::Protocol("a challenge before DTLS".into()))?;
                let (room, pinned) = match &self.config.mode {
                    JoinMode::Join => (None, None),
                    JoinMode::Reconnect { room, owner_key } => (Some(room), Some(owner_key)),
                };
                let code = matches!(self.config.mode, JoinMode::Join).then_some(&self.config.code);
                let verified = verify_owner_hello(&message, room, code, pinned, (&local, &remote))
                    .map_err(|e| NetError::Protocol(e.to_string()))?;
                let reply = match &self.config.mode {
                    JoinMode::Join => Handshake::Join(JoinRequest::create(
                        self.identity,
                        &self.config.code,
                        &verified.room,
                        &verified.bound,
                        &self.config.display_name,
                    )),
                    JoinMode::Reconnect { .. } => Handshake::Reconnect(ReconnectRequest::create(
                        self.identity,
                        &verified.room,
                        &verified.bound,
                    )),
                };
                let bytes = reply
                    .encode()
                    .map_err(|e| NetError::Protocol(e.to_string()))?;
                peer.send(Channel::Control, bytes)?;
                *owner = Some((verified.owner_key, verified.room));
                Ok(None)
            }
            Handshake::Pending => {
                self.deadline = tokio::time::Instant::now() + self.config.approval_timeout;
                if let Some(pending) = &self.config.on_pending {
                    pending();
                }
                Ok(None)
            }
            Handshake::Admitted(admission) => {
                let (owner_key, room) = owner
                    .clone()
                    .ok_or_else(|| NetError::Protocol("admitted before the challenge".into()))?;
                // (The room's owner may differ from the hosting key after an ownership transfer; the peer must be us.)
                if admission.peer != self.identity.peer_id() {
                    return Err(NetError::Protocol(
                        "the admission names another peer".into(),
                    ));
                }
                Ok(Some((admission, owner_key, room, self.path)))
            }
            Handshake::Refused { refusal } => Err(NetError::Refused(refusal)),
            Handshake::Join(_) | Handshake::Reconnect(_) => {
                Err(NetError::Protocol("unexpected handshake message".into()))
            }
        }
    }
}
