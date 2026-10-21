//! OpenMindAI Cloud configuration (Tauri side): the agent's optional remote inference path, next to the
//! local Nemotron engine. Nothing here runs until the user presses Test Connection or sends a message with a
//! cloud model chosen — no request at launch, no background polling. The key is stored encrypted (Windows
//! DPAPI, `secret.rs`), under its own settings key, never returned to the UI once saved.

use openmind_agent::{is_cloud_model, list_cloud_models, CLOUD_DEFAULT_BASE_URL, CLOUD_MODELS};
use openmind_ai::redact;
use openmind_db::EditorSettingsRepository;
use serde::Serialize;
use std::sync::atomic::AtomicBool;
use tauri::State;

use crate::app_state::AppState;
use crate::secret;

const KEY_NAME: &str = "agent.cloud.key";
const BASE_URL_NAME: &str = "agent.cloud.baseUrl";
/// The ids OpenMindAI Cloud reported as enabled the last time Test Connection succeeded (JSON array of
/// strings), so the model picker can restore across a restart without a request at startup.
const MODELS_NAME: &str = "agent.cloud.models";

fn msg(err: impl std::fmt::Display) -> String {
    err.to_string()
}

async fn stored_base_url(state: &AppState) -> String {
    let stored = EditorSettingsRepository::new(state.db.pool())
        .get(BASE_URL_NAME)
        .await
        .ok()
        .flatten()
        .unwrap_or_default();
    let trimmed = stored.trim();
    if trimmed.is_empty() {
        CLOUD_DEFAULT_BASE_URL.to_string()
    } else {
        trimmed.to_string()
    }
}

async fn stored_key(state: &AppState) -> Result<String, String> {
    let stored = EditorSettingsRepository::new(state.db.pool())
        .get(KEY_NAME)
        .await
        .map_err(msg)?;
    match stored.filter(|value| !value.is_empty()) {
        Some(stored) => secret::unprotect(&stored).map_err(msg),
        None => Ok(String::new()),
    }
}

async fn stored_models(state: &AppState) -> Vec<String> {
    let stored = EditorSettingsRepository::new(state.db.pool())
        .get(MODELS_NAME)
        .await
        .ok()
        .flatten()
        .unwrap_or_default();
    serde_json::from_str(&stored).unwrap_or_default()
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CloudModelStatus {
    pub id: &'static str,
    pub name: &'static str,
    /// Reported enabled by OpenMindAI Cloud the last time the connection was tested. `false` until a test
    /// has run, or after one that didn't report this id — a model is never offered to the agent just
    /// because its id is hard-coded here.
    pub available: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CloudStatus {
    pub base_url: String,
    pub is_default_base_url: bool,
    pub has_key: bool,
    pub models: Vec<CloudModelStatus>,
}

/// The agent's own OpenMindAI Cloud configuration: never the generic multi-provider AI chat list — this
/// stays scoped to the coding agent, as its own, smaller, single-purpose setting.
#[tauri::command]
pub async fn agent_cloud_status(state: State<'_, AppState>) -> Result<CloudStatus, String> {
    let base_url = stored_base_url(&state).await;
    let has_key = !stored_key(&state).await?.is_empty();
    let reported = stored_models(&state).await;
    let models = CLOUD_MODELS
        .iter()
        .map(|m| CloudModelStatus {
            id: m.id,
            name: m.name,
            available: reported.iter().any(|id| id == m.id),
        })
        .collect();
    Ok(CloudStatus {
        is_default_base_url: base_url == CLOUD_DEFAULT_BASE_URL,
        base_url,
        has_key,
        models,
    })
}

/// Sets (or, with an empty value, resets to the default) the OpenMindAI Cloud address. Validated the same
/// way any `openmind-ai` provider endpoint is (https only, no embedded credentials).
#[tauri::command]
pub async fn agent_cloud_set_base_url(
    base_url: String,
    state: State<'_, AppState>,
) -> Result<String, String> {
    let trimmed = base_url.trim();
    let effective = if trimmed.is_empty() {
        CLOUD_DEFAULT_BASE_URL
    } else {
        trimmed
    };
    openmind_agent::cloud_provider_config(effective).map_err(msg)?;
    EditorSettingsRepository::new(state.db.pool())
        .set(
            BASE_URL_NAME,
            if trimmed.is_empty() { "" } else { effective },
        )
        .await
        .map_err(msg)?;
    Ok(effective.to_string())
}

/// Stores the key encrypted. It is the only time the UI hands a key over; nothing ever returns it.
#[tauri::command]
pub async fn agent_cloud_set_key(key: String, state: State<'_, AppState>) -> Result<(), String> {
    let key = key.trim();
    if key.is_empty() {
        return Err("Paste the API key from OpenMindAI Cloud first.".into());
    }
    let stored = secret::protect(key).map_err(msg)?;
    EditorSettingsRepository::new(state.db.pool())
        .set(KEY_NAME, &stored)
        .await
        .map_err(msg)
}

#[tauri::command]
pub async fn agent_cloud_clear_key(state: State<'_, AppState>) -> Result<(), String> {
    EditorSettingsRepository::new(state.db.pool())
        .set(KEY_NAME, "")
        .await
        .map_err(msg)?;
    // A cleared key can no longer prove which models are enabled; don't keep showing a stale list.
    EditorSettingsRepository::new(state.db.pool())
        .set(MODELS_NAME, "")
        .await
        .map_err(msg)
}

/// Connection test: asks OpenMindAI Cloud for its enabled models. On success the list is remembered for the
/// model picker and for the next status read.
#[tauri::command]
pub async fn agent_cloud_test(state: State<'_, AppState>) -> Result<Vec<CloudModelStatus>, String> {
    let base_url = stored_base_url(&state).await;
    let key = stored_key(&state).await?;
    if key.is_empty() {
        return Err("Add an API key for OpenMindAI Cloud first.".into());
    }
    let worker_base = base_url.clone();
    let worker_key = key.clone();
    let result = tokio::task::spawn_blocking(move || {
        let cancel = AtomicBool::new(false);
        list_cloud_models(&worker_base, &worker_key, &cancel)
    })
    .await
    .map_err(|err| format!("the test stopped unexpectedly: {err}"));
    let reported = result?.map_err(|err| redact(&err.to_string(), &key))?;
    let ids: Vec<&str> = reported.iter().map(|m| m.id).collect();
    EditorSettingsRepository::new(state.db.pool())
        .set(
            MODELS_NAME,
            &serde_json::to_string(&ids).unwrap_or_default(),
        )
        .await
        .map_err(msg)?;
    Ok(CLOUD_MODELS
        .iter()
        .map(|m| CloudModelStatus {
            id: m.id,
            name: m.name,
            available: ids.contains(&m.id),
        })
        .collect())
}

/// The connection a cloud turn needs (base URL + decrypted key), or the reason it can't run one. Read fresh
/// for every turn — never cached — so a key change or a disconnect takes effect on the very next message.
pub async fn cloud_connection(
    state: &AppState,
    model_id: &str,
) -> Result<(String, String), String> {
    if !is_cloud_model(model_id) {
        return Err(format!("{model_id} is not an OpenMindAI Cloud model."));
    }
    let key = stored_key(state).await?;
    if key.is_empty() {
        return Err(
            "OpenMindAI Cloud has no API key yet. Add one in Agent Settings, then Test Connection."
                .to_string(),
        );
    }
    Ok((stored_base_url(state).await, key))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_default_base_url_is_the_documented_openmindai_cloud_address() {
        assert_eq!(
            CLOUD_DEFAULT_BASE_URL,
            "https://cloud.openmindai.org/api/v1/openmindai"
        );
    }
}
