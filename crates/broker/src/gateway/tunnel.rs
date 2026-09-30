//! A CONNECT tunnel for the tools that can't be pointed at a package gateway without writing their configuration:
//! Cargo (`CARGO_HTTP_PROXY`, read only by Cargo) and OpenMind's portable Composer (its launcher sets the proxy for
//! Composer's own process). The tunnel reaches the target the way the Download Manager would — through the proxy in
//! force (HTTP or SOCKS5, with the saved credentials, which never leave OpenMind) or directly — and then only relays
//! bytes: TLS stays end to end between the tool and the server, so the tool keeps verifying certificates itself.
//! Only port 443 is tunnelled, and only for a client that presents this run's token.

use std::io::{self, BufRead, BufReader, Read, Write};
use std::net::{Shutdown, TcpStream, ToSocketAddrs};
use std::sync::Arc;
use std::time::Duration;

use openmind_network::http::{route, Route};
use ureq::{Proxy, ProxyProtocol};

use super::http1::{write_error, Request};
use super::server::Shared;
use crate::events::{Phase, Reporter};
use crate::staging::Provider;

const CONNECT_TIMEOUT: Duration = Duration::from_secs(15);

pub fn base64(data: &[u8]) -> String {
    const TABLE: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::new();
    for chunk in data.chunks(3) {
        let b = [
            chunk[0],
            *chunk.get(1).unwrap_or(&0),
            *chunk.get(2).unwrap_or(&0),
        ];
        let n = (u32::from(b[0]) << 16) | (u32::from(b[1]) << 8) | u32::from(b[2]);
        for i in 0..4 {
            if i <= chunk.len() {
                out.push(TABLE[((n >> (18 - 6 * i)) & 63) as usize] as char);
            } else {
                out.push('=');
            }
        }
    }
    out
}

/// The tool a client identified as (the user name in its proxy address) when its token is right.
fn tool_of(request: &Request, token: &str) -> Option<Provider> {
    let given = request.header("proxy-authorization")?;
    [
        ("cargo", Provider::Cargo),
        ("composer", Provider::Composer),
        ("yarn", Provider::Yarn),
        ("pnpm", Provider::Pnpm),
    ]
    .into_iter()
    .find(|(user, _)| given == format!("Basic {}", base64(format!("{user}:{token}").as_bytes())))
    .map(|(_, provider)| provider)
}

/// `host:443` with a DNS name (never localhost or an address on this computer).
fn target(request: &Request) -> Option<(String, u16)> {
    let (host, port) = request.target.rsplit_once(':')?;
    let port: u16 = port.parse().ok()?;
    let valid = port == 443
        && !host.is_empty()
        && host.len() <= 253
        && host
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '-'))
        && !host.eq_ignore_ascii_case("localhost")
        && host
            .parse::<std::net::Ipv4Addr>()
            .map_or(true, |ip| !(ip.is_loopback() || ip.is_unspecified()));
    valid.then(|| (host.to_ascii_lowercase(), port))
}

/// Connects to `host:port`. A tunnel's target never resolves to this computer (`allow_loopback` false); a proxy may
/// run on it (a local authentication helper such as Px or CNTLM).
fn connect(host: &str, port: u16, allow_loopback: bool) -> io::Result<TcpStream> {
    let mut last = io::Error::new(io::ErrorKind::NotFound, "the name did not resolve");
    for address in (host, port).to_socket_addrs()? {
        if !allow_loopback && address.ip().is_loopback() {
            continue;
        }
        match TcpStream::connect_timeout(&address, CONNECT_TIMEOUT) {
            Ok(stream) => return Ok(stream),
            Err(err) => last = err,
        }
    }
    Err(last)
}

fn http_proxy(proxy: &Proxy, host: &str, port: u16) -> io::Result<TcpStream> {
    let mut stream = connect(proxy.host(), proxy.port(), true)
        .map_err(|err| io::Error::new(err.kind(), format!("proxy unavailable: {err}")))?;
    let mut head = format!("CONNECT {host}:{port} HTTP/1.1\r\nHost: {host}:{port}\r\n");
    if let Some(user) = proxy.username() {
        let pair = format!("{user}:{}", proxy.password().unwrap_or_default());
        head.push_str(&format!(
            "Proxy-Authorization: Basic {}\r\n",
            base64(pair.as_bytes())
        ));
    }
    head.push_str("\r\n");
    stream.write_all(head.as_bytes())?;
    stream.set_read_timeout(Some(Duration::from_secs(30)))?;
    let mut reader = BufReader::new(stream.try_clone()?);
    let mut status = String::new();
    reader.read_line(&mut status)?;
    let code = status
        .split(' ')
        .nth(1)
        .and_then(|c| c.parse::<u16>().ok())
        .unwrap_or(0);
    loop {
        let mut line = String::new();
        if reader.read_line(&mut line)? == 0 || line.trim().is_empty() {
            break;
        }
    }
    stream.set_read_timeout(None)?;
    match code {
        200 => Ok(stream),
        407 => Err(io::Error::new(
            io::ErrorKind::PermissionDenied,
            "proxy authentication required",
        )),
        other => Err(io::Error::other(format!(
            "the proxy refused the tunnel (HTTP {other})"
        ))),
    }
}

fn socks5(proxy: &Proxy, host: &str, port: u16) -> io::Result<TcpStream> {
    let mut stream = connect(proxy.host(), proxy.port(), true)
        .map_err(|err| io::Error::new(err.kind(), format!("proxy unavailable: {err}")))?;
    stream.set_read_timeout(Some(Duration::from_secs(30)))?;
    let user = proxy.username().unwrap_or_default();
    let password = proxy.password().unwrap_or_default();
    let method = if user.is_empty() { 0x00 } else { 0x02 };
    stream.write_all(&[0x05, 0x01, method])?;
    let mut reply = [0u8; 2];
    stream.read_exact(&mut reply)?;
    if reply[1] == 0x02 {
        let mut auth = vec![0x01, user.len() as u8];
        auth.extend_from_slice(user.as_bytes());
        auth.push(password.len() as u8);
        auth.extend_from_slice(password.as_bytes());
        stream.write_all(&auth)?;
        stream.read_exact(&mut reply)?;
        if reply[1] != 0 {
            return Err(io::Error::new(
                io::ErrorKind::PermissionDenied,
                "proxy authentication required",
            ));
        }
    } else if reply[1] != 0x00 {
        return Err(io::Error::new(
            io::ErrorKind::PermissionDenied,
            "the SOCKS proxy wants another login method",
        ));
    }
    let mut request = vec![0x05, 0x01, 0x00, 0x03, host.len() as u8];
    request.extend_from_slice(host.as_bytes());
    request.extend_from_slice(&port.to_be_bytes());
    stream.write_all(&request)?;
    let mut head = [0u8; 4];
    stream.read_exact(&mut head)?;
    if head[1] != 0 {
        return Err(io::Error::other(format!(
            "the SOCKS proxy refused the connection (code {})",
            head[1]
        )));
    }
    let skip = match head[3] {
        0x01 => 4 + 2,
        0x04 => 16 + 2,
        0x03 => {
            let mut len = [0u8; 1];
            stream.read_exact(&mut len)?;
            usize::from(len[0]) + 2
        }
        _ => {
            return Err(io::Error::other(
                "the SOCKS proxy sent an unknown address type",
            ))
        }
    };
    let mut rest = vec![0u8; skip];
    stream.read_exact(&mut rest)?;
    stream.set_read_timeout(None)?;
    Ok(stream)
}

/// Opens the connection the way OpenMind's own requests go.
fn open(host: &str, port: u16) -> io::Result<TcpStream> {
    let proxy = match route(&format!("https://{host}/")) {
        Route::Proxy(proxy) => Some(proxy),
        Route::Direct => None,
        Route::Unchanged => Proxy::try_from_env().filter(|proxy| {
            !format!("https://{host}/")
                .parse()
                .is_ok_and(|uri| proxy.is_no_proxy(&uri))
        }),
    };
    match proxy {
        None => connect(host, port, false),
        Some(proxy) => match proxy.protocol() {
            ProxyProtocol::Http => http_proxy(&proxy, host, port),
            ProxyProtocol::Socks5 | ProxyProtocol::Socks5h => socks5(&proxy, host, port),
            _ => Err(io::Error::new(
                io::ErrorKind::Unsupported,
                "tunnels through this kind of proxy are not supported (use an HTTP or SOCKS5 proxy)",
            )),
        },
    }
}

/// Serves one CONNECT request; the connection becomes the tunnel.
pub(crate) fn serve(
    shared: &Shared,
    request: &Request,
    reader: BufReader<TcpStream>,
    mut writer: TcpStream,
) {
    let Some(provider) = tool_of(request, &shared.token) else {
        let _ = writer.write_all(
            b"HTTP/1.1 407 Proxy Authentication Required\r\nProxy-Authenticate: Basic realm=\"OpenMind\"\r\nContent-Length: 0\r\nConnection: close\r\n\r\n",
        );
        return;
    };
    let Some((host, port)) = target(request) else {
        let _ = write_error(
            &mut writer,
            403,
            "only https hosts on port 443 are tunnelled",
        );
        return;
    };
    let mut reporter = Reporter::new(
        Arc::clone(shared.broker.events()),
        shared.broker.next_id(),
        provider,
        &host,
    );
    reporter.phase(Phase::Connecting);
    let upstream = match open(&host, port) {
        Ok(stream) => stream,
        Err(err) => {
            let kind = match err.kind() {
                io::ErrorKind::PermissionDenied => crate::error::FailureKind::ProxyAuthentication,
                io::ErrorKind::Unsupported => crate::error::FailureKind::Refused,
                _ if err.to_string().starts_with("proxy unavailable") => {
                    crate::error::FailureKind::ProxyUnavailable
                }
                _ => crate::error::FailureKind::Connection,
            };
            reporter.failed(kind, &err.to_string());
            tracing::warn!(%host, %err, "tunnel could not be opened");
            let _ = write_error(&mut writer, 502, &format!("{}: {err}", kind.label()));
            return;
        }
    };
    if writer
        .write_all(b"HTTP/1.1 200 Connection established\r\n\r\n")
        .is_err()
    {
        return;
    }
    reporter.phase(Phase::Downloading);
    let received = relay(reader, writer, upstream);
    reporter.bytes(received, Some(received));
    reporter.phase(Phase::Complete);
}

/// Copies both ways until either side closes; returns the bytes that came from the server.
fn relay(
    client_reader: BufReader<TcpStream>,
    mut client_writer: TcpStream,
    server: TcpStream,
) -> u64 {
    let Ok(mut server_writer) = server.try_clone() else {
        return 0;
    };
    let mut server_reader = server;
    let upload = std::thread::spawn(move || {
        let mut client_reader = client_reader;
        // Bytes the client sent right after CONNECT are already in the buffer.
        let pending = client_reader.buffer().to_vec();
        let _ = server_writer.write_all(&pending);
        let consumed = pending.len();
        client_reader.consume(consumed);
        let _ = io::copy(&mut client_reader, &mut server_writer);
        let _ = server_writer.shutdown(Shutdown::Write);
    });
    let received = io::copy(&mut server_reader, &mut client_writer).unwrap_or(0);
    let _ = client_writer.shutdown(Shutdown::Both);
    let _ = server_reader.shutdown(Shutdown::Both);
    let _ = upload.join();
    received
}

#[cfg(test)]
mod tests {
    use super::*;

    fn connect(target: &str, auth: Option<String>) -> Request {
        Request {
            method: "CONNECT".into(),
            target: target.into(),
            headers: auth
                .map(|a| vec![("Proxy-Authorization".into(), a)])
                .unwrap_or_default(),
            body: Vec::new(),
            close: false,
        }
    }

    #[test]
    fn base64_matches_the_standard() {
        assert_eq!(base64(b"cargo:tok"), "Y2FyZ286dG9r");
        assert_eq!(base64(b"a"), "YQ==");
        assert_eq!(base64(b"ab"), "YWI=");
        assert_eq!(base64(b""), "");
    }

    #[test]
    fn only_a_known_tool_with_this_runs_token_may_tunnel() {
        let token = "abc123";
        let ok = connect(
            "crates.io:443",
            Some(format!("Basic {}", base64(b"cargo:abc123"))),
        );
        assert_eq!(tool_of(&ok, token), Some(Provider::Cargo));
        let composer = connect(
            "repo.packagist.org:443",
            Some(format!("Basic {}", base64(b"composer:abc123"))),
        );
        assert_eq!(tool_of(&composer, token), Some(Provider::Composer));
        assert_eq!(
            tool_of(
                &connect("x:443", Some(format!("Basic {}", base64(b"cargo:wrong")))),
                token
            ),
            None
        );
        assert_eq!(
            tool_of(
                &connect("x:443", Some(format!("Basic {}", base64(b"curl:abc123")))),
                token
            ),
            None
        );
        assert_eq!(tool_of(&connect("x:443", None), token), None);
    }

    #[test]
    fn only_https_hosts_by_name_are_tunnelled() {
        assert_eq!(
            target(&connect("index.crates.io:443", None)),
            Some(("index.crates.io".into(), 443))
        );
        assert_eq!(target(&connect("index.crates.io:22", None)), None);
        assert_eq!(target(&connect("localhost:443", None)), None);
        assert_eq!(target(&connect("127.0.0.1:443", None)), None);
        assert_eq!(target(&connect("a b:443", None)), None);
    }
}
