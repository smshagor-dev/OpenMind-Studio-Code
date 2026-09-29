//! Network: proxy settings, the proxy environment for processes OpenMind starts, the proxy of OpenMind's own
//! HTTP requests, the credentials (DPAPI) and the connection test. Nothing here changes Windows' proxy, PATH, the
//! Registry or a tool's global configuration, and nothing contacts the network except `network_test`.

use std::collections::HashMap;
use std::path::Path;

use openmind_db::EditorSettingsRepository;
use openmind_network::diagnostics::{diagnose_settings, Diagnostic};
use openmind_network::env::file_url;
use openmind_network::http::{self, HttpProxy};
use openmind_network::probe::{test_connection, TestOutcome};
use openmind_network::proxy::{
    resolve_manual, Credentials, ProxyMode, ProxySettings, ProxySource, ResolvedProxy,
};
use openmind_network::system;
use openmind_settings::schema::Extras;
use openmind_settings::store;
use serde::Serialize;
use serde_json::Value;
use tauri::State;

use crate::app_state::AppState;
use crate::secret;

const CREDENTIALS_KEY: &str = "network.proxy.credentials";

/// The Network settings as the backend uses them.
pub(crate) struct NetworkConfig {
    pub mode: ProxyMode,
    pub settings: ProxySettings,
    pub go_proxy: String,
    pub test_url: String,
    pub use_wheelhouse: bool,
    /// `network.gateway.enabled`: point the package tools of processes OpenMind starts at the package gateway.
    pub gateway_enabled: bool,
}

fn user_values(settings_file: &Path) -> HashMap<String, Value> {
    let layer = store::read_layer(settings_file);
    store::effective(&layer, None, &Extras::default())
        .into_iter()
        .filter(|entry| entry.id.starts_with("network."))
        .map(|entry| (entry.id, entry.value))
        .collect()
}

pub(crate) fn read_config(state: &AppState) -> NetworkConfig {
    read_config_file(&state.settings_file)
}

/// The Network settings of `settings/settings.json` (also read before the app state exists).
pub(crate) fn read_config_file(settings_file: &Path) -> NetworkConfig {
    let values = user_values(settings_file);
    let text = |id: &str| {
        values
            .get(id)
            .and_then(Value::as_str)
            .unwrap_or_default()
            .trim()
            .to_string()
    };
    NetworkConfig {
        mode: ProxyMode::parse(&text("network.proxy.mode")),
        settings: ProxySettings {
            http: text("network.proxy.http"),
            https: text("network.proxy.https"),
            socks: text("network.proxy.socks"),
            no_proxy: text("network.proxy.noProxy"),
        },
        go_proxy: text("network.goProxy"),
        test_url: text("network.testUrl"),
        use_wheelhouse: values
            .get("network.offline.useWheelhouse")
            .and_then(Value::as_bool)
            .unwrap_or(false),
        gateway_enabled: values
            .get("network.gateway.enabled")
            .and_then(Value::as_bool)
            .unwrap_or(true),
    }
}

/// What is saved for the proxy's user name and password. Unreadable is not the same as none: a record exists (another
/// Windows user saved it, or it is damaged) and the user must be able to clear it or save over it.
#[derive(Debug)]
pub(crate) enum CredentialState {
    None,
    Saved(Credentials),
    /// The reason, never the stored value.
    Unreadable(String),
}

impl CredentialState {
    /// `none`, `saved` or `unreadable`, for the UI.
    pub(crate) fn status(&self) -> &'static str {
        match self {
            CredentialState::None => "none",
            CredentialState::Saved(_) => "saved",
            CredentialState::Unreadable(_) => "unreadable",
        }
    }
}

/// Reads a stored credential record: `unprotect` decrypts it (DPAPI in the app). A record that can't be decrypted or
/// isn't the expected JSON is `Unreadable` with a reason that never includes the stored text.
pub(crate) fn credential_state(
    stored: Option<&str>,
    unprotect: impl Fn(&str) -> Result<String, String>,
) -> CredentialState {
    let Some(stored) = stored.filter(|value| !value.is_empty()) else {
        return CredentialState::None;
    };
    let plain = match unprotect(stored) {
        Ok(plain) => plain,
        Err(reason) => return CredentialState::Unreadable(reason),
    };
    let json: Value = match serde_json::from_str(&plain) {
        Ok(json) => json,
        Err(_) => {
            return CredentialState::Unreadable("The saved proxy credentials are damaged.".into())
        }
    };
    match json["username"].as_str().filter(|user| !user.is_empty()) {
        Some(username) => CredentialState::Saved(Credentials {
            username: username.to_string(),
            password: json["password"].as_str().unwrap_or_default().to_string(),
        }),
        None => CredentialState::Unreadable("The saved proxy credentials are damaged.".into()),
    }
}

/// The saved proxy user name and password (DPAPI-encrypted in the app's database).
async fn stored_credentials(db: &openmind_db::Db) -> CredentialState {
    match EditorSettingsRepository::new(db.pool())
        .get(CREDENTIALS_KEY)
        .await
    {
        Ok(stored) => credential_state(stored.as_deref(), |value| {
            secret::unprotect(value).map_err(|err| err.to_string())
        }),
        Err(err) => CredentialState::Unreadable(err.to_string()),
    }
}

/// Removes the saved credential record, readable or not (clearing never needs to decrypt it).
async fn clear_stored_credentials(db: &openmind_db::Db) -> Result<(), String> {
    EditorSettingsRepository::new(db.pool())
        .delete(CREDENTIALS_KEY)
        .await
        .map_err(|err| err.to_string())
}

/// The proxy in force now, and what was found on the way.
pub(crate) struct Resolution {
    pub config: NetworkConfig,
    pub proxy: ResolvedProxy,
    pub credentials: Option<Credentials>,
    pub credential_problem: Option<String>,
    pub stored_username: Option<String>,
    /// `none`, `saved` or `unreadable`.
    pub credential_status: &'static str,
}

/// Resolves the proxy from the settings (reading Windows' and the environment's proxy in System mode — local
/// reads, never a network request, never a change) and makes it the proxy of OpenMind's own requests.
pub(crate) async fn refresh(state: &AppState) -> Resolution {
    let config = read_config(state);
    let credential_state = stored_credentials(&state.db).await;
    let credential_status = credential_state.status();
    let (stored, credential_problem) = match credential_state {
        CredentialState::None => (None, None),
        CredentialState::Saved(credentials) => (Some(credentials), None),
        CredentialState::Unreadable(problem) => (None, Some(problem)),
    };
    let (proxy, found) = match config.mode {
        ProxyMode::None => (ResolvedProxy::off(), None),
        ProxyMode::Manual => (resolve_manual(&config.settings), None),
        ProxyMode::System => system::resolve_system(&system::detect()),
    };
    let stored_username = stored.as_ref().map(|c| c.username.clone());
    // Saved credentials win over ones written into an environment variable.
    let credentials = if proxy.active() {
        stored.or(found)
    } else {
        None
    };
    http::set_current(Some(HttpProxy {
        resolved: proxy.clone(),
        credentials: credentials.clone(),
    }));
    Resolution {
        config,
        proxy,
        credentials,
        credential_problem,
        stored_username,
        credential_status,
    }
}

/// The package settings for a process OpenMind starts: its package tools are pointed at the package gateway, which
/// downloads through OpenMind's own route (the proxy in force). Only that process gets them; no proxy variable is set,
/// so a program's own requests are never routed by OpenMind.
pub(crate) async fn process_env(state: &AppState) -> Vec<(String, String)> {
    let resolution = refresh(state).await;
    env_of(state, &resolution)
}

pub(crate) fn env_of(state: &AppState, resolution: &Resolution) -> Vec<(String, String)> {
    let (mut vars, _) =
        crate::commands::broker::gateway_env(state, resolution.config.gateway_enabled);
    let wheelhouse = crate::commands::network_offline::cache(state).wheelhouse();
    if resolution.config.use_wheelhouse && wheelhouse.is_dir() {
        // pip splits this variable on spaces: a file URL never has one.
        vars.push(("PIP_FIND_LINKS".to_string(), file_url(&wheelhouse)));
    }
    vars
}

/// A diagnostic with its severity (`warning` or `info`), for the Network window.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiagnosticInfo {
    severity: &'static str,
    #[serde(flatten)]
    diagnostic: Diagnostic,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NetworkStatus {
    /// `none`, `system` or `manual`.
    mode: String,
    source: ProxySource,
    /// A proxy is in force (processes get the variables, OpenMind's requests use it).
    active: bool,
    http: Option<String>,
    https: Option<String>,
    socks: Option<String>,
    no_proxy: Vec<String>,
    /// A proxy auto-configuration script Windows uses; OpenMind can't evaluate one.
    pac_url: Option<String>,
    /// What is ignored or can't be done with these settings (an address with credentials in it, a PAC script, ...),
    /// so nothing is dropped without telling the user.
    diagnostics: Vec<DiagnosticInfo>,
    /// Readable credentials are saved (they are used).
    has_credentials: bool,
    /// `none`, `saved` or `unreadable` (a record exists but can't be decrypted: Clear must stay possible).
    credential_status: &'static str,
    /// The saved user name (never the password).
    username: Option<String>,
    /// Why saved credentials can't be read (never the stored value).
    credential_problem: Option<String>,
    use_wheelhouse: bool,
    go_proxy: Option<String>,
    test_url: String,
}

fn status_of(resolution: &Resolution) -> NetworkStatus {
    let proxy = &resolution.proxy;
    let mode = match resolution.config.mode {
        ProxyMode::None => "none",
        ProxyMode::System => "system",
        ProxyMode::Manual => "manual",
    };
    NetworkStatus {
        mode: mode.to_string(),
        source: proxy.source,
        active: proxy.active(),
        http: proxy.http.as_ref().map(|p| p.display()),
        https: proxy.https.as_ref().map(|p| p.display()),
        socks: proxy.socks.as_ref().map(|p| p.display()),
        no_proxy: proxy.no_proxy.clone(),
        pac_url: proxy.pac_url.clone(),
        diagnostics: diagnose_settings(
            proxy,
            resolution.stored_username.is_some(),
            resolution.credential_problem.is_some(),
        )
        .into_iter()
        .map(|diagnostic| DiagnosticInfo {
            severity: diagnostic.severity(),
            diagnostic,
        })
        .collect(),
        has_credentials: resolution.stored_username.is_some(),
        credential_status: resolution.credential_status,
        username: resolution.stored_username.clone(),
        credential_problem: resolution.credential_problem.clone(),
        use_wheelhouse: resolution.config.use_wheelhouse,
        go_proxy: (!resolution.config.go_proxy.is_empty())
            .then(|| resolution.config.go_proxy.clone()),
        test_url: resolution.config.test_url.clone(),
    }
}

/// The current network state (local reads only).
#[tauri::command]
pub async fn network_status(state: State<'_, AppState>) -> Result<NetworkStatus, String> {
    Ok(status_of(&refresh(&state).await))
}

/// Saves the proxy user name and password, encrypted with DPAPI (current Windows user). They are never returned.
#[tauri::command]
pub async fn network_set_credentials(
    username: String,
    password: String,
    state: State<'_, AppState>,
) -> Result<NetworkStatus, String> {
    let username = username.trim();
    let bad = |text: &str| text.chars().any(char::is_control) || text.len() > 1024;
    if username.is_empty() || bad(username) || bad(&password) {
        return Err("The user name is empty or contains characters it cannot have.".to_string());
    }
    let json = serde_json::json!({ "username": username, "password": password }).to_string();
    let stored = secret::protect(&json).map_err(|err| err.to_string())?;
    EditorSettingsRepository::new(state.db.pool())
        .set(CREDENTIALS_KEY, &stored)
        .await
        .map_err(|err| err.to_string())?;
    tracing::info!("proxy credentials saved (encrypted)");
    Ok(status_of(&refresh(&state).await))
}

#[tauri::command]
pub async fn network_clear_credentials(
    state: State<'_, AppState>,
) -> Result<NetworkStatus, String> {
    clear_stored_credentials(&state.db).await?;
    tracing::info!("proxy credentials cleared");
    Ok(status_of(&refresh(&state).await))
}

/// Test Connection: one request, only because the user pressed Test, through the proxy in force.
#[tauri::command]
pub async fn network_test(
    url: Option<String>,
    state: State<'_, AppState>,
) -> Result<TestOutcome, String> {
    let resolution = refresh(&state).await;
    let url = url
        .filter(|u| !u.trim().is_empty())
        .unwrap_or(resolution.config.test_url.clone());
    let proxy = HttpProxy {
        resolved: resolution.proxy,
        credentials: resolution.credentials,
    };
    let outcome = tauri::async_runtime::spawn_blocking(move || test_connection(&url, Some(&proxy)))
        .await
        .map_err(|err| err.to_string())?;
    tracing::info!(ok = outcome.ok, problem = ?outcome.problem, route = %outcome.route, "network test");
    Ok(outcome)
}

/// The package settings a new terminal gets, with the gateway's session token replaced by `****`.
#[tauri::command]
pub async fn network_terminal_env(
    state: State<'_, AppState>,
) -> Result<Vec<(String, String)>, String> {
    let resolution = refresh(&state).await;
    let vars = env_of(&state, &resolution);
    let token = state.broker.endpoints().map(|endpoints| endpoints.token);
    Ok(mask_token(vars, token.as_deref()))
}

/// Hides the gateway's per-run token in values shown to the user.
fn mask_token(vars: Vec<(String, String)>, token: Option<&str>) -> Vec<(String, String)> {
    match token.filter(|token| !token.is_empty()) {
        Some(token) => vars
            .into_iter()
            .map(|(name, value)| (name, value.replace(token, "****")))
            .collect(),
        None => vars,
    }
}

#[cfg(test)]
mod tests {
    use openmind_network::proxy::{resolve_manual, ProxySettings};

    #[test]
    fn a_hand_edited_address_with_credentials_is_reported_without_the_password() {
        let proxy = resolve_manual(&ProxySettings {
            http: "proxy.lab:3128".into(),
            https: "http://ivan:s3cr3t@proxy.lab:3128".into(),
            ..ProxySettings::default()
        });
        let resolution = super::Resolution {
            config: super::NetworkConfig {
                mode: openmind_network::proxy::ProxyMode::Manual,
                settings: ProxySettings::default(),
                go_proxy: String::new(),
                test_url: String::new(),
                use_wheelhouse: false,
                gateway_enabled: true,
            },
            proxy,
            credentials: None,
            credential_problem: None,
            stored_username: None,
            credential_status: "none",
        };
        let json = serde_json::to_string(&super::status_of(&resolution)).expect("json");
        assert!(
            json.contains(r#"{"severity":"warning","kind":"ignoredField","field":"https","problem":"credentialsInAddress"}"#),
            "{json}"
        );
        assert!(json.contains(r#""kind":"noCredentials""#), "{json}");
        assert!(!json.contains("s3cr3t"), "{json}");
    }

    #[test]
    fn the_env_shown_to_the_user_hides_the_gateway_token() {
        let vars = vec![
            (
                "PIP_INDEX_URL".to_string(),
                "http://127.0.0.1:4000/abc123/pypi/simple/".to_string(),
            ),
            (
                "CARGO_HTTP_PROXY".to_string(),
                "http://cargo:abc123@127.0.0.1:4000".to_string(),
            ),
        ];
        let shown = super::mask_token(vars, Some("abc123"));
        assert!(
            shown.iter().all(|(_, v)| !v.contains("abc123")),
            "{shown:?}"
        );
        assert_eq!(shown[0].1, "http://127.0.0.1:4000/****/pypi/simple/");
    }

    #[test]
    fn a_record_that_cant_be_read_is_unreadable_not_none() {
        use super::{credential_state, CredentialState};
        let decrypts = |value: &str| Ok(value.trim_start_matches("enc:").to_string());
        assert!(matches!(
            credential_state(None, decrypts),
            CredentialState::None
        ));
        assert!(matches!(
            credential_state(Some(""), decrypts),
            CredentialState::None
        ));
        match credential_state(
            Some(r#"enc:{"username":"ivan","password":"s3cr3t"}"#),
            decrypts,
        ) {
            CredentialState::Saved(creds) => assert_eq!(creds.username, "ivan"),
            other => panic!("{other:?}"),
        }
        // Another Windows user's DPAPI blob, or a damaged one: unreadable, with a reason and never the stored text.
        let refuses =
            |_: &str| Err("Windows couldn't decrypt the stored value: error 87".to_string());
        let state = credential_state(Some("dpapi1:AAAAbm90LXZhbGlk"), refuses);
        assert_eq!(state.status(), "unreadable");
        let CredentialState::Unreadable(reason) = state else {
            panic!("unreadable")
        };
        assert!(
            !reason.contains("dpapi1") && !reason.contains("AAAA"),
            "{reason}"
        );
        for damaged in ["enc:not json", r#"enc:{"password":"x"}"#] {
            assert_eq!(
                credential_state(Some(damaged), decrypts).status(),
                "unreadable",
                "{damaged}"
            );
        }
    }

    #[test]
    fn a_damaged_record_is_reported_and_can_be_cleared_without_decrypting_it() {
        use openmind_db::EditorSettingsRepository;
        let dir = tempfile::tempdir().expect("tmp");
        tauri::async_runtime::block_on(async {
            let db = openmind_db::Db::connect(&dir.path().join("t.db"))
                .await
                .expect("db");
            EditorSettingsRepository::new(db.pool())
                .set(super::CREDENTIALS_KEY, "dpapi1:AAAAbm90LXZhbGlk")
                .await
                .expect("set");
            let state = super::stored_credentials(&db).await;
            assert_eq!(state.status(), "unreadable");
            // The status the UI gets: unreadable, Clear-able, with the warning, and no stored blob anywhere.
            let proxy = resolve_manual(&ProxySettings {
                http: "proxy.lab:3128".into(),
                ..ProxySettings::default()
            });
            let resolution = super::Resolution {
                config: super::NetworkConfig {
                    mode: openmind_network::proxy::ProxyMode::Manual,
                    settings: ProxySettings::default(),
                    go_proxy: String::new(),
                    test_url: String::new(),
                    use_wheelhouse: false,
                    gateway_enabled: true,
                },
                proxy,
                credentials: None,
                credential_problem: match &state {
                    super::CredentialState::Unreadable(reason) => Some(reason.clone()),
                    _ => None,
                },
                stored_username: None,
                credential_status: state.status(),
            };
            let json = serde_json::to_string(&super::status_of(&resolution)).expect("json");
            assert!(
                json.contains(r#""credentialStatus":"unreadable""#),
                "{json}"
            );
            assert!(json.contains(r#""hasCredentials":false"#), "{json}");
            assert!(
                json.contains(
                    r#"{"severity":"warning","kind":"credentialsUnreadable","inUse":true}"#
                ),
                "{json}"
            );
            assert!(
                !json.contains(r#""kind":"noCredentials""#),
                "unreadable isn't 'none': {json}"
            );
            assert!(!json.contains("dpapi1") && !json.contains("AAAA"), "{json}");
            // Clearing works although the record can't be decrypted; afterwards there is nothing.
            super::clear_stored_credentials(&db).await.expect("clear");
            assert_eq!(super::stored_credentials(&db).await.status(), "none");
            assert_eq!(
                EditorSettingsRepository::new(db.pool())
                    .get(super::CREDENTIALS_KEY)
                    .await
                    .expect("get"),
                None
            );
        });
    }
}
