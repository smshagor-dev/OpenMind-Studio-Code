//! OpenMindAI Cloud: the agent's optional remote inference path, next to the local Nemotron engine. This
//! module adds no network code of its own — it only names the three cloud models and builds the
//! `openmind_ai::ProviderConfig` the existing, tested OpenAI-compatible wire/transport already knows how to
//! drive (`openmind_ai::list_models` for the connection test, `HttpModel` in `client.rs` for the turn itself).
//!
//! The desktop app never talks to a third-party inference vendor directly for this path: it only calls the
//! documented OpenMindAI Cloud API (`GET /models`, `POST /chat/completions`, bearer key), the same way it
//! would call any other OpenAI-compatible server. Which model a cloud model id actually runs on is the
//! backend's business, not this crate's.

use openmind_ai::{AiError, ProviderConfig, ProviderKind};

/// The documented OpenMindAI Cloud API base (`docs: cloud.openmindai.org`). Overridable per installation
/// (a staging address, for instance) — never hard-coded as the only option.
pub const DEFAULT_BASE_URL: &str = "https://cloud.openmindai.org/api/v1/openmindai";

/// A model OpenMindAI Cloud is documented to offer. Kept separate from the local GGUF catalog: a cloud
/// model has no file to download, no hardware fit and no GPU placement to report.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct CloudModel {
    pub id: &'static str,
    pub name: &'static str,
}

/// The three published OpenMindAI Cloud model ids. The backend's `GET /models` is the live source of truth
/// for which of these are actually enabled right now (see `list_cloud_models`); this list is only used to
/// give each id a display name and to recognize a cloud selection before any connection test has run.
pub const CLOUD_MODELS: &[CloudModel] = &[
    CloudModel {
        id: "openmindai-super",
        name: "OpenMindAI Super",
    },
    CloudModel {
        id: "openmindai-ultra",
        name: "OpenMindAI Ultra",
    },
    CloudModel {
        id: "openmindai-lite",
        name: "OpenMindAI Lite",
    },
];

/// The catalog entry for `id`, if it is one of the published cloud models.
pub fn cloud_model(id: &str) -> Option<CloudModel> {
    CLOUD_MODELS.iter().copied().find(|m| m.id == id)
}

/// Whether `id` names a cloud model rather than a local (GGUF) one — the one switch `agent_send` needs to
/// pick the turn's inference path.
pub fn is_cloud_model(id: &str) -> bool {
    cloud_model(id).is_some()
}

/// A conservative context window to report for a cloud model until a real answer says otherwise: the
/// OpenAI-compatible `/models` response carries no context-length field, so this is an assumption, not a
/// value read from the server. Matches the local engine's mid-sized automatic tier (see `engine.rs`).
pub const DEFAULT_CLOUD_CONTEXT_TOKENS: u32 = 65_536;

/// Builds the (secret-free) provider configuration used only to reuse `openmind_ai`'s validated
/// OpenAI-compatible request builders and transport. Never persisted as an `openmind_ai` provider — the
/// agent keeps its own, smaller settings (base URL + encrypted key) under `agent.cloud.*`.
pub fn provider_config(base_url: &str) -> Result<ProviderConfig, AiError> {
    ProviderConfig {
        id: "agent-cloud".to_string(),
        name: "OpenMindAI Cloud".to_string(),
        kind: ProviderKind::OpenAiCompatible,
        base_url: base_url.to_string(),
        model: String::new(),
        models: Vec::new(),
        enabled: true,
        source: None,
        capabilities: Vec::new(),
    }
    .normalized()
}

/// Asks OpenMindAI Cloud which models it currently offers. It doubles as the connection test: a 200 answer
/// proves the address and key work. The three ids this app can actually select are only the ones both
/// published here and reported enabled by the server — the server's answer is the source of truth, a
/// disabled or renamed model is never offered just because its id is hard-coded in this client.
pub fn list_cloud_models(
    base_url: &str,
    key: &str,
    cancel: &std::sync::atomic::AtomicBool,
) -> Result<Vec<CloudModel>, AiError> {
    let cfg = provider_config(base_url)?;
    let reported = openmind_ai::list_models(&cfg, key, cancel)?;
    Ok(CLOUD_MODELS
        .iter()
        .copied()
        .filter(|model| reported.iter().any(|r| r.id == model.id))
        .collect())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{Read, Write};
    use std::net::TcpListener;
    use std::sync::atomic::AtomicBool;

    #[test]
    fn cloud_models_are_recognized_by_id_only() {
        assert!(is_cloud_model("openmindai-super"));
        assert!(is_cloud_model("openmindai-ultra"));
        assert!(is_cloud_model("openmindai-lite"));
        assert!(!is_cloud_model("nemotron-3-nano-4b-q4"));
        assert!(!is_cloud_model(""));
        assert_eq!(
            cloud_model("openmindai-lite").map(|m| m.name),
            Some("OpenMindAI Lite")
        );
        assert_eq!(cloud_model("nvidia/nemotron-ultra"), None);
    }

    #[test]
    fn the_catalog_never_names_the_underlying_vendor() {
        for model in CLOUD_MODELS {
            assert!(model.id.starts_with("openmindai-"));
            assert!(model.name.starts_with("OpenMindAI "));
            assert!(!model.id.to_lowercase().contains("nvidia"));
            assert!(!model.name.to_lowercase().contains("nvidia"));
        }
    }

    #[test]
    fn provider_config_accepts_https_and_refuses_bad_addresses() {
        let cfg = provider_config(DEFAULT_BASE_URL).expect("valid");
        assert_eq!(cfg.kind, ProviderKind::OpenAiCompatible);
        assert_eq!(cfg.base_url, DEFAULT_BASE_URL);
        assert!(provider_config("not a url").is_err());
        assert!(provider_config("http://cloud.openmindai.org/api").is_err());
        assert!(provider_config("https://user:pw@cloud.openmindai.org").is_err());
    }

    #[test]
    fn a_trailing_slash_in_the_configured_base_url_is_tolerated() {
        let cfg =
            provider_config("https://cloud.openmindai.org/api/v1/openmindai/").expect("valid");
        assert_eq!(
            cfg.base_url,
            "https://cloud.openmindai.org/api/v1/openmindai"
        );
    }

    /// A minimal OpenAI-compatible `/models` server on loopback (always reached directly, no proxy
    /// involved) — the same mocking technique `openmind_ai::transport`'s own tests use.
    fn serve_models_once(body: &'static str, status_line: &'static str) -> String {
        serve_models_once_capturing(body, status_line).0
    }

    /// As `serve_models_once`, but also hands back the raw request bytes so a test can check exactly what
    /// headers `GET /models` carried (the connection test's proof that the developer API key was sent).
    fn serve_models_once_capturing(
        body: &'static str,
        status_line: &'static str,
    ) -> (String, std::sync::Arc<std::sync::Mutex<Option<String>>>) {
        let listener = TcpListener::bind("127.0.0.1:0").expect("bind");
        let addr = listener.local_addr().expect("addr");
        let captured = std::sync::Arc::new(std::sync::Mutex::new(None));
        let captured_writer = std::sync::Arc::clone(&captured);
        std::thread::spawn(move || {
            let (mut socket, _) = listener.accept().expect("accept");
            let mut buf = [0u8; 4096];
            let read = socket.read(&mut buf).unwrap_or(0);
            *captured_writer.lock().expect("lock") =
                Some(String::from_utf8_lossy(&buf[..read]).into_owned());
            let response = format!(
                "{status_line}\r\nContent-Type: application/json\r\nConnection: close\r\nContent-Length: {}\r\n\r\n{body}",
                body.len()
            );
            socket
                .write_all(response.as_bytes())
                .expect("write response");
        });
        (format!("http://{addr}"), captured)
    }

    #[test]
    fn get_models_sends_the_developer_api_key_as_a_bearer_token() {
        let (base, captured) = serve_models_once_capturing(
            r#"{"data":[{"id":"openmindai-super"}]}"#,
            "HTTP/1.1 200 OK",
        );
        let cancel = AtomicBool::new(false);
        list_cloud_models(&base, "my-developer-key", &cancel).expect("list");
        let request = captured
            .lock()
            .expect("lock")
            .take()
            .expect("a request arrived");
        assert!(request.starts_with("GET /models"));
        // ureq writes header names in lowercase on the wire; the value itself is what matters.
        assert!(
            request
                .to_lowercase()
                .contains("authorization: bearer my-developer-key\r\n"),
            "expected a Bearer header, got:\n{request}"
        );
    }

    #[test]
    fn only_models_the_server_actually_reports_are_offered() {
        let base = serve_models_once(
            r#"{"data":[{"id":"openmindai-super"},{"id":"openmindai-ultra"},{"id":"something-else"}]}"#,
            "HTTP/1.1 200 OK",
        );
        let cancel = AtomicBool::new(false);
        let models = list_cloud_models(&base, "test-key", &cancel).expect("list");
        assert_eq!(models.len(), 2);
        assert!(models.iter().any(|m| m.id == "openmindai-super"));
        assert!(models.iter().any(|m| m.id == "openmindai-ultra"));
        assert!(!models.iter().any(|m| m.id == "openmindai-lite"));
    }

    #[test]
    fn an_unauthorized_answer_is_a_provider_error_not_a_crash() {
        let base = serve_models_once(
            r#"{"error":"invalid api key"}"#,
            "HTTP/1.1 401 Unauthorized",
        );
        let cancel = AtomicBool::new(false);
        let err = list_cloud_models(&base, "wrong-key", &cancel).unwrap_err();
        assert!(matches!(err, AiError::Provider { status: 401, .. }));
    }
}
