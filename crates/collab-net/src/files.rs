//! The participant's side of file transfers: ask the Owner for a file by id, reassemble its chunks
//! (`openmind_collab::transfer::Incoming` checks every index and length) and hand the content out only after the
//! SHA-256 matches. A failed, cancelled or interrupted transfer drops its buffer at once and can simply be requested
//! again. If the caller stops waiting (a tab closed), the transfer is cancelled on the Owner too.
//!
//! Limits: [`MAX_CLIENT_TRANSFERS`] at a time and [`MAX_CLIENT_BYTES`] of files being received at once.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use openmind_collab::protocol::Body;
use openmind_collab::transfer::{FileErrorCode, Incoming, TransferError};
use openmind_collab::{FileId, TransferId};
use tokio::sync::oneshot;

use crate::participant::ParticipantSender;

/// The same as the Owner allows per participant, so a request this side accepts is never refused as busy there.
pub const MAX_CLIENT_TRANSFERS: usize = crate::owner::serve::MAX_TRANSFERS_PER_PEER;
pub const MAX_CLIENT_BYTES: u64 = 64 * 1024 * 1024;
/// A transfer that makes no progress for this long fails.
pub const STALL_TIMEOUT: Duration = Duration::from_secs(60);

/// A verified file.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ReceivedFile {
    pub file: FileId,
    pub bytes: Vec<u8>,
    pub sha256: String,
    pub text: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum FetchError {
    #[error("{}", .0.message())]
    Owner(FileErrorCode),
    #[error("The file arrived damaged ({}); request it again.", .0.message())]
    Corrupt(TransferError),
    #[error("The transfer was cancelled.")]
    Cancelled,
    #[error("The connection to the room ended during the transfer.")]
    Disconnected,
    #[error("Too many files are downloading; wait for one to finish.")]
    Busy,
    #[error("The transfer stopped making progress.")]
    Stalled,
}

/// Progress callback: file, bytes received, total bytes.
pub type Progress = Arc<dyn Fn(&FileId, u64, u64) + Send + Sync>;

struct Pending {
    file: FileId,
    incoming: Option<Incoming>,
    reply: oneshot::Sender<Result<ReceivedFile, FetchError>>,
    touched: tokio::time::Instant,
}

#[derive(Default)]
struct Inner {
    pending: HashMap<TransferId, Pending>,
}

impl Inner {
    fn bytes(&self) -> u64 {
        self.pending
            .values()
            .filter_map(|p| p.incoming.as_ref())
            .map(|i| i.meta().size)
            .sum()
    }
}

pub struct FileClient {
    sender: ParticipantSender,
    inner: Mutex<Inner>,
    progress: Option<Progress>,
}

/// Cancels the transfer if `fetch` is dropped before it finished.
struct CancelOnDrop<'a> {
    client: &'a FileClient,
    transfer: Option<TransferId>,
}

impl Drop for CancelOnDrop<'_> {
    fn drop(&mut self) {
        if let Some(transfer) = self.transfer.take() {
            self.client
                .finish(&transfer, Err(FetchError::Cancelled), true);
        }
    }
}

impl FileClient {
    pub fn new(sender: ParticipantSender, progress: Option<Progress>) -> Arc<Self> {
        Arc::new(Self {
            sender,
            inner: Mutex::new(Inner::default()),
            progress,
        })
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, Inner> {
        self.inner
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }

    /// Requests `file` and waits for its verified content.
    pub async fn fetch(&self, file: FileId) -> Result<ReceivedFile, FetchError> {
        let transfer = TransferId::random().map_err(|_| FetchError::Busy)?;
        let (reply, mut rx) = oneshot::channel();
        {
            let mut inner = self.lock();
            if inner.pending.len() >= MAX_CLIENT_TRANSFERS {
                return Err(FetchError::Busy);
            }
            let pending = Pending {
                file: file.clone(),
                incoming: None,
                reply,
                touched: tokio::time::Instant::now(),
            };
            inner.pending.insert(transfer.clone(), pending);
        }
        let mut guard = CancelOnDrop {
            client: self,
            transfer: Some(transfer.clone()),
        };
        if self
            .sender
            .send(Body::FileRequest {
                file,
                transfer: transfer.clone(),
            })
            .is_err()
        {
            return Err(FetchError::Disconnected);
        }
        loop {
            match tokio::time::timeout(Duration::from_secs(5), &mut rx).await {
                Ok(result) => {
                    guard.transfer = None;
                    return result.unwrap_or(Err(FetchError::Disconnected));
                }
                Err(_) => {
                    let stalled = self
                        .lock()
                        .pending
                        .get(&transfer)
                        .is_some_and(|p| p.touched.elapsed() > STALL_TIMEOUT);
                    if stalled {
                        return Err(FetchError::Stalled); // the guard cancels it on the Owner
                    }
                }
            }
        }
    }

    /// Stops every transfer of `file` (e.g. its tab closed, or a newer version is wanted).
    pub fn cancel_file(&self, file: &FileId) {
        let transfers: Vec<TransferId> = self
            .lock()
            .pending
            .iter()
            .filter(|(_, p)| p.file == *file)
            .map(|(t, _)| t.clone())
            .collect();
        for transfer in transfers {
            self.finish(&transfer, Err(FetchError::Cancelled), true);
        }
    }

    /// The connection ended: every transfer fails (and can be requested again after reconnecting).
    pub fn disconnected(&self) {
        let all: Vec<TransferId> = self.lock().pending.keys().cloned().collect();
        for transfer in all {
            self.finish(&transfer, Err(FetchError::Disconnected), false);
        }
    }

    pub fn active(&self) -> usize {
        self.lock().pending.len()
    }

    fn finish(
        &self,
        transfer: &TransferId,
        result: Result<ReceivedFile, FetchError>,
        tell_owner: bool,
    ) {
        let pending = self.lock().pending.remove(transfer);
        if let Some(pending) = pending {
            if tell_owner {
                let _ = self.sender.send(Body::FileCancel {
                    transfer: transfer.clone(),
                });
            }
            let _ = pending.reply.send(result);
        }
    }

    /// Handles a transfer message from the Owner; `false` for anything else.
    pub fn handle(&self, body: &Body) -> bool {
        match body {
            Body::FileMeta { meta } => self.meta(meta.clone()),
            Body::FileChunk {
                transfer,
                index,
                data,
            } => self.chunk(transfer, *index, &data.0),
            Body::FileComplete { transfer } => self.complete(transfer),
            Body::FileError { transfer, code } => {
                self.finish(transfer, Err(FetchError::Owner(*code)), false)
            }
            _ => return false,
        }
        true
    }

    fn meta(&self, meta: openmind_collab::transfer::FileMeta) {
        let transfer = meta.transfer.clone();
        let refused = {
            let mut inner = self.lock();
            let over_budget = inner.bytes() + meta.size > MAX_CLIENT_BYTES;
            match inner.pending.get_mut(&transfer) {
                None => return, // unknown or already finished: ignore
                Some(p) if p.incoming.is_some() || p.file != meta.file => {
                    Some(FetchError::Corrupt(TransferError::InvalidMeta))
                }
                Some(_) if over_budget => Some(FetchError::Busy),
                Some(p) => match Incoming::new(meta) {
                    Ok(incoming) => {
                        p.incoming = Some(incoming);
                        p.touched = tokio::time::Instant::now();
                        None
                    }
                    Err(err) => Some(FetchError::Corrupt(err)),
                },
            }
        };
        if let Some(err) = refused {
            self.finish(&transfer, Err(err), true);
        }
    }

    fn chunk(&self, transfer: &TransferId, index: u32, data: &[u8]) {
        let outcome = {
            let mut inner = self.lock();
            let Some(pending) = inner.pending.get_mut(transfer) else {
                return;
            };
            pending.touched = tokio::time::Instant::now();
            match pending.incoming.as_mut() {
                None => Err(TransferError::BadIndex),
                Some(incoming) => incoming.add(index, data).map(|()| {
                    let total = incoming.meta().size;
                    let got = (u64::from(incoming.received())
                        * openmind_collab::transfer::CHUNK_BYTES as u64)
                        .min(total);
                    (pending.file.clone(), got, total)
                }),
            }
        };
        match outcome {
            Ok((file, got, total)) => {
                if let Some(progress) = &self.progress {
                    progress(&file, got, total);
                }
            }
            Err(err) => self.finish(transfer, Err(FetchError::Corrupt(err)), true),
        }
    }

    fn complete(&self, transfer: &TransferId) {
        let Some(pending) = self.lock().pending.remove(transfer) else {
            return;
        };
        let result = match pending.incoming {
            None => Err(FetchError::Corrupt(TransferError::Incomplete)),
            Some(incoming) => {
                let (file, sha256, text) = (
                    pending.file,
                    incoming.meta().sha256.clone(),
                    incoming.meta().text,
                );
                incoming
                    .finish()
                    .map(|bytes| ReceivedFile {
                        file,
                        bytes,
                        sha256,
                        text,
                    })
                    .map_err(FetchError::Corrupt)
            }
        };
        let _ = pending.reply.send(result);
    }
}
