//! The connection to a TURN server: a UDP socket, a TCP stream, or TLS over TCP (`turns:`, typically port 443 on
//! networks that only allow web traffic). This is the I/O half; the TURN protocol itself is sans-IO
//! (`turn-client-proto`) and only ever sees bytes. TLS is rustls with full certificate and host name verification
//! ([`crate::tls`]); a failed handshake never falls back to plain TCP.

use std::net::{IpAddr, Ipv4Addr, SocketAddr};
use std::sync::Arc;
use std::time::Duration;

use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpStream, UdpSocket};

use super::failure::{tls_failure, TurnFailure, TurnFailureKind};
use crate::ice::{TurnServer, TurnTransport};
use crate::transport::RelayProtocol;

/// How long a TCP connection or a TLS handshake to the server may take.
pub(crate) const CONNECT_TIMEOUT: Duration = Duration::from_secs(6);

pub(crate) enum TurnIo {
    Udp {
        socket: UdpSocket,
        server: SocketAddr,
    },
    Tcp(TcpStream),
    Tls(Box<tokio_rustls::client::TlsStream<TcpStream>>),
}

/// The server's address: an IP as written, else the first IPv4 address its name resolves to.
pub(crate) async fn resolve(server: &TurnServer) -> Result<SocketAddr, TurnFailure> {
    if let Ok(ip) = server.host.parse::<IpAddr>() {
        return Ok(SocketAddr::new(ip, server.port));
    }
    let found = tokio::time::timeout(
        CONNECT_TIMEOUT,
        tokio::net::lookup_host((server.host.as_str(), server.port)),
    )
    .await
    .map_err(|_| TurnFailure::new(TurnFailureKind::Resolve))?
    .map_err(|_| TurnFailure::new(TurnFailureKind::Resolve))?;
    let all: Vec<SocketAddr> = found.collect();
    all.iter()
        .find(|addr| addr.is_ipv4())
        .or_else(|| all.first())
        .copied()
        .ok_or_else(|| TurnFailure::new(TurnFailureKind::Resolve))
}

/// How a configured server is reached.
pub fn protocol_of(server: &TurnServer) -> RelayProtocol {
    match (server.secure, server.transport) {
        (true, _) => RelayProtocol::Tls,
        (false, TurnTransport::Tcp) => RelayProtocol::Tcp,
        (false, TurnTransport::Udp) => RelayProtocol::Udp,
    }
}

impl TurnIo {
    pub(crate) async fn connect(
        server: &TurnServer,
        address: SocketAddr,
        tls: Option<Arc<rustls::ClientConfig>>,
    ) -> Result<Self, TurnFailure> {
        match protocol_of(server) {
            RelayProtocol::Udp => {
                let any = if address.is_ipv4() {
                    IpAddr::V4(Ipv4Addr::UNSPECIFIED)
                } else {
                    IpAddr::V6(std::net::Ipv6Addr::UNSPECIFIED)
                };
                let socket = UdpSocket::bind(SocketAddr::new(any, 0))
                    .await
                    .map_err(|_| TurnFailure::new(TurnFailureKind::Unreachable))?;
                Ok(TurnIo::Udp {
                    socket,
                    server: address,
                })
            }
            RelayProtocol::Tcp => Ok(TurnIo::Tcp(tcp(address).await?)),
            RelayProtocol::Tls => {
                let config = tls.ok_or_else(|| TurnFailure::new(TurnFailureKind::Tls))?;
                let name = rustls::pki_types::ServerName::try_from(server.host.clone())
                    .map_err(|_| TurnFailure::new(TurnFailureKind::HostnameMismatch))?;
                let stream = tcp(address).await?;
                let connector = tokio_rustls::TlsConnector::from(config);
                let tls = tokio::time::timeout(CONNECT_TIMEOUT, connector.connect(name, stream))
                    .await
                    .map_err(|_| TurnFailure::new(TurnFailureKind::Timeout))?
                    .map_err(|err| tls_failure(&err))?;
                Ok(TurnIo::Tls(Box::new(tls)))
            }
        }
    }

    pub(crate) fn local_addr(&self) -> std::io::Result<SocketAddr> {
        match self {
            TurnIo::Udp { socket, .. } => socket.local_addr(),
            TurnIo::Tcp(stream) => stream.local_addr(),
            TurnIo::Tls(stream) => stream.get_ref().0.local_addr(),
        }
    }

    pub(crate) fn server_addr(&self) -> std::io::Result<SocketAddr> {
        match self {
            TurnIo::Udp { server, .. } => Ok(*server),
            TurnIo::Tcp(stream) => stream.peer_addr(),
            TurnIo::Tls(stream) => stream.get_ref().0.peer_addr(),
        }
    }

    /// Reads what the server sent: one datagram (UDP; anything from another address is dropped), or the next bytes
    /// of the stream. `Ok(0)` means the stream ended. Cancel-safe.
    pub(crate) async fn read(&mut self, buf: &mut [u8]) -> std::io::Result<usize> {
        match self {
            TurnIo::Udp { socket, server } => loop {
                match socket.recv_from(buf).await {
                    Ok((n, from)) if from == *server => return Ok(n),
                    Ok(_) => {}
                    // Windows reports an ICMP "port unreachable" as a reset on the next receive.
                    Err(err) if err.kind() == std::io::ErrorKind::ConnectionReset => {}
                    Err(err) => return Err(err),
                }
            },
            TurnIo::Tcp(stream) => stream.read(buf).await,
            TurnIo::Tls(stream) => stream.read(buf).await,
        }
    }

    pub(crate) async fn write(&mut self, data: &[u8]) -> std::io::Result<()> {
        match self {
            TurnIo::Udp { socket, server } => socket.send_to(data, *server).await.map(|_| ()),
            TurnIo::Tcp(stream) => stream.write_all(data).await,
            TurnIo::Tls(stream) => stream.write_all(data).await,
        }
    }

    /// Closes a stream (TLS sends close_notify). UDP has nothing to close.
    pub(crate) async fn shutdown(&mut self) {
        let _ = match self {
            TurnIo::Udp { .. } => Ok(()),
            TurnIo::Tcp(stream) => stream.shutdown().await,
            TurnIo::Tls(stream) => stream.shutdown().await,
        };
    }
}

async fn tcp(address: SocketAddr) -> Result<TcpStream, TurnFailure> {
    let stream = tokio::time::timeout(CONNECT_TIMEOUT, TcpStream::connect(address))
        .await
        .map_err(|_| TurnFailure::new(TurnFailureKind::Timeout))?
        .map_err(|_| TurnFailure::new(TurnFailureKind::Unreachable))?;
    let _ = stream.set_nodelay(true);
    Ok(stream)
}
