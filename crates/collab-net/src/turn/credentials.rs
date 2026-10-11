//! Where a TURN login comes from. The relay asks a [`TurnCredentialSource`] each time it allocates, so the password
//! is read (the app decrypts its DPAPI-protected copy) only while relay connectivity is being set up, never kept in
//! room state, and never printed. A short-lived credential service (a TURN REST API style user name with an expiry,
//! possibly with its own server list) is another implementation of the same trait; the transport doesn't change.

use std::fmt;
use std::time::SystemTime;

use crate::error::NetError;
use crate::transport::BoxFuture;

/// One TURN login. `Debug` never shows the password.
#[derive(Clone, PartialEq, Eq)]
pub struct TurnLogin {
    pub username: String,
    pub password: String,
    /// When a short-lived credential stops being valid (`None`: a long-term credential).
    pub expires_at: Option<SystemTime>,
    /// Servers the credential belongs to (`None`: the configured ones). A short-lived credential service may hand
    /// out its own; they are validated like settings before use.
    pub urls: Option<Vec<String>>,
}

impl fmt::Debug for TurnLogin {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("TurnLogin")
            .field("username", &self.username)
            .field("password", &"****")
            .field("expires_at", &self.expires_at)
            .field("urls", &self.urls)
            .finish()
    }
}

impl TurnLogin {
    /// Whether the credential has expired at `now`.
    pub fn expired(&self, now: SystemTime) -> bool {
        self.expires_at.is_some_and(|at| at <= now)
    }
}

/// Supplies the TURN login when an allocation starts.
pub trait TurnCredentialSource: Send + Sync {
    /// The current login, or `Ok(None)` when none is configured.
    fn login(&self) -> BoxFuture<'_, Result<Option<TurnLogin>, NetError>>;
}

/// A fixed login (tests and examples; the app reads its stored one on demand).
pub struct StaticCredential(pub Option<TurnLogin>);

impl TurnCredentialSource for StaticCredential {
    fn login(&self) -> BoxFuture<'_, Result<Option<TurnLogin>, NetError>> {
        let login = self.0.clone();
        Box::pin(async move { Ok(login) })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;

    #[test]
    fn the_password_never_prints_and_expiry_is_checked() {
        let now = SystemTime::now();
        let login = TurnLogin {
            username: "class-7".into(),
            password: "hunter2".into(),
            expires_at: Some(now + Duration::from_secs(60)),
            urls: None,
        };
        let shown = format!("{login:?}");
        assert!(shown.contains("class-7") && !shown.contains("hunter2"));
        assert!(!login.expired(now));
        assert!(login.expired(now + Duration::from_secs(61)));
        let long_term = TurnLogin {
            expires_at: None,
            ..login
        };
        assert!(!long_term.expired(now + Duration::from_secs(1 << 30)));
    }
}
