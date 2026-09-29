//! Why a broker operation failed, precisely enough to say what to do (never just "download failed").

use openmind_network::problem::{NetError, NetProblem};
use openmind_runtime_manager::RuntimeError;
use serde::Serialize;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum FailureKind {
    Dns,
    /// Nothing answered, the connection dropped, or the network has no route.
    Connection,
    Timeout,
    /// The TLS handshake failed for another reason than the certificate.
    Tls,
    /// The server's certificate wasn't trusted (a network that inspects HTTPS often causes this).
    Certificate,
    ProxyUnavailable,
    /// The proxy wants a user name and password (407).
    ProxyAuthentication,
    /// The server wants credentials (401).
    Authentication,
    /// The network or the server refused the address (403/451).
    Blocked,
    NotFound,
    /// The registry answered with a server error (5xx).
    Registry,
    /// Another HTTP status.
    Http,
    /// The file isn't the one the index promised (SHA-256).
    Checksum,
    /// A package's integrity record doesn't match (verified by the tool itself; reported when it says so).
    Integrity,
    /// The registry's answer couldn't be read.
    InvalidMetadata,
    /// A Git remote refused the request or isn't a Git repository.
    GitRemote,
    DiskFull,
    PermissionDenied,
    Cancelled,
    /// The request itself isn't allowed (an address that isn't https, a path the gateway doesn't serve).
    Refused,
    Other,
}

impl FailureKind {
    pub fn from_net(error: &NetError) -> FailureKind {
        match error.problem {
            NetProblem::Dns => FailureKind::Dns,
            NetProblem::Timeout => FailureKind::Timeout,
            NetProblem::ConnectionFailed | NetProblem::Unreachable | NetProblem::Io => {
                FailureKind::Connection
            }
            NetProblem::ProxyUnavailable => FailureKind::ProxyUnavailable,
            NetProblem::ProxyAuthRequired => FailureKind::ProxyAuthentication,
            NetProblem::Tls if error.detail.to_ascii_lowercase().contains("certificate") => {
                FailureKind::Certificate
            }
            NetProblem::Tls => FailureKind::Tls,
            NetProblem::Blocked => FailureKind::Blocked,
            NetProblem::NotFound => FailureKind::NotFound,
            NetProblem::Http => match error.status {
                Some(401) => FailureKind::Authentication,
                Some(status) if status >= 500 => FailureKind::Registry,
                _ => FailureKind::Http,
            },
            NetProblem::Checksum => FailureKind::Checksum,
            NetProblem::InsecureUrl => FailureKind::Refused,
            NetProblem::Cancelled => FailureKind::Cancelled,
            NetProblem::Other => FailureKind::Other,
        }
    }

    /// The category of a local file error (Windows: 112 and 39 are "disk full").
    pub fn from_io(error: &std::io::Error) -> FailureKind {
        if matches!(error.raw_os_error(), Some(112) | Some(39))
            || error.kind() == std::io::ErrorKind::StorageFull
        {
            FailureKind::DiskFull
        } else if error.kind() == std::io::ErrorKind::PermissionDenied {
            FailureKind::PermissionDenied
        } else {
            FailureKind::Other
        }
    }

    /// A short English label for logs and error text.
    pub fn label(self) -> &'static str {
        match self {
            FailureKind::Dns => "DNS lookup failed",
            FailureKind::Connection => "connection failed",
            FailureKind::Timeout => "timed out",
            FailureKind::Tls => "TLS handshake failed",
            FailureKind::Certificate => "certificate not trusted",
            FailureKind::ProxyUnavailable => "proxy unavailable",
            FailureKind::ProxyAuthentication => "proxy authentication required",
            FailureKind::Authentication => "authentication required",
            FailureKind::Blocked => "blocked by the network or server",
            FailureKind::NotFound => "not found",
            FailureKind::Registry => "registry error",
            FailureKind::Http => "HTTP error",
            FailureKind::Checksum => "checksum mismatch",
            FailureKind::Integrity => "integrity check failed",
            FailureKind::InvalidMetadata => "invalid metadata",
            FailureKind::GitRemote => "Git remote error",
            FailureKind::DiskFull => "disk full",
            FailureKind::PermissionDenied => "permission denied",
            FailureKind::Cancelled => "cancelled",
            FailureKind::Refused => "request not allowed",
            FailureKind::Other => "failed",
        }
    }

    /// The HTTP status the gateway answers a tool with, so the tool reports it in its own words.
    pub fn gateway_status(self, upstream: Option<u16>) -> u16 {
        match self {
            FailureKind::NotFound => upstream.unwrap_or(404),
            FailureKind::Authentication => 401,
            FailureKind::Blocked => upstream.unwrap_or(403),
            FailureKind::Refused => 403,
            FailureKind::Timeout => 504,
            FailureKind::Http | FailureKind::Registry => upstream.unwrap_or(502),
            _ => 502,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, thiserror::Error)]
#[serde(rename_all = "camelCase")]
#[error("{} ({})", .kind.label(), .detail)]
pub struct BrokerError {
    pub kind: FailureKind,
    pub detail: String,
    pub status: Option<u16>,
}

impl BrokerError {
    pub fn new(kind: FailureKind, detail: impl Into<String>) -> Self {
        BrokerError {
            kind,
            detail: detail.into(),
            status: None,
        }
    }

    pub fn net(error: &NetError) -> Self {
        BrokerError {
            kind: FailureKind::from_net(error),
            detail: error.detail.clone(),
            status: error.status,
        }
    }

    pub fn io(error: &std::io::Error, what: &str) -> Self {
        BrokerError::new(FailureKind::from_io(error), format!("{what}: {error}"))
    }

    pub fn runtime(error: &RuntimeError) -> Self {
        match error {
            RuntimeError::Network(net) => BrokerError::net(net),
            RuntimeError::ChecksumMismatch { .. } => {
                BrokerError::new(FailureKind::Checksum, error.to_string())
            }
            RuntimeError::InsecureUrl(_) => {
                BrokerError::new(FailureKind::Refused, error.to_string())
            }
            RuntimeError::Io { source, .. } => BrokerError::io(source, &error.to_string()),
            other => BrokerError::new(FailureKind::Other, other.to_string()),
        }
    }

    /// The network problem this is, for retry decisions and the existing failure card.
    pub fn problem(&self) -> NetProblem {
        match self.kind {
            FailureKind::Dns => NetProblem::Dns,
            FailureKind::Connection => NetProblem::ConnectionFailed,
            FailureKind::Timeout => NetProblem::Timeout,
            FailureKind::Tls | FailureKind::Certificate => NetProblem::Tls,
            FailureKind::ProxyUnavailable => NetProblem::ProxyUnavailable,
            FailureKind::ProxyAuthentication => NetProblem::ProxyAuthRequired,
            FailureKind::Blocked => NetProblem::Blocked,
            FailureKind::NotFound => NetProblem::NotFound,
            FailureKind::Checksum | FailureKind::Integrity => NetProblem::Checksum,
            FailureKind::Cancelled => NetProblem::Cancelled,
            FailureKind::Refused => NetProblem::InsecureUrl,
            FailureKind::Authentication | FailureKind::Registry | FailureKind::Http => {
                NetProblem::Http
            }
            _ => NetProblem::Other,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn network_problems_map_to_specific_kinds() {
        let tls = NetError::new(NetProblem::Tls, "invalid peer certificate: UnknownIssuer");
        assert_eq!(FailureKind::from_net(&tls), FailureKind::Certificate);
        let handshake = NetError::new(NetProblem::Tls, "received corrupt message");
        assert_eq!(FailureKind::from_net(&handshake), FailureKind::Tls);
        assert_eq!(
            FailureKind::from_net(&NetError::status(503, "https://r")),
            FailureKind::Registry
        );
        assert_eq!(
            FailureKind::from_net(&NetError::status(400, "https://r")),
            FailureKind::Http
        );
        assert_eq!(
            FailureKind::from_net(&NetError::status(407, "https://r")),
            FailureKind::ProxyAuthentication
        );
        assert_eq!(
            FailureKind::from_net(&NetError::status(401, "https://r")),
            FailureKind::Authentication
        );
    }

    #[test]
    fn disk_full_and_permission_are_told_apart() {
        let full = std::io::Error::from_raw_os_error(112);
        assert_eq!(FailureKind::from_io(&full), FailureKind::DiskFull);
        let denied = std::io::Error::from(std::io::ErrorKind::PermissionDenied);
        assert_eq!(FailureKind::from_io(&denied), FailureKind::PermissionDenied);
    }

    #[test]
    fn a_checksum_mismatch_from_the_download_manager_stays_a_checksum_failure() {
        let error = RuntimeError::ChecksumMismatch {
            expected: "aa".into(),
            actual: "bb".into(),
        };
        assert_eq!(BrokerError::runtime(&error).kind, FailureKind::Checksum);
    }
}
