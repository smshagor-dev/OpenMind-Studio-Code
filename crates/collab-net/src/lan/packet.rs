//! The UDP broadcast discovery messages. A participant broadcasts a [`Query`] for a tag with a fresh nonce; an Owner
//! hosting that tag answers the sender directly with an [`Answer`] that echoes the nonce and names its rendezvous port.
//! The address to use is the answer's *source* address (the network decided it), never one written in the packet, so
//! an answer can't point a participant at a third machine. An answer whose nonce isn't one the participant is waiting
//! for (a replay, a stray) is ignored.
//!
//! Strict on input: at most [`MAX_PACKET`] bytes, JSON with exactly the expected fields, a known marker and version,
//! well-formed hex. Nothing else is ever in a packet — no Room Code, name, path, machine or user identity.

use serde::{Deserialize, Serialize};

use super::{DiscoveryTag, LAN_VERSION};

pub const MAX_PACKET: usize = 512;
const MARKER: &str = "omcollab-lan";

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "t", rename_all = "camelCase", deny_unknown_fields)]
pub enum Packet {
    Query {
        om: String,
        v: u32,
        /// The room's discovery tag.
        tag: String,
        /// 16 random bytes, hex; echoed by the answer.
        nonce: String,
    },
    Answer {
        om: String,
        v: u32,
        tag: String,
        nonce: String,
        /// The Owner's rendezvous port (TCP, on the address the answer came from).
        port: u16,
        /// The Owner's random per-run id (tells two Owners on one computer apart).
        instance: String,
        /// Seconds this answer stays valid.
        ttl: u32,
    },
}

fn is_hex(text: &str, len: usize) -> bool {
    text.len() == len
        && text
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

impl Packet {
    pub fn query(tag: &DiscoveryTag, nonce: &str) -> Self {
        Packet::Query {
            om: MARKER.into(),
            v: LAN_VERSION,
            tag: tag.to_string(),
            nonce: nonce.into(),
        }
    }

    pub fn answer(tag: &DiscoveryTag, nonce: &str, port: u16, instance: &str, ttl: u32) -> Self {
        Packet::Answer {
            om: MARKER.into(),
            v: LAN_VERSION,
            tag: tag.to_string(),
            nonce: nonce.into(),
            port,
            instance: instance.into(),
            ttl,
        }
    }

    pub fn encode(&self) -> Vec<u8> {
        serde_json::to_vec(self).unwrap_or_default()
    }

    /// Parses and checks a received datagram; `None` for anything that isn't exactly a valid packet.
    pub fn decode(bytes: &[u8]) -> Option<Self> {
        if bytes.is_empty() || bytes.len() > MAX_PACKET {
            return None;
        }
        let packet: Packet = serde_json::from_slice(bytes).ok()?;
        let valid = match &packet {
            Packet::Query { om, v, tag, nonce } => {
                om == MARKER && *v == LAN_VERSION && is_hex(tag, 32) && is_hex(nonce, 32)
            }
            Packet::Answer {
                om,
                v,
                tag,
                nonce,
                port,
                instance,
                ttl,
            } => {
                om == MARKER
                    && *v == LAN_VERSION
                    && is_hex(tag, 32)
                    && is_hex(nonce, 32)
                    && *port != 0
                    && is_hex(instance, 16)
                    && (1..=300).contains(ttl)
            }
        };
        valid.then_some(packet)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tag() -> DiscoveryTag {
        DiscoveryTag::for_topic("topic")
    }

    #[test]
    fn packets_round_trip_and_stay_small() {
        let nonce = "ab".repeat(16);
        let query = Packet::query(&tag(), &nonce);
        assert_eq!(Packet::decode(&query.encode()), Some(query.clone()));
        let answer = Packet::answer(&tag(), &nonce, 47732, &"cd".repeat(8), 30);
        let bytes = answer.encode();
        assert!(bytes.len() < MAX_PACKET);
        assert_eq!(Packet::decode(&bytes), Some(answer));
    }

    #[test]
    fn anything_else_is_dropped() {
        let nonce = "ab".repeat(16);
        let good = String::from_utf8(Packet::query(&tag(), &nonce).encode()).expect("utf8");
        let cases = [
            String::new(),
            "not json".into(),
            good.replace("omcollab-lan", "other"),
            good.replace("\"v\":1", "\"v\":2"),
            good.replace(&nonce, "short"),
            good.replace(tag().as_str(), &"Z".repeat(32)),
            good.replace('}', ",\"code\":\"OM-ABCD\"}"), // an extra field
            format!("{}{}", good, " ".repeat(MAX_PACKET)),
        ];
        for case in cases {
            assert_eq!(Packet::decode(case.as_bytes()), None, "{case}");
        }
        let zero_port = Packet::answer(&tag(), &nonce, 0, &"cd".repeat(8), 30);
        assert_eq!(Packet::decode(&zero_port.encode()), None);
        let forever = Packet::answer(&tag(), &nonce, 1, &"cd".repeat(8), 100_000);
        assert_eq!(Packet::decode(&forever.encode()), None);
    }
}
