//! The Owner network's task: one loop over relay events, peer events, finished peer starts and app commands.

use std::collections::HashMap;
use std::sync::Arc;
use std::time::Duration;

use openmind_collab::authority::JoinOutcome;
use openmind_collab::protocol::{Body, Channel, Handshake};
use openmind_collab_signal::{
    ClientMessage, ErrorCode, RelayMessage, Signal, SignalKind, Slot, SIGNAL_VERSION,
};
use tokio::sync::mpsc;

use super::link::{Link, MAX_STRIKES};
use super::serve;
use super::{FrameOutcome, OwnerAuthority, OwnerCommand, OwnerEvent, OwnerOptions};
use crate::gate::{frame_id, Inbound};
use crate::peer::{PeerConfig, PeerHandle, PeerRole};
use crate::state::{ConnectionRoute, ConnectionState, StateTracker};
use crate::transport::{
    PeerEvent, PeerTransport, SignalingConnector, SignalingEvent, SignalingTransport,
};

type Started = (
    Slot,
    Result<(PeerHandle, mpsc::UnboundedReceiver<PeerEvent>), String>,
    Signal,
);

pub(super) struct Hosting {
    authority: Arc<dyn OwnerAuthority>,
    connector: Arc<dyn SignalingConnector>,
    options: OwnerOptions,
    events: mpsc::UnboundedSender<OwnerEvent>,
    links: HashMap<Slot, Link>,
    starting: HashMap<Slot, ()>,
    link: Option<Arc<dyn SignalingTransport>>,
    signaling_state: StateTracker,
    backoff: Duration,
    renew_every: Duration,
    /// Transfers and snapshot bytes in flight across the room.
    budget: Arc<serve::Budget>,
    /// The route each participant's slot arrived on.
    routes: HashMap<Slot, ConnectionRoute>,
    done: mpsc::UnboundedSender<serve::Done>,
    done_rx: Option<mpsc::UnboundedReceiver<serve::Done>>,
}

mod files;

impl Hosting {
    pub fn new(
        authority: Arc<dyn OwnerAuthority>,
        connector: Arc<dyn SignalingConnector>,
        options: OwnerOptions,
        events: mpsc::UnboundedSender<OwnerEvent>,
    ) -> Self {
        let (done, done_rx) = mpsc::unbounded_channel();
        Self {
            budget: Arc::new(serve::Budget::default()),
            routes: HashMap::new(),
            done,
            done_rx: Some(done_rx),
            authority,
            connector,
            options,
            events,
            links: HashMap::new(),
            starting: HashMap::new(),
            link: None,
            signaling_state: StateTracker::new("signaling"),
            backoff: Duration::from_secs(1),
            renew_every: Duration::from_secs(60),
        }
    }

    fn route(&self, slot: &Slot) -> ConnectionRoute {
        self.routes
            .get(slot)
            .copied()
            .unwrap_or(ConnectionRoute::InternetRelay)
    }

    fn emit(&self, event: OwnerEvent) {
        let _ = self.events.send(event);
    }

    fn signaling(&self, state: ConnectionState) {
        if self.signaling_state.set(state) {
            self.emit(OwnerEvent::Signaling { state });
        }
    }

    pub async fn run(mut self, mut commands: mpsc::UnboundedReceiver<OwnerCommand>) {
        let (peer_tx, mut peer_rx) = mpsc::unbounded_channel::<(Slot, PeerEvent)>();
        let (started_tx, mut started_rx) = mpsc::unbounded_channel::<Started>();
        let mut done_rx = match self.done_rx.take() {
            Some(rx) => rx,
            None => return,
        };
        let mut relay_rx: Option<mpsc::Receiver<SignalingEvent>> = None;
        let mut retry_at = tokio::time::Instant::now();
        let mut renew = tokio::time::interval(self.renew_every);
        loop {
            if relay_rx.is_none() && tokio::time::Instant::now() >= retry_at {
                relay_rx = self.connect_relay().await;
                if relay_rx.is_none() {
                    retry_at = tokio::time::Instant::now() + self.backoff;
                    self.backoff = (self.backoff * 2).min(Duration::from_secs(30));
                }
            }
            tokio::select! {
                command = commands.recv() => match command {
                    Some(OwnerCommand::Approved(peer)) => self.approved(peer).await,
                    Some(OwnerCommand::Close(peer)) => self.close_peer(&peer),
                    Some(OwnerCommand::Refuse(peer, refusal)) => self.refuse(&peer, refusal),
                    Some(OwnerCommand::Tree(change)) => self.tree(change),
                    Some(OwnerCommand::Send(peer, body)) => self.send_to(&peer, body),
                    Some(OwnerCommand::Rehost) => {
                        // Dropping the signaling link frees the old topic; the next turn connects with the new one.
                        if let Some(link) = self.link.take() {
                            link.close();
                        }
                        relay_rx = None;
                        retry_at = tokio::time::Instant::now();
                    }
                    None | Some(OwnerCommand::Stop) => break,
                },
                Some(event) = recv_relay(&mut relay_rx), if relay_rx.is_some() => {
                    if let SignalingEvent::Closed { reason } = &event {
                        tracing::info!(%reason, "the signaling link dropped; connected participants are unaffected");
                        self.link = None;
                        relay_rx = None;
                        self.signaling(ConnectionState::Reconnecting);
                        retry_at = tokio::time::Instant::now() + self.backoff;
                    } else if let SignalingEvent::Message(message) = event {
                        self.relay_message(message, &started_tx);
                    }
                },
                Some((slot, event)) = peer_rx.recv() => self.peer_event(slot, event).await,
                Some((slot, result, offer)) = started_rx.recv() => self.started(slot, result, offer, &peer_tx),
                Some(done) = done_rx.recv() => self.transfer_done(done),
                _ = renew.tick() => { if let Some(link) = &self.link { let _ = link.send(ClientMessage::Renew); } },
                _ = tokio::time::sleep_until(retry_at), if relay_rx.is_none() => {}
            }
        }
        for link in self.links.values() {
            link.close();
        }
        if let Some(link) = self.link.take() {
            link.close();
        }
        self.signaling(ConnectionState::Closed);
    }

    async fn connect_relay(&mut self) -> Option<mpsc::Receiver<SignalingEvent>> {
        if self.signaling_state.get() == ConnectionState::Idle {
            self.signaling(ConnectionState::Signaling);
        }
        let topic = match self.authority.topic().await {
            Ok(topic) => topic,
            Err(message) => {
                self.emit(OwnerEvent::Problem { message });
                return None;
            }
        };
        match self.connector.connect().await {
            Ok((link, rx)) => {
                if link
                    .send(ClientMessage::Host {
                        v: SIGNAL_VERSION,
                        topic,
                    })
                    .is_err()
                {
                    return None;
                }
                self.link = Some(link);
                self.backoff = Duration::from_secs(1);
                Some(rx)
            }
            Err(err) => {
                self.emit(OwnerEvent::Problem {
                    message: err.to_string(),
                });
                None
            }
        }
    }

    fn relay_message(&mut self, message: RelayMessage, started: &mpsc::UnboundedSender<Started>) {
        match message {
            RelayMessage::Hosted { ttl_secs, .. } => {
                self.renew_every = Duration::from_secs((ttl_secs / 3).max(5));
                if self.signaling_state.get() == ConnectionState::Reconnecting {
                    self.signaling(ConnectionState::Connected);
                } else {
                    self.signaling(ConnectionState::Connecting);
                    self.signaling(ConnectionState::Connected);
                }
            }
            RelayMessage::Signal { from, signal } => self.signal(from, signal, started),
            RelayMessage::PeerLeft { slot } => {
                // A participant leaving the relay after its connection is up is normal; only abandon a half-made one.
                if self.links.get(&slot).is_some_and(|l| !l.secured) {
                    self.routes.remove(&slot);
                    if let Some(link) = self.links.remove(&slot) {
                        link.close();
                    }
                }
            }
            RelayMessage::Expired => {
                if let Some(link) = self.link.take() {
                    link.close();
                }
            }
            RelayMessage::Error { code } => {
                let message = format!("the signaling relay refused a request: {code:?}");
                if code == ErrorCode::TopicTaken {
                    self.signaling(ConnectionState::Failed);
                }
                self.emit(OwnerEvent::Problem { message });
            }
            RelayMessage::Joined { .. } | RelayMessage::PeerArrived { .. } => {}
        }
    }

    fn signal(&mut self, from: Slot, signal: Signal, started: &mpsc::UnboundedSender<Started>) {
        let is_offer = matches!(signal.kind, SignalKind::Offer { .. });
        let fresh_attempt = self
            .links
            .get(&from)
            .is_some_and(|l| l.remote_negotiation != signal.negotiation);
        if let Some(link) = self.links.get_mut(&from).filter(|_| !fresh_attempt) {
            if link.accept_signal(&signal) {
                let _ = link.peer.remote_signal(signal.kind);
            }
            return;
        }
        if !is_offer || self.starting.contains_key(&from) {
            return;
        }
        if let Some(old) = self.links.remove(&from) {
            old.close();
        }
        self.starting.insert(from.clone(), ());
        let route = self.link.as_ref().and_then(|link| link.route_of(&from));
        self.routes.insert(
            from.clone(),
            route.map_or(ConnectionRoute::InternetRelay, |(route, _)| route),
        );
        let options = super::lan_options(&self.options, route);
        let started = started.clone();
        tokio::spawn(async move {
            let mut config = PeerConfig::new(PeerRole::Answerer);
            config.connect_timeout = options.peer_connect_timeout;
            let result = crate::peer::start(
                config,
                &options.ice,
                options.gatherer.as_ref(),
                options.relay.clone(),
            )
            .await
            .map_err(|e| e.to_string());
            let _ = started.send((from, result, signal));
        });
    }

    fn started(
        &mut self,
        slot: Slot,
        result: Result<(PeerHandle, mpsc::UnboundedReceiver<PeerEvent>), String>,
        offer: Signal,
        peer_tx: &mpsc::UnboundedSender<(Slot, PeerEvent)>,
    ) {
        self.starting.remove(&slot);
        let (peer, mut rx) = match result {
            Ok(started) => started,
            Err(message) => return self.emit(OwnerEvent::Problem { message }),
        };
        let Some(link) = Link::new(peer.clone(), offer.negotiation.clone(), offer.seq) else {
            return;
        };
        let _ = peer.remote_signal(offer.kind);
        self.links.insert(slot.clone(), link);
        let tx = peer_tx.clone();
        tokio::spawn(async move {
            while let Some(event) = rx.recv().await {
                if tx.send((slot.clone(), event)).is_err() {
                    break;
                }
            }
        });
        // A connection that never completes its handshake is dropped.
        let timeout = self.options.handshake_timeout;
        tokio::spawn(async move {
            tokio::time::sleep(timeout).await;
            if peer.state() != ConnectionState::Connected {
                peer.close();
            }
        });
    }

    async fn peer_event(&mut self, slot: Slot, event: PeerEvent) {
        match event {
            PeerEvent::LocalSignal(kind) => {
                let (Some(relay), Some(link)) = (self.link.clone(), self.links.get_mut(&slot))
                else {
                    return;
                };
                let signal = link.next_signal(kind);
                let _ = relay.send(ClientMessage::Signal { to: slot, signal });
            }
            PeerEvent::State(state) => self.link_state(slot, state).await,
            PeerEvent::Path(path) => self.emit(OwnerEvent::Path {
                slot: slot.as_str().to_string(),
                path,
            }),
            PeerEvent::Secured {
                local_fingerprint,
                remote_fingerprint,
            } => {
                if let Some(link) = self.links.get_mut(&slot) {
                    link.secured = true;
                    link.fingerprints = Some((local_fingerprint, remote_fingerprint));
                }
                self.hello(&slot).await;
            }
            PeerEvent::ChannelOpen(channel) => {
                if channel == Channel::Control {
                    if let Some(link) = self.links.get_mut(&slot) {
                        link.control_open = true;
                    }
                    self.hello(&slot).await;
                }
            }
            PeerEvent::Data { channel, data } => self.data(slot, channel, data).await,
        }
    }

    async fn link_state(&mut self, slot: Slot, state: ConnectionState) {
        self.emit(OwnerEvent::Link {
            slot: slot.to_string(),
            state,
        });
        if !state.is_finished() {
            return;
        }
        self.routes.remove(&slot);
        if let Some(link) = self.links.remove(&slot) {
            link.close();
            if let Some((peer, session)) = link.admitted {
                let reason = format!("{state:?}").to_lowercase();
                self.authority
                    .disconnected(peer.clone(), session.clone(), reason.clone())
                    .await;
                self.emit(OwnerEvent::Left {
                    peer,
                    session,
                    reason,
                });
            }
        }
    }

    async fn hello(&mut self, slot: &Slot) {
        let Some(link) = self.links.get(slot).filter(|l| l.ready_for_hello()) else {
            return;
        };
        let Some(bound) = link.bound() else { return };
        let challenge = link.challenge.clone();
        match self.authority.hello(challenge, bound).await {
            Ok(hello) => {
                if let Some(link) = self.links.get_mut(slot) {
                    link.send_handshake(&hello);
                    link.hello_sent = true;
                }
            }
            Err(message) => self.emit(OwnerEvent::Problem { message }),
        }
    }

    async fn data(&mut self, slot: Slot, channel: Channel, data: Vec<u8>) {
        let Some(link) = self.links.get_mut(&slot) else {
            return;
        };
        let admitted = link.gate.is_admitted();
        match link.gate.accept(channel, &data) {
            Ok(Inbound::Handshake(handshake)) => self.handshake(slot, handshake).await,
            Ok(Inbound::Frame(frame)) => self.frame(slot, frame).await,
            Err(err) if admitted => {
                link.strikes += 1;
                if let Some(of) = frame_id(&data) {
                    link.send_body(Body::Reject {
                        of,
                        reason: err.reason(),
                    });
                }
                if link.strikes >= MAX_STRIKES {
                    link.close();
                }
            }
            Err(err) => {
                tracing::info!(reason = %err.reason(), "a connection sent an invalid message before admission; closing it");
                link.close();
            }
        }
    }

    async fn handshake(&mut self, slot: Slot, handshake: Handshake) {
        let Some(bound) = self
            .links
            .get(&slot)
            .filter(|l| l.hello_sent)
            .and_then(|l| l.bound())
        else {
            return;
        };
        let candidate = match &handshake {
            Handshake::Join(request) => request.public_key.peer_id(),
            Handshake::Reconnect(request) => request.public_key.peer_id(),
            _ => {
                if let Some(link) = self.links.get(&slot) {
                    link.close();
                }
                return;
            }
        };
        let outcome = self.authority.admit(handshake, bound).await;
        let Some(link) = self.links.get_mut(&slot) else {
            return;
        };
        match outcome {
            Ok(JoinOutcome::Admitted(admission)) => {
                link.admit(admission.peer.clone(), admission.session.clone());
                link.send_handshake(&Handshake::Admitted(admission.clone()));
                self.emit(OwnerEvent::Admitted {
                    slot: slot.to_string(),
                    peer: admission.peer,
                    session: admission.session,
                    route: self.route(&slot),
                });
            }
            Ok(JoinOutcome::Pending) => {
                link.waiting = Some(candidate.clone());
                link.send_handshake(&Handshake::Pending);
                self.emit(OwnerEvent::Pending {
                    slot: slot.to_string(),
                    peer: candidate,
                });
            }
            Ok(JoinOutcome::Refused(refusal)) => {
                link.send_handshake(&Handshake::Refused { refusal });
                close_soon(link.peer.clone());
            }
            Err(message) => {
                link.close();
                self.emit(OwnerEvent::Problem { message });
            }
        }
    }

    async fn frame(&mut self, slot: Slot, frame: openmind_collab::protocol::Frame) {
        let Some(link) = self.links.get_mut(&slot) else {
            return;
        };
        let Some(actor) = link.gate.actor() else {
            return;
        };
        let id = frame.id.clone();
        let mut frame = frame;
        if let Body::SyncChunk {
            id: transfer,
            index,
            count,
            sha256,
            data,
        } = frame.body
        {
            // A piece of a larger sync message; the whole is handled once it is rebuilt (and acknowledged by the id of
            // its last piece, which is the frame the sender waits for).
            match link.chunks.add(transfer, index, count, sha256, data.0) {
                Ok(None) => return,
                Ok(Some(body)) => frame.body = body,
                Err(err) => {
                    tracing::info!(%err, "a participant sent a broken sync message");
                    return link.send_body(Body::Reject {
                        of: id,
                        reason: "The message arrived damaged.".into(),
                    });
                }
            }
        }
        match &frame.body {
            Body::Ping { nonce } => return link.send_body(Body::Pong { nonce: *nonce }),
            Body::Leave => return link.close(),
            Body::Ack { .. } | Body::Reject { .. } | Body::Pong { .. } => return,
            _ => {}
        }
        if self.files_frame(&slot, actor.clone(), &frame.body) {
            return;
        }
        let voice = matches!(
            frame.body,
            Body::VoiceState { .. } | Body::VoiceSignal { .. }
        );
        let presence = matches!(frame.body, Body::Presence { .. });
        let allowed = |hosting: &mut Self| {
            hosting.links.get_mut(&slot).is_some_and(|l| {
                if voice {
                    l.voice_rate.allow()
                } else {
                    !presence || l.presence_rate.allow()
                }
            })
        };
        if (voice || presence) && !allowed(self) {
            // A flood: dropped quietly. Presence is latest-value; a dropped voice message is renegotiated by the
            // members (and a client that floods gets nothing through).
            return;
        }
        let outcome = self.authority.frame(actor, frame).await;
        let Some(link) = self.links.get_mut(&slot) else {
            return;
        };
        match outcome {
            FrameOutcome::Accepted => link.send_body(Body::Ack { of: id }),
            FrameOutcome::Reply(messages) => {
                link.send_body(Body::Ack { of: id });
                for (peer, body) in messages {
                    self.send_to(&peer, body);
                }
            }
            FrameOutcome::Relay(messages) => {
                for (peer, body) in messages {
                    self.send_to(&peer, body);
                }
            }
            FrameOutcome::Dropped => {}
            FrameOutcome::Rejected(reason) => {
                let reason: String = reason
                    .chars()
                    .take(openmind_collab::protocol::MAX_REASON_CHARS)
                    .collect();
                link.send_body(Body::Reject { of: id, reason });
            }
        }
    }

    /// Sends `body` to every link admitted as `peer` (normally one).
    fn send_to(&mut self, peer: &openmind_collab::PeerId, body: Body) {
        for link in self
            .links
            .values_mut()
            .filter(|l| l.admitted.as_ref().is_some_and(|(p, _)| p == peer))
        {
            link.send_body(body.clone());
        }
    }

    async fn approved(&mut self, peer: openmind_collab::PeerId) {
        let Some(slot) = self
            .links
            .iter()
            .find(|(_, l)| l.waiting.as_ref() == Some(&peer))
            .map(|(s, _)| s.clone())
        else {
            return;
        };
        match self.authority.admit_approved(peer).await {
            Ok(admission) => {
                if let Some(link) = self.links.get_mut(&slot) {
                    link.admit(admission.peer.clone(), admission.session.clone());
                    link.send_handshake(&Handshake::Admitted(admission.clone()));
                    let route = self.route(&slot);
                    self.emit(OwnerEvent::Admitted {
                        slot: slot.to_string(),
                        peer: admission.peer,
                        session: admission.session,
                        route,
                    });
                }
            }
            Err(message) => self.emit(OwnerEvent::Problem { message }),
        }
    }

    fn refuse(
        &mut self,
        peer: &openmind_collab::PeerId,
        refusal: openmind_collab::protocol::Refusal,
    ) {
        for link in self
            .links
            .values()
            .filter(|l| l.waiting.as_ref() == Some(peer))
        {
            link.send_handshake(&Handshake::Refused { refusal });
            close_soon(link.peer.clone());
        }
    }

    fn close_peer(&mut self, peer: &openmind_collab::PeerId) {
        let matching: Vec<Slot> = self
            .links
            .iter()
            .filter(|(_, l)| {
                l.admitted.as_ref().map(|(p, _)| p) == Some(peer)
                    || l.waiting.as_ref() == Some(peer)
            })
            .map(|(s, _)| s.clone())
            .collect();
        for slot in matching {
            if let Some(link) = self.links.get(&slot) {
                link.close();
            }
        }
    }
}

async fn recv_relay(rx: &mut Option<mpsc::Receiver<SignalingEvent>>) -> Option<SignalingEvent> {
    match rx {
        Some(rx) => rx.recv().await,
        None => std::future::pending().await,
    }
}

/// Closes a connection a moment after a final message, so the message is sent first.
fn close_soon(peer: PeerHandle) {
    tokio::spawn(async move {
        tokio::time::sleep(Duration::from_millis(500)).await;
        peer.close();
    });
}
