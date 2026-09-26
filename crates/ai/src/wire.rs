//! The three wire formats, as pure functions: build a request, read an answer, read one line of a stream.
//! Nothing here touches the network, so the request shapes are unit-tested exactly.

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::error::AiError;
use crate::provider::{ProviderConfig, ProviderKind};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ChatMessage {
    /// `user` or `assistant`.
    pub role: String,
    pub content: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatRequest {
    pub model: String,
    #[serde(default)]
    pub system: Option<String>,
    pub messages: Vec<ChatMessage>,
    #[serde(default = "default_max_tokens")]
    pub max_tokens: u32,
}

fn default_max_tokens() -> u32 {
    4096
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Method {
    Get,
    Post,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WireRequest {
    pub method: Method,
    pub url: String,
    pub headers: Vec<(String, String)>,
    pub body: Option<String>,
}

/// One line of a streamed answer, understood.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum StreamEvent {
    Text(String),
    Done,
    Failed(String),
    Skip,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelInfo {
    pub id: String,
    pub chat: bool,
    pub embedding: bool,
}

fn json_headers(mut headers: Vec<(String, String)>) -> Vec<(String, String)> {
    headers.push(("Content-Type".into(), "application/json".into()));
    headers
}

fn auth_headers(cfg: &ProviderConfig, key: &str) -> Vec<(String, String)> {
    match cfg.kind {
        ProviderKind::Claude => vec![
            ("x-api-key".into(), key.into()),
            ("anthropic-version".into(), "2023-06-01".into()),
        ],
        ProviderKind::Gemini => vec![("x-goog-api-key".into(), key.into())],
        ProviderKind::OpenAiCompatible | ProviderKind::Local if key.is_empty() => vec![],
        ProviderKind::OpenAiCompatible | ProviderKind::Local => {
            vec![("Authorization".into(), format!("Bearer {key}"))]
        }
    }
}

/// A Gemini model name as it goes into the URL: letters, digits and `. _ -` only.
fn gemini_model(model: &str) -> Result<&str, AiError> {
    let name = model.strip_prefix("models/").unwrap_or(model);
    if name.is_empty()
        || !name
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || "._-".contains(c))
    {
        return Err(AiError::NotConfigured(
            "Choose a model for this provider first.".to_string(),
        ));
    }
    Ok(name)
}

fn require_model(model: &str) -> Result<(), AiError> {
    if model.trim().is_empty() {
        Err(AiError::NotConfigured(
            "Choose a model for this provider first.".to_string(),
        ))
    } else {
        Ok(())
    }
}

/// The chat request for `cfg`.
pub fn build_chat(
    cfg: &ProviderConfig,
    key: &str,
    req: &ChatRequest,
    stream: bool,
) -> Result<WireRequest, AiError> {
    require_model(&req.model)?;
    let base = cfg.base_url.trim_end_matches('/');
    let (url, body) = match cfg.kind {
        ProviderKind::Claude => {
            let mut body = json!({
                "model": req.model,
                "max_tokens": req.max_tokens,
                "messages": req.messages,
                "stream": stream,
            });
            if let Some(system) = req.system.as_deref().filter(|s| !s.is_empty()) {
                body["system"] = json!(system);
            }
            (format!("{base}/v1/messages"), body)
        }
        ProviderKind::OpenAiCompatible | ProviderKind::Local => {
            let mut messages = Vec::new();
            if let Some(system) = req.system.as_deref().filter(|s| !s.is_empty()) {
                messages.push(json!({"role": "system", "content": system}));
            }
            messages.extend(req.messages.iter().map(|m| json!(m)));
            (
                format!("{base}/chat/completions"),
                json!({"model": req.model, "messages": messages, "stream": stream}),
            )
        }
        ProviderKind::Gemini => {
            let model = gemini_model(&req.model)?;
            let contents: Vec<Value> = req
                .messages
                .iter()
                .map(|m| {
                    let role = if m.role == "assistant" {
                        "model"
                    } else {
                        "user"
                    };
                    json!({"role": role, "parts": [{"text": m.content}]})
                })
                .collect();
            let mut body = json!({"contents": contents});
            if let Some(system) = req.system.as_deref().filter(|s| !s.is_empty()) {
                body["systemInstruction"] = json!({"parts": [{"text": system}]});
            }
            let url = if stream {
                format!("{base}/v1beta/models/{model}:streamGenerateContent?alt=sse")
            } else {
                format!("{base}/v1beta/models/{model}:generateContent")
            };
            (url, body)
        }
    };
    Ok(WireRequest {
        method: Method::Post,
        url,
        headers: json_headers(auth_headers(cfg, key)),
        body: Some(body.to_string()),
    })
}

/// The request that lists a provider's models (also used as the connection test).
pub fn build_models(cfg: &ProviderConfig, key: &str) -> WireRequest {
    let base = cfg.base_url.trim_end_matches('/');
    let url = match cfg.kind {
        ProviderKind::Claude => format!("{base}/v1/models?limit=100"),
        ProviderKind::Gemini => format!("{base}/v1beta/models?pageSize=100"),
        ProviderKind::OpenAiCompatible | ProviderKind::Local => format!("{base}/models"),
    };
    WireRequest {
        method: Method::Get,
        url,
        headers: auth_headers(cfg, key),
        body: None,
    }
}

/// The request that embeds one text (OpenAI-compatible and Gemini only).
pub fn build_embed(
    cfg: &ProviderConfig,
    key: &str,
    model: &str,
    text: &str,
) -> Result<WireRequest, AiError> {
    require_model(model)?;
    let base = cfg.base_url.trim_end_matches('/');
    let (url, body) = match cfg.kind {
        ProviderKind::Claude => return Err(AiError::Unsupported("embeddings")),
        ProviderKind::OpenAiCompatible | ProviderKind::Local => (
            format!("{base}/embeddings"),
            json!({"model": model, "input": text}),
        ),
        ProviderKind::Gemini => (
            format!("{base}/v1beta/models/{}:embedContent", gemini_model(model)?),
            json!({"content": {"parts": [{"text": text}]}}),
        ),
    };
    Ok(WireRequest {
        method: Method::Post,
        url,
        headers: json_headers(auth_headers(cfg, key)),
        body: Some(body.to_string()),
    })
}

fn parse_json(body: &str) -> Result<Value, AiError> {
    serde_json::from_str(body).map_err(|err| AiError::Parse(err.to_string()))
}

/// The text of a complete (non-streamed) answer.
pub fn parse_reply(kind: ProviderKind, body: &str) -> Result<String, AiError> {
    let value = parse_json(body)?;
    let text = match kind {
        ProviderKind::Claude => value["content"]
            .as_array()
            .map(|parts| {
                parts
                    .iter()
                    .filter_map(|p| p["text"].as_str())
                    .collect::<String>()
            })
            .unwrap_or_default(),
        ProviderKind::OpenAiCompatible | ProviderKind::Local => value["choices"][0]["message"]
            ["content"]
            .as_str()
            .unwrap_or_default()
            .to_string(),
        ProviderKind::Gemini => gemini_text(&value),
    };
    Ok(text)
}

fn gemini_text(value: &Value) -> String {
    value["candidates"][0]["content"]["parts"]
        .as_array()
        .map(|parts| parts.iter().filter_map(|p| p["text"].as_str()).collect())
        .unwrap_or_default()
}

/// One line of a streamed answer.
pub fn parse_stream_line(kind: ProviderKind, line: &str) -> StreamEvent {
    let Some(data) = line.strip_prefix("data:") else {
        return StreamEvent::Skip;
    };
    let data = data.trim();
    if data.is_empty() {
        return StreamEvent::Skip;
    }
    if data == "[DONE]" {
        return StreamEvent::Done;
    }
    let Ok(value) = serde_json::from_str::<Value>(data) else {
        return StreamEvent::Skip;
    };
    if let Some(message) = value["error"]["message"].as_str() {
        return StreamEvent::Failed(message.to_string());
    }
    match kind {
        ProviderKind::Claude => match value["type"].as_str() {
            Some("content_block_delta") => value["delta"]["text"]
                .as_str()
                .map_or(StreamEvent::Skip, |t| StreamEvent::Text(t.to_string())),
            Some("message_stop") => StreamEvent::Done,
            _ => StreamEvent::Skip,
        },
        ProviderKind::OpenAiCompatible | ProviderKind::Local => value["choices"][0]["delta"]
            ["content"]
            .as_str()
            .filter(|t| !t.is_empty())
            .map_or(StreamEvent::Skip, |t| StreamEvent::Text(t.to_string())),
        ProviderKind::Gemini => {
            let text = gemini_text(&value);
            if text.is_empty() {
                StreamEvent::Skip
            } else {
                StreamEvent::Text(text)
            }
        }
    }
}

/// The models a provider lists.
pub fn parse_models(kind: ProviderKind, body: &str) -> Result<Vec<ModelInfo>, AiError> {
    let value = parse_json(body)?;
    let mut out = Vec::new();
    match kind {
        ProviderKind::Gemini => {
            for model in value["models"].as_array().into_iter().flatten() {
                let Some(name) = model["name"].as_str() else {
                    continue;
                };
                let methods: Vec<&str> = model["supportedGenerationMethods"]
                    .as_array()
                    .into_iter()
                    .flatten()
                    .filter_map(Value::as_str)
                    .collect();
                out.push(ModelInfo {
                    id: name.strip_prefix("models/").unwrap_or(name).to_string(),
                    chat: methods.contains(&"generateContent"),
                    embedding: methods.contains(&"embedContent"),
                });
            }
        }
        ProviderKind::Claude | ProviderKind::OpenAiCompatible | ProviderKind::Local => {
            for model in value["data"].as_array().into_iter().flatten() {
                if let Some(id) = model["id"].as_str() {
                    let embedding = id.contains("embed");
                    out.push(ModelInfo {
                        id: id.to_string(),
                        chat: !embedding,
                        embedding,
                    });
                }
            }
        }
    }
    Ok(out)
}

/// The vector of an embedding answer.
pub fn parse_embedding(kind: ProviderKind, body: &str) -> Result<Vec<f32>, AiError> {
    let value = parse_json(body)?;
    let list = match kind {
        ProviderKind::Gemini => &value["embedding"]["values"],
        _ => &value["data"][0]["embedding"],
    };
    let vector: Vec<f32> = list
        .as_array()
        .ok_or_else(|| AiError::Parse("no embedding in the answer".to_string()))?
        .iter()
        .filter_map(|n| n.as_f64().map(|f| f as f32))
        .collect();
    if vector.is_empty() {
        return Err(AiError::Parse("the embedding is empty".to_string()));
    }
    Ok(vector)
}

/// A readable message for an error answer.
pub fn describe_error(status: u16, body: &str) -> String {
    let detail = serde_json::from_str::<Value>(body)
        .ok()
        .and_then(|v| {
            v["error"]["message"]
                .as_str()
                .or_else(|| v["error"].as_str())
                .or_else(|| v["message"].as_str())
                .map(str::to_string)
        })
        .unwrap_or_else(|| body.trim().chars().take(300).collect());
    let lead = match status {
        401 | 403 => "The provider rejected the API key or the request",
        404 => "The provider could not find the endpoint or the model",
        429 => "The provider says the rate limit or quota is used up",
        500..=599 => "The provider had a problem on its side",
        _ => "The provider refused the request",
    };
    if detail.is_empty() {
        format!("{lead} (HTTP {status}).")
    } else {
        format!("{lead} (HTTP {status}): {detail}")
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::provider::Capability;

    fn cfg(kind: ProviderKind) -> ProviderConfig {
        ProviderConfig {
            id: "p".into(),
            name: "P".into(),
            kind,
            base_url: String::new(),
            model: "m".into(),
            models: vec![],
            enabled: true,
            source: None,
            capabilities: vec![Capability::Chat],
        }
        .normalized()
        .expect("valid")
    }

    fn request() -> ChatRequest {
        ChatRequest {
            model: "the-model".into(),
            system: Some("be brief".into()),
            messages: vec![
                ChatMessage {
                    role: "user".into(),
                    content: "hi".into(),
                },
                ChatMessage {
                    role: "assistant".into(),
                    content: "hello".into(),
                },
                ChatMessage {
                    role: "user".into(),
                    content: "more".into(),
                },
            ],
            max_tokens: 256,
        }
    }

    fn header<'a>(req: &'a WireRequest, name: &str) -> Option<&'a str> {
        req.headers
            .iter()
            .find(|(n, _)| n.eq_ignore_ascii_case(name))
            .map(|(_, v)| v.as_str())
    }

    #[test]
    fn claude_request_shape() {
        let req = build_chat(&cfg(ProviderKind::Claude), "sk-ant-1", &request(), true).expect("ok");
        assert_eq!(req.url, "https://api.anthropic.com/v1/messages");
        assert_eq!(header(&req, "x-api-key"), Some("sk-ant-1"));
        assert_eq!(header(&req, "anthropic-version"), Some("2023-06-01"));
        let body: Value = serde_json::from_str(req.body.as_deref().expect("body")).expect("json");
        assert_eq!(body["model"], "the-model");
        assert_eq!(body["max_tokens"], 256);
        assert_eq!(body["system"], "be brief");
        assert_eq!(body["stream"], true);
        assert_eq!(body["messages"][1]["role"], "assistant");
    }

    #[test]
    fn openai_request_shape_puts_the_system_message_first() {
        let mut provider = cfg(ProviderKind::OpenAiCompatible);
        provider.base_url = "https://proxy.example.com/v1/".into();
        let provider = provider.normalized().expect("valid");
        let req = build_chat(&provider, "sk-1", &request(), false).expect("ok");
        assert_eq!(req.url, "https://proxy.example.com/v1/chat/completions");
        assert_eq!(header(&req, "authorization"), Some("Bearer sk-1"));
        let body: Value = serde_json::from_str(req.body.as_deref().expect("body")).expect("json");
        assert_eq!(body["messages"][0]["role"], "system");
        assert_eq!(body["messages"][1]["content"], "hi");
        assert_eq!(body["stream"], false);
    }

    #[test]
    fn a_local_server_needs_no_authorization_header() {
        let req = build_chat(&cfg(ProviderKind::Local), "", &request(), true).expect("ok");
        assert!(header(&req, "authorization").is_none());
        assert_eq!(req.url, "http://127.0.0.1:11434/v1/chat/completions");
    }

    #[test]
    fn gemini_request_shape_keeps_the_key_out_of_the_url() {
        let req = build_chat(&cfg(ProviderKind::Gemini), "AIzaKEY", &request(), true).expect("ok");
        assert_eq!(
            req.url,
            "https://generativelanguage.googleapis.com/v1beta/models/the-model:streamGenerateContent?alt=sse"
        );
        assert!(!req.url.contains("AIzaKEY"));
        assert_eq!(header(&req, "x-goog-api-key"), Some("AIzaKEY"));
        let body: Value = serde_json::from_str(req.body.as_deref().expect("body")).expect("json");
        assert_eq!(body["contents"][1]["role"], "model");
        assert_eq!(body["systemInstruction"]["parts"][0]["text"], "be brief");
    }

    #[test]
    fn a_missing_model_or_a_url_breaking_model_is_refused() {
        let mut r = request();
        r.model = " ".into();
        assert!(build_chat(&cfg(ProviderKind::Claude), "k", &r, false).is_err());
        r.model = "a/../b".into();
        assert!(build_chat(&cfg(ProviderKind::Gemini), "k", &r, false).is_err());
    }

    #[test]
    fn replies_are_read_for_each_kind() {
        assert_eq!(
            parse_reply(
                ProviderKind::Claude,
                r#"{"content":[{"type":"text","text":"a"},{"type":"text","text":"b"}]}"#
            )
            .expect("ok"),
            "ab"
        );
        assert_eq!(
            parse_reply(
                ProviderKind::OpenAiCompatible,
                r#"{"choices":[{"message":{"content":"hey"}}]}"#
            )
            .expect("ok"),
            "hey"
        );
        assert_eq!(
            parse_reply(
                ProviderKind::Gemini,
                r#"{"candidates":[{"content":{"parts":[{"text":"x"},{"text":"y"}]}}]}"#
            )
            .expect("ok"),
            "xy"
        );
        assert!(parse_reply(ProviderKind::Claude, "not json").is_err());
    }

    #[test]
    fn stream_lines_are_read_for_each_kind() {
        assert_eq!(
            parse_stream_line(
                ProviderKind::Claude,
                r#"data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"Hi"}}"#
            ),
            StreamEvent::Text("Hi".into())
        );
        assert_eq!(
            parse_stream_line(ProviderKind::Claude, r#"data: {"type":"message_stop"}"#),
            StreamEvent::Done
        );
        assert_eq!(
            parse_stream_line(ProviderKind::Claude, "event: ping"),
            StreamEvent::Skip
        );
        assert_eq!(
            parse_stream_line(
                ProviderKind::OpenAiCompatible,
                r#"data: {"choices":[{"delta":{"content":"yo"}}]}"#
            ),
            StreamEvent::Text("yo".into())
        );
        assert_eq!(
            parse_stream_line(ProviderKind::OpenAiCompatible, "data: [DONE]"),
            StreamEvent::Done
        );
        assert_eq!(
            parse_stream_line(
                ProviderKind::Gemini,
                r#"data: {"candidates":[{"content":{"parts":[{"text":"g"}]}}]}"#
            ),
            StreamEvent::Text("g".into())
        );
        assert_eq!(
            parse_stream_line(
                ProviderKind::OpenAiCompatible,
                r#"data: {"error":{"message":"boom"}}"#
            ),
            StreamEvent::Failed("boom".into())
        );
    }

    #[test]
    fn models_and_embeddings_are_read() {
        let models = parse_models(
            ProviderKind::Gemini,
            r#"{"models":[{"name":"models/gemini-x","supportedGenerationMethods":["generateContent"]},{"name":"models/emb","supportedGenerationMethods":["embedContent"]}]}"#,
        )
        .expect("ok");
        assert_eq!(models[0].id, "gemini-x");
        assert!(models[0].chat && !models[0].embedding);
        assert!(models[1].embedding);
        let openai = parse_models(
            ProviderKind::OpenAiCompatible,
            r#"{"data":[{"id":"gpt-a"},{"id":"text-embedding-3"}]}"#,
        )
        .expect("ok");
        assert!(openai[1].embedding);
        assert_eq!(
            parse_embedding(
                ProviderKind::OpenAiCompatible,
                r#"{"data":[{"embedding":[0.5,1.0]}]}"#
            )
            .expect("ok"),
            vec![0.5, 1.0]
        );
        assert!(build_embed(&cfg(ProviderKind::Claude), "k", "m", "t").is_err());
    }

    #[test]
    fn error_answers_become_readable_messages() {
        let text = describe_error(401, r#"{"error":{"message":"bad key"}}"#);
        assert!(text.contains("rejected") && text.contains("bad key") && text.contains("401"));
        assert!(describe_error(429, "").contains("rate limit"));
        assert!(describe_error(503, "oops").contains("oops"));
    }
}
