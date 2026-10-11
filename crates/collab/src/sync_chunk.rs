//! Bounded chunking for `openmind-sync` messages too large for one data channel message (a big paste, the first sync
//! of a large document). The sender encodes the message, and if it is larger than [`CHUNK_BYTES`] sends it as
//! `SyncChunk`s that each fit; the receiver ([`Reassembler`]) checks every piece (its transfer, index, count, size),
//! refuses duplicates and gaps, keeps at most [`MAX_ASSEMBLIES`] messages in progress per sender within
//! [`MAX_MESSAGE_BYTES`] each, verifies the SHA-256 of the whole, and only then decodes it as a `openmind-sync` message
//! (never another chunk). A connection that ends drops its unfinished pieces with it.

use std::collections::HashMap;

use crate::error::{invalid, CollabError};
use crate::ids::TransferId;
use crate::protocol::{Body, Bytes, Channel};
use crate::transfer::sha256_hex;

/// Data per chunk (base64 in a frame: about 64 KB, well inside the data channel limit).
pub const CHUNK_BYTES: usize = 48 * 1024;
/// Largest message rebuilt from chunks (a document sync with base64 inside its JSON).
pub const MAX_MESSAGE_BYTES: usize = crate::crdt::MAX_SYNC_BYTES / 3 * 4 + 64 * 1024;
pub const MAX_CHUNKS: usize = MAX_MESSAGE_BYTES.div_ceil(CHUNK_BYTES);
/// Messages one sender may have half sent at once.
pub const MAX_ASSEMBLIES: usize = 4;

/// The bodies to send for `body`: itself when it fits one message, else its chunks.
pub fn split(body: Body) -> Result<Vec<Body>, CollabError> {
    let encoded = serde_json::to_vec(&body).map_err(|e| invalid("sync message", e.to_string()))?;
    if encoded.len() <= CHUNK_BYTES {
        return Ok(vec![body]);
    }
    if body.channel() != Channel::Sync
        || matches!(body, Body::SyncChunk { .. })
        || encoded.len() > MAX_MESSAGE_BYTES
    {
        return Err(invalid("sync message", "too large to send"));
    }
    let id = TransferId::random()?;
    let sha256 = sha256_hex(&encoded);
    let count = u32::try_from(encoded.len().div_ceil(CHUNK_BYTES))
        .map_err(|_| invalid("sync message", "too large"))?;
    Ok(encoded
        .chunks(CHUNK_BYTES)
        .enumerate()
        .map(|(index, data)| Body::SyncChunk {
            id: id.clone(),
            index: index as u32,
            count,
            sha256: sha256.clone(),
            data: Bytes(data.to_vec()),
        })
        .collect())
}

struct Assembly {
    count: u32,
    sha256: String,
    next: u32,
    bytes: Vec<u8>,
}

/// One sender's messages being rebuilt.
#[derive(Default)]
pub struct Reassembler {
    pending: HashMap<TransferId, Assembly>,
}

impl Reassembler {
    /// Adds a chunk; `Ok(Some(body))` when it completed a message. Any error drops that message's pieces.
    pub fn add(
        &mut self,
        id: TransferId,
        index: u32,
        count: u32,
        sha256: String,
        data: Vec<u8>,
    ) -> Result<Option<Body>, CollabError> {
        let result = self.add_inner(&id, index, count, sha256, data);
        if !matches!(result, Ok(None)) {
            self.pending.remove(&id);
        }
        result
    }

    fn add_inner(
        &mut self,
        id: &TransferId,
        index: u32,
        count: u32,
        sha256: String,
        data: Vec<u8>,
    ) -> Result<Option<Body>, CollabError> {
        if count as usize > MAX_CHUNKS || data.len() > CHUNK_BYTES || count == 0 {
            return Err(invalid("sync chunk", "out of bounds"));
        }
        if !self.pending.contains_key(id) {
            if index != 0 {
                return Err(invalid(
                    "sync chunk",
                    "a message must start with its first piece",
                ));
            }
            if self.pending.len() >= MAX_ASSEMBLIES {
                return Err(invalid("sync chunk", "too many messages in progress"));
            }
            self.pending.insert(
                id.clone(),
                Assembly {
                    count,
                    sha256: sha256.clone(),
                    next: 0,
                    bytes: Vec::new(),
                },
            );
        }
        let assembly = self
            .pending
            .get_mut(id)
            .ok_or_else(|| invalid("sync chunk", "unknown"))?;
        if index != assembly.next || count != assembly.count || sha256 != assembly.sha256 {
            return Err(invalid(
                "sync chunk",
                "a piece is missing, repeated or inconsistent",
            ));
        }
        if assembly.bytes.len() + data.len() > MAX_MESSAGE_BYTES {
            return Err(invalid("sync chunk", "the message is too large"));
        }
        assembly.bytes.extend_from_slice(&data);
        assembly.next += 1;
        if assembly.next < assembly.count {
            return Ok(None);
        }
        if sha256_hex(&assembly.bytes) != assembly.sha256 {
            return Err(invalid(
                "sync chunk",
                "the rebuilt message doesn't match its checksum",
            ));
        }
        let body: Body = serde_json::from_slice(&assembly.bytes)
            .map_err(|e| invalid("sync message", e.to_string()))?;
        if body.channel() != Channel::Sync || matches!(body, Body::SyncChunk { .. }) {
            return Err(invalid(
                "sync message",
                "only a sync message can be sent in pieces",
            ));
        }
        body.validate_inner()?;
        Ok(Some(body))
    }

    pub fn in_progress(&self) -> usize {
        self.pending.len()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ids::{FileId, MessageId};

    fn big_update(len: usize) -> Body {
        Body::YjsUpdate {
            file: FileId::random().expect("id"),
            id: MessageId::random().expect("id"),
            update: Bytes((0..len).map(|i| (i % 251) as u8).collect()),
        }
    }

    fn parts(body: Body) -> Vec<(TransferId, u32, u32, String, Vec<u8>)> {
        split(body)
            .expect("split")
            .into_iter()
            .map(|b| match b {
                Body::SyncChunk {
                    id,
                    index,
                    count,
                    sha256,
                    data,
                } => (id, index, count, sha256, data.0),
                other => panic!("not a chunk: {other:?}"),
            })
            .collect()
    }

    #[test]
    fn small_messages_go_whole_and_large_ones_rebuild_exactly() {
        let small = big_update(100);
        assert_eq!(split(small.clone()).expect("split"), vec![small]);
        let large = big_update(400_000);
        let pieces = parts(large.clone());
        assert!(pieces.len() > 5);
        let mut reassembler = Reassembler::default();
        let mut done = None;
        for (id, index, count, sha, data) in pieces {
            done = reassembler.add(id, index, count, sha, data).expect("piece");
        }
        assert_eq!(done, Some(large));
        assert_eq!(reassembler.in_progress(), 0);
    }

    #[test]
    fn gaps_repeats_tampering_and_floods_are_refused() {
        let pieces = parts(big_update(200_000));
        let mut r = Reassembler::default();
        let (id, _, count, sha, _) = pieces[1].clone();
        assert!(
            r.add(id, 1, count, sha, vec![1]).is_err(),
            "can't start in the middle"
        );
        let mut r = Reassembler::default();
        let p = pieces.clone();
        r.add(p[0].0.clone(), 0, p[0].2, p[0].3.clone(), p[0].4.clone())
            .expect("first");
        assert!(
            r.add(p[0].0.clone(), 0, p[0].2, p[0].3.clone(), p[0].4.clone())
                .is_err(),
            "repeat"
        );
        assert_eq!(r.in_progress(), 0, "a broken message is dropped");
        let mut r = Reassembler::default();
        let last = pieces.len() - 1;
        for (i, (id, index, count, sha, mut data)) in pieces.into_iter().enumerate() {
            if i == last {
                data[0] ^= 1; // tampered
            }
            let result = r.add(id, index, count, sha, data);
            if i == last {
                assert!(result.is_err(), "checksum");
            }
        }
        let mut r = Reassembler::default();
        for _ in 0..MAX_ASSEMBLIES {
            let p = parts(big_update(100_000));
            r.add(p[0].0.clone(), 0, p[0].2, p[0].3.clone(), p[0].4.clone())
                .expect("start");
        }
        let p = parts(big_update(100_000));
        assert!(
            r.add(p[0].0.clone(), 0, p[0].2, p[0].3.clone(), p[0].4.clone())
                .is_err(),
            "too many at once"
        );
    }

    #[test]
    fn a_chunk_can_not_carry_another_kind_of_message() {
        let control = Body::Leave;
        let encoded = serde_json::to_vec(&control).expect("json");
        let sha = sha256_hex(&encoded);
        let mut r = Reassembler::default();
        assert!(r
            .add(TransferId::random().expect("id"), 0, 1, sha, encoded)
            .is_err());
    }
}
