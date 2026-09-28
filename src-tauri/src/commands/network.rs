//! Network: proxy settings, the proxy environment for processes OpenMind starts, the proxy of OpenMind's own
//! HTTP requests, the credentials (DPAPI) and the connection test. Nothing here changes Windows' proxy, PATH, the
//! Registry or a tool's global configuration, and nothing contacts the network except `network_test`.

use std::collections::HashMap;

use openmind_db::EditorSettingsRepository;
use openmind_network::env::{proxy_env, EnvExtras};
use openmind_network::http::{self, HttpProxy};
use openmind_network::probe::{test_connection, TestOutcome};
use openmind_network::proxy::{
    resolve_manual, Credentials, ProxyMode, ProxySettings, ProxySource, ResolvedProxy,
};
use openmind_network::redact::redact_env;
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
}

fn user_values(state: &AppState) -> HashMap<String, Value> {
    let layer = store::read_layer(&state.settings_file);
    store::effective(&layer, None, &Extras::default())
        .into_iter()
        .filter(|entry| entry.id.starts_with("network."))
        .map(|entry| (entry.id, entry.value))
        .collect()
}

pub(crate) fn read_config(state: &AppState) -> NetworkConfig {
    let values = user_values(state);
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
    }
}

/// The saved proxy user name and password (DPAPI-encrypted in the app's database).
async fn stored_credentials(state: &AppState) -> Result<Option<Credentials>, String> {
    let stored = EditorSettingsRepository::new(state.db.pool())
        .get(CREDENTIALS_KEY)
        .await
        .map_err(|err| err.to_string())?;
    let Some(stored) = stored.filter(|value| !value.is_empty()) else {
        return Ok(None);
    };
    let plain = secret::unprotect(&stored).map_err(|err| err.to_string())?;
    let json: Value = serde_json::from_str(&plain)
        .map_err(|_| "The saved proxy credentials are damaged.".to_string())?;
    Ok(Some(Credentials {
        username: json["username"].as_str().unwrap_or_default().to_string(),
        password: json["password"].as_str().unwrap_or_default().to_string(),
    }))
}

/// The proxy in force now, and what was found on the way.
pub(crate) struct Resolution {
    pub config: NetworkConfig,
    pub proxy: ResolvedProxy,
    pub credentials: Option<Credentials>,
    pub credential_problem: Option<String>,
    pub stored_username: Option<String>,
}

/// Resolves the proxy from the settings (reading Windows' and the environment's proxy in System mode — local
/// reads, never a network request, never a change) and makes it the proxy of OpenMind's own requests.
pub(crate) async fn refresh(state: &AppState) -> Resolution {
    let config = read_config(state);
    let (stored, credential_problem) = match stored_credentials(state).await {
        Ok(stored) => (stored, None),
        Err(problem) => (None, Some(problem)),
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
    }
}

/// The proxy variables for a process OpenMind starts (empty when no proxy is in force). Only that process gets them.
pub(crate) async fn process_env(state: &AppState) -> Vec<(String, String)> {
    let resolution = refresh(state).await;
    env_of(state, &resolution)
}

pub(crate) fn env_of(state: &AppState, resolution: &Resolution) -> Vec<(String, String)> {
    let wheelhouse = crate::commands::network_offline::cache(state).wheelhouse();
    let use_wheels = resolution.config.use_wheelhouse && wheelhouse.is_dir();
    let go_proxy = resolution.config.go_proxy.as_str();
    let extras = EnvExtras {
        go_proxy: (!go_proxy.is_empty()).then_some(go_proxy),
        pip_find_links: use_wheels.then_some(wheelhouse.as_path()),
    };
    proxy_env(&resolution.proxy, resolution.credentials.as_ref(), &extras)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProxyProblemInfo {
    field: String,
    problem: String,
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
    problems: Vec<ProxyProblemInfo>,
    has_credentials: bool,
    /// The saved user name (never the password).
    username: Option<String>,
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
        problems: proxy
            .problems
            .iter()
            .map(|(field, problem)| ProxyProblemInfo {
                field: field.clone(),
                problem: format!("{problem:?}"),
            })
            .collect(),
        has_credentials: resolution.stored_username.is_some(),
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
    EditorSettingsRepository::new(state.db.pool())
        .delete(CREDENTIALS_KEY)
        .await
        .map_err(|err| err.to_string())?;
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

/// The proxy variables a new terminal gets, with the password replaced by `****`.
#[tauri::command]
pub async fn network_terminal_env(
    state: State<'_, AppState>,
) -> Result<Vec<(String, String)>, String> {
    let resolution = refresh(&state).await;
    let vars = env_of(&state, &resolution);
    Ok(redact_env(&vars, resolution.credentials.as_ref()))
}

#[cfg(test)]
mod tests {
    use openmind_network::proxy::{resolve_manual, ProxySettings};
    use openmind_network::redact::redact_env;

    #[test]
    fn the_env_shown_to_the_user_never_contains_the_password() {
        let proxy = resolve_manual(&ProxySettings {
            http: "proxy.lab:3128".into(),
            ..ProxySettings::default()
        });
        let creds = openmind_network::proxy::Credentials {
            username: "ivan".into(),
            password: "s3cr3t!".into(),
        };
        let vars = openmind_network::env::proxy_env(&proxy, Some(&creds), &Default::default());
        assert!(
            vars.iter().any(|(_, v)| v.contains("s3cr3t")),
            "the process gets the password"
        );
        let shown = redact_env(&vars, Some(&creds));
        assert!(
            shown
                .iter()
                .all(|(_, v)| !v.contains("s3cr3t") && !v.contains("s3cr3t%21")),
            "{shown:?}"
        );
    }
}
