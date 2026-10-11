//! The task that runs one `str0m::Rtc`: it sends what the state machine wants sent, feeds it received datagrams and
//! timeouts, applies commands, and turns `str0m` events into [`PeerEvent`]s and [`ConnectionState`]s.

use std::collections::{HashMap, HashSet, VecDeque};
use std::net::SocketAddr;
use std::sync::Arc;
use std::time::Instant;

use openmind_collab::protocol::Channel;
use openmind_collab_signal::SignalKind;
use str0m::change::{SdpAnswer, SdpOffer, SdpPendingOffer};
use str0m::channel::{ChannelConfig, ChannelId, Reliability};
use str0m::net::{Protocol, Receive};
use str0m::{Candidate, CandidateKind as IceKind, Event, IceConnectionState, Input, Output, Rtc};
use tokio::net::UdpSocket;
use tokio::sync::mpsc;

use super::{channel_by_label, Command, PeerConfig, PeerRole, CHANNELS};
use crate::error::NetError;
use crate::state::{ConnectionState, StateTracker};
use crate::transport::{
    CandidateKind, IcePath, LocalCandidate, PeerEvent, RelayAllocation, RelayEvent, RelayLink,
    RelayProtocol,
};

const MAX_QUEUED: usize = 1024;

/// What a driver is built from (the socket is converted to tokio's on the driver's own runtime).
pub(super) struct Setup<S> {
    pub socket: S,
    pub candidates: Vec<LocalCandidate>,
    pub relay: Option<RelayAllocation>,
    pub events: mpsc::UnboundedSender<PeerEvent>,
    pub state: Arc<StateTracker>,
    pub flow: Arc<super::Flow>,
}

impl Setup<std::net::UdpSocket> {
    pub(super) fn into_tokio(self) -> Result<Setup<UdpSocket>, NetError> {
        Ok(Setup {
            socket: UdpSocket::from_std(self.socket)?,
            candidates: self.candidates,
            relay: self.relay,
            events: self.events,
            state: self.state,
            flow: self.flow,
        })
    }
}

/// A TURN allocation in use: its relayed address (the base of the relayed candidate) and the relay itself.
struct Relayed {
    addr: SocketAddr,
    protocol: RelayProtocol,
    link: RelayLink,
}

/// The next relay event; never resolves without a relay.
async fn next_relay(relay: &mut Option<Relayed>) -> Option<RelayEvent> {
    match relay {
        Some(relayed) => relayed.link.recv().await,
        None => std::future::pending().await,
    }
}

/// A STUN message (first byte 0-3; DTLS is 20-63 — RFC 7983 §7). Only non-STUN traffic says which pair the connection
/// uses (connectivity checks go out on every pair).
fn is_stun(data: &[u8]) -> bool {
    data.first().is_some_and(|b| *b < 4)
}

pub(super) struct Driver {
    rtc: Rtc,
    socket: UdpSocket,
    local: SocketAddr,
    config: PeerConfig,
    events: mpsc::UnboundedSender<PeerEvent>,
    state: Arc<StateTracker>,
    ids: HashMap<ChannelId, Channel>,
    open: HashSet<Channel>,
    queued: VecDeque<(Channel, Vec<u8>)>,
    pending: Option<SdpPendingOffer>,
    deadline: Instant,
    lost_since: Option<Instant>,
    /// Set while a graceful close (SCTP shutdown, DTLS close_notify) drains; the instance is dropped at this time.
    closing: Option<Instant>,
    /// A remote description was accepted (before that, ICE activity doesn't change the reported state).
    described: bool,
    flow: Arc<super::Flow>,
    relay: Option<Relayed>,
    /// The other side's host candidates (a pair to one of them is a direct path).
    remote_hosts: HashSet<SocketAddr>,
    path: Option<IcePath>,
}

fn channel_config(channel: Channel) -> ChannelConfig {
    ChannelConfig {
        label: channel.label().to_string(),
        ordered: channel.reliable(),
        reliability: if channel.reliable() {
            Reliability::Reliable
        } else {
            Reliability::MaxRetransmits { retransmits: 0 }
        },
        negotiated: None,
        protocol: "openmind-collab-v1".to_string(),
    }
}

impl Driver {
    pub(super) fn new(config: PeerConfig, setup: Setup<UdpSocket>) -> Result<Self, NetError> {
        let local = setup.socket.local_addr()?;
        let now = Instant::now();
        let mut rtc = Rtc::builder()
            .set_crypto_provider(Arc::new(str0m::crypto::from_feature_flags()))
            .build(now);
        for candidate in &setup.candidates {
            let made = match candidate.kind {
                CandidateKind::Host => Candidate::host(candidate.addr, "udp"),
                CandidateKind::ServerReflexive => {
                    Candidate::server_reflexive(candidate.addr, candidate.base, "udp")
                }
                CandidateKind::Relayed => Candidate::relayed(candidate.addr, candidate.base, "udp"),
            };
            match made {
                Ok(c) => {
                    rtc.add_local_candidate(c);
                }
                Err(err) => tracing::debug!(%err, "a local candidate was refused"),
            }
        }
        let mut driver = Self {
            rtc,
            socket: setup.socket,
            local,
            deadline: now + config.connect_timeout,
            config,
            events: setup.events,
            state: setup.state,
            ids: HashMap::new(),
            open: HashSet::new(),
            queued: VecDeque::new(),
            pending: None,
            lost_since: None,
            closing: None,
            described: false,
            flow: setup.flow,
            relay: None,
            remote_hosts: HashSet::new(),
            path: None,
        };
        if let Some(allocation) = setup.relay {
            driver.add_relay(allocation, false);
        }
        Ok(driver)
    }

    /// Adds a TURN allocation's relayed candidate; `announce` trickles it to the other side (after the offer).
    fn add_relay(&mut self, allocation: RelayAllocation, announce: bool) {
        let candidate = match Candidate::relayed(allocation.relayed, allocation.local, "udp") {
            Ok(candidate) => candidate,
            Err(err) => {
                tracing::debug!(%err, "the relayed candidate was refused");
                return;
            }
        };
        let Some(added) = self.rtc.add_local_candidate(candidate) else {
            return;
        };
        if announce {
            let candidate = added.to_sdp_string();
            self.emit(PeerEvent::LocalSignal(SignalKind::Candidate { candidate }));
        }
        tracing::info!(protocol = ?allocation.protocol, "a TURN relay candidate was added");
        self.relay = Some(Relayed {
            addr: allocation.relayed,
            protocol: allocation.protocol,
            link: allocation.link,
        });
    }

    fn relay_event(&mut self, event: Option<RelayEvent>) {
        match event {
            Some(RelayEvent::Data { peer, data }) => {
                if let Some(relayed) = self.relay.as_ref().map(|r| r.addr) {
                    self.receive_at(&data, peer, relayed);
                }
            }
            Some(RelayEvent::Problem(failure)) => tracing::info!(%failure, "TURN"),
            Some(RelayEvent::Ended(failure)) => {
                tracing::info!(%failure, "the TURN relay ended");
                self.relay = None;
            }
            None => self.relay = None,
        }
    }

    /// Records the kind of path traffic takes (from the pair a non-STUN packet goes out on).
    fn note_path(&mut self, source: SocketAddr, destination: SocketAddr) {
        let path = match &self.relay {
            Some(relayed) if relayed.addr == source => IcePath::relayed(relayed.protocol),
            _ if self.remote_hosts.contains(&destination) => IcePath::Direct,
            _ => IcePath::Stun,
        };
        if self.path != Some(path) {
            self.path = Some(path);
            tracing::info!(?path, "the connection's path");
            self.emit(PeerEvent::Path(path));
        }
    }

    /// Remembers the other side's host candidates in a description or a trickled candidate line.
    fn note_remote(&mut self, text: &str) {
        for line in text.lines() {
            let line = line.trim().trim_start_matches("a=");
            if !line.starts_with("candidate:") {
                continue;
            }
            if let Ok(candidate) = Candidate::from_sdp_string(line) {
                if candidate.kind() == IceKind::Host {
                    self.remote_hosts.insert(candidate.addr());
                }
            }
        }
    }

    fn emit(&self, event: PeerEvent) {
        let _ = self.events.send(event);
    }

    fn set_state(&self, next: ConnectionState) {
        if self.state.set(next) {
            self.emit(PeerEvent::State(next));
        }
    }

    pub(super) async fn run(mut self, mut commands: mpsc::UnboundedReceiver<Command>) {
        self.set_state(ConnectionState::Signaling);
        if self.config.role == PeerRole::Offerer {
            self.create_offer(true);
        }
        let mut buf = vec![0u8; 2048];
        loop {
            let Some(timeout) = self.drain().await else {
                break;
            };
            if !self.rtc.is_alive() {
                let finished = if self.closing.is_some() {
                    ConnectionState::Closed
                } else {
                    ConnectionState::Disconnected
                };
                self.set_state(finished);
                break;
            }
            let wake = tokio::time::Instant::from_std(timeout.min(self.next_deadline()));
            tokio::select! {
                command = commands.recv(), if self.closing.is_none() => match command {
                    None | Some(Command::Close) => self.start_close(),
                    Some(command) => self.command(command),
                },
                event = next_relay(&mut self.relay) => self.relay_event(event),
                received = self.socket.recv_from(&mut buf) => match received {
                    Ok((n, source)) => self.receive(&buf[..n], source),
                    // Windows reports an ICMP "port unreachable" as a reset on the next receive; it is not fatal.
                    Err(err) if err.kind() == std::io::ErrorKind::ConnectionReset => {}
                    Err(err) => {
                        tracing::warn!(%err, "the peer socket failed");
                        self.set_state(ConnectionState::Failed);
                        break;
                    }
                },
                _ = tokio::time::sleep_until(wake) => {
                    let now = Instant::now();
                    if self.closing.is_some_and(|at| now >= at) {
                        self.rtc.disconnect();
                        self.set_state(ConnectionState::Closed);
                        break;
                    }
                    if self.rtc.handle_input(Input::Timeout(now)).is_err() || self.deadline_passed(now) {
                        self.rtc.disconnect();
                        self.set_state(ConnectionState::Failed);
                        break;
                    }
                }
            }
            self.flush();
            self.publish_flow();
        }
        self.flow.close();
    }

    /// Publishes, per channel, the bytes still queued here or in the SCTP send buffer, and wakes waiting senders.
    fn publish_flow(&mut self) {
        for channel in CHANNELS {
            let queued: usize = self
                .queued
                .iter()
                .filter(|(c, _)| *c == channel)
                .map(|(_, d)| d.len())
                .sum();
            let id = self
                .ids
                .iter()
                .find(|(_, c)| **c == channel)
                .map(|(id, _)| *id);
            let sctp = id
                .and_then(|id| self.rtc.channel(id))
                .map_or(0, |mut ch| ch.buffered_amount());
            self.flow.publish(channel, queued + sctp);
        }
        self.flow.wake();
    }

    /// Starts a graceful close: the other side is told (SCTP shutdown, DTLS close_notify) instead of having to
    /// wait for ICE consent to expire.
    fn start_close(&mut self) {
        self.flush();
        if self.rtc.close().is_err() {
            self.rtc.disconnect();
        }
        self.closing = Some(Instant::now() + std::time::Duration::from_secs(2));
    }

    fn next_deadline(&self) -> Instant {
        if let Some(at) = self.closing {
            return at;
        }
        match (self.state.get(), self.lost_since) {
            (ConnectionState::Signaling | ConnectionState::Connecting, _) => self.deadline,
            (ConnectionState::Reconnecting, Some(since)) => since + self.config.reconnect_grace,
            _ => Instant::now() + std::time::Duration::from_secs(3600),
        }
    }

    fn deadline_passed(&self, now: Instant) -> bool {
        match self.state.get() {
            ConnectionState::Signaling | ConnectionState::Connecting => now >= self.deadline,
            ConnectionState::Reconnecting => self
                .lost_since
                .is_some_and(|since| now >= since + self.config.reconnect_grace),
            _ => false,
        }
    }

    /// Sends what the state machine produced and handles its events; returns its next timeout.
    async fn drain(&mut self) -> Option<Instant> {
        loop {
            match self.rtc.poll_output() {
                Ok(Output::Timeout(at)) => return Some(at),
                Ok(Output::Transmit(t)) => {
                    if !is_stun(&t.contents) {
                        self.note_path(t.source, t.destination);
                    }
                    match &self.relay {
                        Some(relayed) if relayed.addr == t.source => {
                            relayed.link.send(t.destination, t.contents.to_vec());
                        }
                        _ => {
                            if let Err(err) = self.socket.send_to(&t.contents, t.destination).await
                            {
                                tracing::debug!(%err, "a datagram couldn't be sent");
                            }
                        }
                    }
                }
                Ok(Output::Event(event)) => self.event(event),
                Err(err) => {
                    tracing::warn!(%err, "the WebRTC connection failed");
                    self.set_state(ConnectionState::Failed);
                    return None;
                }
            }
        }
    }

    fn receive(&mut self, data: &[u8], source: SocketAddr) {
        self.receive_at(data, source, self.local);
    }

    /// Hands a datagram that arrived at `destination` (the socket, or the relayed address) to the state machine.
    fn receive_at(&mut self, data: &[u8], source: SocketAddr, destination: SocketAddr) {
        let Ok(contents) = data.try_into() else {
            return;
        };
        let input = Input::Receive(
            Instant::now(),
            Receive {
                proto: Protocol::Udp,
                source,
                destination,
                contents,
            },
        );
        if self.rtc.accepts(&input) {
            if let Err(err) = self.rtc.handle_input(input) {
                tracing::debug!(%err, "a datagram was refused");
            }
        }
    }

    fn event(&mut self, event: Event) {
        match event {
            Event::Connected => self.secured(),
            Event::IceConnectionStateChange(ice) => self.ice_state(ice),
            Event::ChannelOpen(id, label) => match channel_by_label(&label) {
                Some(channel) => {
                    self.ids.insert(id, channel);
                    self.open.insert(channel);
                    self.emit(PeerEvent::ChannelOpen(channel));
                }
                None => tracing::info!("ignored a data channel with an unknown label"),
            },
            Event::ChannelData(data) => {
                if let Some(channel) = self.ids.get(&data.id).copied() {
                    self.emit(PeerEvent::Data {
                        channel,
                        data: data.data,
                    });
                }
            }
            Event::ChannelClose(id) => {
                if let Some(channel) = self.ids.remove(&id) {
                    self.open.remove(&channel);
                    if channel == Channel::Control {
                        self.set_state(ConnectionState::Disconnected);
                    }
                }
            }
            _ => {}
        }
    }

    fn secured(&mut self) {
        let api = self.rtc.direct_api();
        let local = api.local_dtls_fingerprint().to_string();
        let remote = api
            .remote_dtls_fingerprint()
            .map(ToString::to_string)
            .unwrap_or_default();
        self.set_state(ConnectionState::Connected);
        self.emit(PeerEvent::Secured {
            local_fingerprint: local,
            remote_fingerprint: remote,
        });
    }

    fn ice_state(&mut self, ice: IceConnectionState) {
        match ice {
            IceConnectionState::Checking if self.described => {
                self.set_state(ConnectionState::Connecting)
            }
            IceConnectionState::Disconnected if self.state.get() == ConnectionState::Connected => {
                self.lost_since = Some(Instant::now());
                self.set_state(ConnectionState::Reconnecting);
            }
            IceConnectionState::Connected | IceConnectionState::Completed
                if self.state.get() == ConnectionState::Reconnecting =>
            {
                self.lost_since = None;
                self.set_state(ConnectionState::Connected);
            }
            _ => {}
        }
    }

    fn create_offer(&mut self, with_channels: bool) {
        let mut api = self.rtc.sdp_api();
        if with_channels {
            for channel in CHANNELS {
                let id = api.add_channel_with_config(channel_config(channel));
                self.ids.insert(id, channel);
            }
        } else {
            api.ice_restart(true);
        }
        if let Some((offer, pending)) = api.apply() {
            self.pending = Some(pending);
            self.emit(PeerEvent::LocalSignal(SignalKind::Offer {
                sdp: offer.to_sdp_string(),
            }));
        }
    }

    fn command(&mut self, command: Command) {
        match command {
            Command::Send(channel, data) => {
                self.flow.consumed(channel, data.len());
                if self.queued.len() < MAX_QUEUED {
                    self.queued.push_back((channel, data));
                } else {
                    tracing::warn!("a data channel queue is full; a message was dropped");
                }
            }
            Command::Remote(signal) => self.remote(signal),
            Command::IceRestart => self.create_offer(false),
            Command::Relay(allocation) => self.add_relay(allocation, true),
            Command::Close => {}
        }
    }

    fn remote(&mut self, signal: SignalKind) {
        match &signal {
            SignalKind::Offer { sdp } | SignalKind::Answer { sdp } => self.note_remote(sdp),
            SignalKind::Candidate { candidate } => self.note_remote(candidate),
            _ => {}
        }
        let result: Result<(), String> = match signal {
            SignalKind::Offer { sdp } => SdpOffer::from_sdp_string(&sdp)
                .map_err(|e| e.to_string())
                .and_then(|offer| {
                    self.rtc
                        .sdp_api()
                        .accept_offer(offer)
                        .map_err(|e| e.to_string())
                })
                .map(|answer| {
                    self.described = true;
                    self.emit(PeerEvent::LocalSignal(SignalKind::Answer {
                        sdp: answer.to_sdp_string(),
                    }));
                    self.set_state(ConnectionState::Connecting);
                }),
            SignalKind::Answer { sdp } => match self.pending.take() {
                Some(pending) => SdpAnswer::from_sdp_string(&sdp)
                    .map_err(|e| e.to_string())
                    .and_then(|answer| {
                        self.rtc
                            .sdp_api()
                            .accept_answer(pending, answer)
                            .map_err(|e| e.to_string())
                    })
                    .map(|()| {
                        self.described = true;
                        self.set_state(ConnectionState::Connecting);
                    }),
                None => Err("an answer arrived without an offer".into()),
            },
            SignalKind::Candidate { candidate } => {
                let text = candidate.strip_prefix("a=").unwrap_or(&candidate);
                Candidate::from_sdp_string(text)
                    .map(|c| self.rtc.add_remote_candidate(c))
                    .map_err(|e| e.to_string())
            }
            SignalKind::EndOfCandidates => Ok(()),
            SignalKind::Bye => {
                self.rtc.disconnect();
                Ok(())
            }
        };
        if let Err(err) = result {
            tracing::info!(%err, "a remote signal was refused");
        }
    }

    /// Writes queued messages to channels that are open (in order; a full channel keeps the rest queued).
    fn flush(&mut self) {
        let mut kept = VecDeque::new();
        // Once one message of a channel waits, every later one of that channel waits too (order is kept).
        let mut blocked: HashSet<Channel> = HashSet::new();
        while let Some((channel, data)) = self.queued.pop_front() {
            let id = self
                .ids
                .iter()
                .find(|(_, c)| **c == channel)
                .map(|(id, _)| *id);
            let written = match (blocked.contains(&channel), self.open.contains(&channel), id) {
                (false, true, Some(id)) => self.rtc.channel(id).map(|mut ch| ch.write(true, &data)),
                _ => None,
            };
            match written {
                Some(Ok(true)) => {}
                Some(Err(err)) => {
                    tracing::warn!(%err, "a data channel message couldn't be written")
                }
                Some(Ok(false)) | None => {
                    blocked.insert(channel);
                    kept.push_back((channel, data));
                }
            }
        }
        self.queued = kept;
    }
}

#[cfg(test)]
mod tests {
    #[test]
    fn stun_and_dtls_are_told_apart_by_their_first_byte() {
        assert!(super::is_stun(&[0x00, 0x01]) && super::is_stun(&[0x01, 0x01]));
        // DTLS handshake (22) and application data (23) are not STUN, though their top bits are zero too.
        assert!(!super::is_stun(&[22, 0xfe]) && !super::is_stun(&[23, 0xfe]));
        assert!(!super::is_stun(&[]));
    }
}
