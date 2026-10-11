//! The TURN login as the app stores it: the user name from Settings > Collaboration and the password DPAPI-protected
//! in `editor_settings`. [`StoredTurnLogin`] reads and decrypts it only when a TURN allocation starts, so no plaintext
//! copy lives in room state, the canonical collaboration state, a page, a log or the audit. The WebView's voice
//! service gets it the same way, only when the window that holds a call asks (`net_voice`).

use std::sync::Arc;

use openmind_collab_net::ice::IceSetup;
use openmind_collab_net::relay::TurnRelay;
use openmind_collab_net::transport::BoxFuture;
use openmind_collab_net::turn::{TurnCredentialSource, TurnLogin};
use openmind_collab_net::NetError;
use openmind_db::{Db, EditorSettingsRepository};

use crate::app_state::AppState;
use crate::secret;

pub(crate) struct StoredTurnLogin {
    db: Db,
    username: Option<String>,
}

impl StoredTurnLogin {
    pub(crate) fn new(state: &AppState) -> Self {
        Self::with(state.db.clone(), super::read_config(state).turn_username)
    }

    fn with(db: Db, username: Option<String>) -> Self {
        Self { db, username }
    }

    /// Whether a user name and password are saved (nothing is decrypted).
    pub(crate) async fn saved(&self) -> Result<bool, String> {
        if self.username.is_none() {
            return Ok(false);
        }
        let stored = EditorSettingsRepository::new(self.db.pool())
            .get(super::TURN_CREDENTIAL_KEY)
            .await
            .map_err(|err| err.to_string())?;
        Ok(stored.is_some())
    }

    /// The login now (decrypted for this call only); `None` when no user name or password is saved.
    pub(crate) async fn read(&self) -> Result<Option<TurnLogin>, String> {
        let Some(username) = self.username.clone() else {
            return Ok(None);
        };
        let stored = EditorSettingsRepository::new(self.db.pool())
            .get(super::TURN_CREDENTIAL_KEY)
            .await
            .map_err(|err| err.to_string())?;
        let Some(stored) = stored else {
            return Ok(None);
        };
        let password = secret::unprotect(&stored).map_err(|err| err.to_string())?;
        Ok(Some(TurnLogin {
            username,
            password,
            expires_at: None,
            urls: None,
        }))
    }
}

impl TurnCredentialSource for StoredTurnLogin {
    fn login(&self) -> BoxFuture<'_, Result<Option<TurnLogin>, NetError>> {
        Box::pin(async move {
            self.read().await.map_err(|err| {
                tracing::warn!(%err, "the stored TURN password can't be read");
                NetError::Config("the stored TURN password can't be read".into())
            })
        })
    }
}

/// The configured TURN servers with the stored login (nothing is read or decrypted until an allocation starts).
pub(crate) fn relay(state: &AppState, ice: &IceSetup) -> Arc<TurnRelay> {
    Arc::new(
        TurnRelay::new(ice.turn.clone()).with_credentials(Arc::new(StoredTurnLogin::new(state))),
    )
}

/// What TURN can do here, for diagnostics: whether servers and a login are set, and which protocols (never the host,
/// the user name or the password).
pub(crate) async fn diagnostics(state: &AppState) -> super::net::TurnDiagnostics {
    let config = super::read_config(state);
    let ice = IceSetup::from_config(&config);
    let mut protocols: Vec<_> = ice
        .turn
        .iter()
        .map(openmind_collab_net::turn::protocol_of)
        .collect();
    protocols.sort();
    protocols.dedup();
    let has_login = matches!(StoredTurnLogin::new(state).saved().await, Ok(true));
    let status = match (protocols.is_empty(), has_login) {
        (true, _) => "notConfigured",
        (false, false) => "noLogin",
        (false, true) => "configured",
    };
    super::net::TurnDiagnostics {
        status,
        protocols,
        relay_only: super::net::debug_ice_policy()
            == openmind_collab_net::ice::IcePolicy::RelayOnly,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn block<T>(future: impl std::future::Future<Output = T>) -> T {
        tauri::async_runtime::block_on(future)
    }

    #[test]
    fn the_password_is_stored_protected_and_read_only_when_asked() {
        let dir = tempfile::tempdir().expect("dir");
        block(async {
            let db = Db::connect(&dir.path().join("t.db")).await.expect("db");
            let repo = EditorSettingsRepository::new(db.pool());
            let protected = secret::protect("hunter2-turn").expect("protect");
            repo.set(super::super::TURN_CREDENTIAL_KEY, &protected)
                .await
                .expect("set");
            let stored = repo
                .get(super::super::TURN_CREDENTIAL_KEY)
                .await
                .expect("get")
                .expect("value");
            if cfg!(windows) {
                assert!(!stored.contains("hunter2-turn"), "DPAPI-protected at rest");
            }
            let source = StoredTurnLogin::with(db.clone(), Some("class-7".into()));
            assert!(source.saved().await.expect("saved"));
            let login = source.login().await.expect("login").expect("some");
            assert_eq!(
                (login.username.as_str(), login.password.as_str()),
                ("class-7", "hunter2-turn")
            );
            assert!(
                !format!("{login:?}").contains("hunter2"),
                "Debug never shows it"
            );
            // No user name: nothing is decrypted or returned.
            let nameless = StoredTurnLogin::with(db.clone(), None);
            assert!(nameless.login().await.expect("login").is_none());
            assert!(!nameless.saved().await.expect("saved"));
            db.pool().close().await;
        });
    }
}
