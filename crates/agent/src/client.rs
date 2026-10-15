//! The model the agent talks to: anything that streams the OpenAI-compatible chat format. The real one goes through
//! `openmind-ai`'s transport (no redirects, cancellation, the proxy rules; 127.0.0.1 is always direct).

use std::sync::atomic::AtomicBool;

use openmind_ai::transport::stream_lines;
use openmind_ai::wire::{Method, WireRequest};
use openmind_ai::{redact, AiError};
use serde_json::Value;

pub trait ModelClient: Send + Sync {
    /// Sends `body` and calls `on_line` for every line of the answer until it returns `false` or the answer ends.
    fn stream(
        &self,
        body: &Value,
        cancel: &AtomicBool,
        on_line: &mut dyn FnMut(&str) -> bool,
    ) -> Result<(), String>;
}

/// An OpenAI-compatible endpoint: the local engine (`http://127.0.0.1:<port>/v1`) or a configured provider.
pub struct HttpModel {
    pub base_url: String,
    pub key: String,
}

impl ModelClient for HttpModel {
    fn stream(
        &self,
        body: &Value,
        cancel: &AtomicBool,
        on_line: &mut dyn FnMut(&str) -> bool,
    ) -> Result<(), String> {
        let mut headers = vec![("Content-Type".to_string(), "application/json".to_string())];
        if !self.key.is_empty() {
            headers.push(("Authorization".into(), format!("Bearer {}", self.key)));
        }
        let request = WireRequest {
            method: Method::Post,
            url: format!("{}/chat/completions", self.base_url.trim_end_matches('/')),
            headers,
            body: Some(body.to_string()),
        };
        match stream_lines(&request, &self.key, cancel, &mut |line| Ok(on_line(line))) {
            Ok(()) => Ok(()),
            Err(AiError::Cancelled) => Err("cancelled".into()),
            Err(err) => Err(redact(&err.to_string(), &self.key)),
        }
    }
}
