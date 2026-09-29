//! Listening, connection handling and routing.

use std::collections::HashMap;
use std::io::{self, BufReader, Write};
use std::net::{Shutdown, TcpListener, TcpStream};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex, RwLock};
use std::time::Duration;

use super::credentials::{CredentialCache, CredentialSource, NoCredentials};
use super::http1::{expects_continue, read_body, read_head, write_error, BodyReader, Request};
use super::upstream::Upstream;
use super::{fetch, pypi};
use crate::broker::Broker;

/// Where the gateway fetches from (the public registries unless a caller changes them).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GatewayConfig {
    pub pypi_index: String,
    pub pypi_files: String,
    pub npm_registry: String,
    pub go_proxy: String,
}

impl Default for GatewayConfig {
    fn default() -> Self {
        GatewayConfig {
            pypi_index: "https://pypi.org/simple/".into(),
            pypi_files: "https://files.pythonhosted.org/".into(),
            npm_registry: "https://registry.npmjs.org/".into(),
            go_proxy: "https://proxy.golang.org/".into(),
        }
    }
}

/// At most this many connections are served at once; more get "503 busy".
const MAX_CONNECTIONS: usize = 128;
const IDLE: Duration = Duration::from_secs(30);
/// Hashes remembered from index pages (for checking the files pip asks for next).
const MAX_HASHES: usize = 200_000;

pub(crate) struct Shared {
    pub broker: Arc<Broker>,
    pub upstream: Arc<dyn Upstream>,
    pub config: GatewayConfig,
    pub token: String,
    pub port: u16,
    pub npm_port: u16,
    pub stop: AtomicBool,
    /// The user's credential helper, for Git remotes that ask for credentials.
    pub credentials: Arc<dyn CredentialSource>,
    /// Credentials the remotes accepted, in memory only.
    pub git_credentials: CredentialCache,
    /// The Go module proxy fetched from (changes with the setting, no restart).
    go_proxy: RwLock<String>,
    active: AtomicUsize,
    hashes: Mutex<HashMap<String, String>>,
}

impl Shared {
    /// `http://127.0.0.1:<port>/<token>`.
    pub fn base(&self) -> String {
        format!("http://127.0.0.1:{}/{}", self.port, self.token)
    }

    pub fn remember_hash(&self, url: &str, sha256: &str) {
        if let Ok(mut map) = self.hashes.lock() {
            if map.len() >= MAX_HASHES {
                map.clear();
            }
            map.insert(url.to_string(), sha256.to_ascii_lowercase());
        }
    }

    pub fn hash_of(&self, url: &str) -> Option<String> {
        self.hashes.lock().ok()?.get(url).cloned()
    }

    pub fn go_proxy(&self) -> String {
        self.go_proxy
            .read()
            .map(|value| value.clone())
            .unwrap_or_else(|_| self.config.go_proxy.clone())
    }
}

pub struct Gateway {
    shared: Arc<Shared>,
}

fn token() -> io::Result<String> {
    let mut bytes = [0u8; 16];
    getrandom::fill(&mut bytes).map_err(|err| io::Error::other(err.to_string()))?;
    Ok(bytes.iter().map(|b| format!("{b:02x}")).collect())
}

impl Gateway {
    /// Binds two loopback ports (the gateway, and npm's registry at the root of its own port) and starts serving,
    /// without a credential helper.
    pub fn start(
        broker: Arc<Broker>,
        upstream: Arc<dyn Upstream>,
        config: GatewayConfig,
    ) -> io::Result<Gateway> {
        Self::start_with(broker, upstream, config, Arc::new(NoCredentials))
    }

    /// `start`, with the user's credential helper for Git remotes that ask for credentials.
    pub fn start_with(
        broker: Arc<Broker>,
        upstream: Arc<dyn Upstream>,
        config: GatewayConfig,
        credentials: Arc<dyn CredentialSource>,
    ) -> io::Result<Gateway> {
        let main = TcpListener::bind(("127.0.0.1", 0))?;
        let npm = TcpListener::bind(("127.0.0.1", 0))?;
        let shared = Arc::new(Shared {
            broker,
            upstream,
            go_proxy: RwLock::new(config.go_proxy.clone()),
            config,
            credentials,
            git_credentials: CredentialCache::default(),
            token: token()?,
            port: main.local_addr()?.port(),
            npm_port: npm.local_addr()?.port(),
            stop: AtomicBool::new(false),
            active: AtomicUsize::new(0),
            hashes: Mutex::new(HashMap::new()),
        });
        for (listener, npm) in [(main, false), (npm, true)] {
            let shared = Arc::clone(&shared);
            std::thread::Builder::new()
                .name(if npm { "gateway-npm" } else { "gateway" }.into())
                .spawn(move || accept_loop(listener, shared, npm))?;
        }
        tracing::info!(
            port = shared.port,
            npm_port = shared.npm_port,
            "package gateway listening on 127.0.0.1"
        );
        Ok(Gateway { shared })
    }

    pub fn port(&self) -> u16 {
        self.shared.port
    }

    pub fn npm_port(&self) -> u16 {
        self.shared.npm_port
    }

    pub fn token(&self) -> &str {
        &self.shared.token
    }

    /// `http://127.0.0.1:<port>/<token>`.
    pub fn base(&self) -> String {
        self.shared.base()
    }

    pub fn broker(&self) -> &Arc<Broker> {
        &self.shared.broker
    }

    /// The Go module proxy to fetch from from now on (an https address; anything else keeps the current one).
    pub fn set_go_proxy(&self, url: &str) -> bool {
        let url = url.trim();
        if !url.starts_with("https://") || url.contains(['@', ' ', ',', '|']) {
            return false;
        }
        match self.shared.go_proxy.write() {
            Ok(mut current) => {
                if *current != url {
                    tracing::info!(upstream = %url, "go module proxy changed");
                    *current = url.to_string();
                }
                true
            }
            Err(_) => false,
        }
    }

    /// The Go module proxy fetched from.
    pub fn go_proxy(&self) -> String {
        self.shared.go_proxy()
    }

    /// Forgets the credentials remotes accepted this session (the helper keeps what it stores).
    pub fn forget_credentials(&self) {
        self.shared.git_credentials.clear();
    }

    /// Stops accepting connections and cancels running downloads.
    pub fn stop(&self) {
        if self.shared.stop.swap(true, Ordering::SeqCst) {
            return;
        }
        self.shared.broker.cancel_all();
        for port in [self.shared.port, self.shared.npm_port] {
            // Wake the accept loops so they see the flag.
            let _ = TcpStream::connect_timeout(
                &std::net::SocketAddr::from(([127, 0, 0, 1], port)),
                Duration::from_millis(200),
            );
        }
    }
}

impl Drop for Gateway {
    fn drop(&mut self) {
        self.stop();
    }
}

fn accept_loop(listener: TcpListener, shared: Arc<Shared>, npm: bool) {
    for stream in listener.incoming() {
        if shared.stop.load(Ordering::SeqCst) {
            break;
        }
        let Ok(stream) = stream else { continue };
        if shared.active.fetch_add(1, Ordering::SeqCst) >= MAX_CONNECTIONS {
            shared.active.fetch_sub(1, Ordering::SeqCst);
            let mut stream = stream;
            let _ = write_error(&mut stream, 503, "too many connections at once; try again");
            continue;
        }
        let shared = Arc::clone(&shared);
        let spawned = std::thread::Builder::new()
            .name("gateway-conn".into())
            .spawn({
                let shared = Arc::clone(&shared);
                move || {
                    serve(stream, &shared, npm);
                    shared.active.fetch_sub(1, Ordering::SeqCst);
                }
            });
        if spawned.is_err() {
            shared.active.fetch_sub(1, Ordering::SeqCst);
        }
    }
}

/// The request is addressed to this gateway (`Host: 127.0.0.1:<port>` or `localhost:<port>`).
fn host_ok(request: &Request, port: u16) -> bool {
    let Some(host) = request.header("host") else {
        return false;
    };
    let host = host.to_ascii_lowercase();
    host == format!("127.0.0.1:{port}") || host == format!("localhost:{port}")
}

/// Compares without stopping at the first difference.
fn same(a: &str, b: &str) -> bool {
    a.len() == b.len()
        && a.bytes()
            .zip(b.bytes())
            .fold(0u8, |acc, (x, y)| acc | (x ^ y))
            == 0
}

fn serve(stream: TcpStream, shared: &Shared, npm: bool) {
    let _ = stream.set_read_timeout(Some(IDLE));
    let _ = stream.set_nodelay(true);
    let port = if npm { shared.npm_port } else { shared.port };
    let Ok(mut writer) = stream.try_clone() else {
        return;
    };
    let mut reader = BufReader::new(stream);
    loop {
        let (mut request, kind) = match read_head(&mut reader) {
            Ok(Some(head)) => head,
            Ok(None) => return,
            Err(err) => {
                if err.kind() == io::ErrorKind::InvalidData {
                    let _ = write_error(&mut writer, 400, &err.to_string());
                }
                return;
            }
        };
        if shared.stop.load(Ordering::SeqCst) {
            let _ = write_error(&mut writer, 503, "OpenMind Studio is closing");
            return;
        }
        if request.method == "CONNECT" && !npm {
            // A CONNECT names its target in Host; the token in Proxy-Authorization is what admits it.
            let _ = reader.get_ref().set_read_timeout(None);
            super::tunnel::serve(shared, &request, reader, writer);
            return;
        }
        if !host_ok(&request, port) {
            let _ = write_error(&mut writer, 403, "requests must be addressed to 127.0.0.1");
            return;
        }
        if expects_continue(&request, kind)
            && writer.write_all(b"HTTP/1.1 100 Continue\r\n\r\n").is_err()
        {
            return;
        }
        tracing::debug!(method = %request.method, path = %redact_token(request.path(), &shared.token), npm, "gateway request");
        if !npm && is_push(&request) {
            // A push body is streamed to the remote as it arrives; the connection ends with it.
            let mut body = BodyReader::new(&mut reader, kind);
            let _ = route_push(shared, &request, &mut body, &mut writer);
            let _ = writer.shutdown(Shutdown::Both);
            return;
        }
        request.body = match read_body(&mut reader, kind) {
            Ok(body) => body,
            Err(err) => {
                let _ = write_error(&mut writer, 413, &err.to_string());
                return;
            }
        };
        let result = if npm {
            super::npm::handle(shared, &request, &mut writer)
        } else {
            route(shared, &request, &mut writer)
        };
        if result.is_err() || request.close {
            let _ = writer.shutdown(Shutdown::Both);
            return;
        }
    }
}

/// `POST <token>/git/.../git-receive-pack`.
fn is_push(request: &Request) -> bool {
    request.method == "POST"
        && request.path().contains("/git/")
        && request.path().ends_with("/git-receive-pack")
}

/// The token-checked part of a path: `(section, rest)`.
fn session<'a>(shared: &Shared, path: &'a str) -> Option<(&'a str, &'a str)> {
    let (given, rest) = path.strip_prefix('/').and_then(|p| p.split_once('/'))?;
    if !same(given, &shared.token) {
        return None;
    }
    Some(rest.split_once('/').unwrap_or((rest, "")))
}

fn route_push(
    shared: &Shared,
    request: &Request,
    body: &mut BodyReader<'_>,
    out: &mut dyn Write,
) -> io::Result<()> {
    match session(shared, request.path()) {
        Some(("git", rest)) => super::git::handle_push(shared, request, rest, body, out),
        _ => write_error(out, 403, "unknown session"),
    }
}

/// A path for the log, with the session token hidden.
fn redact_token(path: &str, token: &str) -> String {
    path.replace(token, "<token>")
}

fn route(shared: &Shared, request: &Request, out: &mut dyn Write) -> io::Result<()> {
    let Some((section, rest)) = session(shared, request.path()) else {
        return write_error(out, 403, "unknown session");
    };
    match section {
        "status" => super::http1::write_full(out, 200, &[], b"ok"),
        "pypi" => pypi::handle(shared, request, rest, out),
        "fetch" => fetch::handle(shared, request, out),
        "git" => super::git::handle(shared, request, rest, out),
        "go" => super::goproxy::handle(shared, request, rest, out),
        _ => write_error(out, 404, "not served"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_requests_addressed_to_the_gateway_are_served() {
        let request = |host: Option<&str>| Request {
            method: "GET".into(),
            target: "/".into(),
            headers: host
                .map(|h| vec![("Host".into(), h.into())])
                .unwrap_or_default(),
            body: Vec::new(),
            close: false,
        };
        assert!(host_ok(&request(Some("127.0.0.1:4000")), 4000));
        assert!(host_ok(&request(Some("LOCALHOST:4000")), 4000));
        assert!(!host_ok(&request(Some("127.0.0.1:4001")), 4000));
        assert!(!host_ok(&request(Some("evil.example:4000")), 4000));
        assert!(!host_ok(&request(None), 4000));
    }

    #[test]
    fn token_comparison_needs_the_whole_token() {
        assert!(same("abc", "abc"));
        assert!(!same("abc", "abd"));
        assert!(!same("abc", "ab"));
    }
}
