//! One TURN allocation, driven: the sans-IO client (`turn-client-proto`) decides what to send and when (Allocate
//! with long-term credentials, Refresh before the lifetime ends, permission and channel refreshes, stale-nonce
//! retries, Refresh with lifetime 0 to release); this task does the I/O and moves peer data between the client and
//! the [`RelayLink`] the WebRTC engine holds. Dropping the link releases the allocation.

use std::collections::{HashMap, HashSet};
use std::net::{IpAddr, SocketAddr};
use std::time::{Duration, Instant as StdInstant};

use tokio::sync::mpsc;
use turn_client_proto::api::{TurnConfig, TurnEvent, TurnPollRet, TurnRecvRet};
use turn_client_proto::client::TurnClient;
use turn_client_proto::prelude::*;
use turn_client_proto::tcp::TurnClientTcp;
use turn_client_proto::types::{Instant, TransportType, TurnCredentials};
use turn_client_proto::udp::TurnClientUdp;

use super::failure::{TurnFailure, TurnFailureKind};
use super::io::TurnIo;
use super::watch::{pad_for_stream, ServerWatch, StreamFramer};
use crate::transport::{RelayEvent, RelayLink, RelayProtocol};

/// Peer packets held per address while its permission is being installed.
const QUEUED_PER_PEER: usize = 32;
/// Packets waiting between the WebRTC engine and this task, each way (UDP semantics: overflow is dropped).
const LINK_DEPTH: usize = 512;
/// How long the release (Refresh with lifetime 0) may take when the link is dropped.
const RELEASE_WAIT: Duration = Duration::from_millis(1500);

pub(crate) struct Session {
    client: TurnClient,
    io: TurnIo,
    watch: ServerWatch,
    /// TCP and TLS only: splits the stream into whole frames (see [`StreamFramer`]).
    framer: Option<StreamFramer>,
    base: StdInstant,
    queued: HashMap<IpAddr, Vec<(SocketAddr, Vec<u8>)>>,
    asked: HashSet<IpAddr>,
    channels: HashSet<SocketAddr>,
}

fn sans_io_now(base: StdInstant) -> Instant {
    Instant::from_nanos(i64::try_from(base.elapsed().as_nanos()).unwrap_or(i64::MAX))
}

impl Session {
    pub(crate) fn new(
        io: TurnIo,
        protocol: RelayProtocol,
        username: &str,
        password: &str,
    ) -> std::io::Result<Self> {
        let local = io.local_addr()?;
        let server = io.server_addr()?;
        let mut config = TurnConfig::new(TurnCredentials::new(username, password));
        // RFC 8489's 500 ms first retransmission, doubling up to 2 s: about 10 s before a request over UDP gives up.
        config.set_request_retransmits(
            Duration::from_millis(500),
            Duration::from_secs(2),
            6,
            Duration::from_secs(2),
        );
        let (client, framer) = match protocol {
            RelayProtocol::Udp => (
                TurnClient::Udp(TurnClientUdp::allocate(local, server, config)),
                None,
            ),
            RelayProtocol::Tcp | RelayProtocol::Tls => (
                TurnClient::Tcp(TurnClientTcp::allocate(local, server, config)),
                Some(StreamFramer::default()),
            ),
        };
        Ok(Self {
            client,
            io,
            watch: ServerWatch::default(),
            framer,
            base: StdInstant::now(),
            queued: HashMap::new(),
            asked: HashSet::new(),
            channels: HashSet::new(),
        })
    }

    /// The local address the server sees this client's traffic come from.
    pub(crate) fn local_addr(&self) -> std::net::SocketAddr {
        self.client.local_addr()
    }

    fn now(&self) -> Instant {
        sans_io_now(self.base)
    }

    fn wake_at(&self, at: Instant) -> tokio::time::Instant {
        let now = self.now();
        let wait = if at > now { at - now } else { Duration::ZERO };
        tokio::time::Instant::now() + wait.min(Duration::from_secs(3600))
    }

    /// Writes one frame (ChannelData padded on a stream).
    async fn write_frame(&mut self, frame: &[u8]) -> Result<(), TurnFailure> {
        let written = if self.framer.is_some() {
            self.io.write(&pad_for_stream(frame.to_vec())).await
        } else {
            self.io.write(frame).await
        };
        written.map_err(|_| TurnFailure::new(TurnFailureKind::Lost))
    }

    /// Writes everything the client wants sent.
    async fn flush(&mut self) -> Result<(), TurnFailure> {
        while let Some(transmit) = self.client.poll_transmit(self.now()) {
            self.write_frame(&transmit.data).await?;
        }
        Ok(())
    }

    /// The failure that explains an allocation that didn't happen.
    fn allocation_failure(&self) -> TurnFailure {
        match self.watch.last_error {
            Some(code) => TurnFailure::from_code(code),
            None if self.watch.received == 0 => TurnFailure::new(TurnFailureKind::Timeout),
            None => TurnFailure::new(TurnFailureKind::Refused),
        }
    }

    /// Feeds bytes from the server to the client, one whole frame at a time; peer data goes to `inbound`.
    fn received(
        &mut self,
        data: &[u8],
        inbound: Option<&mpsc::Sender<RelayEvent>>,
    ) -> Result<(), TurnFailure> {
        let frames = match self.framer.as_mut() {
            Some(framer) => framer
                .push(data)
                .map_err(|_| TurnFailure::new(TurnFailureKind::Lost))?,
            None => vec![data.to_vec()],
        };
        for frame in frames {
            self.frame(&frame, inbound);
        }
        Ok(())
    }

    fn frame(&mut self, frame: &[u8], inbound: Option<&mpsc::Sender<RelayEvent>>) {
        self.watch.observe(frame);
        let (Ok(local), Ok(server)) = (self.io.local_addr(), self.io.server_addr()) else {
            return;
        };
        let transport = self.client.transport();
        let now = self.now();
        let transmit = turn_client_proto::api::Transmit::new(frame, transport, server, local);
        if let TurnRecvRet::PeerData(peer) = self.client.recv(transmit, now) {
            deliver(inbound, peer.peer, peer.data());
        }
        while let Some(peer) = self.client.poll_recv(now) {
            deliver(inbound, peer.peer, peer.data());
        }
    }

    /// Runs until the allocation exists (its relayed address) or fails.
    pub(crate) async fn allocate(
        &mut self,
        deadline: tokio::time::Instant,
    ) -> Result<SocketAddr, TurnFailure> {
        let mut buf = vec![0u8; 65_536];
        loop {
            self.flush().await?;
            while let Some(event) = self.client.poll_event() {
                match event {
                    TurnEvent::AllocationCreated(_, relayed) => return Ok(relayed),
                    TurnEvent::AllocationCreateFailed(_) => return Err(self.allocation_failure()),
                    _ => {}
                }
            }
            let wake = match self.client.poll(self.now()) {
                TurnPollRet::WaitUntil(at) => self.wake_at(at).min(deadline),
                TurnPollRet::Closed => return Err(self.allocation_failure()),
                _ => deadline,
            };
            tokio::select! {
                read = self.io.read(&mut buf) => match read {
                    Ok(0) | Err(_) if self.watch.received == 0 => {
                        return Err(TurnFailure::new(TurnFailureKind::Unreachable))
                    }
                    Ok(0) | Err(_) => return Err(self.allocation_failure()),
                    Ok(n) => {
                        self.received(&buf[..n], None)?;
                        if let Some(code) = self.watch.decisive {
                            return Err(TurnFailure::from_code(code));
                        }
                    }
                },
                _ = tokio::time::sleep_until(wake) => {
                    if tokio::time::Instant::now() >= deadline {
                        return Err(match self.watch.last_error {
                            Some(code) => TurnFailure::from_code(code),
                            None => TurnFailure::new(TurnFailureKind::Timeout),
                        });
                    }
                }
            }
        }
    }

    /// Sends `data` to `peer` through the relay, installing a permission (then a channel) first when needed.
    fn send_peer(
        &mut self,
        peer: SocketAddr,
        data: Vec<u8>,
    ) -> Option<turn_client_proto::api::Transmit<Vec<u8>>> {
        let now = self.now();
        if self.client.have_permission(TransportType::Udp, peer.ip()) {
            if self.channels.insert(peer) {
                let _ = self.client.bind_channel(TransportType::Udp, peer, now);
            }
            return match self.client.send_to(TransportType::Udp, peer, data, now) {
                Ok(Some(build)) => Some(build.build()),
                _ => None,
            };
        }
        let queue = self.queued.entry(peer.ip()).or_default();
        if queue.len() < QUEUED_PER_PEER {
            queue.push((peer, data));
        }
        if self.asked.insert(peer.ip()) {
            let _ = self
                .client
                .create_permission(TransportType::Udp, peer.ip(), now);
        }
        None
    }

    /// Handles client events after the allocation exists; `Err` ends the relay.
    fn events(
        &mut self,
        inbound: &mpsc::Sender<RelayEvent>,
    ) -> Vec<turn_client_proto::api::Transmit<Vec<u8>>> {
        let mut out = Vec::new();
        while let Some(event) = self.client.poll_event() {
            match event {
                TurnEvent::PermissionCreated(_, ip) => {
                    for (peer, data) in self.queued.remove(&ip).unwrap_or_default() {
                        out.extend(self.send_peer(peer, data));
                    }
                }
                TurnEvent::PermissionCreateFailed(_, ip) => {
                    self.queued.remove(&ip);
                    self.asked.remove(&ip);
                    let _ = inbound.try_send(RelayEvent::Problem(TurnFailure::new(
                        TurnFailureKind::PermissionDenied,
                    )));
                }
                TurnEvent::ChannelCreateFailed(_, peer) => {
                    // Send indications keep working without a channel.
                    tracing::debug!(port = peer.port(), "a TURN channel couldn't be bound");
                }
                _ => {}
            }
        }
        out
    }

    async fn write_all(
        &mut self,
        transmits: Vec<turn_client_proto::api::Transmit<Vec<u8>>>,
    ) -> Result<(), TurnFailure> {
        for transmit in transmits {
            self.write_frame(&transmit.data).await?;
        }
        Ok(())
    }

    /// Relays until the link is dropped (then releases the allocation) or the allocation ends.
    pub(crate) async fn run(
        mut self,
        mut outbound: mpsc::Receiver<(SocketAddr, Vec<u8>)>,
        inbound: mpsc::Sender<RelayEvent>,
    ) {
        let ended = self.relay(&mut outbound, &inbound).await;
        match ended {
            Ok(()) => self.release().await,
            Err(failure) => {
                tracing::info!(%failure, "the TURN relay ended");
                let _ = inbound.try_send(RelayEvent::Ended(failure));
            }
        }
        self.io.shutdown().await;
    }

    async fn relay(
        &mut self,
        outbound: &mut mpsc::Receiver<(SocketAddr, Vec<u8>)>,
        inbound: &mpsc::Sender<RelayEvent>,
    ) -> Result<(), TurnFailure> {
        let mut buf = vec![0u8; 65_536];
        loop {
            self.flush().await?;
            let sends = self.events(inbound);
            self.write_all(sends).await?;
            let wake = match self.client.poll(self.now()) {
                TurnPollRet::WaitUntil(at) => self.wake_at(at),
                TurnPollRet::Closed => return Err(self.ended_failure()),
                _ => tokio::time::Instant::now() + Duration::from_secs(1),
            };
            // When refreshes keep failing until the lifetime passes, the library drops the allocation without
            // closing or reporting it: notice it here, so the connection learns its relay is gone.
            if self.client.relayed_addresses().next().is_none() {
                return Err(self.ended_failure());
            }
            tokio::select! {
                packet = outbound.recv() => match packet {
                    None => return Ok(()),
                    Some((peer, data)) => {
                        let sends: Vec<_> = self.send_peer(peer, data).into_iter().collect();
                        self.write_all(sends).await?;
                    }
                },
                read = self.io.read(&mut buf) => match read {
                    Ok(0) | Err(_) => return Err(TurnFailure::new(TurnFailureKind::Lost)),
                    Ok(n) => self.received(&buf[..n], Some(inbound))?,
                },
                _ = tokio::time::sleep_until(wake) => {}
            }
        }
    }

    /// Why a working allocation stopped (the client closes when a refresh times out or is refused).
    fn ended_failure(&self) -> TurnFailure {
        match self.watch.last_error {
            Some(code) => TurnFailure {
                kind: TurnFailureKind::RefreshFailed,
                code: Some(code),
            },
            None => TurnFailure::new(TurnFailureKind::RefreshFailed),
        }
    }

    /// Asks the server to remove the allocation (Refresh, lifetime 0) and waits briefly for it to be sent.
    async fn release(&mut self) {
        if self.client.delete(self.now()).is_err() {
            return;
        }
        let deadline = tokio::time::Instant::now() + RELEASE_WAIT;
        let mut buf = vec![0u8; 65_536];
        while tokio::time::Instant::now() < deadline {
            if self.flush().await.is_err() {
                return;
            }
            if self.client.relayed_addresses().next().is_none() {
                return;
            }
            let wake = match self.client.poll(self.now()) {
                TurnPollRet::WaitUntil(at) => self.wake_at(at).min(deadline),
                _ => return,
            };
            tokio::select! {
                read = self.io.read(&mut buf) => match read {
                    Ok(0) | Err(_) => return,
                    Ok(n) => {
                        if self.received(&buf[..n], None).is_err() {
                            return;
                        }
                    }
                },
                _ = tokio::time::sleep_until(wake) => {}
            }
        }
    }
}

fn deliver(inbound: Option<&mpsc::Sender<RelayEvent>>, peer: SocketAddr, data: &[u8]) {
    if let Some(inbound) = inbound {
        let _ = inbound.try_send(RelayEvent::Data {
            peer,
            data: data.to_vec(),
        });
    }
}

/// Starts relaying for an allocated session and returns the WebRTC engine's end.
pub(crate) fn spawn(session: Session) -> RelayLink {
    let (out_tx, out_rx) = mpsc::channel(LINK_DEPTH);
    let (in_tx, in_rx) = mpsc::channel(LINK_DEPTH);
    tokio::spawn(session.run(out_rx, in_tx));
    RelayLink::new(out_tx, in_rx)
}
