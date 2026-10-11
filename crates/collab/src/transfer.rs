//! Chunked file transfer, the parts both sides agree on.
//!
//! The Owner reads a file once into memory and hashes *those* bytes ([`Snapshot`]): the hash in the metadata always
//! describes exactly what is sent, whatever happens to the file meanwhile. The bytes then go out as numbered chunks
//! of [`CHUNK_BYTES`] (a chunk, base64-encoded in a frame, is about 88 KB: inside the 120 KB data channel limit). The
//! participant ([`Incoming`]) checks every chunk's index and length against the metadata, refuses duplicates and
//! anything past the end, and only hands the content out after every chunk arrived *and* the SHA-256 matches; a
//! failed transfer drops its buffer at once.
//!
//! Limits: a shared file may be up to [`MAX_FILE_BYTES`] (16 MiB). Source files are far smaller; the bound exists
//! because a file is held whole in memory on both sides (that is what makes the hash exact) and must fit a Monaco
//! model. Larger files are reported as too large rather than truncated.

use std::sync::Arc;

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::ids::{FileId, TransferId};

pub const CHUNK_BYTES: usize = 64 * 1024;
pub const MAX_FILE_BYTES: u64 = 16 * 1024 * 1024;

/// Why a transfer didn't happen or failed. Unknown, deleted, sensitive and out-of-room ids all answer `Unavailable`
/// (a participant can't tell which).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum FileErrorCode {
    Unavailable,
    TooLarge,
    /// Too many transfers right now; try again.
    Busy,
    /// The file kept changing while it was read.
    Changed,
    Cancelled,
    Failed,
}

impl FileErrorCode {
    pub fn message(self) -> &'static str {
        match self {
            FileErrorCode::Unavailable => "This file isn't available.",
            FileErrorCode::TooLarge => {
                "This file is larger than collaboration can transfer (16 MB)."
            }
            FileErrorCode::Busy => "Too many files are being transferred right now; try again.",
            FileErrorCode::Changed => "The file kept changing while it was read; try again.",
            FileErrorCode::Cancelled => "The transfer was cancelled.",
            FileErrorCode::Failed => "The transfer failed.",
        }
    }
}

pub fn sha256_hex(bytes: &[u8]) -> String {
    hex::encode(Sha256::digest(bytes))
}

pub fn chunk_count(size: u64) -> u32 {
    u32::try_from(size.div_ceil(CHUNK_BYTES as u64)).unwrap_or(u32::MAX)
}

/// The exact bytes of one file version, as the Owner read them.
#[derive(Debug, Clone)]
pub struct Snapshot {
    pub bytes: Arc<Vec<u8>>,
    pub sha256: String,
    /// Not binary (no NUL in the first 8 KB; UTF-16 with a BOM counts as text).
    pub text: bool,
}

impl Snapshot {
    pub fn new(bytes: Vec<u8>, text: bool) -> Self {
        let sha256 = sha256_hex(&bytes);
        Self {
            bytes: Arc::new(bytes),
            sha256,
            text,
        }
    }

    pub fn chunks(&self) -> u32 {
        chunk_count(self.bytes.len() as u64)
    }

    pub fn chunk(&self, index: u32) -> Option<&[u8]> {
        let start = (index as usize).checked_mul(CHUNK_BYTES)?;
        if start >= self.bytes.len() {
            return None;
        }
        let end = (start + CHUNK_BYTES).min(self.bytes.len());
        self.bytes.get(start..end)
    }
}

/// The metadata that opens a transfer.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct FileMeta {
    pub transfer: TransferId,
    pub file: FileId,
    pub size: u64,
    pub sha256: String,
    pub chunk_size: u32,
    pub chunks: u32,
    pub text: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TransferError {
    InvalidMeta,
    BadIndex,
    Duplicate,
    BadLength,
    Incomplete,
    HashMismatch,
}

impl TransferError {
    pub fn message(self) -> &'static str {
        match self {
            TransferError::InvalidMeta => "the transfer's description is invalid",
            TransferError::BadIndex => "a piece of the file was out of range",
            TransferError::Duplicate => "a piece of the file arrived twice",
            TransferError::BadLength => "a piece of the file had the wrong length",
            TransferError::Incomplete => "the file ended before all its pieces arrived",
            TransferError::HashMismatch => "the received file doesn't match its checksum",
        }
    }
}

/// A transfer being received.
#[derive(Debug)]
pub struct Incoming {
    meta: FileMeta,
    buffer: Vec<u8>,
    received: Vec<bool>,
    count: u32,
}

impl Incoming {
    pub fn new(meta: FileMeta) -> Result<Self, TransferError> {
        let valid = meta.size <= MAX_FILE_BYTES
            && meta.chunk_size as usize == CHUNK_BYTES
            && meta.chunks == chunk_count(meta.size)
            && meta.sha256.len() == 64
            && meta.sha256.bytes().all(|b| b.is_ascii_hexdigit());
        if !valid {
            return Err(TransferError::InvalidMeta);
        }
        let size = usize::try_from(meta.size).map_err(|_| TransferError::InvalidMeta)?;
        Ok(Self {
            buffer: vec![0; size],
            received: vec![false; meta.chunks as usize],
            count: 0,
            meta,
        })
    }

    pub fn meta(&self) -> &FileMeta {
        &self.meta
    }

    pub fn received(&self) -> u32 {
        self.count
    }

    pub fn add(&mut self, index: u32, data: &[u8]) -> Result<(), TransferError> {
        let slot = self
            .received
            .get_mut(index as usize)
            .ok_or(TransferError::BadIndex)?;
        if *slot {
            return Err(TransferError::Duplicate);
        }
        let start = index as usize * CHUNK_BYTES;
        let expected = (self.buffer.len() - start).min(CHUNK_BYTES);
        if data.len() != expected {
            return Err(TransferError::BadLength);
        }
        self.buffer[start..start + expected].copy_from_slice(data);
        *slot = true;
        self.count += 1;
        Ok(())
    }

    /// The verified content, once every chunk arrived and the checksum matches.
    pub fn finish(self) -> Result<Vec<u8>, TransferError> {
        if self.count != self.meta.chunks {
            return Err(TransferError::Incomplete);
        }
        if sha256_hex(&self.buffer) != self.meta.sha256 {
            return Err(TransferError::HashMismatch);
        }
        Ok(self.buffer)
    }
}

#[cfg(test)]
#[path = "transfer_tests.rs"]
mod tests;
