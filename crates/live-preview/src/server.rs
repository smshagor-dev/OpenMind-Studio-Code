//! A small HTTP/1.1 file server on `127.0.0.1` (GET and HEAD only, one request per connection).

use std::io::{BufRead, BufReader, Read, Write};
use std::net::{Shutdown, SocketAddr, TcpListener, TcpStream};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::Arc;
use std::thread::JoinHandle;
use std::time::Duration;

use crate::bridge::{directory_page, inject_bridge, run_script_page, BRIDGE_SCRIPT};
use crate::mime::content_type;
use crate::request::{address_of, resolve_path, Resolved};
use crate::PreviewError;

const MAX_HEAD: usize = 16 * 1024;
const MAX_CONNECTIONS: usize = 64;
/// An HTML page larger than this is sent as it is, without the console bridge.
const MAX_INJECTED_HTML: u64 = 20 * 1024 * 1024;

/// A running server for one folder. Dropping it stops it.
pub struct Server {
    root: PathBuf,
    port: u16,
    stop: Arc<AtomicBool>,
    accept: Option<JoinHandle<()>>,
}

impl Server {
    /// Serves `root` on a free loopback port.
    pub fn start(root: &Path) -> Result<Self, PreviewError> {
        let root = std::fs::canonicalize(root)
            .ok()
            .filter(|path| path.is_dir())
            .ok_or_else(|| PreviewError::MissingRoot(root.display().to_string()))?;
        let listener = TcpListener::bind(("127.0.0.1", 0)).map_err(PreviewError::Bind)?;
        let port = listener.local_addr().map_err(PreviewError::Bind)?.port();
        let stop = Arc::new(AtomicBool::new(false));
        let shared = Arc::new(Shared {
            root: root.clone(),
            port,
            active: AtomicUsize::new(0),
        });
        let flag = Arc::clone(&stop);
        let accept = std::thread::Builder::new()
            .name("live-preview".into())
            .spawn(move || accept_loop(listener, shared, flag))
            .map_err(PreviewError::Bind)?;
        tracing::info!(port, root = %root.display(), "built-in browser server started");
        Ok(Self {
            root,
            port,
            stop,
            accept: Some(accept),
        })
    }

    /// The canonical folder it serves.
    pub fn root(&self) -> &Path {
        &self.root
    }

    pub fn port(&self) -> u16 {
        self.port
    }

    /// `http://127.0.0.1:<port>`.
    pub fn origin(&self) -> String {
        format!("http://127.0.0.1:{}", self.port)
    }

    /// The address of `file` (which must be inside the folder), e.g. `/sub%20dir/index.html`.
    pub fn address_of(&self, file: &Path) -> Result<String, PreviewError> {
        let canonical = std::fs::canonicalize(file).map_err(|_| PreviewError::Outside)?;
        address_of(&self.root, &canonical)
    }
}

impl Drop for Server {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::SeqCst);
        // Wake the blocking `accept` so the thread sees the flag.
        let _ = TcpStream::connect_timeout(
            &SocketAddr::from(([127, 0, 0, 1], self.port)),
            Duration::from_millis(500),
        );
        if let Some(handle) = self.accept.take() {
            let _ = handle.join();
        }
        tracing::info!(port = self.port, "built-in browser server stopped");
    }
}

struct Shared {
    root: PathBuf,
    port: u16,
    active: AtomicUsize,
}

fn accept_loop(listener: TcpListener, shared: Arc<Shared>, stop: Arc<AtomicBool>) {
    for stream in listener.incoming() {
        if stop.load(Ordering::SeqCst) {
            break;
        }
        let Ok(stream) = stream else { continue };
        if shared.active.fetch_add(1, Ordering::SeqCst) >= MAX_CONNECTIONS {
            shared.active.fetch_sub(1, Ordering::SeqCst);
            let _ = stream.shutdown(Shutdown::Both);
            continue;
        }
        let shared = Arc::clone(&shared);
        let spawned = std::thread::Builder::new()
            .name("live-preview-conn".into())
            .spawn(move || {
                if let Err(err) = serve(stream, &shared) {
                    tracing::debug!(?err, "built-in browser request ended early");
                }
                shared.active.fetch_sub(1, Ordering::SeqCst);
            });
        if spawned.is_err() {
            tracing::warn!("couldn't start a thread for a built-in browser request");
        }
    }
}

struct Head {
    method: String,
    target: String,
    host: Option<String>,
}

fn read_head(stream: &TcpStream) -> std::io::Result<Option<Head>> {
    let mut reader = BufReader::new(stream.take(MAX_HEAD as u64));
    let mut line = String::new();
    if reader.read_line(&mut line)? == 0 {
        return Ok(None);
    }
    let mut parts = line.split_whitespace();
    let (Some(method), Some(target), Some(version)) = (parts.next(), parts.next(), parts.next())
    else {
        return Ok(None);
    };
    if !version.starts_with("HTTP/1.") {
        return Ok(None);
    }
    let mut head = Head {
        method: method.to_string(),
        target: target.to_string(),
        host: None,
    };
    loop {
        let mut header = String::new();
        if reader.read_line(&mut header)? == 0 {
            return Ok(None);
        }
        let header = header.trim_end();
        if header.is_empty() {
            return Ok(Some(head));
        }
        if let Some((name, value)) = header.split_once(':') {
            if name.trim().eq_ignore_ascii_case("host") {
                head.host = Some(value.trim().to_ascii_lowercase());
            }
        }
    }
}

fn serve(mut stream: TcpStream, shared: &Shared) -> std::io::Result<()> {
    stream.set_read_timeout(Some(Duration::from_secs(15)))?;
    stream.set_write_timeout(Some(Duration::from_secs(30)))?;
    let Some(head) = read_head(&stream)? else {
        return respond_text(&mut stream, 400, "Bad Request", "Bad request.", false);
    };
    let head_only = head.method == "HEAD";
    let own = [
        format!("127.0.0.1:{}", shared.port),
        format!("localhost:{}", shared.port),
    ];
    if !head.host.as_ref().is_some_and(|host| own.contains(host)) {
        return respond_text(&mut stream, 403, "Forbidden", "Forbidden.", head_only);
    }
    if head.method != "GET" && !head_only {
        return respond_text(
            &mut stream,
            405,
            "Method Not Allowed",
            "Only GET is supported.",
            false,
        );
    }
    if !head.target.starts_with('/') {
        return respond_text(&mut stream, 400, "Bad Request", "Bad request.", head_only);
    }
    match resolve_path(&shared.root, &head.target) {
        Err(_) => respond_text(
            &mut stream,
            403,
            "Forbidden",
            "This address is outside the served folder.",
            head_only,
        ),
        Ok(Resolved::Missing) => {
            respond_text(&mut stream, 404, "Not Found", "File not found.", head_only)
        }
        Ok(Resolved::Bridge) => respond(
            &mut stream,
            200,
            "OK",
            "text/javascript; charset=utf-8",
            BRIDGE_SCRIPT.as_bytes(),
            head_only,
        ),
        Ok(Resolved::RunScript { src, module }) => respond(
            &mut stream,
            200,
            "OK",
            "text/html; charset=utf-8",
            run_script_page(&src, module).as_bytes(),
            head_only,
        ),
        Ok(Resolved::File(path)) if crate::sass::is_sass(&path) => {
            serve_sass(&mut stream, &path, head_only)
        }
        Ok(Resolved::Sass(path)) => serve_sass(&mut stream, &path, head_only),
        Ok(Resolved::File(path)) => serve_file(&mut stream, &path, head_only),
        Ok(Resolved::Directory { path, slash }) => {
            serve_directory(&mut stream, shared, &head.target, &path, slash, head_only)
        }
    }
}

fn serve_directory(
    stream: &mut TcpStream,
    shared: &Shared,
    target: &str,
    path: &Path,
    slash: bool,
    head_only: bool,
) -> std::io::Result<()> {
    if !slash {
        let (path_part, query) = match target.split_once('?') {
            Some((path_part, query)) => (path_part, format!("?{query}")),
            None => (target, String::new()),
        };
        let location = format!("{path_part}/{query}");
        let head = format!(
            "HTTP/1.1 301 Moved Permanently\r\nLocation: {location}\r\nContent-Length: 0\r\n\
             Cache-Control: no-store\r\nConnection: close\r\n\r\n"
        );
        return stream.write_all(head.as_bytes());
    }
    for index in ["index.html", "index.htm"] {
        let candidate = path.join(index);
        if candidate.is_file() {
            return serve_file(stream, &candidate, head_only);
        }
    }
    let mut entries: Vec<(String, bool)> = std::fs::read_dir(path)?
        .flatten()
        .map(|entry| {
            let is_dir = entry.file_type().map(|kind| kind.is_dir()).unwrap_or(false);
            (entry.file_name().to_string_lossy().into_owned(), is_dir)
        })
        .collect();
    entries.sort_by(|a, b| {
        b.1.cmp(&a.1)
            .then_with(|| a.0.to_lowercase().cmp(&b.0.to_lowercase()))
    });
    let address = address_of(&shared.root, path)
        .map(|address| {
            if address.ends_with('/') {
                address
            } else {
                format!("{address}/")
            }
        })
        .unwrap_or_else(|_| "/".into());
    let page = directory_page(
        &crate::request::percent_decode(&address).unwrap_or(address),
        &entries,
    );
    respond(
        stream,
        200,
        "OK",
        "text/html; charset=utf-8",
        page.as_bytes(),
        head_only,
    )
}

/// A `.scss`/`.sass` file compiled to CSS; a compile error is a stylesheet that shows it on the page.
fn serve_sass(stream: &mut TcpStream, path: &Path, head_only: bool) -> std::io::Result<()> {
    let css = crate::sass::compile(path).unwrap_or_else(|message| {
        let name = path
            .file_name()
            .map(|name| name.to_string_lossy().into_owned())
            .unwrap_or_default();
        tracing::debug!(file = %name, "SCSS compile error in the built-in browser");
        crate::sass::error_stylesheet(&name, &message)
    });
    respond(
        stream,
        200,
        "OK",
        "text/css; charset=utf-8",
        css.as_bytes(),
        head_only,
    )
}

fn serve_file(stream: &mut TcpStream, path: &Path, head_only: bool) -> std::io::Result<()> {
    let kind = content_type(path);
    let size = std::fs::metadata(path)?.len();
    if kind.starts_with("text/html") && size <= MAX_INJECTED_HTML {
        let bytes = std::fs::read(path)?;
        return match String::from_utf8(bytes) {
            Ok(text) => {
                let text = text.strip_prefix('\u{feff}').unwrap_or(&text);
                respond(
                    stream,
                    200,
                    "OK",
                    kind,
                    inject_bridge(text).as_bytes(),
                    head_only,
                )
            }
            Err(err) => respond(stream, 200, "OK", "text/html", err.as_bytes(), head_only),
        };
    }
    write_head(stream, 200, "OK", kind, size)?;
    if !head_only {
        let mut file = std::fs::File::open(path)?;
        std::io::copy(&mut file, stream)?;
    }
    stream.flush()
}

fn write_head(
    stream: &mut TcpStream,
    status: u16,
    reason: &str,
    kind: &str,
    length: u64,
) -> std::io::Result<()> {
    let head = format!(
        "HTTP/1.1 {status} {reason}\r\nContent-Type: {kind}\r\nContent-Length: {length}\r\n\
         Cache-Control: no-store\r\nX-Content-Type-Options: nosniff\r\nConnection: close\r\n\r\n"
    );
    stream.write_all(head.as_bytes())
}

fn respond(
    stream: &mut TcpStream,
    status: u16,
    reason: &str,
    kind: &str,
    body: &[u8],
    head_only: bool,
) -> std::io::Result<()> {
    write_head(stream, status, reason, kind, body.len() as u64)?;
    if !head_only {
        stream.write_all(body)?;
    }
    stream.flush()
}

fn respond_text(
    stream: &mut TcpStream,
    status: u16,
    reason: &str,
    text: &str,
    head_only: bool,
) -> std::io::Result<()> {
    respond(
        stream,
        status,
        reason,
        "text/plain; charset=utf-8",
        text.as_bytes(),
        head_only,
    )
}
