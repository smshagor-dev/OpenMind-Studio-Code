//! Credentials for Git remotes that ask for them. The gateway sits between Git and the real host, so a `401` from the
//! host must not reach Git (it would ask for credentials for `127.0.0.1`). Instead the gateway asks the user's own Git
//! credential helper for the **real** host — exactly the `git credential fill / approve / reject` exchange Git runs
//! itself — and sends the request again. Credentials live in memory only for a short while (whatever the helper stores
//! is the helper's business), are never logged, never put in an event or a diagnostics file, and only ever go to the
//! host they belong to.

use std::collections::HashMap;
use std::fmt;
use std::sync::Mutex;
use std::time::{Duration, Instant};

use super::tunnel::base64;

/// What a credential is for: the real remote (`https`, `github.com`, `user/repo.git`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CredentialRequest {
    pub protocol: String,
    pub host: String,
    pub path: String,
}

#[derive(Clone, PartialEq, Eq)]
pub struct Credential {
    pub username: String,
    pub password: String,
}

impl fmt::Debug for Credential {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("Credential(****)")
    }
}

impl Credential {
    /// The `Authorization` value for HTTP Basic (a token goes in the password, as Git sends it).
    pub fn basic(&self) -> String {
        format!(
            "Basic {}",
            base64(format!("{}:{}", self.username, self.password).as_bytes())
        )
    }
}

/// The user's credential helper (the app runs `git credential`).
pub trait CredentialSource: Send + Sync {
    /// Credentials for `request`, or why there are none (no helper, the prompt was cancelled ...) — never a secret.
    fn fill(&self, request: &CredentialRequest) -> Result<Credential, String>;
    /// The host accepted them (the helper may store them).
    fn approve(&self, request: &CredentialRequest, credential: &Credential);
    /// The host refused them (the helper forgets them: an expired token isn't offered again).
    fn reject(&self, request: &CredentialRequest, credential: &Credential);
}

/// No helper at all (tests, or a gateway without Git).
pub struct NoCredentials;

impl CredentialSource for NoCredentials {
    fn fill(&self, request: &CredentialRequest) -> Result<Credential, String> {
        Err(format!(
            "no Git credential helper is available to sign in to {}",
            request.host
        ))
    }
    fn approve(&self, _request: &CredentialRequest, _credential: &Credential) {}
    fn reject(&self, _request: &CredentialRequest, _credential: &Credential) {}
}

/// How long accepted credentials are reused without asking the helper again.
const REUSE: Duration = Duration::from_secs(15 * 60);

/// Accepted credentials by host, in memory only.
#[derive(Default)]
pub struct CredentialCache {
    entries: Mutex<HashMap<String, (Credential, Instant)>>,
}

impl CredentialCache {
    pub fn get(&self, host: &str) -> Option<Credential> {
        let mut entries = self.entries.lock().ok()?;
        match entries.get(host) {
            Some((credential, at)) if at.elapsed() < REUSE => Some(credential.clone()),
            Some(_) => {
                entries.remove(host);
                None
            }
            None => None,
        }
    }

    pub fn put(&self, host: &str, credential: Credential) {
        if let Ok(mut entries) = self.entries.lock() {
            entries.insert(host.to_string(), (credential, Instant::now()));
        }
    }

    pub fn forget(&self, host: &str) {
        if let Ok(mut entries) = self.entries.lock() {
            entries.remove(host);
        }
    }

    pub fn clear(&self) {
        if let Ok(mut entries) = self.entries.lock() {
            entries.clear();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_credential_never_prints_its_secret() {
        let credential = Credential {
            username: "ivan".into(),
            password: "ghp_secret".into(),
        };
        assert_eq!(format!("{credential:?}"), "Credential(****)");
        assert_eq!(
            credential.basic(),
            format!("Basic {}", base64(b"ivan:ghp_secret"))
        );
    }

    #[test]
    fn the_cache_is_per_host_and_forgets() {
        let cache = CredentialCache::default();
        let credential = Credential {
            username: "a".into(),
            password: "b".into(),
        };
        cache.put("github.com", credential.clone());
        assert_eq!(cache.get("github.com"), Some(credential));
        assert_eq!(cache.get("gitlab.com"), None);
        cache.forget("github.com");
        assert_eq!(cache.get("github.com"), None);
    }
}
