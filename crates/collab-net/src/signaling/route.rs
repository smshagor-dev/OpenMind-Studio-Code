//! How the signaling WebSocket reaches the relay: straight, or through the HTTP proxy OpenMind already uses for its
//! own requests (`openmind_network::http::current()`, the same no-proxy rules), with an HTTP `CONNECT` tunnel and
//! Basic credentials when set. `wss://` runs TLS (rustls with the `ring` provider; Windows' certificate store plus
//! the bundled web roots) inside that tunnel. An HTTPS-to-the-proxy or SOCKS proxy is not supported for signaling
//! yet and is reported as such. None of this carries WebRTC traffic: a proxy for signaling doesn't make peer
//! connections or TURN traverse it.

use std::sync::Arc;
use std::time::Duration;

use base64::engine::general_purpose::STANDARD as BASE64;
use base64::Engine as _;
use openmind_network::http::HttpProxy;
use openmind_network::proxy::{ProxyMode, Scheme};
use tokio::io::{AsyncBufReadExt, AsyncRead, AsyncWrite, AsyncWriteExt, BufReader};
use tokio::net::TcpStream;

use crate::error::NetError;

pub trait Io: AsyncRead + AsyncWrite + Unpin + Send {}
impl<T: AsyncRead + AsyncWrite + Unpin + Send> Io for T {}

/// A parsed `ws://` / `wss://` address.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Target {
    pub secure: bool,
    pub host: String,
    pub port: u16,
}

pub fn parse(url: &str) -> Result<Target, NetError> {
    let lower = url.to_ascii_lowercase();
    let (secure, rest) = if lower.starts_with("wss://") {
        (true, &url[6..])
    } else if lower.starts_with("ws://") {
        (false, &url[5..])
    } else {
        return Err(NetError::Config(
            "the signaling address must start with ws:// or wss://".into(),
        ));
    };
    let authority = rest.split(['/', '?', '#']).next().unwrap_or_default();
    let default = if secure { 443 } else { 80 };
    let (host, port) = if let Some(inner) = authority.strip_prefix('[') {
        let (host, after) = inner
            .split_once(']')
            .ok_or_else(|| NetError::Config("bad IPv6 address".into()))?;
        (
            host.to_string(),
            after
                .strip_prefix(':')
                .map_or(Ok(default), str::parse)
                .map_err(|_| NetError::Config("bad port".into()))?,
        )
    } else {
        match authority.rsplit_once(':') {
            Some((host, port)) => (
                host.to_string(),
                port.parse()
                    .map_err(|_| NetError::Config("bad port".into()))?,
            ),
            None => (authority.to_string(), default),
        }
    };
    if host.is_empty() || host.contains('@') {
        return Err(NetError::Config(
            "the signaling address has no usable host".into(),
        ));
    }
    Ok(Target { secure, host, port })
}

/// Opens the byte stream for the WebSocket: TCP (maybe tunnelled), then TLS for `wss://`.
pub async fn open(
    url: &str,
    proxy: Option<HttpProxy>,
    timeout: Duration,
) -> Result<Box<dyn Io>, NetError> {
    let target = parse(url)?;
    let via = proxy
        .as_ref()
        .filter(|p| p.resolved.mode != ProxyMode::None)
        .and_then(|p| {
            p.resolved
                .for_target(target.secure, &target.host)
                .map(|addr| (addr.clone(), p.credentials.clone()))
        });
    let connect = async {
        let tcp = match via {
            None => TcpStream::connect((target.host.as_str(), target.port)).await?,
            Some((proxy, credentials)) => {
                if proxy.scheme != Scheme::Http {
                    return Err(NetError::Config(
                        "signaling through an https:// or SOCKS proxy isn't supported yet; use an http:// proxy".into(),
                    ));
                }
                let tcp = TcpStream::connect((proxy.host.as_str(), proxy.port)).await?;
                tunnel(tcp, &target, credentials.as_ref()).await?
            }
        };
        tcp.set_nodelay(true)?;
        if target.secure {
            Ok(Box::new(tls(tcp, &target.host).await?) as Box<dyn Io>)
        } else {
            Ok(Box::new(tcp) as Box<dyn Io>)
        }
    };
    tokio::time::timeout(timeout, connect)
        .await
        .map_err(|_| NetError::Timeout("connecting to the signaling relay"))?
}

async fn tunnel(
    mut tcp: TcpStream,
    target: &Target,
    credentials: Option<&openmind_network::proxy::Credentials>,
) -> Result<TcpStream, NetError> {
    let authority = if target.host.contains(':') {
        format!("[{}]:{}", target.host, target.port)
    } else {
        format!("{}:{}", target.host, target.port)
    };
    let mut request = format!("CONNECT {authority} HTTP/1.1\r\nHost: {authority}\r\n");
    if let Some(c) = credentials.filter(|c| !c.username.is_empty()) {
        let token = BASE64.encode(format!("{}:{}", c.username, c.password));
        request.push_str(&format!("Proxy-Authorization: Basic {token}\r\n"));
    }
    request.push_str("\r\n");
    tcp.write_all(request.as_bytes()).await?;
    let mut reader = BufReader::new(tcp);
    let mut status = String::new();
    reader.read_line(&mut status).await?;
    let code = status
        .split_whitespace()
        .nth(1)
        .unwrap_or_default()
        .to_string();
    loop {
        let mut line = String::new();
        let n = reader.read_line(&mut line).await?;
        if n == 0 || line == "\r\n" || line == "\n" {
            break;
        }
    }
    match code.as_str() {
        "200" => Ok(reader.into_inner()),
        "407" => Err(NetError::Signaling(
            "the proxy requires a user name and password (Network settings)".into(),
        )),
        other => Err(NetError::Signaling(format!(
            "the proxy refused the tunnel (HTTP {other})"
        ))),
    }
}

fn client_config() -> Result<Arc<rustls::ClientConfig>, NetError> {
    crate::tls::client_config(None).map_err(|e| NetError::Signaling(e.to_string()))
}

async fn tls(
    tcp: TcpStream,
    host: &str,
) -> Result<tokio_rustls::client::TlsStream<TcpStream>, NetError> {
    let name = rustls::pki_types::ServerName::try_from(host.to_string())
        .map_err(|_| NetError::Config("the signaling host isn't a valid TLS name".into()))?;
    tokio_rustls::TlsConnector::from(client_config()?)
        .connect(name, tcp)
        .await
        .map_err(|e| NetError::Signaling(format!("TLS with the signaling relay failed: {e}")))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn addresses_parse_with_default_ports() {
        assert_eq!(
            parse("wss://signal.example.org/rooms").expect("ok"),
            Target {
                secure: true,
                host: "signal.example.org".into(),
                port: 443
            }
        );
        assert_eq!(
            parse("ws://127.0.0.1:8787").expect("ok"),
            Target {
                secure: false,
                host: "127.0.0.1".into(),
                port: 8787
            }
        );
        assert_eq!(parse("ws://[::1]:9").expect("ok").host, "::1");
        for bad in ["http://x", "ws://", "ws://user@host", "wss://host:notaport"] {
            assert!(parse(bad).is_err(), "{bad}");
        }
    }

    #[tokio::test]
    async fn a_connect_tunnel_passes_credentials_and_reports_refusals() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .expect("bind");
        let addr = listener.local_addr().expect("addr");
        let proxy = tokio::spawn(async move {
            let mut seen = Vec::new();
            for answer in [
                "HTTP/1.1 407 Proxy Authentication Required\r\n\r\n",
                "HTTP/1.1 200 Connection established\r\n\r\n",
            ] {
                let (stream, _) = listener.accept().await.expect("accept");
                let mut reader = BufReader::new(stream);
                let mut request = String::new();
                while !request.ends_with("\r\n\r\n") {
                    if reader.read_line(&mut request).await.expect("read") == 0 {
                        break;
                    }
                }
                seen.push(request);
                reader
                    .into_inner()
                    .write_all(answer.as_bytes())
                    .await
                    .expect("write");
            }
            seen
        });
        let target = parse("ws://relay.example:8787").expect("target");
        let creds = openmind_network::proxy::Credentials {
            username: "u".into(),
            password: "p".into(),
        };
        let first = tunnel(
            TcpStream::connect(addr).await.expect("tcp"),
            &target,
            Some(&creds),
        )
        .await;
        assert!(matches!(first, Err(NetError::Signaling(why)) if why.contains("user name")));
        let second = tunnel(TcpStream::connect(addr).await.expect("tcp"), &target, None).await;
        assert!(second.is_ok());
        let seen = proxy.await.expect("proxy");
        assert!(seen[0].starts_with("CONNECT relay.example:8787 HTTP/1.1"));
        assert!(seen[0].contains("Proxy-Authorization: Basic dTpw"));
        assert!(!seen[1].contains("Proxy-Authorization"));
    }
}
