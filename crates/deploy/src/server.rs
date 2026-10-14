//! The package server of a computer that offers OpenMind Studio packages: plain HTTP/1.1 on the LAN with exactly two
//! kinds of address — [`MANIFEST_PATH`] and [`PACKAGE_PREFIX`]`<release file name>` — and nothing else.
//!
//! - **read-only**: `GET` only; nothing a client sends is written anywhere;
//! - **no paths from the network**: a package name is looked up in the catalog the app built from its own folder; any
//!   other name, `..`, an encoded character or a query is a 404, so no file outside the catalog can be reached;
//! - **bounded**: request headers at most 8 KB, a slow client times out, at most [`MAX_CONNECTIONS`] at once;
//! - **integrity is not the transport's job**: a client checks the size, the SHA-256 and the release signature of what
//!   it received (see [`crate::package`]), so a man in the middle can only make a download fail.

use std::collections::HashMap;
use std::io::{Read, Write};
use std::net::{SocketAddr, TcpListener, TcpStream};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::Arc;
use std::thread::JoinHandle;
use std::time::Duration;

use crate::advert::Manifest;

pub const MANIFEST_PATH: &str = "/openmind-deploy/v1/manifest";
pub const PACKAGE_PREFIX: &str = "/openmind-deploy/v1/packages/";
pub const MAX_CONNECTIONS: usize = 16;
const MAX_REQUEST: usize = 8 * 1024;
const IO_TIMEOUT: Duration = Duration::from_secs(30);
/// The whole request head must arrive within this (a client sending a byte now and then can't hold a slot).
const HEAD_DEADLINE: Duration = Duration::from_secs(10);

/// What a server offers: the manifest and, for each package name in it, the file on this computer.
#[derive(Debug, Clone)]
pub struct Catalog {
    pub manifest: Manifest,
    pub files: HashMap<String, PathBuf>,
    /// Each file's resolved path when the catalog was made: a file later replaced by a link or junction to something
    /// else no longer matches and is not served.
    resolved: HashMap<String, PathBuf>,
}

impl Catalog {
    /// A catalog whose every manifest package has a file, and nothing more.
    pub fn new(manifest: Manifest, files: HashMap<String, PathBuf>) -> Result<Self, String> {
        manifest.validate()?;
        if manifest.packages.len() != files.len()
            || manifest
                .packages
                .iter()
                .any(|p| !files.contains_key(&p.name))
        {
            return Err("every package needs exactly one file".into());
        }
        let mut resolved = HashMap::new();
        for (name, file) in &files {
            let canonical =
                std::fs::canonicalize(file).map_err(|err| format!("{}: {err}", file.display()))?;
            resolved.insert(name.clone(), canonical);
        }
        Ok(Self {
            manifest,
            files,
            resolved,
        })
    }
}

impl Catalog {
    /// The file to serve for `name`: still a regular file (not a link) at the place it resolved to when the catalog was
    /// made.
    fn servable(&self, name: &str) -> Option<&PathBuf> {
        let file = self.files.get(name)?;
        let meta = std::fs::symlink_metadata(file).ok()?;
        let unchanged =
            meta.is_file() && std::fs::canonicalize(file).ok().as_ref() == self.resolved.get(name);
        unchanged.then_some(file)
    }
}

pub struct PackageServer {
    address: SocketAddr,
    stop: Arc<AtomicBool>,
    thread: Option<JoinHandle<()>>,
}

impl PackageServer {
    /// Listens on `bind` (port 0: any free port).
    pub fn start(bind: SocketAddr, catalog: Catalog) -> std::io::Result<Self> {
        let listener = TcpListener::bind(bind)?;
        listener.set_nonblocking(true)?;
        let address = listener.local_addr()?;
        let stop = Arc::new(AtomicBool::new(false));
        let catalog = Arc::new(catalog);
        let thread = std::thread::Builder::new()
            .name("deploy-packages".into())
            .spawn({
                let stop = stop.clone();
                move || accept_loop(&listener, &stop, &catalog)
            })?;
        tracing::info!(%address, "serving OpenMind Studio packages");
        Ok(Self {
            address,
            stop,
            thread: Some(thread),
        })
    }

    pub fn address(&self) -> SocketAddr {
        self.address
    }
}

impl Drop for PackageServer {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::SeqCst);
        if let Some(thread) = self.thread.take() {
            let _ = thread.join();
        }
    }
}

fn accept_loop(listener: &TcpListener, stop: &AtomicBool, catalog: &Arc<Catalog>) {
    let active = Arc::new(AtomicUsize::new(0));
    while !stop.load(Ordering::SeqCst) {
        match listener.accept() {
            Ok((mut stream, _)) => {
                if active.load(Ordering::SeqCst) >= MAX_CONNECTIONS {
                    let _ = respond_status(&mut stream, 503, "Busy");
                    continue;
                }
                active.fetch_add(1, Ordering::SeqCst);
                let (catalog, active) = (catalog.clone(), active.clone());
                let spawned = std::thread::Builder::new()
                    .name("deploy-package".into())
                    .spawn(move || {
                        let _ = serve(stream, &catalog);
                        active.fetch_sub(1, Ordering::SeqCst);
                    });
                if spawned.is_err() {
                    tracing::warn!("couldn't start a thread for a package request");
                }
            }
            Err(err) if err.kind() == std::io::ErrorKind::WouldBlock => {
                std::thread::sleep(Duration::from_millis(50));
            }
            Err(_) => std::thread::sleep(Duration::from_millis(50)),
        }
    }
}

/// The request line's method and path, after reading at most [`MAX_REQUEST`] bytes of headers.
fn read_request(stream: &mut TcpStream) -> std::io::Result<Option<(String, String)>> {
    let mut data = Vec::new();
    let mut buf = [0u8; 1024];
    let deadline = std::time::Instant::now() + HEAD_DEADLINE;
    while !data.windows(4).any(|w| w == b"\r\n\r\n") {
        let left = deadline.saturating_duration_since(std::time::Instant::now());
        if data.len() > MAX_REQUEST || left.is_zero() {
            return Ok(None);
        }
        stream.set_read_timeout(Some(left))?;
        let n = stream.read(&mut buf)?;
        if n == 0 {
            return Ok(None);
        }
        data.extend_from_slice(&buf[..n]);
    }
    let text = String::from_utf8_lossy(&data);
    let mut words = text.lines().next().unwrap_or_default().split(' ');
    match (words.next(), words.next(), words.next()) {
        (Some(method), Some(path), Some(version)) if version.starts_with("HTTP/1.") => {
            Ok(Some((method.to_string(), path.to_string())))
        }
        _ => Ok(None),
    }
}

fn serve(mut stream: TcpStream, catalog: &Catalog) -> std::io::Result<()> {
    stream.set_nonblocking(false)?;
    stream.set_read_timeout(Some(IO_TIMEOUT))?;
    stream.set_write_timeout(Some(IO_TIMEOUT))?;
    let Some((method, path)) = read_request(&mut stream)? else {
        return respond_status(&mut stream, 400, "Bad Request");
    };
    if method != "GET" {
        return respond_status(&mut stream, 405, "Method Not Allowed");
    }
    if path == MANIFEST_PATH {
        let body = serde_json::to_vec(&catalog.manifest).map_err(std::io::Error::other)?;
        write_head(
            &mut stream,
            200,
            "OK",
            "application/json",
            body.len() as u64,
        )?;
        return stream.write_all(&body);
    }
    let file = path
        .strip_prefix(PACKAGE_PREFIX)
        .filter(|name| catalog.manifest.packages.iter().any(|p| p.name == *name))
        .and_then(|name| catalog.servable(name));
    let Some(file) = file else {
        return respond_status(&mut stream, 404, "Not Found");
    };
    let Ok(mut reader) = std::fs::File::open(file) else {
        return respond_status(&mut stream, 404, "Not Found");
    };
    let length = reader.metadata()?.len();
    write_head(&mut stream, 200, "OK", "application/octet-stream", length)?;
    std::io::copy(&mut reader, &mut stream).map(|_| ())
}

fn write_head(
    stream: &mut TcpStream,
    status: u16,
    reason: &str,
    content_type: &str,
    length: u64,
) -> std::io::Result<()> {
    write!(
        stream,
        "HTTP/1.1 {status} {reason}\r\nContent-Type: {content_type}\r\nContent-Length: {length}\r\n\
         Cache-Control: no-store\r\nX-Content-Type-Options: nosniff\r\nConnection: close\r\n\r\n"
    )
}

fn respond_status(stream: &mut TcpStream, status: u16, reason: &str) -> std::io::Result<()> {
    write_head(stream, status, reason, "text/plain", reason.len() as u64)?;
    stream.write_all(reason.as_bytes())?;
    linger_close(stream);
    Ok(())
}

/// After an error answer the client may still be sending (an oversized request). Closing a socket with unread data makes
/// Windows send a reset, which can throw away the answer before the client reads it; so the send side is shut and a
/// bounded amount of input (64 KB, one second) is read and dropped first.
fn linger_close(stream: &mut TcpStream) {
    let _ = stream.shutdown(std::net::Shutdown::Write);
    let _ = stream.set_read_timeout(Some(std::time::Duration::from_secs(1)));
    let mut buf = [0u8; 4096];
    let mut left = 64 * 1024usize;
    while left > 0 {
        match stream.read(&mut buf) {
            Ok(0) | Err(_) => break,
            Ok(n) => left = left.saturating_sub(n),
        }
    }
}
