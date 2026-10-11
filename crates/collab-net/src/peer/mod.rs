//! One WebRTC peer connection, implemented with `str0m` (sans-IO): this module owns the UDP socket and runs the
//! `Rtc` state machine on a tokio task ([`driver`]); everything else talks to it through [`PeerHandle`]
//! ([`PeerTransport`]/[`DataChannelTransport`]) and the [`PeerEvent`] stream. The only module that names `str0m`.
//!
//! The offering side (a participant) creates the four logical data channels — `openmind-control`, `-sync`,
//! `-files` (reliable, ordered) and `-awareness` (unordered, no retransmissions) — and the answering side (the Owner)
//! accepts them by label; any other label is ignored. Voice is not here: it will be WebRTC *media* in the WebView,
//! with its signaling on the control channel, so nothing in this engine stands in its way.

mod driver;

use std::net::{IpAddr, Ipv4Addr, SocketAddr};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::Arc;
use std::time::Duration;

use openmind_collab::protocol::Channel;
use openmind_collab_signal::SignalKind;
use tokio::net::UdpSocket;
use tokio::sync::{mpsc, watch, Notify};

use crate::error::NetError;
use crate::ice::{IcePolicy, IceSetup};
use crate::state::ConnectionState;
use crate::transport::{
    CandidateGatherer, DataChannelTransport, PeerEvent, PeerTransport, RelayAllocation,
    RelayProvider, RelayStatus,
};

/// The largest application message one data channel message may carry (larger content is chunked by its sender).
/// `str0m` holds at most 128 KB in SCTP send buffers across all streams and refuses a write that doesn't fit, so a
/// message must stay below that (a larger one could never be written and would stall its channel).
pub const MAX_CHANNEL_MESSAGE: usize = 120 * 1024;

/// Every logical channel, in the order the offering side creates them.
pub const CHANNELS: [Channel; 4] = [
    Channel::Control,
    Channel::Sync,
    Channel::Files,
    Channel::Awareness,
];

pub fn channel_by_label(label: &str) -> Option<Channel> {
    CHANNELS.into_iter().find(|c| c.label() == label)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PeerRole {
    /// Creates the channels and the offer (a participant).
    Offerer,
    /// Waits for an offer (the Owner).
    Answerer,
}

#[derive(Debug, Clone, Copy)]
pub struct PeerConfig {
    pub role: PeerRole,
    /// Time from creation to a secured connection.
    pub connect_timeout: Duration,
    /// How long a dropped link may try to recover before it fails.
    pub reconnect_grace: Duration,
}

impl PeerConfig {
    pub fn new(role: PeerRole) -> Self {
        Self {
            role,
            connect_timeout: Duration::from_secs(20),
            reconnect_grace: Duration::from_secs(20),
        }
    }
}

#[derive(Debug)]
enum Command {
    Send(Channel, Vec<u8>),
    Remote(SignalKind),
    IceRestart,
    /// A TURN allocation that finished after the connection started (its candidate is trickled to the other side).
    Relay(RelayAllocation),
    Close,
}

/// Bytes in flight per channel, shared by the handle (which adds what it sends) and the driver (which publishes what
/// is still queued or in the SCTP send buffer after each turn and wakes waiting senders).
#[derive(Debug, Default)]
pub(crate) struct Flow {
    in_flight: [AtomicUsize; 4],
    buffered: [AtomicUsize; 4],
    closed: AtomicBool,
    notify: Notify,
}

pub(crate) fn channel_index(channel: Channel) -> usize {
    CHANNELS.iter().position(|c| *c == channel).unwrap_or(0)
}

impl Flow {
    fn total(&self, channel: Channel) -> usize {
        let i = channel_index(channel);
        self.in_flight[i].load(Ordering::Acquire) + self.buffered[i].load(Ordering::Acquire)
    }

    pub(crate) fn consumed(&self, channel: Channel, len: usize) {
        let i = channel_index(channel);
        let _ = self.in_flight[i].fetch_update(Ordering::AcqRel, Ordering::Acquire, |v| {
            Some(v.saturating_sub(len))
        });
    }

    pub(crate) fn publish(&self, channel: Channel, buffered: usize) {
        self.buffered[channel_index(channel)].store(buffered, Ordering::Release);
    }

    pub(crate) fn wake(&self) {
        self.notify.notify_waiters();
    }

    pub(crate) fn close(&self) {
        self.closed.store(true, Ordering::Release);
        self.notify.notify_waiters();
    }
}

/// A running peer connection.
#[derive(Debug, Clone)]
pub struct PeerHandle {
    commands: mpsc::UnboundedSender<Command>,
    state: watch::Receiver<ConnectionState>,
    role: PeerRole,
    flow: Arc<Flow>,
}

impl PeerHandle {
    pub fn watch_state(&self) -> watch::Receiver<ConnectionState> {
        self.state.clone()
    }

    fn command(&self, command: Command) -> Result<(), NetError> {
        self.commands.send(command).map_err(|_| NetError::Closed)
    }
}

impl DataChannelTransport for PeerHandle {
    fn send(&self, channel: Channel, data: Vec<u8>) -> Result<(), NetError> {
        if data.len() > MAX_CHANNEL_MESSAGE {
            return Err(NetError::Protocol(format!(
                "a message is limited to {MAX_CHANNEL_MESSAGE} bytes"
            )));
        }
        let len = data.len();
        self.flow.in_flight[channel_index(channel)].fetch_add(len, Ordering::AcqRel);
        let sent = self.command(Command::Send(channel, data));
        if sent.is_err() {
            self.flow.consumed(channel, len);
        }
        sent
    }

    fn buffered(&self, channel: Channel) -> usize {
        self.flow.total(channel)
    }

    fn writable(
        &self,
        channel: Channel,
        below: usize,
    ) -> crate::transport::BoxFuture<'_, Result<(), NetError>> {
        Box::pin(async move {
            loop {
                let notified = self.flow.notify.notified();
                if self.flow.closed.load(Ordering::Acquire) {
                    return Err(NetError::Closed);
                }
                if self.flow.total(channel) < below {
                    return Ok(());
                }
                // Woken by the driver's next turn; the timeout only guards against a missed wake-up.
                let _ = tokio::time::timeout(Duration::from_millis(250), notified).await;
            }
        })
    }
}

impl PeerTransport for PeerHandle {
    fn remote_signal(&self, signal: SignalKind) -> Result<(), NetError> {
        self.command(Command::Remote(signal))
    }

    fn ice_restart(&self) -> Result<(), NetError> {
        if self.role != PeerRole::Offerer {
            return Err(NetError::Protocol(
                "only the offering side restarts ICE".into(),
            ));
        }
        self.command(Command::IceRestart)
    }

    fn state(&self) -> ConnectionState {
        *self.state.borrow()
    }

    fn close(&self) {
        let _ = self.commands.send(Command::Close);
    }
}

/// The local address of the default route (no packet is sent), else loopback.
fn default_ip() -> IpAddr {
    let probe = std::net::UdpSocket::bind((Ipv4Addr::UNSPECIFIED, 0))
        .and_then(|socket| {
            socket
                .connect((Ipv4Addr::new(192, 0, 2, 1), 9))
                .map(|()| socket)
        })
        .and_then(|socket| socket.local_addr());
    match probe {
        Ok(addr) if !addr.ip().is_unspecified() => addr.ip(),
        _ => IpAddr::V4(Ipv4Addr::LOCALHOST),
    }
}

/// Stack of a connection's own thread. `str0m` polls its output recursively (once per batch of SCTP packets it
/// feeds to DTLS), so the depth grows with the data queued; unoptimized builds have large frames and overflowed a
/// tokio worker's 2 MB stack with a full send buffer. The memory is reserved, and committed only as it is used.
const DRIVER_STACK: usize = 16 * 1024 * 1024;

/// Runs one connection's driver on its own thread (with [`DRIVER_STACK`]) and a single-threaded runtime.
async fn run_driver(
    config: PeerConfig,
    setup: driver::Setup<std::net::UdpSocket>,
    receiver: mpsc::UnboundedReceiver<Command>,
) -> Result<(), NetError> {
    let (ready, started) = tokio::sync::oneshot::channel::<Result<(), NetError>>();
    std::thread::Builder::new()
        .name("openmind-collab-peer".into())
        .stack_size(DRIVER_STACK)
        .spawn(move || {
            let runtime = match tokio::runtime::Builder::new_current_thread()
                .enable_all()
                .build()
            {
                Ok(runtime) => runtime,
                Err(err) => {
                    let _ = ready.send(Err(NetError::Io(err.to_string())));
                    return;
                }
            };
            runtime.block_on(async move {
                let driver = setup
                    .into_tokio()
                    .and_then(|setup| driver::Driver::new(config, setup));
                match driver {
                    Ok(driver) => {
                        let _ = ready.send(Ok(()));
                        driver.run(receiver).await;
                    }
                    Err(err) => {
                        let _ = ready.send(Err(err));
                    }
                }
            });
        })?;
    started.await.map_err(|_| NetError::Closed)?
}

/// Binds a socket, gathers its candidates and starts the connection. With [`IcePolicy::All`] a TURN allocation (when a
/// relay is configured) runs alongside and its candidate is added when it arrives, so a direct path is never delayed
/// by TURN; with [`IcePolicy::RelayOnly`] the relayed candidate is the only one and the start waits for it.
pub async fn start(
    config: PeerConfig,
    ice: &IceSetup,
    gatherer: &dyn CandidateGatherer,
    relay: Arc<dyn RelayProvider>,
) -> Result<(PeerHandle, mpsc::UnboundedReceiver<PeerEvent>), NetError> {
    let ip = ice.bind_ip.unwrap_or_else(default_ip);
    let socket = UdpSocket::bind(SocketAddr::new(ip, 0)).await?;
    let (candidates, relayed) = match ice.policy {
        IcePolicy::RelayOnly => (Vec::new(), Some(relay.allocate().await?)),
        IcePolicy::All => (gatherer.gather(&socket).await, None),
    };
    let (commands, receiver) = mpsc::unbounded_channel();
    let (events, event_receiver) = mpsc::unbounded_channel();
    let state = Arc::new(crate::state::StateTracker::new("peer"));
    let watch = state.watch();
    let flow = Arc::new(Flow::default());
    let setup = driver::Setup {
        socket: socket.into_std()?,
        candidates,
        relay: relayed,
        events,
        state,
        flow: flow.clone(),
    };
    run_driver(config, setup, receiver).await?;
    if ice.policy == IcePolicy::All && matches!(relay.status(), RelayStatus::Available { .. }) {
        let commands = commands.clone();
        tokio::spawn(async move {
            match relay.allocate().await {
                // A connection that already ended drops the allocation, which releases it.
                Ok(allocation) => drop(commands.send(Command::Relay(allocation))),
                Err(err) => tracing::info!(%err, "no relayed candidate"),
            }
        });
    }
    Ok((
        PeerHandle {
            commands,
            state: watch,
            role: config.role,
            flow,
        },
        event_receiver,
    ))
}
