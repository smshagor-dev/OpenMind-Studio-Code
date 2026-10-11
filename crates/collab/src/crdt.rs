//! One collaborative text document (Milestone 24, phase 6): a `yrs` document — wire-compatible with Yjs — holding the
//! file's text in the root text type [`TEXT_NAME`], indexed in UTF-16 code units exactly like JavaScript strings, so a
//! position means the same thing in Monaco, Yjs and here.
//!
//! Every way in is checked and none can panic the caller: an update must decode, stay within [`MAX_UPDATE_BYTES`],
//! depend only on what the document already has (no "pending" data: such an update is refused before it is applied),
//! and leave the text within [`MAX_TEXT_UNITS`]. `yrs` itself is called behind `catch_unwind`; if it ever panicked or
//! left pending data, the document is reported [`CrdtError::Poisoned`] and its owner reloads it from storage (the
//! update that caused it was never persisted).

use std::panic::{catch_unwind, AssertUnwindSafe};

use yrs::updates::decoder::Decode;
use yrs::updates::encoder::Encode;
use yrs::{
    Doc, GetString, OffsetKind, Options, ReadTxn, StateVector, Text, TextRef, Transact, Update,
};

use crate::protocol::MAX_UPDATE_BYTES;

/// The name of the shared text type (the frontend uses `doc.getText("content")`).
pub const TEXT_NAME: &str = "content";
/// Largest collaboratively edited text, in UTF-16 code units (about 1 MB of source). Bigger files stay read-only
/// snapshots (Phase 5): one edit of such a file could exceed what one update may carry.
pub const MAX_TEXT_UNITS: usize = 1024 * 1024;
/// Largest initial sync (a whole document with its history; always sent in chunks).
pub const MAX_SYNC_BYTES: usize = 8 * 1024 * 1024;

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum CrdtError {
    #[error("the update is malformed")]
    Malformed,
    #[error("the update is too large")]
    TooLarge,
    #[error("the update depends on changes this document doesn't have")]
    Missing,
    #[error("the document would become too large")]
    TextTooLarge,
    #[error("the state vector is malformed")]
    BadStateVector,
    #[error("the document is in an inconsistent state and must be reloaded")]
    Poisoned,
}

pub struct CollabDoc {
    doc: Doc,
    text: TextRef,
}

fn utf16_len(text: &str) -> usize {
    text.encode_utf16().count()
}

/// A fresh Yjs-compatible document (a random client id, UTF-16 offsets).
fn new_doc() -> Doc {
    let options = Options {
        offset_kind: OffsetKind::Utf16,
        ..Options::default()
    };
    Doc::with_options(options)
}

impl Default for CollabDoc {
    fn default() -> Self {
        let doc = new_doc();
        let text = doc.get_or_insert_text(TEXT_NAME);
        Self { doc, text }
    }
}

impl CollabDoc {
    /// A document whose history starts with `initial` inserted by this side.
    pub fn from_text(initial: &str) -> Self {
        let me = Self::default();
        if !initial.is_empty() {
            let mut txn = me.doc.transact_mut();
            me.text.insert(&mut txn, 0, initial);
        }
        me
    }

    /// Rebuilds a document from a stored full state and the updates stored after it (in order).
    pub fn restore(snapshot: Option<&[u8]>, updates: &[Vec<u8>]) -> Result<Self, CrdtError> {
        if snapshot.is_some_and(|s| s.len() > MAX_SYNC_BYTES) {
            return Err(CrdtError::TooLarge);
        }
        let me = Self::default();
        for bytes in snapshot
            .into_iter()
            .chain(updates.iter().map(Vec::as_slice))
        {
            me.apply_unchecked(bytes)?;
        }
        Ok(me)
    }

    pub fn text(&self) -> String {
        self.text.get_string(&self.doc.transact())
    }

    pub fn text_units(&self) -> usize {
        utf16_len(&self.text())
    }

    pub fn state_vector(&self) -> Vec<u8> {
        self.doc.transact().state_vector().encode_v1()
    }

    /// The whole document as one update (a snapshot).
    pub fn full_state(&self) -> Vec<u8> {
        self.doc
            .transact()
            .encode_state_as_update_v1(&StateVector::default())
    }

    /// What a peer with `state_vector` is missing, as one update.
    pub fn diff(&self, state_vector: &[u8]) -> Result<Vec<u8>, CrdtError> {
        let sv = StateVector::decode_v1(state_vector).map_err(|_| CrdtError::BadStateVector)?;
        catch_unwind(AssertUnwindSafe(|| self.doc.transact().encode_diff_v1(&sv)))
            .map_err(|_| CrdtError::Poisoned)
    }

    fn apply_unchecked(&self, bytes: &[u8]) -> Result<(), CrdtError> {
        let update = Update::decode_v1(bytes).map_err(|_| CrdtError::Malformed)?;
        let applied = catch_unwind(AssertUnwindSafe(|| {
            let mut txn = self.doc.transact_mut();
            let result = txn.apply_update(update);
            let pending = txn.has_missing_updates();
            (result, pending)
        }));
        match applied {
            Ok((Ok(()), false)) => Ok(()),
            Ok((Err(_), _)) => Err(CrdtError::Malformed),
            Ok((Ok(()), true)) | Err(_) => Err(CrdtError::Poisoned),
        }
    }

    /// Applies a peer's update after checking it. `Ok(true)` when it changed the document, `Ok(false)` when everything
    /// in it was already here (a resend): nothing to store or forward.
    pub fn apply(&self, bytes: &[u8]) -> Result<bool, CrdtError> {
        if bytes.len() > MAX_UPDATE_BYTES {
            return Err(CrdtError::TooLarge);
        }
        let update = Update::decode_v1(bytes).map_err(|_| CrdtError::Malformed)?;
        let have = self.doc.transact().state_vector();
        // Every client's first clock in the update must already be here, or the update would wait as "pending".
        let needs = catch_unwind(AssertUnwindSafe(|| update.state_vector_lower()))
            .map_err(|_| CrdtError::Malformed)?;
        if needs
            .iter()
            .any(|(client, clock)| *clock > have.get(client))
        {
            return Err(CrdtError::Missing);
        }
        if self.text_units() + bytes.len() > MAX_TEXT_UNITS {
            // Could exceed the limit: try it on a copy first.
            let copy = Self::restore(Some(&self.full_state()), &[bytes.to_vec()])?;
            if copy.text_units() > MAX_TEXT_UNITS {
                return Err(CrdtError::TextTooLarge);
            }
        }
        let before = (self.state_vector(), self.text());
        self.apply_unchecked(bytes)?;
        Ok((self.state_vector(), self.text()) != before)
    }

    /// Makes the text equal `target` with one minimal edit (common prefix and suffix kept), as this side's own
    /// transaction; returns the update to share, `None` when nothing changed. Used for the Owner's own changes that
    /// arrive as whole text (a file changed on disk).
    pub fn set_text(&self, target: &str) -> Option<Vec<u8>> {
        let current: Vec<u16> = self.text().encode_utf16().collect();
        let wanted: Vec<u16> = target.encode_utf16().collect();
        if current == wanted {
            return None;
        }
        let high = |unit: u16| (0xD800..0xDC00).contains(&unit);
        let low = |unit: u16| (0xDC00..0xE000).contains(&unit);
        let mut prefix = current
            .iter()
            .zip(&wanted)
            .take_while(|(a, b)| a == b)
            .count();
        if prefix > 0 && high(wanted[prefix - 1]) {
            prefix -= 1; // never split a surrogate pair (an emoji, a rare CJK character)
        }
        let max_suffix = current.len().min(wanted.len()) - prefix;
        let mut suffix = current
            .iter()
            .rev()
            .zip(wanted.iter().rev())
            .take(max_suffix)
            .take_while(|(a, b)| a == b)
            .count();
        if suffix > 0 && low(wanted[wanted.len() - suffix]) {
            suffix -= 1;
        }
        let removed = current.len() - prefix - suffix;
        let inserted = String::from_utf16_lossy(&wanted[prefix..wanted.len() - suffix]);
        let before = self.doc.transact().state_vector();
        {
            let mut txn = self.doc.transact_mut();
            let at = u32::try_from(prefix).unwrap_or(u32::MAX);
            if removed > 0 {
                self.text
                    .remove_range(&mut txn, at, u32::try_from(removed).unwrap_or(u32::MAX));
            }
            if !inserted.is_empty() {
                self.text.insert(&mut txn, at, &inserted);
            }
        }
        Some(self.doc.transact().encode_diff_v1(&before))
    }
}

#[cfg(test)]
#[path = "crdt_tests.rs"]
mod tests;
