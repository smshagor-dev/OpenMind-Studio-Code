//! Why a TURN relay couldn't be used, as a category with a fixed, secret-free message. Nothing a server sends (its
//! reason phrase, its realm) and nothing from the credential ever goes into these messages.

use serde::Serialize;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum TurnFailureKind {
    /// No login is configured, or the server list is empty.
    NotConfigured,
    /// The short-lived credential's expiry time has passed (nothing was sent).
    CredentialExpired,
    /// The server address couldn't be resolved.
    Resolve,
    /// The TCP connection to the server was refused or couldn't be made.
    Unreachable,
    /// The server never answered in time.
    Timeout,
    /// The server's certificate isn't trusted (unknown issuer, expired, invalid).
    Certificate,
    /// The certificate is valid but not for the server name that was configured.
    HostnameMismatch,
    /// TLS failed for another reason.
    Tls,
    /// The server rejected the user name or password (wrong, or a short-lived credential that expired).
    Unauthorized,
    /// The server refused the allocation (forbidden, quota, capacity, or another error code).
    Refused,
    /// The server refused to let a peer address through.
    PermissionDenied,
    /// The allocation couldn't be refreshed and ended.
    RefreshFailed,
    /// The connection to the server ended after the allocation was made.
    Lost,
}

/// A categorized TURN failure; `code` is the STUN error code when the server sent one.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TurnFailure {
    pub kind: TurnFailureKind,
    pub code: Option<u16>,
}

impl TurnFailure {
    pub fn new(kind: TurnFailureKind) -> Self {
        Self { kind, code: None }
    }

    /// The category for a STUN error code from the server.
    pub fn from_code(code: u16) -> Self {
        let kind = match code {
            401 | 441 => TurnFailureKind::Unauthorized,
            _ => TurnFailureKind::Refused,
        };
        Self {
            kind,
            code: Some(code),
        }
    }

    pub fn message(&self) -> &'static str {
        match self.kind {
            TurnFailureKind::NotConfigured => "no TURN server or login is configured",
            TurnFailureKind::CredentialExpired => "the TURN credential has expired",
            TurnFailureKind::Resolve => "the TURN server's name couldn't be resolved",
            TurnFailureKind::Unreachable => "the TURN server couldn't be reached",
            TurnFailureKind::Timeout => "the TURN server didn't answer in time",
            TurnFailureKind::Certificate => "the TURN server's TLS certificate isn't trusted",
            TurnFailureKind::HostnameMismatch => {
                "the TURN server's TLS certificate is for a different name"
            }
            TurnFailureKind::Tls => "the TLS connection to the TURN server failed",
            TurnFailureKind::Unauthorized => {
                "the TURN server rejected the user name or password (wrong or expired)"
            }
            TurnFailureKind::Refused => "the TURN server refused the relay allocation",
            TurnFailureKind::PermissionDenied => "the TURN server refused a peer permission",
            TurnFailureKind::RefreshFailed => "the TURN allocation couldn't be refreshed",
            TurnFailureKind::Lost => "the connection to the TURN server was lost",
        }
    }

    /// Which of two failures says more (shown when every server failed).
    pub(crate) fn rank(&self) -> u8 {
        match self.kind {
            TurnFailureKind::NotConfigured => 0,
            TurnFailureKind::Timeout | TurnFailureKind::Unreachable | TurnFailureKind::Resolve => 1,
            TurnFailureKind::Lost | TurnFailureKind::RefreshFailed => 2,
            TurnFailureKind::Tls => 3,
            _ => 4,
        }
    }
}

impl std::fmt::Display for TurnFailure {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self.code {
            Some(code) => write!(f, "{} (error {code})", self.message()),
            None => f.write_str(self.message()),
        }
    }
}

/// Classifies a failed TLS handshake by the rustls error inside the I/O error.
pub(crate) fn tls_failure(err: &std::io::Error) -> TurnFailure {
    use rustls::{CertificateError, Error};
    let inner = err
        .get_ref()
        .and_then(|inner| inner.downcast_ref::<Error>());
    let kind = match inner {
        Some(Error::InvalidCertificate(
            CertificateError::NotValidForName | CertificateError::NotValidForNameContext { .. },
        )) => TurnFailureKind::HostnameMismatch,
        Some(Error::InvalidCertificate(_)) => TurnFailureKind::Certificate,
        Some(_) => TurnFailureKind::Tls,
        None if err.kind() == std::io::ErrorKind::TimedOut => TurnFailureKind::Timeout,
        None => TurnFailureKind::Tls,
    };
    TurnFailure::new(kind)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn codes_and_tls_errors_have_fixed_categories() {
        assert_eq!(
            TurnFailure::from_code(401).kind,
            TurnFailureKind::Unauthorized
        );
        assert_eq!(
            TurnFailure::from_code(441).kind,
            TurnFailureKind::Unauthorized
        );
        assert_eq!(TurnFailure::from_code(486).kind, TurnFailureKind::Refused);
        assert_eq!(
            TurnFailure::from_code(486).to_string(),
            "the TURN server refused the relay allocation (error 486)"
        );
        let name = std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            rustls::Error::InvalidCertificate(rustls::CertificateError::NotValidForName),
        );
        assert_eq!(tls_failure(&name).kind, TurnFailureKind::HostnameMismatch);
        let issuer = std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            rustls::Error::InvalidCertificate(rustls::CertificateError::UnknownIssuer),
        );
        assert_eq!(tls_failure(&issuer).kind, TurnFailureKind::Certificate);
        assert!(
            TurnFailure::from_code(401).rank() > TurnFailure::new(TurnFailureKind::Timeout).rank()
        );
    }
}
