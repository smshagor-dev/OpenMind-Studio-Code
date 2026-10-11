//! The relay's wire protocol, version 1: JSON text messages over a WebSocket.
//!
//! A room's Owner `host`s a topic (the value `openmind-collab` derives from the Room Code — the relay never sees the
//! code); a participant `join`s it and gets a slot. The relay then forwards `signal`s (SDP offers/answers, ICE
//! candidates, a goodbye) between the host and each participant, stamping who sent them. Slots are random per
//! connection and mean nothing outside it: they are not identities. Authentication happens later, between the two
//! peers, over the encrypted WebRTC connection.

use serde::{Deserialize, Serialize};

pub const SIGNAL_VERSION: u16 = 1;
/// Largest message the relay accepts (checked by the WebSocket layer and again here).
pub const MAX_MESSAGE_BYTES: usize = 64 * 1024;
pub const MAX_SDP_BYTES: usize = 48 * 1024;
pub const MAX_CANDIDATE_BYTES: usize = 1024;

fn is_lower_hex(text: &str, len: usize) -> bool {
    text.len() == len
        && text
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

macro_rules! hex_name {
    ($name:ident, $len:expr, $what:literal) => {
        #[derive(Debug, Clone, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
        #[serde(try_from = "String", into = "String")]
        pub struct $name(String);

        impl $name {
            pub fn parse(text: &str) -> Result<Self, String> {
                if is_lower_hex(text, $len) {
                    Ok(Self(text.to_string()))
                } else {
                    Err(format!("{} must be {} lowercase hex digits", $what, $len))
                }
            }

            pub fn as_str(&self) -> &str {
                &self.0
            }
        }

        impl TryFrom<String> for $name {
            type Error = String;
            fn try_from(text: String) -> Result<Self, Self::Error> {
                Self::parse(&text)
            }
        }

        impl From<$name> for String {
            fn from(value: $name) -> String {
                value.0
            }
        }

        impl std::fmt::Display for $name {
            fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
                f.write_str(&self.0)
            }
        }
    };
}

hex_name!(Topic, 64, "a topic");
hex_name!(Slot, 16, "a peer slot");
hex_name!(NegotiationId, 16, "a negotiation id");

impl Slot {
    /// A new random slot (8 bytes from the operating system's generator).
    pub fn random() -> Result<Self, String> {
        let mut bytes = [0u8; 8];
        getrandom::fill(&mut bytes).map_err(|err| err.to_string())?;
        Ok(Self(hex::encode(bytes)))
    }
}

impl NegotiationId {
    pub fn random() -> Result<Self, String> {
        let mut bytes = [0u8; 8];
        getrandom::fill(&mut bytes).map_err(|err| err.to_string())?;
        Ok(Self(hex::encode(bytes)))
    }
}

/// What one peer tells another through the relay.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum SignalKind {
    Offer {
        sdp: String,
    },
    Answer {
        sdp: String,
    },
    Candidate {
        candidate: String,
    },
    EndOfCandidates,
    /// The sender is abandoning this negotiation.
    Bye,
}

/// A signal with the sender's negotiation id (one per connection attempt) and a sequence number, so the receiver
/// can drop duplicates and signals of an older negotiation.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Signal {
    pub negotiation: NegotiationId,
    pub seq: u64,
    pub kind: SignalKind,
}

impl Signal {
    fn check(&self) -> Result<(), ErrorCode> {
        let too_big = match &self.kind {
            SignalKind::Offer { sdp } | SignalKind::Answer { sdp } => sdp.len() > MAX_SDP_BYTES,
            SignalKind::Candidate { candidate } => candidate.len() > MAX_CANDIDATE_BYTES,
            SignalKind::EndOfCandidates | SignalKind::Bye => false,
        };
        if too_big {
            Err(ErrorCode::TooLarge)
        } else {
            Ok(())
        }
    }
}

/// Client -> relay.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum ClientMessage {
    /// Register as the topic's host (the room's Owner).
    Host {
        v: u16,
        topic: Topic,
    },
    /// Join a hosted topic as a participant.
    Join {
        v: u16,
        topic: Topic,
    },
    Signal {
        to: Slot,
        signal: Signal,
    },
    /// Keeps a hosted topic from expiring while the Owner waits for participants.
    Renew,
    Leave,
}

impl ClientMessage {
    /// Parses and checks one received message.
    pub fn decode(text: &str) -> Result<Self, ErrorCode> {
        if text.len() > MAX_MESSAGE_BYTES {
            return Err(ErrorCode::TooLarge);
        }
        let message: ClientMessage =
            serde_json::from_str(text).map_err(|_| ErrorCode::Malformed)?;
        match &message {
            ClientMessage::Host { v, .. } | ClientMessage::Join { v, .. }
                if *v != SIGNAL_VERSION =>
            {
                Err(ErrorCode::UnsupportedVersion)
            }
            ClientMessage::Signal { signal, .. } => signal.check().map(|()| message),
            _ => Ok(message),
        }
    }

    pub fn encode(&self) -> String {
        serde_json::to_string(self).unwrap_or_default()
    }
}

/// Why the relay refused a message.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ErrorCode {
    Malformed,
    TooLarge,
    UnsupportedVersion,
    TopicTaken,
    NoHost,
    NotInTopic,
    UnknownPeer,
    AlreadyRegistered,
    TopicFull,
    RelayFull,
    RateLimited,
}

/// Relay -> client.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum RelayMessage {
    Hosted {
        slot: Slot,
        ttl_secs: u64,
    },
    Joined {
        slot: Slot,
        host: Slot,
    },
    /// A participant joined the host's topic.
    PeerArrived {
        slot: Slot,
    },
    Signal {
        from: Slot,
        signal: Signal,
    },
    PeerLeft {
        slot: Slot,
    },
    /// The topic was idle for its whole lifetime and is gone; host it again to be reachable.
    Expired,
    Error {
        code: ErrorCode,
    },
}

impl RelayMessage {
    pub fn encode(&self) -> String {
        serde_json::to_string(self).unwrap_or_default()
    }

    pub fn decode(text: &str) -> Result<Self, ErrorCode> {
        if text.len() > MAX_MESSAGE_BYTES {
            return Err(ErrorCode::TooLarge);
        }
        serde_json::from_str(text).map_err(|_| ErrorCode::Malformed)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn topic() -> String {
        "ab".repeat(32)
    }

    #[test]
    fn messages_round_trip() {
        let signal = Signal {
            negotiation: NegotiationId::random().expect("id"),
            seq: 3,
            kind: SignalKind::Candidate {
                candidate: "candidate:1 1 udp 1 127.0.0.1 9 typ host".into(),
            },
        };
        let message = ClientMessage::Signal {
            to: Slot::random().expect("slot"),
            signal,
        };
        assert_eq!(
            ClientMessage::decode(&message.encode()).expect("decode"),
            message
        );
        let host = format!(r#"{{"type":"host","v":1,"topic":"{}"}}"#, topic());
        assert!(matches!(
            ClientMessage::decode(&host),
            Ok(ClientMessage::Host { .. })
        ));
    }

    #[test]
    fn malformed_oversized_and_wrong_version_messages_are_refused() {
        for bad in [
            "not json".to_string(),
            r#"{"type":"host","v":1,"topic":"short"}"#.to_string(),
            r#"{"type":"host","v":1,"topic":"ZZ"}"#.to_string(),
            r#"{"type":"nonsense"}"#.to_string(),
            r#"{"type":"signal","to":"0011223344556677","signal":{"negotiation":"0011223344556677","seq":1,"kind":{"kind":"offer","sdp":"x"},"extra":1}}"#.to_string(),
        ] {
            assert_eq!(ClientMessage::decode(&bad), Err(ErrorCode::Malformed), "{bad}");
        }
        let old = format!(r#"{{"type":"join","v":9,"topic":"{}"}}"#, topic());
        assert_eq!(
            ClientMessage::decode(&old),
            Err(ErrorCode::UnsupportedVersion)
        );
        assert_eq!(
            ClientMessage::decode(&" ".repeat(MAX_MESSAGE_BYTES + 1)),
            Err(ErrorCode::TooLarge)
        );
        let big = ClientMessage::Signal {
            to: Slot::random().expect("slot"),
            signal: Signal {
                negotiation: NegotiationId::random().expect("id"),
                seq: 1,
                kind: SignalKind::Candidate {
                    candidate: "x".repeat(MAX_CANDIDATE_BYTES + 1),
                },
            },
        };
        assert_eq!(
            ClientMessage::decode(&big.encode()),
            Err(ErrorCode::TooLarge)
        );
    }
}
