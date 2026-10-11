//! Local-network rooms (Milestone 24, phase 5.1): finding a room's Owner on the same LAN and signaling to it there,
//! with no Internet, no hosted relay, no STUN and no TURN.
//!
//! Nothing about a room changes: the same room, Room Code, authority, permissions, protocol and file transfer, and the
//! same signaling messages. Only *where* the signaling goes differs — to a relay embedded in the Owner's app
//! ([`host::LanHost`]: `openmind_collab_signal::Relay` listening on the LAN, which only this computer may host on) —
//! and how a participant learns its address ([`discover`]: mDNS and a UDP broadcast query, or an address typed in).
//!
//! The LAN is untrusted. What is announced is a [`DiscoveryTag`] — a SHA-256 of the room's signaling topic with its own
//! label, so neither the Room Code nor the topic itself is ever sent — plus a port, a protocol version and a random
//! per-run instance id. Anyone can announce any tag; a forged or replayed announcement only makes a participant try an
//! address where the Owner's Room Code proof, pinned key and DTLS-bound handshake fail, and it moves on.

pub mod broadcast;
pub mod discover;
pub mod firewall;
pub mod host;
pub mod mdns;
pub mod netif;
pub mod packet;

use std::fmt;
use std::net::SocketAddr;

use sha2::{Digest, Sha256};

/// Version of the discovery announcements (mDNS TXT `v`, broadcast `v`).
pub const LAN_VERSION: u32 = 1;
/// UDP port the Owner listens on for broadcast discovery queries (shared by every Owner on a computer).
pub const DISCOVERY_PORT: u16 = 47731;
/// Port the Owner's local rendezvous tries first, so a typed-in address stays the same across restarts.
pub const PREFERRED_RENDEZVOUS_PORT: u16 = 47732;
/// mDNS service type.
pub const SERVICE_TYPE: &str = "_omcollab._tcp.local.";

/// What a room is announced as on the local network: derived from the signaling topic (itself derived from the Room
/// Code), one-way, with a label of its own so the tag can't be used as the topic on a relay.
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct DiscoveryTag(String);

impl DiscoveryTag {
    pub fn for_topic(topic: &str) -> Self {
        let digest =
            Sha256::digest(format!("openmind-collab-lan-v{LAN_VERSION}\n{topic}").as_bytes());
        Self(hex::encode(&digest[..16]))
    }

    /// A tag as received: exactly 32 lowercase hex digits.
    pub fn parse(text: &str) -> Option<Self> {
        (text.len() == 32
            && text
                .bytes()
                .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b)))
        .then(|| Self(text.to_string()))
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl fmt::Display for DiscoveryTag {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.0)
    }
}

/// How a participant reached (or will try to reach) an Owner on the local network.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub enum LanSource {
    Mdns,
    Broadcast,
    /// Typed in by the user, or the address that worked last time.
    Known,
}

/// A local rendezvous address found for a room.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LanEndpoint {
    pub addr: SocketAddr,
    pub source: LanSource,
    /// The announcing Owner's random per-run id (empty for a known address).
    pub instance: String,
}

impl LanEndpoint {
    pub fn known(addr: SocketAddr) -> Self {
        Self {
            addr,
            source: LanSource::Known,
            instance: String::new(),
        }
    }

    pub fn signaling_url(&self) -> String {
        format!("ws://{}", self.addr)
    }
}

/// Random lowercase hex of `bytes` bytes.
pub(crate) fn random_hex(bytes: usize) -> Option<String> {
    let mut buf = vec![0u8; bytes];
    getrandom::fill(&mut buf).ok()?;
    Some(hex::encode(buf))
}

/// Parses a typed-in Owner address (`192.168.1.25:47732`, `[fe80::1%3]:47732`); the port is required.
pub fn parse_endpoint(text: &str) -> Result<SocketAddr, String> {
    let trimmed = text
        .trim()
        .trim_start_matches("ws://")
        .trim_end_matches('/');
    let addr: SocketAddr = trimmed.parse().map_err(|_| {
        "Enter the Owner's local address with its port, for example 192.168.1.25:47732.".to_string()
    })?;
    if addr.port() == 0 || addr.ip().is_unspecified() || addr.ip().is_multicast() {
        return Err("That isn't an address a computer can be reached at.".into());
    }
    Ok(addr)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_tag_is_one_way_labelled_and_stable() {
        let code = openmind_collab::RoomCode::generate().expect("code");
        let topic = code.signaling_topic();
        let tag = DiscoveryTag::for_topic(&topic);
        assert_eq!(
            tag,
            DiscoveryTag::for_topic(&topic),
            "the same room always has the same tag"
        );
        assert_eq!(tag.as_str().len(), 32);
        assert!(
            !topic.contains(tag.as_str()) && !tag.as_str().contains(&topic[..8]),
            "not the topic"
        );
        let display = code.display();
        let bare = display
            .trim_start_matches("OM-")
            .replace('-', "")
            .to_lowercase();
        assert!(
            !tag.as_str().contains(&bare[..6].to_lowercase()),
            "not the code"
        );
        let other = openmind_collab::RoomCode::generate().expect("code");
        assert_ne!(DiscoveryTag::for_topic(&other.signaling_topic()), tag);
        assert_eq!(DiscoveryTag::parse(tag.as_str()), Some(tag));
        for bad in [
            "",
            "ABCDEF0123456789ABCDEF0123456789",
            "x".repeat(32).as_str(),
            "0".repeat(33).as_str(),
        ] {
            assert!(DiscoveryTag::parse(bad).is_none(), "{bad}");
        }
    }

    #[test]
    fn typed_in_addresses_need_a_port() {
        assert_eq!(
            parse_endpoint(" 192.168.1.25:47732 ").map(|a| a.port()),
            Ok(47732)
        );
        assert!(parse_endpoint("ws://10.0.0.5:5000/").is_ok());
        for bad in [
            "192.168.1.25",
            "0.0.0.0:47732",
            "224.0.0.251:5353",
            "host.local:1",
            "192.168.1.25:0",
            "",
        ] {
            assert!(parse_endpoint(bad).is_err(), "{bad}");
        }
    }
}
