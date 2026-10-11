//! Room Codes: the shareable invitation credential, e.g. `OM-7K3D-9QPF-M2XR-V6TW-8H`.
//!
//! 22 characters of Crockford base32 (no I, L, O, U), each from one random byte masked to 5 bits (256 is a multiple
//! of 32, so every character is uniform): 110 random bits. Uniqueness is by randomness alone — there is no central
//! registry to ask — and at 110 bits a collision or a guess is out of reach.
//!
//! Three separate values are derived from a code (domain-separated SHA-256), so no party ever needs more than its
//! own: the **invite hash** the Owner stores and compares, the **proof key** a joining peer uses to prove it knows
//! the code (HMAC over the Owner's fresh challenge — the code itself never travels), and the **signaling topic**
//! the relay sees (it can neither recover the code nor forge a proof from it). The room's permanent identity is its
//! [`crate::RoomUid`]; rotating the code changes all three values and leaves the room as it is.

use std::fmt;

use sha2::{Digest, Sha256};
use subtle::ConstantTimeEq;

use crate::error::{invalid, CollabError};
use crate::hmac::hmac_sha256;
use crate::ids::{random_bytes, PeerId, RoomUid};

const ALPHABET: &[u8; 32] = b"0123456789ABCDEFGHJKMNPQRSTVWXYZ";
/// Characters after the `OM-` prefix.
pub const CODE_CHARS: usize = 22;
const GROUPS: [usize; 6] = [4, 4, 4, 4, 4, 2];

/// A Room Code. Its `Debug` output hides the code (it is a credential and must not reach a log).
#[derive(Clone, PartialEq, Eq)]
pub struct RoomCode {
    body: String,
}

impl fmt::Debug for RoomCode {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("RoomCode(****)")
    }
}

impl RoomCode {
    /// A new random code.
    pub fn generate() -> Result<Self, CollabError> {
        let bytes = random_bytes::<CODE_CHARS>()?;
        let body = bytes
            .iter()
            .map(|b| ALPHABET[usize::from(b & 31)] as char)
            .collect();
        Ok(Self { body })
    }

    /// Reads a code as people type it: case, spaces and dashes don't matter, the `OM` prefix is optional, and the
    /// look-alikes Crockford allows are read as their digit (I/L -> 1, O -> 0).
    pub fn parse(text: &str) -> Result<Self, CollabError> {
        let cleaned: String = text
            .chars()
            .filter(|c| !c.is_whitespace() && *c != '-')
            .map(|c| c.to_ascii_uppercase())
            .collect();
        // "OM" followed by a separator is always the prefix; without one, only when it makes the length right.
        let upper = text.trim_start().to_ascii_uppercase();
        let marked = upper.starts_with("OM-") || upper.starts_with("OM ");
        let body = match cleaned.strip_prefix("OM") {
            Some(rest) if marked || cleaned.len() == CODE_CHARS + 2 => rest,
            _ => cleaned.as_str(),
        };
        if body.chars().count() != CODE_CHARS {
            return Err(invalid(
                "Room Code",
                format!("a code has {CODE_CHARS} characters after \"OM-\""),
            ));
        }
        let mut normalized = String::with_capacity(CODE_CHARS);
        for c in body.chars() {
            let c = match c {
                'I' | 'L' => '1',
                'O' => '0',
                other => other,
            };
            if !ALPHABET.contains(&(c as u8)) || !c.is_ascii() {
                return Err(invalid(
                    "Room Code",
                    "it contains a character codes never use",
                ));
            }
            normalized.push(c);
        }
        Ok(Self { body: normalized })
    }

    /// The code as it is shown and shared: `OM-XXXX-XXXX-XXXX-XXXX-XXXX-XX`.
    pub fn display(&self) -> String {
        let mut out = String::from("OM");
        let mut rest = self.body.as_str();
        for len in GROUPS {
            let (group, tail) = rest.split_at(len);
            out.push('-');
            out.push_str(group);
            rest = tail;
        }
        out
    }

    fn derive(&self, label: &str) -> [u8; 32] {
        let mut hasher = Sha256::new();
        hasher.update(b"openmind-collab:v1:");
        hasher.update(label.as_bytes());
        hasher.update(b"\n");
        hasher.update(self.body.as_bytes());
        hasher.finalize().into()
    }

    /// The value the Owner stores and compares (never the code itself in clear).
    pub fn invite_hash(&self) -> String {
        hex::encode(self.derive("invite-hash"))
    }

    /// The topic the signaling relay sees for this room. Reveals nothing usable about the code.
    pub fn signaling_topic(&self) -> String {
        hex::encode(self.derive("signaling-topic"))
    }

    /// The join proof for `challenge` (hex) by `peer` into `room`: HMAC-SHA-256 under a key derived from the code.
    pub fn join_proof(&self, room: &RoomUid, peer: &PeerId, challenge: &str) -> String {
        let key = self.derive("join-proof-key");
        let message = format!("join\n{room}\n{peer}\n{challenge}");
        hex::encode(hmac_sha256(&key, message.as_bytes()))
    }

    /// Whether `proof` is this code's join proof (constant-time comparison).
    pub fn verify_join_proof(
        &self,
        room: &RoomUid,
        peer: &PeerId,
        challenge: &str,
        proof: &str,
    ) -> bool {
        let expected = self.join_proof(room, peer, challenge);
        expected.len() == proof.len() && bool::from(expected.as_bytes().ct_eq(proof.as_bytes()))
    }

    /// The Owner's proof that it knows the code, for a (bound) `challenge`: lets a joining peer tell the real Owner
    /// from a relay or anyone else who only knows the signaling topic. Separate from the join proof by its label.
    pub fn owner_proof(&self, room: &RoomUid, owner: &PeerId, challenge: &str) -> String {
        let key = self.derive("join-proof-key");
        let message = format!(
            "owner
{room}
{owner}
{challenge}"
        );
        hex::encode(hmac_sha256(&key, message.as_bytes()))
    }

    /// Whether `proof` is this code's Owner proof (constant-time comparison).
    pub fn verify_owner_proof(
        &self,
        room: &RoomUid,
        owner: &PeerId,
        challenge: &str,
        proof: &str,
    ) -> bool {
        let expected = self.owner_proof(room, owner, challenge);
        expected.len() == proof.len() && bool::from(expected.as_bytes().ct_eq(proof.as_bytes()))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn generated_codes_have_the_documented_shape_and_differ() {
        let a = RoomCode::generate().expect("code");
        let shown = a.display();
        assert_eq!(shown.len(), 2 + CODE_CHARS + GROUPS.len());
        assert!(shown.starts_with("OM-"));
        let others: std::collections::HashSet<String> = (0..2000)
            .map(|_| RoomCode::generate().expect("code").display())
            .collect();
        assert_eq!(others.len(), 2000, "2000 codes must all differ");
    }

    #[test]
    fn every_alphabet_character_appears_over_many_codes() {
        let mut seen = std::collections::HashSet::new();
        for _ in 0..200 {
            seen.extend(RoomCode::generate().expect("code").body.chars());
        }
        assert_eq!(seen.len(), 32);
    }

    #[test]
    fn typed_codes_are_normalized() {
        let code = RoomCode::generate().expect("code");
        let shown = code.display();
        assert_eq!(RoomCode::parse(&shown).expect("parse"), code);
        assert_eq!(RoomCode::parse(&shown.to_lowercase()).expect("parse"), code);
        let spaced = shown.replace('-', "  ");
        assert_eq!(RoomCode::parse(&spaced).expect("parse"), code);
        let bare = &shown.replace('-', "")[2..];
        assert_eq!(RoomCode::parse(bare).expect("parse"), code);
        let looks = RoomCode::parse("OM-IL00-0000-0000-0000-0000-00").expect("parse");
        assert_eq!(looks.display(), "OM-1100-0000-0000-0000-0000-00");
    }

    #[test]
    fn malformed_codes_are_refused() {
        for bad in [
            "",
            "OM-",
            "OM-7K3D",
            "OM-7K3D-9QPF-M2XR-V6TW-8H-XX",
            "OM-U000-0000-0000-0000-0000-00",
            "OM-ÄÄÄÄ-0000-0000-0000-0000-00",
        ] {
            assert!(RoomCode::parse(bad).is_err(), "{bad}");
        }
    }

    #[test]
    fn the_debug_form_never_prints_the_code() {
        let code = RoomCode::generate().expect("code");
        assert!(!format!("{code:?}").contains(&code.body));
    }

    #[test]
    fn derived_values_are_separate() {
        let code = RoomCode::generate().expect("code");
        assert_ne!(code.invite_hash(), code.signaling_topic());
        assert!(!code.invite_hash().contains(&code.body));
        let other = RoomCode::generate().expect("code");
        assert_ne!(code.invite_hash(), other.invite_hash());
    }

    #[test]
    fn a_join_proof_is_bound_to_room_peer_challenge_and_code() {
        let code = RoomCode::generate().expect("code");
        let room = RoomUid::random().expect("room");
        let peer = PeerId::of_key(&[7; 32]);
        let proof = code.join_proof(&room, &peer, "aa");
        assert!(code.verify_join_proof(&room, &peer, "aa", &proof));
        assert!(!code.verify_join_proof(&room, &peer, "ab", &proof));
        assert!(!code.verify_join_proof(&room, &PeerId::of_key(&[8; 32]), "aa", &proof));
        let other_room = RoomUid::random().expect("room");
        assert!(!code.verify_join_proof(&other_room, &peer, "aa", &proof));
        let rotated = RoomCode::generate().expect("code");
        assert!(!rotated.verify_join_proof(&room, &peer, "aa", &proof));
        assert!(!code.verify_join_proof(&room, &peer, "aa", ""));
    }
}
