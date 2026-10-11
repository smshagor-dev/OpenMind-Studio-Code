//! Identifiers. Random ones come straight from the operating system's generator (`getrandom`); none is sequential
//! or derived from a clock, so nothing about one tells anything about another. All travel and are stored as
//! lowercase hex, and a received one is checked for its exact length on deserialization — a malformed id never
//! reaches the authority.

use std::fmt;

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::error::{invalid, CollabError};

/// `N` bytes from the operating system's random number generator.
pub fn random_bytes<const N: usize>() -> Result<[u8; N], CollabError> {
    let mut bytes = [0u8; N];
    getrandom::fill(&mut bytes).map_err(|err| CollabError::Random(err.to_string()))?;
    Ok(bytes)
}

fn parse_hex(what: &'static str, text: &str, len: usize) -> Result<String, CollabError> {
    if text.len() != len * 2 {
        return Err(invalid(what, format!("expected {} hex digits", len * 2)));
    }
    if !text
        .bytes()
        .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
    {
        return Err(invalid(what, "expected lowercase hex digits"));
    }
    Ok(text.to_string())
}

macro_rules! hex_id {
    ($(#[$doc:meta])* $name:ident, $what:literal, $len:expr) => {
        $(#[$doc])*
        #[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
        #[serde(try_from = "String", into = "String")]
        pub struct $name(String);

        impl $name {
            pub const BYTES: usize = $len;

            /// A new random id.
            pub fn random() -> Result<Self, CollabError> {
                Ok(Self(hex::encode(random_bytes::<$len>()?)))
            }

            /// Parses a received or stored id (exact length, lowercase hex).
            pub fn parse(text: &str) -> Result<Self, CollabError> {
                parse_hex($what, text, $len).map(Self)
            }

            pub fn as_str(&self) -> &str {
                &self.0
            }
        }

        impl TryFrom<String> for $name {
            type Error = CollabError;
            fn try_from(text: String) -> Result<Self, Self::Error> {
                Self::parse(&text)
            }
        }

        impl From<$name> for String {
            fn from(id: $name) -> String {
                id.0
            }
        }

        impl fmt::Display for $name {
            fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
                f.write_str(&self.0)
            }
        }
    };
}

hex_id!(
    /// A room's permanent identity. Never changes, unlike its Room Code (which can be rotated).
    RoomUid, "room id", 16
);
hex_id!(
    /// One authenticated connection of one peer to a room. A new connection gets a new one; frames carrying an
    /// older one are refused.
    SessionId, "session id", 16
);
hex_id!(
    /// One message, unique across sessions: duplicate deliveries and outbox resends are recognised by it.
    MessageId, "message id", 16
);
hex_id!(
    /// A one-time value the Owner sends a connecting peer; the peer signs it (and, to join, proves the Room Code
    /// over it), so an answer recorded earlier is useless on a new connection.
    Challenge, "challenge", 32
);
hex_id!(
    /// One file transfer, chosen by the requesting participant (unique among its active transfers).
    TransferId, "transfer id", 16
);
hex_id!(
    /// A file or folder shared in a room. The Owner maps it to a validated relative path
    /// ([`crate::files::FileTable`]); a remote peer never names a path to touch an existing entry.
    FileId, "file id", 16
);
hex_id!(
    /// A peer: the SHA-256 of its Ed25519 public key ([`PeerId::of_key`]). Display names are not identities.
    PeerId, "peer id", 32
);

impl PeerId {
    /// The peer id of a public key's raw 32 bytes.
    pub fn of_key(public_key: &[u8; 32]) -> Self {
        let mut hasher = Sha256::new();
        hasher.update(b"openmind-collab:v1:peer\n");
        hasher.update(public_key);
        Self(hex::encode(hasher.finalize()))
    }

    /// A short form people can compare by eye ("3f2a 9c01 77b4 e5d0").
    pub fn fingerprint(&self) -> String {
        self.0.as_bytes()[..16]
            .chunks(4)
            .map(|chunk| String::from_utf8_lossy(chunk).into_owned())
            .collect::<Vec<_>>()
            .join(" ")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn random_ids_differ_and_round_trip() {
        let a = RoomUid::random().expect("random");
        let b = RoomUid::random().expect("random");
        assert_ne!(a, b);
        assert_eq!(a.as_str().len(), 32);
        let json = serde_json::to_string(&a).expect("serialize");
        let back: RoomUid = serde_json::from_str(&json).expect("deserialize");
        assert_eq!(a, back);
    }

    #[test]
    fn malformed_ids_are_refused_when_received() {
        for bad in [
            "\"\"",
            "\"abc\"",
            "\"ABCDEF0123456789ABCDEF0123456789\"",
            "\"zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz\"",
            "\"0123456789abcdef0123456789abcdef00\"",
            "\"../../../etc/passwd/aaaaaaaaaaaaaa\"",
        ] {
            assert!(serde_json::from_str::<SessionId>(bad).is_err(), "{bad}");
        }
    }

    #[test]
    fn a_peer_id_is_bound_to_its_key() {
        let a = PeerId::of_key(&[1; 32]);
        assert_eq!(a, PeerId::of_key(&[1; 32]));
        assert_ne!(a, PeerId::of_key(&[2; 32]));
        assert_eq!(a.fingerprint().len(), 19);
    }
}
