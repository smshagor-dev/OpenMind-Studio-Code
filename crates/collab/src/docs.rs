//! The Owner's collaborative documents for one room (Milestone 24, phase 6): one [`CollabDoc`] per shared text file,
//! keyed by its stable [`FileId`] (a rename keeps the document; a delete closes it), loaded when someone opens it and
//! dropped when nobody uses it any more. Decisions only — no I/O: every accepted change comes back as a [`Change`]
//! saying what to store and whom to send it to, and the caller stores it *before* acknowledging it.
//!
//! The caller authorizes first (`file.read` to open, `file.write` to change, through `fsauth`); this module then
//! insists that a participant opened the document before changing it, that the change applies cleanly
//! ([`CollabDoc::apply`]), and turns a resend into a no-op (nothing stored, nothing forwarded).

use std::collections::{BTreeSet, HashMap, HashSet};

use crate::crdt::{CollabDoc, CrdtError};
use crate::ids::{FileId, MessageId, PeerId};
use crate::protocol::{Body, Bytes, DocClosedReason};

/// Accepted changes after which a document's full state is stored again (recovery = latest snapshot + later updates).
pub const SNAPSHOT_EVERY: u32 = 500;

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum DocError {
    #[error("Open the document before changing it.")]
    NotOpen,
    #[error("The file was deleted; changes to it are refused.")]
    Deleted,
    #[error("The change was refused: {0}")]
    Crdt(#[from] CrdtError),
}

/// Who made a change.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Origin {
    /// The Owner's own editor (or the file changing on the Owner's disk).
    Owner,
    Peer(PeerId),
}

/// One accepted change to store (exactly once: `id` is unique per room).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StoredUpdate {
    pub file: FileId,
    pub id: MessageId,
    pub origin: Origin,
    pub bytes: Vec<u8>,
}

/// What an accepted change requires.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct Change {
    /// `None`: everything in it was already here (a resend) — nothing to store or send.
    pub store: Option<StoredUpdate>,
    /// Messages to participants.
    pub send: Vec<(PeerId, Body)>,
    /// The update for the Owner's own editor (when someone else made it).
    pub to_owner: Option<Vec<u8>>,
}

struct Active {
    doc: CollabDoc,
    subscribers: BTreeSet<PeerId>,
    /// The Owner's editor follows this document.
    owner_bound: bool,
    /// Stored updates since the last snapshot, and the newest stored row.
    since_snapshot: u32,
    last_stored: i64,
}

#[derive(Default)]
pub struct DocHost {
    docs: HashMap<FileId, Active>,
    deleted: HashSet<FileId>,
}

impl DocHost {
    pub fn is_loaded(&self, file: &FileId) -> bool {
        self.docs.contains_key(file)
    }

    /// Takes a document rebuilt from storage (and reconciled with the file's current text by the caller).
    pub fn load(&mut self, file: FileId, doc: CollabDoc, last_stored: i64) {
        self.deleted.remove(&file);
        self.docs.entry(file).or_insert(Active {
            doc,
            subscribers: BTreeSet::new(),
            owner_bound: false,
            since_snapshot: 0,
            last_stored,
        });
    }

    pub fn text(&self, file: &FileId) -> Option<String> {
        self.docs.get(file).map(|a| a.doc.text())
    }

    pub fn full_state(&self, file: &FileId) -> Option<Vec<u8>> {
        self.docs.get(file).map(|a| a.doc.full_state())
    }

    /// A participant opens `file`: what it is missing given its state vector, and the Owner's state vector.
    pub fn subscribe(
        &mut self,
        peer: &PeerId,
        file: &FileId,
        state_vector: &[u8],
    ) -> Result<Body, DocError> {
        if self.deleted.contains(file) {
            return Err(DocError::Deleted);
        }
        let active = self.docs.get_mut(file).ok_or(DocError::NotOpen)?;
        let update = active.doc.diff(state_vector)?;
        active.subscribers.insert(peer.clone());
        Ok(Body::DocSync {
            file: file.clone(),
            state_vector: Bytes(active.doc.state_vector()),
            update: Bytes(update),
        })
    }

    pub fn unsubscribe(&mut self, peer: &PeerId, file: &FileId) {
        if let Some(active) = self.docs.get_mut(file) {
            active.subscribers.remove(peer);
        }
    }

    /// A participant left: it no longer follows any document.
    pub fn peer_left(&mut self, peer: &PeerId) {
        for active in self.docs.values_mut() {
            active.subscribers.remove(peer);
        }
    }

    pub fn set_owner_bound(&mut self, file: &FileId, bound: bool) {
        if let Some(active) = self.docs.get_mut(file) {
            active.owner_bound = bound;
        }
    }

    pub fn owner_bound(&self, file: &FileId) -> bool {
        self.docs.get(file).is_some_and(|a| a.owner_bound)
    }

    pub fn subscribers(&self, file: &FileId) -> Vec<PeerId> {
        self.docs
            .get(file)
            .map(|a| a.subscribers.iter().cloned().collect())
            .unwrap_or_default()
    }

    /// An authorized change. A participant must have opened the document; the Owner may change any loaded one.
    pub fn update(
        &mut self,
        origin: Origin,
        file: &FileId,
        id: MessageId,
        bytes: Vec<u8>,
    ) -> Result<Change, DocError> {
        if self.deleted.contains(file) {
            return Err(DocError::Deleted);
        }
        let active = self.docs.get_mut(file).ok_or(DocError::NotOpen)?;
        if let Origin::Peer(peer) = &origin {
            if !active.subscribers.contains(peer) {
                return Err(DocError::NotOpen);
            }
        }
        if !active.doc.apply(&bytes)? {
            return Ok(Change::default());
        }
        Ok(Self::fan_out(active, file, id, origin, bytes))
    }

    /// The Owner's file changed as a whole (on disk, while its editor doesn't follow the document): one minimal edit.
    pub fn set_text(&mut self, file: &FileId, text: &str) -> Result<Option<Change>, DocError> {
        let active = self.docs.get_mut(file).ok_or(DocError::NotOpen)?;
        let Some(bytes) = active.doc.set_text(text) else {
            return Ok(None);
        };
        let id = MessageId::random().map_err(|_| DocError::NotOpen)?;
        Ok(Some(Self::fan_out(active, file, id, Origin::Owner, bytes)))
    }

    fn fan_out(
        active: &Active,
        file: &FileId,
        id: MessageId,
        origin: Origin,
        bytes: Vec<u8>,
    ) -> Change {
        let from = match &origin {
            Origin::Peer(peer) => Some(peer.clone()),
            Origin::Owner => None,
        };
        let send = active
            .subscribers
            .iter()
            .filter(|peer| Some(*peer) != from.as_ref())
            .map(|peer| {
                (
                    peer.clone(),
                    Body::YjsUpdate {
                        file: file.clone(),
                        id: id.clone(),
                        update: Bytes(bytes.clone()),
                    },
                )
            })
            .collect();
        let to_owner = from.is_some().then(|| bytes.clone());
        Change {
            store: Some(StoredUpdate {
                file: file.clone(),
                id,
                origin,
                bytes,
            }),
            send,
            to_owner,
        }
    }

    /// Records that a change was stored as row `row`; `Some((state, state vector, covered row))` when a snapshot is due.
    pub fn stored(&mut self, file: &FileId, row: i64) -> Option<(Vec<u8>, Vec<u8>, i64)> {
        let active = self.docs.get_mut(file)?;
        active.last_stored = active.last_stored.max(row);
        active.since_snapshot += 1;
        if active.since_snapshot < SNAPSHOT_EVERY {
            return None;
        }
        active.since_snapshot = 0;
        Some((
            active.doc.full_state(),
            active.doc.state_vector(),
            active.last_stored,
        ))
    }

    /// The file was deleted or hidden: its document closes, later changes are refused, its history stays stored.
    pub fn deleted(&mut self, file: &FileId) -> Vec<(PeerId, Body)> {
        self.deleted.insert(file.clone());
        let Some(active) = self.docs.remove(file) else {
            return Vec::new();
        };
        active
            .subscribers
            .into_iter()
            .map(|peer| {
                (
                    peer,
                    Body::DocClosed {
                        file: file.clone(),
                        reason: DocClosedReason::Deleted,
                    },
                )
            })
            .collect()
    }

    /// Drops a document that went wrong in memory (it is rebuilt from storage when next opened).
    pub fn discard(&mut self, file: &FileId) -> Vec<PeerId> {
        self.docs
            .remove(file)
            .map(|a| a.subscribers.into_iter().collect())
            .unwrap_or_default()
    }

    /// Documents nobody follows any more: unloaded (their state is in storage), with a final snapshot each.
    pub fn unload_idle(&mut self) -> Vec<(FileId, Vec<u8>, Vec<u8>, i64)> {
        let idle: Vec<FileId> = self
            .docs
            .iter()
            .filter(|(_, a)| a.subscribers.is_empty() && !a.owner_bound)
            .map(|(f, _)| f.clone())
            .collect();
        idle.into_iter()
            .filter_map(|file| {
                let active = self.docs.remove(&file)?;
                let snapshot = (active.since_snapshot > 0)
                    .then(|| (active.doc.full_state(), active.doc.state_vector()));
                snapshot.map(|(state, sv)| (file, state, sv, active.last_stored))
            })
            .collect()
    }

    pub fn loaded_files(&self) -> Vec<FileId> {
        self.docs.keys().cloned().collect()
    }

    pub fn loaded(&self) -> usize {
        self.docs.len()
    }
}

#[cfg(test)]
#[path = "docs_tests.rs"]
mod tests;
