//! The TURN client behind [`crate::relay::TurnRelay`]: long-term credentials, Allocate, Refresh, CreatePermission,
//! ChannelBind and Send/Data indications from `turn-client-proto` (sans-IO), driven over UDP, TCP or TLS by
//! [`io`]. Only this module names the library; the peer engine sees a [`crate::transport::RelayAllocation`].

mod credentials;
mod failure;
mod io;
mod session;
mod watch;

use std::sync::Arc;
use std::time::Duration;

pub use credentials::{StaticCredential, TurnCredentialSource, TurnLogin};
pub use failure::{TurnFailure, TurnFailureKind};
pub use io::protocol_of;

use crate::ice::TurnServer;
use crate::transport::RelayAllocation;

/// How long one allocation may take, from connecting to the server to the relayed address.
pub const ALLOCATE_TIMEOUT: Duration = Duration::from_secs(10);

/// Allocates a relay on `server` with `login`.
pub(crate) async fn allocate(
    server: &TurnServer,
    login: &TurnLogin,
    tls: Option<Arc<rustls::ClientConfig>>,
) -> Result<RelayAllocation, TurnFailure> {
    let deadline = tokio::time::Instant::now() + ALLOCATE_TIMEOUT;
    let protocol = io::protocol_of(server);
    let attempt = async {
        let address = io::resolve(server).await?;
        let connection = io::TurnIo::connect(server, address, tls).await?;
        let mut session =
            session::Session::new(connection, protocol, &login.username, &login.password)
                .map_err(|_| TurnFailure::new(TurnFailureKind::Unreachable))?;
        let relayed = session.allocate(deadline).await?;
        let local = session.local_addr();
        Ok::<_, TurnFailure>((relayed, local, session))
    };
    let (relayed, local, session) = tokio::time::timeout_at(deadline, attempt)
        .await
        .map_err(|_| TurnFailure::new(TurnFailureKind::Timeout))??;
    Ok(RelayAllocation {
        relayed,
        local,
        protocol,
        link: session::spawn(session),
    })
}
