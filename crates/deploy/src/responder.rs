//! Answering discovery queries for a deployment this computer offers.
//!
//! One UDP socket on the discovery port (`SO_REUSEADDR`, so another program on the computer can listen too, and
//! `SO_BROADCAST`). It answers only a well-formed query of this protocol, only to the address it came from, with this
//! deployment's [`Advert`], at most [`ANSWERS_PER_SECOND`] times a second (so it can't be used to flood anyone), and
//! never anything else. It runs on its own thread and stops when dropped.

use std::net::{IpAddr, Ipv4Addr, SocketAddr, UdpSocket};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

use socket2::{Domain, Protocol, Socket, Type};

use crate::advert::Advert;
use crate::packet::{decode, Decoded, Packet, MAX_PACKET};

pub const ANSWERS_PER_SECOND: u32 = 20;
const POLL: Duration = Duration::from_millis(200);

/// What the responder did so far (diagnostics).
#[derive(Debug, Default)]
pub struct Counters {
    pub queries: AtomicU64,
    pub answered: AtomicU64,
    pub limited: AtomicU64,
    pub ignored: AtomicU64,
}

pub struct Responder {
    address: SocketAddr,
    stop: Arc<AtomicBool>,
    advert: Arc<Mutex<Advert>>,
    counters: Arc<Counters>,
    thread: Option<JoinHandle<()>>,
}

/// A UDP socket on `port` that other sockets may share, able to send broadcasts.
pub fn shared_socket(bind: IpAddr, port: u16) -> std::io::Result<UdpSocket> {
    let domain = if bind.is_ipv4() {
        Domain::IPV4
    } else {
        Domain::IPV6
    };
    let socket = Socket::new(domain, Type::DGRAM, Some(Protocol::UDP))?;
    socket.set_reuse_address(true)?;
    socket.set_broadcast(true)?;
    socket.bind(&SocketAddr::new(bind, port).into())?;
    Ok(socket.into())
}

impl Responder {
    /// Starts answering on `port` (0: any free port — tests). `bind` is normally all IPv4 addresses.
    pub fn start(bind: IpAddr, port: u16, advert: Advert) -> std::io::Result<Self> {
        advert.validate().map_err(|field| {
            std::io::Error::other(format!("this deployment's {field} is invalid"))
        })?;
        let socket = shared_socket(bind, port)?;
        socket.set_read_timeout(Some(POLL))?;
        let address = socket.local_addr()?;
        let stop = Arc::new(AtomicBool::new(false));
        let advert = Arc::new(Mutex::new(advert));
        let counters = Arc::new(Counters::default());
        let thread = std::thread::Builder::new()
            .name("deploy-responder".into())
            .spawn({
                let (stop, advert, counters) = (stop.clone(), advert.clone(), counters.clone());
                move || answer_loop(&socket, &stop, &advert, &counters)
            })?;
        tracing::info!(%address, "answering deployment discovery queries");
        Ok(Self {
            address,
            stop,
            advert,
            counters,
            thread: Some(thread),
        })
    }

    /// The default: every IPv4 address on [`crate::DISCOVERY_PORT`].
    pub fn start_default(advert: Advert) -> std::io::Result<Self> {
        Self::start(
            IpAddr::V4(Ipv4Addr::UNSPECIFIED),
            crate::DISCOVERY_PORT,
            advert,
        )
    }

    pub fn address(&self) -> SocketAddr {
        self.address
    }

    /// Changes what is announced (a new version after an update, packages added).
    pub fn set_advert(&self, advert: Advert) -> Result<(), String> {
        advert.validate()?;
        *self
            .advert
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner) = advert;
        Ok(())
    }

    pub fn counters(&self) -> &Counters {
        &self.counters
    }
}

impl Drop for Responder {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::SeqCst);
        if let Some(thread) = self.thread.take() {
            let _ = thread.join();
        }
    }
}

fn answer_loop(socket: &UdpSocket, stop: &AtomicBool, advert: &Mutex<Advert>, counters: &Counters) {
    let mut buf = [0u8; MAX_PACKET + 1];
    let (mut window, mut answered) = (Instant::now(), 0u32);
    while !stop.load(Ordering::SeqCst) {
        let (n, from) = match socket.recv_from(&mut buf) {
            Ok(received) => received,
            // A timeout to look at `stop`, or an ICMP "port unreachable" Windows reports on the next receive.
            Err(_) => continue,
        };
        let Decoded::Packet(Packet::Query { nonce }) = decode(&buf[..n]) else {
            counters.ignored.fetch_add(1, Ordering::Relaxed);
            continue;
        };
        counters.queries.fetch_add(1, Ordering::Relaxed);
        if window.elapsed() >= Duration::from_secs(1) {
            (window, answered) = (Instant::now(), 0);
        }
        if answered >= ANSWERS_PER_SECOND {
            counters.limited.fetch_add(1, Ordering::Relaxed);
            continue;
        }
        answered += 1;
        let advert = advert
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .clone();
        let reply = Packet::Answer { nonce, advert }.encode();
        if socket.send_to(&reply, from).is_ok() {
            counters.answered.fetch_add(1, Ordering::Relaxed);
        }
    }
}
