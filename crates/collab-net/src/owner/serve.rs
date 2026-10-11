//! Serving the shared workspace on the Owner side: manifest pages and chunked file transfers, each in its own task so
//! a large file never stalls the network loop. Bulk sends wait for the `openmind-files` channel to drain below
//! [`HIGH_WATER`] before the next chunk, so a fast Owner can't flood a slow participant.
//!
//! Limits (per Owner, generous for development, firm against a hostile peer): [`MAX_TRANSFERS_PER_PEER`] active
//! transfers per participant and [`MAX_TRANSFERS`] in all, [`MAX_INFLIGHT_BYTES`] of file snapshots held at once,
//! a request rate per participant, one manifest per [`MANIFEST_INTERVAL`], and a participant that keeps asking for
//! ids that don't exist is disconnected after [`MAX_UNAVAILABLE`] answers.

use std::sync::atomic::{AtomicU64, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use openmind_collab::manifest::paginate;
use openmind_collab::protocol::{Body, Bytes, Channel, Frame};
use openmind_collab::replay::SequenceCounter;
use openmind_collab::transfer::{FileErrorCode, FileMeta, CHUNK_BYTES};
use openmind_collab::{Actor, FileId, SessionId, TransferId};
use openmind_collab_signal::Slot;
use tokio::sync::mpsc;

use super::OwnerAuthority;
use crate::error::NetError;
use crate::peer::PeerHandle;
use crate::transport::DataChannelTransport;

pub const MAX_TRANSFERS_PER_PEER: usize = 4;
pub const MAX_TRANSFERS: usize = 32;
pub const MAX_INFLIGHT_BYTES: u64 = 128 * 1024 * 1024;
/// Buffered bytes on the files channel above which a sender waits.
pub const HIGH_WATER: usize = 1024 * 1024;
pub const MANIFEST_INTERVAL: Duration = Duration::from_secs(1);
pub const MAX_UNAVAILABLE: u32 = 256;
const RATE_BURST: f64 = 40.0;
const RATE_PER_SECOND: f64 = 20.0;

/// Sends frames of one admitted session from any task, in sequence order.
#[derive(Clone)]
pub(super) struct FrameSender {
    peer: PeerHandle,
    session: SessionId,
    seq: Arc<Mutex<SequenceCounter>>,
}

impl FrameSender {
    pub fn new(peer: PeerHandle, session: SessionId) -> Self {
        Self {
            peer,
            session,
            seq: Arc::new(Mutex::new(SequenceCounter::default())),
        }
    }

    pub fn send(&self, body: Body) -> Result<(), NetError> {
        let channel = body.channel();
        // Numbered and queued under one lock, so frames leave in sequence order whichever task sends them.
        let mut seq = self.seq.lock().map_err(|_| NetError::Closed)?;
        let bytes = Frame::new(self.session.clone(), seq.advance(), body)
            .and_then(|f| f.encode())
            .map_err(|e| NetError::Protocol(e.to_string()))?;
        self.peer.send(channel, bytes)
    }

    pub async fn send_bulk(&self, body: Body) -> Result<(), NetError> {
        self.peer.writable(Channel::Files, HIGH_WATER).await?;
        self.send(body)
    }
}

/// Transfers and bytes in flight across the whole room.
#[derive(Debug, Default)]
pub(super) struct Budget {
    transfers: AtomicUsize,
    bytes: AtomicU64,
}

/// A transfer slot (released when dropped, also when the task is aborted).
pub(super) struct TransferSlot(Arc<Budget>);

impl Drop for TransferSlot {
    fn drop(&mut self) {
        self.0.transfers.fetch_sub(1, Ordering::AcqRel);
    }
}

/// Bytes of one snapshot (released when dropped).
pub(super) struct ByteReservation(Arc<Budget>, u64);

impl Drop for ByteReservation {
    fn drop(&mut self) {
        self.0.bytes.fetch_sub(self.1, Ordering::AcqRel);
    }
}

impl Budget {
    pub fn transfer(self: &Arc<Self>) -> Option<TransferSlot> {
        let taken = self
            .transfers
            .fetch_update(Ordering::AcqRel, Ordering::Acquire, |n| {
                (n < MAX_TRANSFERS).then_some(n + 1)
            })
            .is_ok();
        taken.then(|| TransferSlot(self.clone()))
    }

    fn bytes(self: &Arc<Self>, len: u64) -> Option<ByteReservation> {
        let taken = self
            .bytes
            .fetch_update(Ordering::AcqRel, Ordering::Acquire, |n| {
                (n + len <= MAX_INFLIGHT_BYTES).then_some(n + len)
            })
            .is_ok();
        taken.then(|| ByteReservation(self.clone(), len))
    }

    #[cfg(test)]
    pub fn active(&self) -> usize {
        self.transfers.load(Ordering::Acquire)
    }
}

/// A token bucket for one participant's file requests.
pub(super) struct RateLimit {
    tokens: f64,
    last: Instant,
    burst: f64,
    per_second: f64,
}

impl Default for RateLimit {
    fn default() -> Self {
        Self::new(RATE_BURST, RATE_PER_SECOND)
    }
}

/// Presence states one participant may send: a client sends at most ~20 a second; more is dropped, not answered.
pub const PRESENCE_BURST: f64 = 40.0;
pub const PRESENCE_PER_SECOND: f64 = 30.0;
/// Voice states and negotiation messages one participant may send (a call of six negotiates in well under this; more is
/// a flood and is dropped, with its own budget so it never eats into code or presence).
pub const VOICE_BURST: f64 = 80.0;
pub const VOICE_PER_SECOND: f64 = 20.0;

impl RateLimit {
    pub fn new(burst: f64, per_second: f64) -> Self {
        Self {
            tokens: burst,
            last: Instant::now(),
            burst,
            per_second,
        }
    }

    pub fn allow(&mut self) -> bool {
        let now = Instant::now();
        self.tokens = (self.tokens + now.duration_since(self.last).as_secs_f64() * self.per_second)
            .min(self.burst);
        self.last = now;
        if self.tokens >= 1.0 {
            self.tokens -= 1.0;
            true
        } else {
            false
        }
    }
}

/// A finished (or failed) transfer, reported back to the network loop.
pub(super) struct Done {
    pub slot: Slot,
    pub transfer: TransferId,
    pub unavailable: bool,
}

/// Reads the file through the authority (which authorizes it) and streams it in chunks.
#[allow(clippy::too_many_arguments)]
pub(super) async fn serve_file(
    authority: Arc<dyn OwnerAuthority>,
    actor: Actor,
    file: FileId,
    transfer: TransferId,
    sender: FrameSender,
    budget: Arc<Budget>,
    held: TransferSlot,
    done: (Slot, mpsc::UnboundedSender<Done>),
) {
    let _held = held;
    let outcome = stream(
        authority.as_ref(),
        actor,
        &file,
        &transfer,
        &sender,
        &budget,
    )
    .await;
    let unavailable = outcome == Err(FileErrorCode::Unavailable);
    if let Err(code) = outcome {
        let _ = sender.send(Body::FileError {
            transfer: transfer.clone(),
            code,
        });
    }
    let _ = done.1.send(Done {
        slot: done.0,
        transfer,
        unavailable,
    });
}

async fn stream(
    authority: &dyn OwnerAuthority,
    actor: Actor,
    file: &FileId,
    transfer: &TransferId,
    sender: &FrameSender,
    budget: &Arc<Budget>,
) -> Result<(), FileErrorCode> {
    let snapshot = authority.open_file(actor, file.clone()).await?;
    let _bytes = budget
        .bytes(snapshot.bytes.len() as u64)
        .ok_or(FileErrorCode::Busy)?;
    let meta = FileMeta {
        transfer: transfer.clone(),
        file: file.clone(),
        size: snapshot.bytes.len() as u64,
        sha256: snapshot.sha256.clone(),
        chunk_size: CHUNK_BYTES as u32,
        chunks: snapshot.chunks(),
        text: snapshot.text,
    };
    sender
        .send(Body::FileMeta { meta })
        .map_err(|_| FileErrorCode::Failed)?;
    for index in 0..snapshot.chunks() {
        let data = snapshot.chunk(index).ok_or(FileErrorCode::Failed)?.to_vec();
        let body = Body::FileChunk {
            transfer: transfer.clone(),
            index,
            data: Bytes(data),
        };
        sender
            .send_bulk(body)
            .await
            .map_err(|_| FileErrorCode::Failed)?;
    }
    sender
        .send(Body::FileComplete {
            transfer: transfer.clone(),
        })
        .map_err(|_| FileErrorCode::Failed)
}

/// Sends the current manifest as pages.
pub(super) async fn serve_manifest(
    authority: Arc<dyn OwnerAuthority>,
    actor: Actor,
    sender: FrameSender,
) {
    let manifest = match authority.manifest(actor).await {
        Ok(manifest) => manifest,
        Err(reason) => {
            tracing::info!(%reason, "a manifest request was refused");
            return;
        }
    };
    let pages = paginate(&manifest.entries);
    let total = pages.len() as u32;
    for (page, entries) in pages.into_iter().enumerate() {
        let body = Body::ManifestPage {
            version: manifest.version,
            page: page as u32,
            pages: total,
            root: manifest.root.clone(),
            entries,
        };
        if sender.send_bulk(body).await.is_err() {
            return;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn budgets_release_on_drop() {
        let budget = Arc::new(Budget::default());
        let slots: Vec<_> = (0..MAX_TRANSFERS)
            .map(|_| budget.transfer().expect("slot"))
            .collect();
        assert!(budget.transfer().is_none(), "the room is full");
        drop(slots);
        assert_eq!(budget.active(), 0);
        let big = budget.bytes(MAX_INFLIGHT_BYTES).expect("bytes");
        assert!(budget.bytes(1).is_none());
        drop(big);
        assert!(budget.bytes(1).is_some());
    }

    #[test]
    fn the_rate_limit_allows_a_burst_then_refuses() {
        let mut rate = RateLimit::default();
        let allowed = (0..100).filter(|_| rate.allow()).count();
        assert!((40..=42).contains(&allowed), "{allowed}");
    }
}
