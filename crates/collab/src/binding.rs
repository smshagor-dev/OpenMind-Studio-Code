//! Binding the room handshake to the encrypted WebRTC connection it runs on.
//!
//! The signaling relay forwards the SDP, so a hostile relay could put its own DTLS endpoint between a participant
//! and the Owner and pass the handshake through. To make that useless, both sides replace the Owner's raw
//! challenge with a *bound* challenge: `SHA-256(challenge + both DTLS fingerprints, sorted)`, computed from what
//! each side sees on its own connection. Every proof and signature of the handshake is made over the bound value,
//! so a relay in the middle (which sees two different connections) produces proofs that never verify.
//!
//! In the other direction the participant checks the Owner: on a first join the Owner must prove the Room Code
//! (an HMAC the relay can't make, since it never sees the code) and sign with its key; on a reconnect the Owner's
//! key must be the one pinned at the first join.

use sha2::{Digest, Sha256};

use crate::code::RoomCode;
use crate::error::{invalid, CollabError};
use crate::identity::{PeerIdentity, PublicKey};
use crate::ids::{Challenge, RoomUid};
use crate::protocol::{Handshake, PROTOCOL_VERSION};

/// The challenge bound to the connection's two DTLS fingerprints (order doesn't matter).
pub fn bind_challenge(
    challenge: &Challenge,
    fingerprint_a: &str,
    fingerprint_b: &str,
) -> Challenge {
    let (low, high) = if fingerprint_a <= fingerprint_b {
        (fingerprint_a, fingerprint_b)
    } else {
        (fingerprint_b, fingerprint_a)
    };
    let mut hasher = Sha256::new();
    hasher.update(b"openmind-collab:v1:binding\n");
    hasher.update(challenge.as_str().as_bytes());
    hasher.update(b"\n");
    hasher.update(low.as_bytes());
    hasher.update(b"\n");
    hasher.update(high.as_bytes());
    // A SHA-256 is 32 bytes of hex: always a valid `Challenge`.
    Challenge::parse(&hex::encode(hasher.finalize())).unwrap_or_else(|_| challenge.clone())
}

fn hello_payload(room: &RoomUid, bound: &Challenge) -> Vec<u8> {
    format!("{room}\n{bound}").into_bytes()
}

/// The Owner's first message on a new connection.
pub fn owner_hello(
    host: &PeerIdentity,
    code: &RoomCode,
    room: &RoomUid,
    challenge: &Challenge,
    bound: &Challenge,
) -> Handshake {
    Handshake::Challenge {
        v: PROTOCOL_VERSION,
        room: room.clone(),
        owner_key: host.public_key(),
        challenge: challenge.clone(),
        owner_proof: code.owner_proof(room, &host.peer_id(), bound.as_str()),
        signature: host.sign("challenge", &hello_payload(room, bound)),
    }
}

/// What a participant learned from a verified Owner hello.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct VerifiedOwner {
    pub room: RoomUid,
    pub owner_key: PublicKey,
    /// The bound challenge to answer with.
    pub bound: Challenge,
}

/// Checks the Owner's hello as a participant. `code` is required for a first join; `pinned` is the Owner key
/// recorded at the first join (a reconnect must match it). `fingerprints` are this side's view of the connection.
pub fn verify_owner_hello(
    hello: &Handshake,
    expected_room: Option<&RoomUid>,
    code: Option<&RoomCode>,
    pinned: Option<&PublicKey>,
    fingerprints: (&str, &str),
) -> Result<VerifiedOwner, CollabError> {
    let Handshake::Challenge {
        v,
        room,
        owner_key,
        challenge,
        owner_proof,
        signature,
    } = hello
    else {
        return Err(invalid("handshake", "expected the Owner's challenge"));
    };
    if *v != PROTOCOL_VERSION {
        return Err(invalid(
            "handshake",
            format!("protocol version {v} isn't supported"),
        ));
    }
    if expected_room.is_some_and(|expected| expected != room) {
        return Err(invalid(
            "handshake",
            "this connection belongs to another room",
        ));
    }
    if pinned.is_some_and(|key| key != owner_key) {
        return Err(invalid(
            "handshake",
            "the Owner's key changed since you joined; refusing",
        ));
    }
    if code.is_none() && pinned.is_none() {
        return Err(invalid("handshake", "a first join needs the Room Code"));
    }
    let bound = bind_challenge(challenge, fingerprints.0, fingerprints.1);
    owner_key.verify("challenge", &hello_payload(room, &bound), signature)?;
    if let Some(code) = code {
        if !code.verify_owner_proof(room, &owner_key.peer_id(), bound.as_str(), owner_proof) {
            return Err(invalid(
                "handshake",
                "the other side doesn't know this Room Code (not the Owner)",
            ));
        }
    }
    Ok(VerifiedOwner {
        room: room.clone(),
        owner_key: *owner_key,
        bound,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    struct Setup {
        host: PeerIdentity,
        code: RoomCode,
        room: RoomUid,
        challenge: Challenge,
    }

    fn setup() -> Setup {
        Setup {
            host: PeerIdentity::generate().expect("identity"),
            code: RoomCode::generate().expect("code"),
            room: RoomUid::random().expect("room"),
            challenge: Challenge::random().expect("challenge"),
        }
    }

    #[test]
    fn binding_is_order_independent_and_fingerprint_sensitive() {
        let c = Challenge::random().expect("challenge");
        assert_eq!(
            bind_challenge(&c, "sha-256 AA", "sha-256 BB"),
            bind_challenge(&c, "sha-256 BB", "sha-256 AA")
        );
        assert_ne!(
            bind_challenge(&c, "sha-256 AA", "sha-256 BB"),
            bind_challenge(&c, "sha-256 AA", "sha-256 CC")
        );
        assert_ne!(bind_challenge(&c, "a", "b"), c);
    }

    #[test]
    fn a_participant_accepts_the_real_owner_on_the_same_connection() {
        let s = setup();
        let bound = bind_challenge(&s.challenge, "owner-fp", "peer-fp");
        let hello = owner_hello(&s.host, &s.code, &s.room, &s.challenge, &bound);
        let ok = verify_owner_hello(&hello, None, Some(&s.code), None, ("peer-fp", "owner-fp"))
            .expect("verified");
        assert_eq!(ok.bound, bound);
        assert_eq!(ok.owner_key, s.host.public_key());
        let again = verify_owner_hello(
            &hello,
            Some(&s.room),
            None,
            Some(&s.host.public_key()),
            ("owner-fp", "peer-fp"),
        );
        assert!(again.is_ok(), "a reconnect checks the pinned key");
    }

    #[test]
    fn a_relay_in_the_middle_or_without_the_code_is_refused() {
        let s = setup();
        // The Owner's view of its connection (to the relay) differs from the participant's (to the relay).
        let owner_bound = bind_challenge(&s.challenge, "owner-fp", "relay-fp-1");
        let hello = owner_hello(&s.host, &s.code, &s.room, &s.challenge, &owner_bound);
        assert!(
            verify_owner_hello(&hello, None, Some(&s.code), None, ("peer-fp", "relay-fp-2"))
                .is_err()
        );
        // A relay that answers itself knows the topic but not the code.
        let impostor = PeerIdentity::generate().expect("identity");
        let guess = RoomCode::generate().expect("code");
        let bound = bind_challenge(&s.challenge, "a", "b");
        let fake = owner_hello(&impostor, &guess, &s.room, &s.challenge, &bound);
        assert!(verify_owner_hello(&fake, None, Some(&s.code), None, ("a", "b")).is_err());
        // A different key on reconnect is refused.
        let real = owner_hello(&s.host, &s.code, &s.room, &s.challenge, &bound);
        assert!(
            verify_owner_hello(&real, None, None, Some(&impostor.public_key()), ("a", "b"))
                .is_err()
        );
        assert!(
            verify_owner_hello(&real, None, None, None, ("a", "b")).is_err(),
            "no code and no pin"
        );
        let other_room = RoomUid::random().expect("room");
        assert!(
            verify_owner_hello(&real, Some(&other_room), Some(&s.code), None, ("a", "b")).is_err()
        );
    }
}
