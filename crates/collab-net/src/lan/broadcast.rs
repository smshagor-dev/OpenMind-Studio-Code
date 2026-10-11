//! UDP broadcast discovery (the fallback where mDNS is filtered). Low-noise by design: a participant sends one small
//! query per target (the limited broadcast plus each usable interface's subnet broadcast), three times over the
//! discovery window, and stops; nothing scans addresses. An Owner answers only queries for its own tag, only to the
//! sender, at most [`ANSWERS_PER_SECOND`] (so it can't be used to flood someone), and never answers anything else.
//!
//! All rooms one app hosts are answered by one socket on [`super::DISCOVERY_PORT`]; other app copies on the computer
//! listen on the same port with `SO_REUSEADDR`, which a broadcast reaches as well.

use std::collections::{HashMap, HashSet};
use std::net::{Ipv4Addr, SocketAddr};
use std::sync::{Arc, Mutex as StdMutex};
use std::time::Duration;

use socket2::{Domain, Protocol, Socket, Type};
use tokio::net::UdpSocket;
use tokio::task::JoinHandle;

use super::packet::{Packet, MAX_PACKET};
use super::{netif, random_hex, DiscoveryTag, LanEndpoint, LanSource};

pub const ANSWERS_PER_SECOND: u32 = 20;
/// How long an answer says it stays valid.
pub const ANSWER_TTL_SECS: u32 = 30;

fn shared_socket(port: u16) -> std::io::Result<UdpSocket> {
    let socket = Socket::new(Domain::IPV4, Type::DGRAM, Some(Protocol::UDP))?;
    socket.set_reuse_address(true)?;
    socket.set_broadcast(true)?;
    socket.set_nonblocking(true)?;
    socket.bind(&SocketAddr::from((Ipv4Addr::UNSPECIFIED, port)).into())?;
    UdpSocket::from_std(socket.into())
}

/// The rooms one process answers for on one port: tag -> (rendezvous port, instance) of each hosting Owner.
type Rooms = Arc<StdMutex<HashMap<String, Vec<(u16, String)>>>>;

struct Listener {
    rooms: Rooms,
    task: JoinHandle<()>,
}

/// One listener per port per process: a unicast datagram to a port shared by several sockets reaches only one of them
/// (Windows), so every room this process hosts is answered by the same socket. Other app copies on the computer get
/// their own socket on the same port (`SO_REUSEADDR`), which a real broadcast reaches too.
static LISTENERS: StdMutex<Option<HashMap<u16, Listener>>> = StdMutex::new(None);

fn listeners() -> std::sync::MutexGuard<'static, Option<HashMap<u16, Listener>>> {
    LISTENERS
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
}

/// An Owner's registration with its process's broadcast responder; withdrawn when dropped.
pub struct Responder {
    port: u16,
    tag: String,
    instance: String,
}

impl Drop for Responder {
    fn drop(&mut self) {
        let mut all = listeners();
        let Some(map) = all.as_mut() else { return };
        let empty = map.get(&self.port).is_some_and(|listener| {
            let mut rooms = listener
                .rooms
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            if let Some(owners) = rooms.get_mut(&self.tag) {
                owners.retain(|(_, instance)| *instance != self.instance);
                if owners.is_empty() {
                    rooms.remove(&self.tag);
                }
            }
            rooms.is_empty()
        });
        if empty {
            if let Some(listener) = map.remove(&self.port) {
                listener.task.abort();
            }
        }
    }
}

impl Responder {
    /// Answers queries for `tag` on `port` with the rendezvous `rendezvous_port`.
    pub fn start(
        port: u16,
        tag: DiscoveryTag,
        rendezvous_port: u16,
        instance: String,
    ) -> std::io::Result<Self> {
        let mut all = listeners();
        let map = all.get_or_insert_with(HashMap::new);
        // A listener whose runtime ended (tests run one per test) is replaced; its rooms are gone with it.
        if map
            .get(&port)
            .is_some_and(|listener| listener.task.is_finished())
        {
            map.remove(&port);
        }
        let listener = match map.entry(port) {
            std::collections::hash_map::Entry::Occupied(entry) => entry.into_mut(),
            std::collections::hash_map::Entry::Vacant(entry) => {
                let socket = shared_socket(port)?;
                let rooms: Rooms = Arc::default();
                let task = tokio::spawn(answer_loop(socket, rooms.clone()));
                entry.insert(Listener { rooms, task })
            }
        };
        {
            let mut rooms = listener
                .rooms
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            rooms
                .entry(tag.to_string())
                .or_default()
                .push((rendezvous_port, instance.clone()));
        }
        Ok(Self {
            port,
            tag: tag.to_string(),
            instance,
        })
    }
}

async fn answer_loop(socket: UdpSocket, rooms: Rooms) {
    let mut buf = [0u8; MAX_PACKET + 1];
    let (mut window, mut answered) = (tokio::time::Instant::now(), 0u32);
    loop {
        let Ok((n, from)) = socket.recv_from(&mut buf).await else {
            tokio::time::sleep(Duration::from_millis(50)).await; // e.g. ICMP "port unreachable" surfacing on Windows
            continue;
        };
        let Some(Packet::Query {
            tag: wanted, nonce, ..
        }) = Packet::decode(&buf[..n])
        else {
            continue;
        };
        let owners = rooms
            .lock()
            .map(|r| r.get(&wanted).cloned().unwrap_or_default())
            .unwrap_or_default();
        let Some(tag) = DiscoveryTag::parse(&wanted).filter(|_| !owners.is_empty()) else {
            continue; // another room, or a guess: silence
        };
        if window.elapsed() >= Duration::from_secs(1) {
            (window, answered) = (tokio::time::Instant::now(), 0);
        }
        for (rendezvous_port, instance) in owners {
            if answered >= ANSWERS_PER_SECOND {
                break;
            }
            answered += 1;
            let answer = Packet::answer(&tag, &nonce, rendezvous_port, &instance, ANSWER_TTL_SECS);
            let _ = socket.send_to(&answer.encode(), from).await;
        }
    }
}

/// Where queries go: the limited broadcast and each usable interface's subnet broadcast, on `port`.
pub fn default_targets(port: u16) -> Vec<SocketAddr> {
    let mut targets = vec![SocketAddr::from((Ipv4Addr::BROADCAST, port))];
    for interface in netif::current() {
        for broadcast in interface.broadcasts() {
            let target = SocketAddr::from((broadcast, port));
            if !targets.contains(&target) {
                targets.push(target);
            }
        }
    }
    targets
}

/// Asks `targets` for `tag` for up to `window`; returns the Owners that answered with the right nonce (deduplicated,
/// in the order they answered). Returns early, shortly after the first answer. An `Err` means the query couldn't be
/// made at all (no socket, no randomness, no query could be sent) — never confused with "nobody answered".
pub async fn query(
    tag: &DiscoveryTag,
    targets: &[SocketAddr],
    window: Duration,
) -> Result<Vec<LanEndpoint>, String> {
    let socket = shared_socket(0).map_err(|err| format!("no discovery socket: {err}"))?;
    let nonce = random_hex(16).ok_or("no randomness for the discovery nonce")?;
    let request = Packet::query(tag, &nonce).encode();
    let deadline = tokio::time::Instant::now() + window;
    let mut found: Vec<LanEndpoint> = Vec::new();
    let mut seen = HashSet::new();
    let mut buf = [0u8; MAX_PACKET + 1];
    let mut first_answer: Option<tokio::time::Instant> = None;
    for attempt in 0..3u32 {
        let mut sent = 0;
        let mut last_error = None;
        for target in targets {
            match socket.send_to(&request, target).await {
                Ok(_) => sent += 1,
                Err(err) => last_error = Some(err),
            }
        }
        if sent == 0 {
            if let Some(err) = last_error {
                return Err(format!("no discovery query could be sent: {err}"));
            }
        }
        let round_end = (tokio::time::Instant::now() + window / 3).min(deadline);
        let until = first_answer.map_or(round_end, |at| {
            (at + Duration::from_millis(250)).min(round_end)
        });
        loop {
            let (n, from) = match tokio::time::timeout_at(until, socket.recv_from(&mut buf)).await {
                Ok(Ok(received)) => received,
                // Windows reports an ICMP "port unreachable" from one target as an error on the next receive; it says
                // nothing about the other targets, so keep listening until the round ends.
                Ok(Err(_)) => continue,
                Err(_) => break,
            };
            let Some(Packet::Answer {
                tag: answered,
                nonce: echoed,
                port,
                instance,
                ..
            }) = Packet::decode(&buf[..n])
            else {
                continue;
            };
            if answered != tag.as_str() || echoed != nonce {
                continue; // someone else's answer, or a replay of an old one
            }
            let addr = SocketAddr::new(from.ip(), port);
            if seen.insert((addr, instance.clone())) {
                found.push(LanEndpoint {
                    addr,
                    source: LanSource::Broadcast,
                    instance,
                });
                first_answer.get_or_insert_with(tokio::time::Instant::now);
            }
        }
        if !found.is_empty() || attempt == 2 || tokio::time::Instant::now() >= deadline {
            break;
        }
    }
    Ok(found)
}
