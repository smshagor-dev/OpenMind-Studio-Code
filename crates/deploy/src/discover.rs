//! Looking for deployments: a few queries, then listen for the answers that carry this run's nonce.
//!
//! The query goes to the limited broadcast (255.255.255.255), to the broadcast address of each IPv4 network this
//! computer is on (Windows sends the limited broadcast on one adapter only) and to any address it was given (a source
//! on another subnet, typed in or remembered). It is sent [`Options::rounds`] times spread over the window, because a
//! single datagram may be lost. Nothing scans address ranges.
//!
//! The [`Report`] keeps enough to tell the user *why* nothing was found ([`Outcome`]): no socket at all (discovery
//! unavailable), every send refused (the network or a policy blocks broadcasts), answers only from another protocol
//! version (incompatible), or simply no answer (no deployment, or inbound UDP is filtered — which a computer can't tell
//! apart from silence; the report says so).

use std::net::{IpAddr, Ipv4Addr, SocketAddr, UdpSocket};
use std::time::{Duration, Instant};

use crate::advert::Advert;
use crate::packet::{decode, Decoded, Packet, MAX_PACKET};
use crate::random_hex;

/// At most this many answers (and this many incompatible ones) are kept from one search: a flood of forged answers
/// can't grow memory without bound.
pub const MAX_FOUND: usize = 256;
pub const MAX_INCOMPATIBLE: usize = 64;

#[derive(Debug, Clone)]
pub struct Options {
    pub port: u16,
    pub window: Duration,
    pub rounds: u32,
    /// Send to broadcast addresses (off: only `targets`).
    pub broadcast: bool,
    /// Addresses to ask directly.
    pub targets: Vec<SocketAddr>,
}

impl Default for Options {
    fn default() -> Self {
        Self {
            port: crate::DISCOVERY_PORT,
            window: Duration::from_millis(2500),
            rounds: 3,
            broadcast: true,
            targets: Vec::new(),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Found {
    pub advert: Advert,
    pub from: SocketAddr,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct IncompatibleFound {
    pub from: SocketAddr,
    pub protocol: u64,
    pub deployment_id: Option<String>,
    pub app_version: Option<String>,
}

/// Why a search ended the way it did.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Outcome {
    Found,
    /// Queries went out, nothing answered.
    NothingFound,
    /// Only deployments speaking another protocol version answered.
    ProtocolIncompatible,
    /// Every query was refused by this computer's network stack (no route, broadcasts blocked by policy).
    NetworkBlocked,
    /// No UDP socket could be opened at all.
    DiscoveryUnavailable,
}

#[derive(Debug, Clone, Default)]
pub struct Report {
    pub found: Vec<Found>,
    pub incompatible: Vec<IncompatibleFound>,
    /// Packets marked as ours that were broken or failed validation.
    pub malformed: u32,
    /// Answers to another nonce (late answers of an earlier search, or replays).
    pub stale: u32,
    pub targets: Vec<SocketAddr>,
    pub sent: u32,
    pub send_errors: Vec<String>,
    pub socket_error: Option<String>,
    pub elapsed: Duration,
}

impl Report {
    pub fn outcome(&self) -> Outcome {
        if self.socket_error.is_some() {
            Outcome::DiscoveryUnavailable
        } else if !self.found.is_empty() {
            Outcome::Found
        } else if !self.incompatible.is_empty() {
            Outcome::ProtocolIncompatible
        } else if self.sent == 0 {
            Outcome::NetworkBlocked
        } else {
            Outcome::NothingFound
        }
    }
}

/// This computer's IPv4 networks that are up (address, prefix), loopback left out.
pub fn local_ipv4_networks() -> Vec<(Ipv4Addr, u8)> {
    use netdev::interface::state::OperState;
    netdev::get_interfaces()
        .iter()
        .filter(|i| {
            !i.is_loopback()
                && !matches!(
                    i.oper_state,
                    OperState::Down | OperState::LowerLayerDown | OperState::NotPresent
                )
        })
        .flat_map(|i| i.ipv4.iter().map(|net| (net.addr(), net.prefix_len())))
        .filter(|(ip, _)| !ip.is_loopback() && !ip.is_unspecified())
        .collect()
}

/// Where a broadcast query goes: the limited broadcast and each network's broadcast address.
pub fn broadcast_targets(port: u16) -> Vec<SocketAddr> {
    let mut targets = vec![SocketAddr::from((Ipv4Addr::BROADCAST, port))];
    for (ip, prefix) in local_ipv4_networks() {
        if prefix < 31 {
            let broadcast = Ipv4Addr::from(u32::from(ip) | (u32::MAX >> prefix));
            let target = SocketAddr::from((broadcast, port));
            if !targets.contains(&target) {
                targets.push(target);
            }
        }
    }
    targets
}

/// Runs one search (blocking for about `options.window`).
pub fn discover(options: &Options) -> Report {
    let started = Instant::now();
    let mut report = Report::default();
    let socket = match open_socket() {
        Ok(socket) => socket,
        Err(err) => {
            report.socket_error = Some(err.to_string());
            report.elapsed = started.elapsed();
            return report;
        }
    };
    report.targets = options.targets.clone();
    if options.broadcast {
        for target in broadcast_targets(options.port) {
            if !report.targets.contains(&target) {
                report.targets.push(target);
            }
        }
    }
    let nonce = random_hex(8);
    let query = Packet::Query {
        nonce: nonce.clone(),
    }
    .encode();
    let rounds = options.rounds.max(1);
    let gap = options.window / rounds;
    let mut buf = [0u8; MAX_PACKET + 1];
    for round in 0..rounds {
        send_round(&socket, &query, &mut report);
        let until = started + gap * (round + 1);
        receive_until(&socket, &nonce, until, &mut buf, &mut report);
    }
    report.elapsed = started.elapsed();
    report
}

fn open_socket() -> std::io::Result<UdpSocket> {
    let socket = UdpSocket::bind(SocketAddr::from((Ipv4Addr::UNSPECIFIED, 0)))?;
    socket.set_broadcast(true)?;
    Ok(socket)
}

fn send_round(socket: &UdpSocket, query: &[u8], report: &mut Report) {
    for target in report.targets.clone() {
        match socket.send_to(query, target) {
            Ok(_) => report.sent += 1,
            Err(err) => {
                let line = format!("{target}: {err}");
                if !report.send_errors.contains(&line) {
                    report.send_errors.push(line);
                }
            }
        }
    }
}

fn receive_until(
    socket: &UdpSocket,
    nonce: &str,
    until: Instant,
    buf: &mut [u8],
    report: &mut Report,
) {
    loop {
        let left = until.saturating_duration_since(Instant::now());
        if left.is_zero() {
            return;
        }
        if socket
            .set_read_timeout(Some(left.max(Duration::from_millis(1))))
            .is_err()
        {
            return;
        }
        let Ok((n, from)) = socket.recv_from(buf) else {
            continue;
        };
        record(decode(&buf[..n]), from, nonce, report);
    }
}

fn record(decoded: Decoded, from: SocketAddr, nonce: &str, report: &mut Report) {
    match decoded {
        Decoded::Packet(Packet::Answer {
            nonce: answered,
            advert,
        }) => {
            if answered != nonce {
                report.stale += 1;
            } else if report.found.len() < MAX_FOUND
                && !report
                    .found
                    .iter()
                    .any(|f| f.from == from && f.advert.instance == advert.instance)
            {
                report.found.push(Found { advert, from });
            }
        }
        Decoded::Incompatible {
            protocol,
            deployment_id,
            app_version,
        } => {
            if report.incompatible.len() < MAX_INCOMPATIBLE
                && !report.incompatible.iter().any(|i| i.from == from)
            {
                report.incompatible.push(IncompatibleFound {
                    from,
                    protocol,
                    deployment_id,
                    app_version,
                });
            }
        }
        Decoded::Malformed(_) => report.malformed += 1,
        // Our own query echoed back by a broadcast, or anything else on the port.
        Decoded::Packet(Packet::Query { .. }) | Decoded::Foreign => {}
    }
}

/// The loopback address of the discovery port (asking a source on this computer, and tests).
pub fn loopback(port: u16) -> SocketAddr {
    SocketAddr::new(IpAddr::V4(Ipv4Addr::LOCALHOST), port)
}
