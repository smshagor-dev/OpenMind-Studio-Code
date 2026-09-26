//! What the app asks of a provider: chat (streamed or whole), a connection test that lists models, and the
//! embedding foundation. The API key is passed in for the one call and is never stored or logged here.

use std::sync::atomic::AtomicBool;

use crate::error::{redact, AiError};
use crate::provider::{Capability, ProviderConfig};
use crate::transport::{send_json, stream_lines};
use crate::wire::{
    build_chat, build_embed, build_models, parse_embedding, parse_models, parse_reply,
    parse_stream_line, ChatRequest, ModelInfo, StreamEvent,
};

fn check_ready(cfg: &ProviderConfig, key: &str) -> Result<(), AiError> {
    if !cfg.enabled {
        return Err(AiError::NotConfigured(format!(
            "{} is turned off.",
            cfg.name
        )));
    }
    if cfg.needs_key() && key.trim().is_empty() {
        return Err(AiError::NotConfigured(format!(
            "Add an API key for {} first.",
            cfg.name
        )));
    }
    Ok(())
}

/// Sends the conversation and returns the answer. When the provider streams, `on_chunk` gets every piece as it
/// arrives; otherwise it gets the whole answer once.
pub fn chat(
    cfg: &ProviderConfig,
    key: &str,
    req: &ChatRequest,
    stream: bool,
    cancel: &AtomicBool,
    on_chunk: &mut dyn FnMut(&str),
) -> Result<String, AiError> {
    check_ready(cfg, key)?;
    let streaming = stream && cfg.has(Capability::Streaming);
    let wire = build_chat(cfg, key, req, streaming)?;
    tracing::info!(
        provider = %cfg.id,
        kind = ?cfg.kind,
        host = %cfg.host(),
        model = %req.model,
        messages = req.messages.len(),
        streaming,
        "ai chat request"
    );
    if !streaming {
        let body = send_json(&wire, key, cancel)?;
        let text = parse_reply(cfg.kind, &body)?;
        if text.is_empty() {
            return Err(AiError::Parse("the answer had no text".to_string()));
        }
        on_chunk(&text);
        return Ok(text);
    }
    let mut full = String::new();
    let mut failure: Option<String> = None;
    stream_lines(
        &wire,
        key,
        cancel,
        &mut |line| match parse_stream_line(cfg.kind, line) {
            StreamEvent::Text(piece) => {
                on_chunk(&piece);
                full.push_str(&piece);
                Ok(true)
            }
            StreamEvent::Done => Ok(false),
            StreamEvent::Failed(message) => {
                failure = Some(message);
                Ok(false)
            }
            StreamEvent::Skip => Ok(true),
        },
    )?;
    if let Some(message) = failure {
        return Err(AiError::Provider {
            status: 0,
            message: redact(&message, key),
        });
    }
    if full.is_empty() {
        return Err(AiError::Parse("the answer had no text".to_string()));
    }
    Ok(full)
}

/// Asks the provider for its models. It doubles as the connection test: it proves the address and key work.
pub fn list_models(
    cfg: &ProviderConfig,
    key: &str,
    cancel: &AtomicBool,
) -> Result<Vec<ModelInfo>, AiError> {
    check_ready(cfg, key)?;
    let body = send_json(&build_models(cfg, key), key, cancel)?;
    parse_models(cfg.kind, &body)
}

/// The models that can embed text (the embedding foundation; nothing calls it automatically).
pub fn list_embedding_models(
    cfg: &ProviderConfig,
    key: &str,
    cancel: &AtomicBool,
) -> Result<Vec<String>, AiError> {
    if !cfg.has(Capability::Embeddings) {
        return Err(AiError::Unsupported("embeddings"));
    }
    Ok(list_models(cfg, key, cancel)?
        .into_iter()
        .filter(|m| m.embedding)
        .map(|m| m.id)
        .collect())
}

/// Embeds one text with `model`. Only ever runs on an explicit call; nothing indexes the workspace with it.
pub fn embed_text(
    cfg: &ProviderConfig,
    key: &str,
    model: &str,
    text: &str,
    cancel: &AtomicBool,
) -> Result<Vec<f32>, AiError> {
    if !cfg.has(Capability::Embeddings) {
        return Err(AiError::Unsupported("embeddings"));
    }
    check_ready(cfg, key)?;
    let wire = build_embed(cfg, key, model, text)?;
    let body = send_json(&wire, key, cancel)?;
    parse_embedding(cfg.kind, &body)
}
