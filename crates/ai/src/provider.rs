//! What a provider is: kind, endpoint, model, capabilities. Providers are data — the chat code picks the
//! protocol by [`ProviderKind`], so no UI or command is written for one vendor.

use serde::{Deserialize, Serialize};
use ureq::http::Uri;

use crate::error::AiError;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum ProviderKind {
    /// Anthropic's Messages API.
    Claude,
    /// OpenAI's Chat Completions API and every server that copies it (a custom endpoint).
    #[serde(rename = "openai-compatible")]
    OpenAiCompatible,
    /// Google's Gemini `generateContent` API.
    Gemini,
    /// An OpenAI-compatible server running on this machine (Ollama, LM Studio, llama.cpp ...). OpenMind
    /// does not run models itself; it only talks to a loopback address.
    Local,
}

impl ProviderKind {
    /// The kind for a contribution's `type` (`custom` is an OpenAI-compatible endpoint).
    pub fn parse(text: &str) -> Option<Self> {
        match text.trim().to_ascii_lowercase().as_str() {
            "claude" | "anthropic" => Some(Self::Claude),
            "openai-compatible" | "openai" | "custom" => Some(Self::OpenAiCompatible),
            "gemini" => Some(Self::Gemini),
            "local" => Some(Self::Local),
            _ => None,
        }
    }

    pub fn default_base_url(self) -> &'static str {
        match self {
            Self::Claude => "https://api.anthropic.com",
            Self::OpenAiCompatible => "https://api.openai.com/v1",
            Self::Gemini => "https://generativelanguage.googleapis.com",
            Self::Local => "http://127.0.0.1:11434/v1",
        }
    }

    /// What this app actually implements for the kind — a provider can't claim more.
    pub fn implemented(self) -> &'static [Capability] {
        use Capability::{Chat, CodeAssistance, Embeddings, LocalOffline, Streaming};
        match self {
            Self::Claude => &[Chat, Streaming, CodeAssistance],
            Self::OpenAiCompatible | Self::Gemini => &[Chat, Streaming, Embeddings, CodeAssistance],
            Self::Local => &[Chat, Streaming, Embeddings, LocalOffline, CodeAssistance],
        }
    }

    pub fn label(self) -> &'static str {
        match self {
            Self::Claude => "Claude",
            Self::OpenAiCompatible => "OpenAI-compatible",
            Self::Gemini => "Gemini",
            Self::Local => "Local",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Capability {
    Chat,
    Streaming,
    Embeddings,
    Vision,
    ToolCalling,
    LocalOffline,
    CodeAssistance,
}

impl Capability {
    pub fn parse(text: &str) -> Option<Self> {
        let key = text
            .trim()
            .to_ascii_lowercase()
            .replace(['-', '_', '/'], "");
        match key.as_str() {
            "chat" => Some(Self::Chat),
            "streaming" => Some(Self::Streaming),
            "embeddings" => Some(Self::Embeddings),
            "vision" => Some(Self::Vision),
            "toolcalling" => Some(Self::ToolCalling),
            "localoffline" | "local" | "offline" => Some(Self::LocalOffline),
            "codeassistance" | "code" => Some(Self::CodeAssistance),
            _ => None,
        }
    }
}

/// A configured provider. Holds no secret: the API key lives apart, encrypted, under the provider's id.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderConfig {
    pub id: String,
    pub name: String,
    pub kind: ProviderKind,
    #[serde(default)]
    pub base_url: String,
    #[serde(default)]
    pub model: String,
    /// Models known for this provider (from the last connection test, or the extension's list).
    #[serde(default)]
    pub models: Vec<String>,
    #[serde(default = "yes")]
    pub enabled: bool,
    /// The extension that contributed the provider, if any (`publisher.name`).
    #[serde(default)]
    pub source: Option<String>,
    #[serde(default)]
    pub capabilities: Vec<Capability>,
}

fn yes() -> bool {
    true
}

const MAX_ID: usize = 120;

impl ProviderConfig {
    /// Checks the provider and fills in what is implicit (default endpoint, implemented capabilities).
    pub fn normalized(mut self) -> Result<Self, AiError> {
        let bad = |what: &str| AiError::InvalidProvider(what.to_string());
        if self.id.is_empty()
            || self.id.len() > MAX_ID
            || !self
                .id
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || "-_.:/@".contains(c))
        {
            return Err(bad(
                "The provider id may only contain letters, digits and - _ . : / @.",
            ));
        }
        self.name = self.name.trim().to_string();
        if self.name.is_empty() || self.name.chars().count() > 80 {
            return Err(bad("Give the provider a name of up to 80 characters."));
        }
        self.model = self.model.trim().to_string();
        if self.model.chars().count() > 120 || self.model.chars().any(char::is_control) {
            return Err(bad("The model name is not valid."));
        }
        self.models
            .retain(|m| !m.trim().is_empty() && m.len() <= 120);
        self.models.truncate(500);
        self.base_url = self.base_url.trim().trim_end_matches('/').to_string();
        if self.base_url.is_empty() {
            self.base_url = self.kind.default_base_url().to_string();
        }
        check_endpoint(&self.base_url, self.kind)?;
        let implemented = self.kind.implemented();
        self.capabilities.retain(|c| implemented.contains(c));
        for cap in implemented {
            if !self.capabilities.contains(cap) {
                self.capabilities.push(*cap);
            }
        }
        if let Some(source) = &self.source {
            if source.is_empty() || source.len() > MAX_ID {
                return Err(bad("The extension id is not valid."));
            }
        }
        Ok(self)
    }

    pub fn has(&self, capability: Capability) -> bool {
        self.capabilities.contains(&capability)
    }

    /// Whether requests stay on this machine (a loopback address).
    pub fn is_local(&self) -> bool {
        host_of(&self.base_url).is_some_and(|host| is_loopback(&host))
    }

    /// Whether the provider needs an API key (a loopback server usually does not).
    pub fn needs_key(&self) -> bool {
        !self.is_local()
    }

    /// The host content would be sent to, for the confirmation message.
    pub fn host(&self) -> String {
        host_of(&self.base_url).unwrap_or_default()
    }
}

fn host_of(url: &str) -> Option<String> {
    let uri: Uri = url.parse().ok()?;
    uri.host()
        .map(|h| h.trim_matches(['[', ']']).to_ascii_lowercase())
}

fn is_loopback(host: &str) -> bool {
    host == "localhost" || host == "::1" || host.starts_with("127.")
}

fn check_endpoint(url: &str, kind: ProviderKind) -> Result<(), AiError> {
    let bad = |what: &str| AiError::InvalidProvider(what.to_string());
    if url.chars().any(|c| c.is_control() || c.is_whitespace()) {
        return Err(bad("The endpoint address is not valid."));
    }
    let uri: Uri = url
        .parse()
        .map_err(|_| bad("The endpoint address is not valid."))?;
    let authority = uri.authority().map(ToString::to_string).unwrap_or_default();
    if authority.contains('@') {
        return Err(bad(
            "The endpoint address must not contain a user name or password.",
        ));
    }
    let host = host_of(url).ok_or_else(|| bad("The endpoint address has no host."))?;
    match uri.scheme_str() {
        Some("https") if kind != ProviderKind::Local => Ok(()),
        Some("https" | "http") if is_loopback(&host) => Ok(()),
        Some("http") => Err(bad(
            "Only https endpoints are allowed (http is accepted for this computer only).",
        )),
        _ if kind == ProviderKind::Local => Err(bad(
            "A local provider must use an address on this computer (localhost).",
        )),
        _ => Err(bad("The endpoint address must start with https://.")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn config(kind: ProviderKind, url: &str) -> ProviderConfig {
        ProviderConfig {
            id: "p1".into(),
            name: "Test".into(),
            kind,
            base_url: url.into(),
            model: String::new(),
            models: vec![],
            enabled: true,
            source: None,
            capabilities: vec![Capability::Vision, Capability::Chat],
        }
    }

    #[test]
    fn fills_defaults_and_drops_capabilities_the_app_lacks() {
        let p = config(ProviderKind::Claude, "")
            .normalized()
            .expect("valid");
        assert_eq!(p.base_url, "https://api.anthropic.com");
        assert!(!p.has(Capability::Vision));
        assert!(p.has(Capability::Streaming));
        assert!(!p.has(Capability::Embeddings));
        assert!(p.needs_key());
    }

    #[test]
    fn endpoints_are_https_or_loopback() {
        assert!(
            config(ProviderKind::OpenAiCompatible, "http://example.com/v1")
                .normalized()
                .is_err()
        );
        assert!(config(
            ProviderKind::OpenAiCompatible,
            "https://user:pw@example.com"
        )
        .normalized()
        .is_err());
        let local = config(ProviderKind::OpenAiCompatible, "http://127.0.0.1:8080/v1")
            .normalized()
            .expect("loopback http is fine");
        assert!(local.is_local());
        assert!(!local.needs_key());
        assert!(config(ProviderKind::Local, "https://example.com")
            .normalized()
            .is_err());
    }

    #[test]
    fn ids_and_names_are_checked() {
        let mut p = config(ProviderKind::Gemini, "");
        p.id = "a b".into();
        assert!(p.normalized().is_err());
        let mut p = config(ProviderKind::Gemini, "");
        p.name = "  ".into();
        assert!(p.normalized().is_err());
    }

    #[test]
    fn kinds_use_the_names_the_ui_and_extensions_use() {
        for (kind, name) in [
            (ProviderKind::Claude, "claude"),
            (ProviderKind::OpenAiCompatible, "openai-compatible"),
            (ProviderKind::Gemini, "gemini"),
            (ProviderKind::Local, "local"),
        ] {
            let json = serde_json::to_string(&kind).expect("serialize");
            assert_eq!(json, format!("\"{name}\""));
            assert_eq!(
                serde_json::from_str::<ProviderKind>(&json).expect("parse"),
                kind
            );
            assert_eq!(ProviderKind::parse(name), Some(kind));
        }
        let config: ProviderConfig = serde_json::from_str(
            r#"{"id":"a","name":"A","kind":"openai-compatible","capabilities":["toolCalling","localOffline"]}"#,
        )
        .expect("the UI's spelling is accepted");
        assert_eq!(config.kind, ProviderKind::OpenAiCompatible);
        assert_eq!(
            config.capabilities,
            vec![Capability::ToolCalling, Capability::LocalOffline]
        );
    }

    #[test]
    fn contribution_types_parse() {
        assert_eq!(
            ProviderKind::parse("custom"),
            Some(ProviderKind::OpenAiCompatible)
        );
        assert_eq!(ProviderKind::parse("Claude"), Some(ProviderKind::Claude));
        assert_eq!(ProviderKind::parse("x"), None);
        assert_eq!(
            Capability::parse("tool-calling"),
            Some(Capability::ToolCalling)
        );
        assert_eq!(
            Capability::parse("local/offline"),
            Some(Capability::LocalOffline)
        );
    }
}
