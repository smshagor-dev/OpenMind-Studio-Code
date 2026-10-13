//! Fetching from another computer's package server ([`crate::server`]): its manifest and one package.
//!
//! A download goes to a `.part` file of its own next to the destination, is hashed while it arrives, and becomes the
//! destination only when its length is the manifest's size and its SHA-256 the manifest's checksum; anything else is
//! deleted. The signature is checked by the caller afterwards ([`crate::package::verify_file`]): this module trusts
//! nothing it receives.

use std::io::{BufRead, BufReader, Read, Write};
use std::net::{SocketAddr, TcpStream};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use sha2::{Digest, Sha256};

use crate::advert::{Manifest, PackageEntry, MAX_PACKAGE_BYTES};
use crate::server::{MANIFEST_PATH, PACKAGE_PREFIX};

const MAX_MANIFEST: u64 = 256 * 1024;
const MAX_HEADERS: usize = 8 * 1024;

#[derive(Debug, thiserror::Error, PartialEq, Eq)]
pub enum FetchError {
    #[error("couldn't connect to {0}")]
    Connect(String),
    #[error("the source answered HTTP {0}")]
    Http(u16),
    #[error("the source's answer isn't valid: {0}")]
    Protocol(String),
    #[error("the source's manifest is invalid ({0})")]
    Invalid(String),
    #[error("the package is {got} bytes, not the {expected} the manifest says")]
    SizeMismatch { expected: u64, got: u64 },
    #[error(
        "the package's SHA-256 doesn't match the manifest: it was changed or damaged on the way"
    )]
    ChecksumMismatch,
    #[error("the download was cancelled")]
    Cancelled,
    #[error("{0}")]
    Io(String),
}

fn io(err: std::io::Error) -> FetchError {
    FetchError::Io(err.to_string())
}

/// Sends `GET path` and reads the status line and headers; returns the body's length and the reader.
fn get(
    address: SocketAddr,
    path: &str,
    timeout: Duration,
) -> Result<(u64, BufReader<TcpStream>), FetchError> {
    let mut stream = TcpStream::connect_timeout(&address, timeout)
        .map_err(|err| FetchError::Connect(format!("{address}: {err}")))?;
    stream.set_read_timeout(Some(timeout)).map_err(io)?;
    stream.set_write_timeout(Some(timeout)).map_err(io)?;
    write!(
        stream,
        "GET {path} HTTP/1.1\r\nHost: {address}\r\nUser-Agent: OpenMindStudio-deploy\r\nConnection: close\r\n\r\n"
    )
    .map_err(io)?;
    let mut reader = BufReader::new(stream);
    let mut line = String::new();
    reader.read_line(&mut line).map_err(io)?;
    let status = line
        .split(' ')
        .nth(1)
        .and_then(|code| code.parse::<u16>().ok())
        .filter(|_| line.starts_with("HTTP/1."))
        .ok_or_else(|| FetchError::Protocol("not an HTTP answer".into()))?;
    let mut length = None;
    let mut read = line.len();
    loop {
        line.clear();
        read += reader.read_line(&mut line).map_err(io)?;
        if read > MAX_HEADERS {
            return Err(FetchError::Protocol("headers too long".into()));
        }
        let header = line.trim_end();
        if header.is_empty() {
            break;
        }
        if let Some((name, value)) = header.split_once(':') {
            if name.eq_ignore_ascii_case("content-length") {
                length = value.trim().parse::<u64>().ok();
            }
        }
    }
    if status != 200 {
        return Err(FetchError::Http(status));
    }
    let length = length.ok_or_else(|| FetchError::Protocol("no Content-Length".into()))?;
    Ok((length, reader))
}

/// The source's manifest, validated.
pub fn fetch_manifest(address: SocketAddr, timeout: Duration) -> Result<Manifest, FetchError> {
    let (length, reader) = get(address, MANIFEST_PATH, timeout)?;
    if length > MAX_MANIFEST {
        return Err(FetchError::Protocol("manifest too large".into()));
    }
    let mut body = Vec::with_capacity(length as usize);
    reader.take(length).read_to_end(&mut body).map_err(io)?;
    let manifest: Manifest =
        serde_json::from_slice(&body).map_err(|err| FetchError::Invalid(err.to_string()))?;
    manifest.validate().map_err(FetchError::Invalid)?;
    Ok(manifest)
}

fn part_name(dest: &Path) -> PathBuf {
    let name = dest
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_default();
    dest.with_file_name(format!("{name}.{}.part", crate::random_hex(6)))
}

/// Downloads `entry` into `dest` (see the module text). `progress(received, total)`; `cancel` stops it.
pub fn download(
    address: SocketAddr,
    entry: &PackageEntry,
    dest: &Path,
    timeout: Duration,
    progress: &mut dyn FnMut(u64, u64),
    cancel: &AtomicBool,
) -> Result<(), FetchError> {
    let path = format!("{PACKAGE_PREFIX}{}", entry.name);
    let (length, mut reader) = get(address, &path, timeout)?;
    if length != entry.size || length > MAX_PACKAGE_BYTES {
        return Err(FetchError::SizeMismatch {
            expected: entry.size,
            got: length,
        });
    }
    if let Some(parent) = dest.parent() {
        std::fs::create_dir_all(parent).map_err(io)?;
    }
    let part = part_name(dest);
    let outcome = receive(&mut reader, &part, entry, progress, cancel);
    if outcome.is_err() {
        let _ = std::fs::remove_file(&part);
        return outcome;
    }
    let _ = std::fs::remove_file(dest);
    std::fs::rename(&part, dest).map_err(|err| {
        let _ = std::fs::remove_file(&part);
        io(err)
    })
}

fn receive(
    reader: &mut impl Read,
    part: &Path,
    entry: &PackageEntry,
    progress: &mut dyn FnMut(u64, u64),
    cancel: &AtomicBool,
) -> Result<(), FetchError> {
    let mut file = std::fs::File::create(part).map_err(io)?;
    let mut hasher = Sha256::new();
    let mut received = 0u64;
    let mut buf = vec![0u8; 64 * 1024];
    while received < entry.size {
        if cancel.load(Ordering::SeqCst) {
            return Err(FetchError::Cancelled);
        }
        let want = (entry.size - received).min(buf.len() as u64) as usize;
        let n = reader.read(&mut buf[..want]).map_err(io)?;
        if n == 0 {
            break;
        }
        hasher.update(&buf[..n]);
        file.write_all(&buf[..n]).map_err(io)?;
        received += n as u64;
        progress(received, entry.size);
    }
    if received != entry.size {
        return Err(FetchError::SizeMismatch {
            expected: entry.size,
            got: received,
        });
    }
    file.sync_all().map_err(io)?;
    if crate::to_hex(&hasher.finalize()) != entry.sha256 {
        return Err(FetchError::ChecksumMismatch);
    }
    Ok(())
}
