//! Errors of the AI providers. Every message that can carry text from a server or a URL goes through
//! [`redact`] first, so an API key never reaches a log, a toast or a stored conversation.

#[derive(Debug, thiserror::Error, PartialEq, Eq)]
pub enum AiError {
    #[error("{0}")]
    InvalidProvider(String),
    #[error("{0}")]
    NotConfigured(String),
    /// The server could not be reached (or the connection broke).
    #[error("{0}")]
    Network(String),
    /// The server answered with an error status.
    #[error("{message}")]
    Provider { status: u16, message: String },
    #[error("The server's answer could not be read: {0}")]
    Parse(String),
    #[error("The request was cancelled.")]
    Cancelled,
    #[error("This provider does not support {0}.")]
    Unsupported(&'static str),
    #[error("{0}")]
    Storage(String),
}

impl From<rusqlite::Error> for AiError {
    fn from(err: rusqlite::Error) -> Self {
        Self::Storage(format!("The AI history could not be used: {err}"))
    }
}

impl From<std::io::Error> for AiError {
    fn from(err: std::io::Error) -> Self {
        Self::Storage(format!("The AI settings could not be saved: {err}"))
    }
}

/// `text` with every occurrence of `secret` replaced, and any `key=...` query value hidden.
pub fn redact(text: &str, secret: &str) -> String {
    let mut out = if secret.len() >= 4 {
        text.replace(secret, "[key hidden]")
    } else {
        text.to_string()
    };
    for marker in ["key=", "api_key=", "apikey="] {
        let mut from = 0;
        while let Some(found) = out[from..].find(marker) {
            let start = from + found + marker.len();
            let end = out[start..]
                .find(|c: char| !(c.is_ascii_alphanumeric() || "-_.~".contains(c)))
                .map_or(out.len(), |n| start + n);
            if end > start {
                out.replace_range(start..end, "[key hidden]");
                from = start + "[key hidden]".len();
            } else {
                from = start;
            }
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::redact;

    #[test]
    fn hides_the_secret_and_query_keys() {
        assert_eq!(
            redact("bad sk-abc123 here", "sk-abc123"),
            "bad [key hidden] here"
        );
        assert_eq!(
            redact("GET /x?key=AIzaSy123&alt=sse", ""),
            "GET /x?key=[key hidden]&alt=sse"
        );
    }

    #[test]
    fn short_secrets_are_not_replaced_blindly() {
        assert_eq!(redact("a b c", "a"), "a b c");
    }
}
