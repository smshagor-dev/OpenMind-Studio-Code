//! A collaboration identity: an Ed25519 key pair per local profile. Its public key's hash is the peer's
//! [`PeerId`]; it is deliberately unrelated to the machine identity that picks the local profile (that one never
//! leaves the computer). Everything signed is prefixed with a context label, so a signature made for one purpose
//! can never be presented as another.
//!
//! The secret key's text form is only for the caller to protect (DPAPI in the app) — it is never logged and `Debug`
//! hides it.

use std::fmt;

use base64::engine::general_purpose::STANDARD as BASE64;
use base64::Engine as _;
use ed25519_dalek::{Signer as _, SigningKey, VerifyingKey};
use serde::{Deserialize, Serialize};

use crate::error::{invalid, CollabError};
use crate::ids::{random_bytes, PeerId};

fn contextual(context: &str, payload: &[u8]) -> Vec<u8> {
    let mut message = Vec::with_capacity(context.len() + payload.len() + 24);
    message.extend_from_slice(b"openmind-collab:v1:");
    message.extend_from_slice(context.as_bytes());
    message.push(b'\n');
    message.extend_from_slice(payload);
    message
}

/// A local identity (holds the secret key).
#[derive(Clone)]
pub struct PeerIdentity {
    key: SigningKey,
}

impl fmt::Debug for PeerIdentity {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "PeerIdentity({})", self.peer_id())
    }
}

impl PeerIdentity {
    /// A new identity from the operating system's random number generator.
    pub fn generate() -> Result<Self, CollabError> {
        Ok(Self {
            key: SigningKey::from_bytes(&random_bytes::<32>()?),
        })
    }

    /// Restores an identity from [`PeerIdentity::secret_text`].
    pub fn from_secret_text(text: &str) -> Result<Self, CollabError> {
        let bytes = BASE64
            .decode(text.trim())
            .map_err(|_| invalid("identity key", "not base64"))?;
        let seed: [u8; 32] = bytes
            .try_into()
            .map_err(|_| invalid("identity key", "expected 32 bytes"))?;
        Ok(Self {
            key: SigningKey::from_bytes(&seed),
        })
    }

    /// The secret key as text, for the caller to encrypt before storing.
    pub fn secret_text(&self) -> String {
        BASE64.encode(self.key.to_bytes())
    }

    pub fn public_key(&self) -> PublicKey {
        PublicKey(self.key.verifying_key().to_bytes())
    }

    pub fn peer_id(&self) -> PeerId {
        self.public_key().peer_id()
    }

    /// Signs `payload` for `context` (e.g. "join", "audit").
    pub fn sign(&self, context: &str, payload: &[u8]) -> Signature {
        Signature(self.key.sign(&contextual(context, payload)).to_bytes())
    }
}

/// A peer's public key (32 bytes; base64 on the wire).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(try_from = "String", into = "String")]
pub struct PublicKey([u8; 32]);

impl PublicKey {
    pub fn from_bytes(bytes: [u8; 32]) -> Result<Self, CollabError> {
        VerifyingKey::from_bytes(&bytes)
            .map_err(|_| invalid("public key", "not a valid Ed25519 point"))?;
        Ok(Self(bytes))
    }

    pub fn bytes(&self) -> &[u8; 32] {
        &self.0
    }

    pub fn peer_id(&self) -> PeerId {
        PeerId::of_key(&self.0)
    }

    pub fn to_text(&self) -> String {
        BASE64.encode(self.0)
    }

    pub fn parse(text: &str) -> Result<Self, CollabError> {
        let bytes = BASE64
            .decode(text)
            .map_err(|_| invalid("public key", "not base64"))?;
        let bytes: [u8; 32] = bytes
            .try_into()
            .map_err(|_| invalid("public key", "expected 32 bytes"))?;
        Self::from_bytes(bytes)
    }

    /// Checks `signature` over `payload` for `context`. Strict verification: malleable and small-order forms fail.
    pub fn verify(
        &self,
        context: &str,
        payload: &[u8],
        signature: &Signature,
    ) -> Result<(), CollabError> {
        let key = VerifyingKey::from_bytes(&self.0).map_err(|_| CollabError::BadSignature)?;
        let signature = ed25519_dalek::Signature::from_bytes(&signature.0);
        key.verify_strict(&contextual(context, payload), &signature)
            .map_err(|_| CollabError::BadSignature)
    }
}

impl TryFrom<String> for PublicKey {
    type Error = CollabError;
    fn try_from(text: String) -> Result<Self, Self::Error> {
        Self::parse(&text)
    }
}

impl From<PublicKey> for String {
    fn from(key: PublicKey) -> String {
        key.to_text()
    }
}

/// An Ed25519 signature (64 bytes; base64 on the wire).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(try_from = "String", into = "String")]
pub struct Signature([u8; 64]);

impl Signature {
    pub fn to_text(&self) -> String {
        BASE64.encode(self.0)
    }

    pub fn parse(text: &str) -> Result<Self, CollabError> {
        let bytes = BASE64
            .decode(text)
            .map_err(|_| invalid("signature", "not base64"))?;
        let bytes: [u8; 64] = bytes
            .try_into()
            .map_err(|_| invalid("signature", "expected 64 bytes"))?;
        Ok(Self(bytes))
    }
}

impl TryFrom<String> for Signature {
    type Error = CollabError;
    fn try_from(text: String) -> Result<Self, Self::Error> {
        Self::parse(&text)
    }
}

impl From<Signature> for String {
    fn from(signature: Signature) -> String {
        signature.to_text()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn signatures_verify_only_for_their_key_context_and_payload() {
        let me = PeerIdentity::generate().expect("identity");
        let other = PeerIdentity::generate().expect("identity");
        let sig = me.sign("join", b"payload");
        assert!(me.public_key().verify("join", b"payload", &sig).is_ok());
        assert_eq!(
            me.public_key().verify("audit", b"payload", &sig),
            Err(CollabError::BadSignature)
        );
        assert!(me.public_key().verify("join", b"payloaD", &sig).is_err());
        assert!(other.public_key().verify("join", b"payload", &sig).is_err());
    }

    #[test]
    fn the_secret_round_trips_and_is_hidden_from_debug() {
        let me = PeerIdentity::generate().expect("identity");
        let text = me.secret_text();
        let back = PeerIdentity::from_secret_text(&text).expect("restore");
        assert_eq!(back.peer_id(), me.peer_id());
        assert!(!format!("{me:?}").contains(&text));
        assert!(PeerIdentity::from_secret_text("short").is_err());
    }

    #[test]
    fn public_keys_and_signatures_parse_strictly() {
        let me = PeerIdentity::generate().expect("identity");
        let key = me.public_key();
        assert_eq!(PublicKey::parse(&key.to_text()).expect("parse"), key);
        assert!(PublicKey::parse("AAAA").is_err());
        assert!(Signature::parse(&BASE64.encode([0u8; 63])).is_err());
        assert_eq!(key.peer_id(), me.peer_id());
    }
}
