use openmind_collab::protocol::Refusal;
use openmind_collab_signal::ErrorCode;

/// Every way collaboration networking can fail. Messages never contain secrets (codes, credentials) or SDP.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum NetError {
    #[error("Network error: {0}")]
    Io(String),
    #[error("The collaboration network settings can't be used: {0}")]
    Config(String),
    #[error("The signaling relay couldn't be reached: {0}")]
    Signaling(String),
    #[error("The signaling relay refused the request: {0:?}")]
    Relay(ErrorCode),
    #[error("WebRTC error: {0}")]
    Rtc(String),
    #[error("Timed out while {0}.")]
    Timeout(&'static str),
    #[error("The connection is closed.")]
    Closed,
    #[error("Protocol error: {0}")]
    Protocol(String),
    #[error("The room refused the connection: {0:?}")]
    Refused(Refusal),
    #[error("TURN relaying isn't available: {0}")]
    RelayUnavailable(String),
    /// A TURN relay couldn't be allocated or was lost (a category, never a server's own text or a credential).
    #[error("TURN relay: {0}")]
    Turn(crate::turn::TurnFailure),
    /// No route reached the room (nothing found on the local network and no Internet route, or every try failed).
    #[error("{0}")]
    NoRoute(String),
}

impl From<std::io::Error> for NetError {
    fn from(err: std::io::Error) -> Self {
        NetError::Io(err.to_string())
    }
}
