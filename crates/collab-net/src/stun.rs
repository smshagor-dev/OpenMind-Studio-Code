//! STUN binding (RFC 8489, the parts a client needs to learn its public address): a Binding request with a random
//! transaction id, sent from the peer connection's own socket, and the XOR-MAPPED-ADDRESS (or MAPPED-ADDRESS) of the
//! answer. [`StunGatherer`] turns that into ICE candidates: the socket's host address, plus a server-reflexive one
//! per STUN server that reports a different address. No credentials, no TURN.

use std::net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddr};
use std::time::Duration;

use tokio::net::UdpSocket;

use crate::ice::StunServer;
use crate::transport::{BoxFuture, CandidateGatherer, CandidateKind, LocalCandidate};

const MAGIC: u32 = 0x2112_A442;
const BINDING_REQUEST: u16 = 0x0001;
const BINDING_SUCCESS: u16 = 0x0101;
const MAPPED_ADDRESS: u16 = 0x0001;
const XOR_MAPPED_ADDRESS: u16 = 0x0020;

pub type TransactionId = [u8; 12];

pub fn binding_request(transaction: &TransactionId) -> [u8; 20] {
    let mut out = [0u8; 20];
    out[0..2].copy_from_slice(&BINDING_REQUEST.to_be_bytes());
    out[4..8].copy_from_slice(&MAGIC.to_be_bytes());
    out[8..20].copy_from_slice(transaction);
    out
}

/// Whether `packet` looks like STUN (first two bits zero and the magic cookie).
pub fn is_stun(packet: &[u8]) -> bool {
    packet.len() >= 20 && packet[0] & 0xC0 == 0 && packet[4..8] == MAGIC.to_be_bytes()
}

fn decode_address(value: &[u8], xor: bool, transaction: &TransactionId) -> Option<SocketAddr> {
    if value.len() < 4 {
        return None;
    }
    let family = value[1];
    let mut port = u16::from_be_bytes([value[2], value[3]]);
    if xor {
        port ^= (MAGIC >> 16) as u16;
    }
    match family {
        0x01 if value.len() >= 8 => {
            let mut ip = [value[4], value[5], value[6], value[7]];
            if xor {
                for (byte, key) in ip.iter_mut().zip(MAGIC.to_be_bytes()) {
                    *byte ^= key;
                }
            }
            Some(SocketAddr::new(IpAddr::V4(Ipv4Addr::from(ip)), port))
        }
        0x02 if value.len() >= 20 => {
            let mut ip = [0u8; 16];
            ip.copy_from_slice(&value[4..20]);
            if xor {
                let mut key = [0u8; 16];
                key[..4].copy_from_slice(&MAGIC.to_be_bytes());
                key[4..].copy_from_slice(transaction);
                for (byte, k) in ip.iter_mut().zip(key) {
                    *byte ^= k;
                }
            }
            Some(SocketAddr::new(IpAddr::V6(Ipv6Addr::from(ip)), port))
        }
        _ => None,
    }
}

/// The mapped address of a Binding success answering `transaction`; anything else gives `None`.
pub fn parse_binding_response(packet: &[u8], transaction: &TransactionId) -> Option<SocketAddr> {
    if !is_stun(packet) || u16::from_be_bytes([packet[0], packet[1]]) != BINDING_SUCCESS {
        return None;
    }
    if &packet[8..20] != transaction {
        return None;
    }
    let length = usize::from(u16::from_be_bytes([packet[2], packet[3]]));
    let body = packet.get(20..20 + length)?;
    let (mut offset, mut plain) = (0, None);
    while offset + 4 <= body.len() {
        let kind = u16::from_be_bytes([body[offset], body[offset + 1]]);
        let len = usize::from(u16::from_be_bytes([body[offset + 2], body[offset + 3]]));
        let value = body.get(offset + 4..offset + 4 + len)?;
        match kind {
            XOR_MAPPED_ADDRESS => return decode_address(value, true, transaction),
            MAPPED_ADDRESS => plain = decode_address(value, false, transaction),
            _ => {}
        }
        offset += 4 + len.div_ceil(4) * 4;
    }
    plain
}

/// Host candidate plus one server-reflexive candidate per responding STUN server.
pub struct StunGatherer {
    servers: Vec<StunServer>,
    timeout: Duration,
}

impl StunGatherer {
    pub fn new(servers: Vec<StunServer>) -> Self {
        Self {
            servers,
            timeout: Duration::from_millis(1500),
        }
    }

    pub fn with_timeout(mut self, timeout: Duration) -> Self {
        self.timeout = timeout;
        self
    }

    async fn ask(&self, socket: &UdpSocket, server: &StunServer) -> Option<SocketAddr> {
        let local = socket.local_addr().ok()?;
        let target = tokio::net::lookup_host((server.host.as_str(), server.port))
            .await
            .ok()?
            .find(|addr| addr.is_ipv4() == local.is_ipv4())?;
        let mut transaction = [0u8; 12];
        getrandom::fill(&mut transaction).ok()?;
        let request = binding_request(&transaction);
        let mut buf = [0u8; 1500];
        let deadline = tokio::time::Instant::now() + self.timeout;
        // Retransmit a few times inside the time limit (UDP may drop the first try).
        for _ in 0..3 {
            socket.send_to(&request, target).await.ok()?;
            let attempt = tokio::time::Instant::now() + self.timeout / 3;
            while let Ok(Ok((n, from))) =
                tokio::time::timeout_at(attempt.min(deadline), socket.recv_from(&mut buf)).await
            {
                if from == target {
                    if let Some(mapped) = parse_binding_response(&buf[..n], &transaction) {
                        return Some(mapped);
                    }
                }
            }
        }
        None
    }
}

impl CandidateGatherer for StunGatherer {
    fn gather<'a>(&'a self, socket: &'a UdpSocket) -> BoxFuture<'a, Vec<LocalCandidate>> {
        Box::pin(async move {
            let Ok(local) = socket.local_addr() else {
                return Vec::new();
            };
            let mut candidates = vec![LocalCandidate {
                kind: CandidateKind::Host,
                addr: local,
                base: local,
            }];
            for server in &self.servers {
                match self.ask(socket, server).await {
                    Some(mapped) if candidates.iter().all(|c| c.addr != mapped) => {
                        candidates.push(LocalCandidate {
                            kind: CandidateKind::ServerReflexive,
                            addr: mapped,
                            base: local,
                        });
                    }
                    Some(_) => {}
                    None => tracing::info!(server = %server.host, "a STUN server didn't answer"),
                }
            }
            candidates
        })
    }
}

#[cfg(test)]
#[path = "stun_tests.rs"]
mod tests;
