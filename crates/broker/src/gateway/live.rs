//! Passing a download on to the tool while it is still arriving. A large file (TensorFlow's wheel is hundreds of MB)
//! used to reach the tool only after the broker had downloaded and verified all of it, and pip gave up after 15 s
//! without a byte (`ReadTimeoutError ... read timeout=15`). Now the bytes go out as they land in the staging `.part`
//! file. The broker still verifies the whole file: the stream ends cleanly only when the download succeeded *and*
//! everything already sent equals the verified file; otherwise the connection is cut before the end of the chunked
//! body, so the tool sees an incomplete transfer and never accepts a wrong file (pip checks the hash as well).

use std::fs::File;
use std::io::{self, Read, Seek, SeekFrom};
use std::path::PathBuf;
use std::sync::mpsc::{Receiver, RecvTimeoutError, TryRecvError};
use std::time::{Duration, Instant};

use sha2::{Digest, Sha256};

use crate::broker::Lease;
use crate::error::BrokerError;

/// How often the growing file is looked at when it has no new bytes.
const POLL: Duration = Duration::from_millis(50);

/// What the stream is waiting on: the broker's answer for the download.
pub(crate) type Outcome = Receiver<Result<Lease, BrokerError>>;

/// How the start of the answer went.
pub(crate) enum Start {
    /// The download already ended (staged before, or very small/fast): answer as before, with its length or error.
    Finished(Result<Lease, BrokerError>),
    /// Bytes are arriving (or the wait for the first byte ran out): stream them.
    Streaming,
}

/// Waits until the first bytes reach `part`, the download ends, or `first_byte` passes — whichever comes first.
pub(crate) fn wait_for_start(part: &PathBuf, outcome: &Outcome, first_byte: Duration) -> Start {
    let deadline = Instant::now() + first_byte;
    loop {
        match outcome.recv_timeout(POLL) {
            Ok(result) => return Start::Finished(result),
            Err(RecvTimeoutError::Disconnected) => {
                return Start::Finished(Err(BrokerError::new(
                    crate::error::FailureKind::Other,
                    "the download stopped unexpectedly",
                )))
            }
            Err(RecvTimeoutError::Timeout) => {}
        }
        if std::fs::metadata(part).is_ok_and(|meta| meta.len() > 0) || Instant::now() >= deadline {
            return Start::Streaming;
        }
    }
}

/// Reads the download as it grows, then the verified file. Read errors end the chunked answer without its last chunk.
pub(crate) struct LiveRead {
    part: PathBuf,
    outcome: Outcome,
    /// The growing file, once it exists (Rust opens files with delete sharing, so the downloader can still rename it).
    growing: Option<File>,
    /// The verified file, after the download succeeded (kept alive by `lease`).
    verified: Option<File>,
    lease: Option<Lease>,
    sent: u64,
    sent_hash: Sha256,
}

impl LiveRead {
    pub(crate) fn new(part: PathBuf, outcome: Outcome) -> Self {
        Self {
            part,
            outcome,
            growing: None,
            verified: None,
            lease: None,
            sent: 0,
            sent_hash: Sha256::new(),
        }
    }

    fn sent_bytes(&mut self, bytes: &[u8]) -> usize {
        self.sent_hash.update(bytes);
        self.sent += bytes.len() as u64;
        bytes.len()
    }

    /// The download succeeded: what was sent must be the start of the verified file (a retry that started over, or a
    /// mirror, could have replaced the bytes under us). Then the rest comes from the verified file itself.
    fn switch_to_verified(&mut self, lease: Lease) -> io::Result<()> {
        let mut file = lease.open()?;
        if lease.len() < self.sent {
            return Err(cut(
                "the verified file is shorter than what was already sent",
            ));
        }
        let mut prefix = Sha256::new();
        let mut left = self.sent;
        let mut buffer = vec![0u8; 256 * 1024];
        while left > 0 {
            let want = buffer
                .len()
                .min(usize::try_from(left).unwrap_or(buffer.len()));
            let read = file.read(&mut buffer[..want])?;
            if read == 0 {
                return Err(cut("the verified file ended early"));
            }
            prefix.update(&buffer[..read]);
            left -= read as u64;
        }
        if prefix.finalize() != self.sent_hash.clone().finalize() {
            return Err(cut(
                "the download changed while it was being passed on; the tool will retry",
            ));
        }
        file.seek(SeekFrom::Start(self.sent))?;
        self.verified = Some(file);
        self.lease = Some(lease);
        self.growing = None;
        Ok(())
    }
}

fn cut(why: &str) -> io::Error {
    io::Error::new(io::ErrorKind::ConnectionAborted, why.to_string())
}

impl Read for LiveRead {
    fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
        loop {
            if let Some(file) = self.verified.as_mut() {
                let read = file.read(buf)?;
                if read == 0 {
                    let expected = self.lease.as_ref().map_or(0, |lease| lease.len());
                    if self.sent != expected {
                        return Err(cut("the verified file changed while it was sent"));
                    }
                    return Ok(0);
                }
                return Ok(self.sent_bytes(&buf[..read]));
            }
            if self.growing.is_none() {
                self.growing = File::open(&self.part).ok();
            }
            if let Some(file) = self.growing.as_mut() {
                file.seek(SeekFrom::Start(self.sent))?;
                let read = file.read(buf)?;
                if read > 0 {
                    let bytes = buf[..read].to_vec();
                    return Ok(self.sent_bytes(&bytes));
                }
            }
            match self.outcome.try_recv() {
                Ok(Ok(lease)) => self.switch_to_verified(lease)?,
                Ok(Err(error)) => {
                    return Err(cut(&format!("{}: {}", error.kind.label(), error.detail)));
                }
                Err(TryRecvError::Disconnected) => {
                    return Err(cut("the download stopped unexpectedly"))
                }
                Err(TryRecvError::Empty) => std::thread::sleep(POLL),
            }
        }
    }
}
