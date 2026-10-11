//! TURN relaying behind [`RelayProvider`]: the configured servers, a [`TurnCredentialSource`] asked when an
//! allocation starts, and the order **TURN over UDP, then TCP, then TLS** (`turns:`, e.g. port 443 where only web
//! traffic leaves the network). Every server is tried at once; the best protocol that succeeds is used, waiting at
//! most [`BETTER_WAIT`] for a better one once any has succeeded. Attempts that aren't used finish and release their
//! allocation. The peer engine adds the relayed candidate next to its host and STUN ones, so ICE still prefers a
//! direct path; a relay is only the fallback (or the only path in the relay-only diagnostic mode).

use std::sync::Arc;
use std::time::{Duration, SystemTime};

use tokio::task::JoinSet;

use crate::error::NetError;
use crate::ice::TurnServer;
use crate::transport::{BoxFuture, RelayAllocation, RelayProtocol, RelayProvider, RelayStatus};
use crate::turn::{self, TurnCredentialSource, TurnFailure, TurnFailureKind, TurnLogin};

/// Once one server has given an allocation, how long a server with a better protocol may still take.
pub const BETTER_WAIT: Duration = Duration::from_millis(1500);

/// The configured TURN servers.
pub struct TurnRelay {
    servers: Vec<TurnServer>,
    credentials: Option<Arc<dyn TurnCredentialSource>>,
    tls_roots: Option<rustls::RootCertStore>,
}

impl TurnRelay {
    /// Servers without a login (nothing can be allocated until one is set with [`Self::with_credentials`]).
    pub fn new(servers: Vec<TurnServer>) -> Self {
        Self {
            servers,
            credentials: None,
            tls_roots: None,
        }
    }

    pub fn with_credentials(mut self, credentials: Arc<dyn TurnCredentialSource>) -> Self {
        self.credentials = Some(credentials);
        self
    }

    /// Trusts one more certificate authority for `turns:` servers, on top of the system and webpki roots (a private
    /// deployment's own CA, or a test CA). Certificate and host name verification stay on.
    pub fn with_tls_roots(mut self, roots: rustls::RootCertStore) -> Self {
        self.tls_roots = Some(roots);
        self
    }

    fn urls(&self) -> Vec<String> {
        self.servers.iter().map(TurnServer::url).collect()
    }

    async fn login(&self) -> Result<TurnLogin, TurnFailure> {
        let not_configured = || TurnFailure::new(TurnFailureKind::NotConfigured);
        let source = self.credentials.as_ref().ok_or_else(not_configured)?;
        let login = source
            .login()
            .await
            .map_err(|_| not_configured())?
            .ok_or_else(not_configured)?;
        if login.expired(SystemTime::now()) {
            return Err(TurnFailure::new(TurnFailureKind::CredentialExpired));
        }
        Ok(login)
    }

    async fn allocate_best(&self) -> Result<RelayAllocation, TurnFailure> {
        if self.servers.is_empty() {
            return Err(TurnFailure::new(TurnFailureKind::NotConfigured));
        }
        let login = self.login().await?;
        let tls = if self.servers.iter().any(|s| s.secure) {
            Some(
                crate::tls::client_config(self.tls_roots.as_ref())
                    .map_err(|_| TurnFailure::new(TurnFailureKind::Tls))?,
            )
        } else {
            None
        };
        let mut attempts = JoinSet::new();
        for server in self.servers.clone() {
            let (login, tls) = (login.clone(), tls.clone());
            attempts.spawn(async move {
                let protocol = turn::protocol_of(&server);
                (protocol, turn::allocate(&server, &login, tls).await)
            });
        }
        drop(login);
        let outcome = pick(
            &mut attempts,
            self.servers.iter().map(turn::protocol_of).collect(),
        )
        .await;
        // Unused attempts run to their end; an allocation they make is released when its link is dropped.
        attempts.detach_all();
        outcome
    }
}

/// Collects attempts until the best protocol still possible has answered (or [`BETTER_WAIT`] after a success).
async fn pick(
    attempts: &mut JoinSet<(RelayProtocol, Result<RelayAllocation, TurnFailure>)>,
    mut pending: Vec<RelayProtocol>,
) -> Result<RelayAllocation, TurnFailure> {
    let mut best: Option<RelayAllocation> = None;
    let mut failure: Option<TurnFailure> = None;
    let mut cutoff: Option<tokio::time::Instant> = None;
    loop {
        if let Some(found) = &best {
            if pending.iter().all(|p| *p >= found.protocol) {
                break;
            }
        }
        let next = match cutoff {
            Some(at) => match tokio::time::timeout_at(at, attempts.join_next()).await {
                Ok(next) => next,
                Err(_) => break,
            },
            None => attempts.join_next().await,
        };
        let Some(joined) = next else {
            break;
        };
        let Ok((protocol, result)) = joined else {
            continue;
        };
        if let Some(i) = pending.iter().position(|p| *p == protocol) {
            pending.swap_remove(i);
        }
        match result {
            Ok(allocation) => {
                if best
                    .as_ref()
                    .is_none_or(|b| allocation.protocol < b.protocol)
                {
                    best = Some(allocation);
                }
                cutoff.get_or_insert_with(|| tokio::time::Instant::now() + BETTER_WAIT);
            }
            Err(err) => {
                tracing::info!(%err, ?protocol, "a TURN server couldn't be used");
                if failure.is_none_or(|f| err.rank() >= f.rank()) {
                    failure = Some(err);
                }
            }
        }
    }
    best.ok_or_else(|| failure.unwrap_or(TurnFailure::new(TurnFailureKind::Timeout)))
}

impl RelayProvider for TurnRelay {
    fn status(&self) -> RelayStatus {
        if self.servers.is_empty() {
            return RelayStatus::NotConfigured;
        }
        if self.credentials.is_none() {
            return RelayStatus::Unavailable {
                servers: self.urls(),
                reason: TurnFailure::new(TurnFailureKind::NotConfigured).to_string(),
            };
        }
        RelayStatus::Available {
            servers: self.urls(),
        }
    }

    fn allocate(&self) -> BoxFuture<'_, Result<RelayAllocation, NetError>> {
        Box::pin(async move { self.allocate_best().await.map_err(NetError::Turn) })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ice::TurnTransport;
    use crate::turn::StaticCredential;

    fn server(port: u16, transport: TurnTransport, secure: bool) -> TurnServer {
        TurnServer {
            secure,
            host: "127.0.0.1".into(),
            port,
            transport,
        }
    }

    fn login(expires_at: Option<SystemTime>) -> Arc<StaticCredential> {
        Arc::new(StaticCredential(Some(TurnLogin {
            username: "u".into(),
            password: "secret".into(),
            expires_at,
            urls: None,
        })))
    }

    #[tokio::test]
    async fn status_and_missing_configuration_are_reported_without_secrets() {
        assert_eq!(
            TurnRelay::new(Vec::new()).status(),
            RelayStatus::NotConfigured
        );
        let relay = TurnRelay::new(vec![server(443, TurnTransport::Tcp, true)]);
        match relay.status() {
            RelayStatus::Unavailable { servers, reason } => {
                assert_eq!(
                    servers,
                    vec!["turns:127.0.0.1:443?transport=tcp".to_string()]
                );
                assert!(reason.contains("no TURN server or login"));
            }
            other => panic!("unexpected {other:?}"),
        }
        let err = relay.allocate().await.expect_err("no login");
        assert!(matches!(err, NetError::Turn(f) if f.kind == TurnFailureKind::NotConfigured));
        let ready = TurnRelay::new(vec![server(3478, TurnTransport::Udp, false)])
            .with_credentials(login(None));
        assert!(matches!(ready.status(), RelayStatus::Available { .. }));
    }

    #[tokio::test]
    async fn an_expired_credential_sends_nothing() {
        let past = SystemTime::now() - Duration::from_secs(5);
        let relay = TurnRelay::new(vec![server(9, TurnTransport::Udp, false)])
            .with_credentials(login(Some(past)));
        let err = relay.allocate().await.expect_err("expired");
        assert!(matches!(err, NetError::Turn(f) if f.kind == TurnFailureKind::CredentialExpired));
        assert!(!err.to_string().contains("secret"));
    }

    #[tokio::test]
    async fn an_unreachable_tcp_server_fails_fast_with_its_category() {
        // A port nothing listens on: the connection is refused at once (no hang, no secret in the message).
        let closed = std::net::TcpListener::bind("127.0.0.1:0").expect("bind");
        let port = closed.local_addr().expect("addr").port();
        drop(closed);
        let relay = TurnRelay::new(vec![server(port, TurnTransport::Tcp, false)])
            .with_credentials(login(None));
        let started = std::time::Instant::now();
        let err = relay.allocate().await.expect_err("refused");
        assert!(started.elapsed() < Duration::from_secs(8));
        assert!(
            matches!(err, NetError::Turn(f) if matches!(f.kind, TurnFailureKind::Unreachable | TurnFailureKind::Timeout)),
            "{err}"
        );
        assert!(!err.to_string().contains("secret"));
    }
}
