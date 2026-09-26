//! AI providers and chat (Milestone 13). Nothing here runs until the UI asks for it: no request is made at launch
//! or in the background. API keys are stored encrypted (Windows DPAPI, see `secret.rs`) under the provider's id,
//! are read only inside a command that needs one, and are never returned to the UI, logged or put in an error.
//! A provider contributed by an extension is refused here too while that extension is disabled or gone.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, PoisonError};

use openmind_ai::wire::ChatRequest;
use openmind_ai::{
    chat, list_models, redact, AiError, Conversation, ConversationStore, ConversationSummary,
    ModelInfo, ProviderConfig, ProviderStore,
};
use openmind_db::EditorSettingsRepository;
use serde::Serialize;
use tauri::{Emitter, State};

use crate::app_state::AppState;
use crate::secret;

/// The providers file, the (lazily opened) history and the requests in flight.
pub struct AiRuntime {
    pub providers: ProviderStore,
    history_path: PathBuf,
    history: Mutex<Option<Arc<ConversationStore>>>,
    requests: Mutex<HashMap<String, Arc<AtomicBool>>>,
}

impl AiRuntime {
    pub fn new(dir: PathBuf) -> Self {
        Self {
            providers: ProviderStore::new(dir.join("providers.json")),
            history_path: dir.join("conversations.sqlite"),
            history: Mutex::new(None),
            requests: Mutex::new(HashMap::new()),
        }
    }

    pub fn history_exists(&self) -> bool {
        self.history_path.exists()
    }

    /// The history file is only created when something first asks for it.
    fn history(&self) -> Result<Arc<ConversationStore>, String> {
        let mut slot = self.history.lock().unwrap_or_else(PoisonError::into_inner);
        if let Some(store) = slot.as_ref() {
            return Ok(Arc::clone(store));
        }
        let store = Arc::new(ConversationStore::open(&self.history_path).map_err(msg)?);
        *slot = Some(Arc::clone(&store));
        Ok(store)
    }

    fn begin(&self, request_id: &str) -> Arc<AtomicBool> {
        let flag = Arc::new(AtomicBool::new(false));
        self.requests
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .insert(request_id.to_string(), Arc::clone(&flag));
        flag
    }

    fn finish(&self, request_id: &str) {
        self.requests
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .remove(request_id);
    }

    pub fn cancel(&self, request_id: &str) {
        if let Some(flag) = self
            .requests
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .get(request_id)
        {
            flag.store(true, Ordering::Relaxed);
        }
    }

    /// Stops every request in flight (the app is closing).
    pub fn cancel_all(&self) {
        for flag in self
            .requests
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .values()
        {
            flag.store(true, Ordering::Relaxed);
        }
    }
}

fn msg(err: AiError) -> String {
    err.to_string()
}

fn key_name(provider_id: &str) -> String {
    format!("ai.key.{provider_id}")
}

/// A configured provider as the UI sees it: never with its key, only whether one is stored.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderInfo {
    #[serde(flatten)]
    config: ProviderConfig,
    has_key: bool,
    needs_key: bool,
    /// Requests stay on this computer (a loopback address).
    local: bool,
    host: String,
}

async fn stored_key(state: &AppState, provider_id: &str) -> Result<String, String> {
    let stored = EditorSettingsRepository::new(state.db.pool())
        .get(&key_name(provider_id))
        .await
        .map_err(|err| err.to_string())?;
    match stored.filter(|value| !value.is_empty()) {
        Some(stored) => secret::unprotect(&stored).map_err(|err| err.to_string()),
        None => Ok(String::new()),
    }
}

async fn info(state: &AppState, config: ProviderConfig) -> ProviderInfo {
    let has_key = EditorSettingsRepository::new(state.db.pool())
        .get(&key_name(&config.id))
        .await
        .ok()
        .flatten()
        .is_some_and(|value| !value.is_empty());
    ProviderInfo {
        needs_key: config.needs_key(),
        local: config.is_local(),
        host: config.host(),
        has_key,
        config,
    }
}

/// One installed extension as far as its AI providers are concerned: its id, whether it is enabled, and the
/// contributed provider ids.
struct Offer {
    extension: String,
    enabled: bool,
    providers: Vec<String>,
}

/// Whether the extension that contributed the provider is installed, enabled and still offering it. A provider
/// that came from no extension is always fine.
fn provider_offered(offers: &[Offer], config: &ProviderConfig) -> Result<(), String> {
    let Some(source) = &config.source else {
        return Ok(());
    };
    let offered = offers.iter().any(|offer| {
        offer.enabled
            && &offer.extension == source
            && offer
                .providers
                .iter()
                .any(|id| config.id == format!("ext:{source}/{id}"))
    });
    if offered {
        Ok(())
    } else {
        Err(format!(
            "The extension that provides {} is disabled or not installed.",
            config.name
        ))
    }
}

fn source_available(state: &AppState, config: &ProviderConfig) -> Result<(), String> {
    let offers: Vec<Offer> = state
        .extensions
        .store
        .list()
        .extensions
        .iter()
        .map(|extension| Offer {
            extension: extension.id.clone(),
            enabled: extension.enabled,
            providers: extension
                .manifest
                .contributes
                .ai_providers
                .iter()
                .map(|p| p.id.clone())
                .collect(),
        })
        .collect();
    provider_offered(&offers, config)
}

fn provider(state: &AppState, id: &str) -> Result<ProviderConfig, String> {
    let config = state
        .ai
        .providers
        .get(id)
        .map_err(msg)?
        .ok_or_else(|| "That AI provider does not exist.".to_string())?;
    source_available(state, &config)?;
    Ok(config)
}

#[tauri::command]
pub async fn ai_providers_list(state: State<'_, AppState>) -> Result<Vec<ProviderInfo>, String> {
    let configs = state.ai.providers.list().map_err(msg)?;
    let mut out = Vec::with_capacity(configs.len());
    for config in configs {
        out.push(info(&state, config).await);
    }
    Ok(out)
}

#[tauri::command]
pub async fn ai_provider_save(
    config: ProviderConfig,
    state: State<'_, AppState>,
) -> Result<ProviderInfo, String> {
    let saved = state.ai.providers.upsert(config).map_err(msg)?;
    Ok(info(&state, saved).await)
}

/// Removes the provider and its stored key.
#[tauri::command]
pub async fn ai_provider_delete(id: String, state: State<'_, AppState>) -> Result<(), String> {
    state.ai.providers.delete(&id).map_err(msg)?;
    EditorSettingsRepository::new(state.db.pool())
        .delete(&key_name(&id))
        .await
        .map_err(|err| err.to_string())
}

#[tauri::command]
pub async fn ai_provider_set_enabled(
    id: String,
    enabled: bool,
    state: State<'_, AppState>,
) -> Result<ProviderInfo, String> {
    let config = state.ai.providers.set_enabled(&id, enabled).map_err(msg)?;
    Ok(info(&state, config).await)
}

/// Stores the key encrypted. It is the only time the UI hands a key over; nothing ever returns it.
#[tauri::command]
pub async fn ai_provider_set_key(
    id: String,
    key: String,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let key = key.trim();
    if key.is_empty() || key.chars().any(char::is_control) || key.len() > 4096 {
        return Err("The API key is empty or contains characters a key cannot have.".to_string());
    }
    state
        .ai
        .providers
        .get(&id)
        .map_err(msg)?
        .ok_or_else(|| "That AI provider does not exist.".to_string())?;
    let stored = secret::protect(key).map_err(|err| err.to_string())?;
    EditorSettingsRepository::new(state.db.pool())
        .set(&key_name(&id), &stored)
        .await
        .map_err(|err| err.to_string())
}

#[tauri::command]
pub async fn ai_provider_clear_key(id: String, state: State<'_, AppState>) -> Result<(), String> {
    EditorSettingsRepository::new(state.db.pool())
        .delete(&key_name(&id))
        .await
        .map_err(|err| err.to_string())
}

/// Connection test: asks the provider for its models (a request the user just asked for). On success the model
/// list is remembered for the model picker.
#[tauri::command]
pub async fn ai_provider_test(
    id: String,
    request_id: String,
    state: State<'_, AppState>,
) -> Result<Vec<ModelInfo>, String> {
    let config = provider(&state, &id)?;
    let key = stored_key(&state, &id).await?;
    let cancel = state.ai.begin(&request_id);
    let worker = config.clone();
    let worker_key = key.clone();
    let result = tokio::task::spawn_blocking(move || list_models(&worker, &worker_key, &cancel))
        .await
        .map_err(|err| format!("the test stopped unexpectedly: {err}"));
    state.ai.finish(&request_id);
    let models = result?.map_err(|err| redact(&err.to_string(), &key))?;
    let mut updated = config;
    updated.models = models
        .iter()
        .filter(|m| m.chat)
        .map(|m| m.id.clone())
        .collect();
    state.ai.providers.upsert(updated).map_err(msg)?;
    Ok(models)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatResult {
    pub text: String,
    pub cancelled: bool,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ChunkEvent<'a> {
    request_id: &'a str,
    text: &'a str,
}

/// Sends the conversation to the provider. Answer pieces arrive as `ai:chunk` events to the asking window; the
/// command returns the whole answer (or the error). The UI has already shown the user what is sent and where.
#[tauri::command]
pub async fn ai_chat_send(
    request_id: String,
    provider_id: String,
    request: ChatRequest,
    window: tauri::Window,
    state: State<'_, AppState>,
) -> Result<ChatResult, String> {
    let config = provider(&state, &provider_id)?;
    let key = stored_key(&state, &provider_id).await?;
    let cancel = state.ai.begin(&request_id);
    let label = window.label().to_string();
    let target = window.clone();
    let id = request_id.clone();
    let worker_cancel = Arc::clone(&cancel);
    let worker_key = key.clone();
    let result = tokio::task::spawn_blocking(move || {
        chat(
            &config,
            &worker_key,
            &request,
            true,
            &worker_cancel,
            &mut |piece| {
                let _ = target.emit_to(
                    label.as_str(),
                    "ai:chunk",
                    ChunkEvent {
                        request_id: &id,
                        text: piece,
                    },
                );
            },
        )
    })
    .await
    .map_err(|err| format!("the request stopped unexpectedly: {err}"));
    state.ai.finish(&request_id);
    match result? {
        Ok(text) => Ok(ChatResult {
            text,
            cancelled: false,
        }),
        Err(AiError::Cancelled) => Ok(ChatResult {
            text: String::new(),
            cancelled: true,
        }),
        Err(err) => Err(redact(&err.to_string(), &key)),
    }
}

#[tauri::command]
pub fn ai_request_cancel(request_id: String, state: State<'_, AppState>) {
    state.ai.cancel(&request_id);
}

#[tauri::command]
pub async fn ai_conversations_list(
    state: State<'_, AppState>,
) -> Result<Vec<ConversationSummary>, String> {
    if !state.ai.history_exists() {
        return Ok(Vec::new());
    }
    state.ai.history()?.list(100).map_err(msg)
}

#[tauri::command]
pub async fn ai_conversation_load(
    id: String,
    state: State<'_, AppState>,
) -> Result<Option<Conversation>, String> {
    if !state.ai.history_exists() {
        return Ok(None);
    }
    state.ai.history()?.load(&id).map_err(msg)
}

#[tauri::command]
pub async fn ai_conversation_save(
    conversation: Conversation,
    state: State<'_, AppState>,
) -> Result<(), String> {
    state.ai.history()?.save(&conversation).map_err(msg)
}

#[tauri::command]
pub async fn ai_conversation_delete(id: String, state: State<'_, AppState>) -> Result<(), String> {
    if !state.ai.history_exists() {
        return Ok(());
    }
    state.ai.history()?.delete(&id).map(|_| ()).map_err(msg)
}

/// Deletes every saved conversation.
#[tauri::command]
pub async fn ai_conversations_clear(state: State<'_, AppState>) -> Result<(), String> {
    if !state.ai.history_exists() {
        return Ok(());
    }
    state.ai.history()?.clear_all().map_err(msg)
}

#[cfg(test)]
mod tests {
    use super::*;
    use openmind_ai::{Capability, ProviderKind};

    fn config(id: &str, source: Option<&str>) -> ProviderConfig {
        ProviderConfig {
            id: id.to_string(),
            name: "Acme".to_string(),
            kind: ProviderKind::OpenAiCompatible,
            base_url: "https://api.acme.test/v1".to_string(),
            model: "m".to_string(),
            models: vec![],
            enabled: true,
            source: source.map(str::to_string),
            capabilities: vec![Capability::Chat],
        }
    }

    fn offer(enabled: bool) -> Offer {
        Offer {
            extension: "openmind-samples.sample-ai".to_string(),
            enabled,
            providers: vec!["acme".to_string()],
        }
    }

    #[test]
    fn a_provider_of_no_extension_is_always_allowed() {
        assert!(provider_offered(&[], &config("user.a", None)).is_ok());
    }

    #[test]
    fn an_extensions_provider_needs_its_extension_enabled_and_still_offering_it() {
        let provider = config(
            "ext:openmind-samples.sample-ai/acme",
            Some("openmind-samples.sample-ai"),
        );
        assert!(provider_offered(&[offer(true)], &provider).is_ok());
        let disabled = provider_offered(&[offer(false)], &provider).expect_err("disabled");
        assert!(disabled.contains("disabled or not installed"));
        assert!(provider_offered(&[], &provider).is_err());
        // The extension is enabled but no longer offers that provider id.
        let other = config(
            "ext:openmind-samples.sample-ai/gone",
            Some("openmind-samples.sample-ai"),
        );
        assert!(provider_offered(&[offer(true)], &other).is_err());
    }

    #[test]
    fn what_the_ui_receives_about_a_provider_never_includes_a_key() {
        let info = ProviderInfo {
            config: config("user.a", None),
            has_key: true,
            needs_key: true,
            local: false,
            host: "api.acme.test".to_string(),
        };
        let json = serde_json::to_value(&info).expect("json");
        let keys: Vec<&str> = json
            .as_object()
            .expect("object")
            .keys()
            .map(String::as_str)
            .collect();
        assert!(keys.contains(&"hasKey"));
        assert!(!keys
            .iter()
            .any(|k| k.to_lowercase().contains("apikey") || *k == "key"));
    }

    #[test]
    fn requests_are_tracked_and_cancelled_by_id() {
        let dir = tempfile::tempdir().expect("tempdir");
        let runtime = AiRuntime::new(dir.path().join("ai"));
        let flag = runtime.begin("r1");
        let other = runtime.begin("r2");
        runtime.cancel("r1");
        assert!(flag.load(Ordering::Relaxed));
        assert!(!other.load(Ordering::Relaxed));
        runtime.cancel_all();
        assert!(other.load(Ordering::Relaxed));
        runtime.finish("r1");
        // Nothing is created on disk until the history is first used.
        assert!(!runtime.history_exists());
    }

    #[test]
    fn the_history_file_appears_only_when_first_used() {
        let dir = tempfile::tempdir().expect("tempdir");
        let runtime = AiRuntime::new(dir.path().join("ai"));
        assert!(!runtime.history_exists());
        runtime.history().expect("opens");
        assert!(runtime.history_exists());
    }
}
