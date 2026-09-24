//! JSON-RPC 2.0 over stdio with LSP's `Content-Length` framing.

use std::io::{BufRead, Write};

use serde_json::{json, Value};

use crate::error::LspError;

/// One message from the server.
#[derive(Debug, Clone, PartialEq)]
pub enum Incoming {
    /// A reply to one of our requests.
    Response {
        id: i64,
        result: Result<Value, ResponseError>,
    },
    /// The server asks us something and waits for the answer.
    Request {
        id: Value,
        method: String,
        params: Value,
    },
    Notification {
        method: String,
        params: Value,
    },
}

#[derive(Debug, Clone, PartialEq)]
pub struct ResponseError {
    pub code: i64,
    pub message: String,
}

pub fn request_message(id: i64, method: &str, params: &Value) -> Value {
    json!({ "jsonrpc": "2.0", "id": id, "method": method, "params": params })
}

pub fn notification_message(method: &str, params: &Value) -> Value {
    json!({ "jsonrpc": "2.0", "method": method, "params": params })
}

pub fn response_message(id: &Value, result: Value) -> Value {
    json!({ "jsonrpc": "2.0", "id": id, "result": result })
}

pub fn error_response(id: &Value, code: i64, message: &str) -> Value {
    json!({ "jsonrpc": "2.0", "id": id, "error": { "code": code, "message": message } })
}

/// The bytes on the wire for `message`: a header, a blank line, the JSON.
pub fn encode(message: &Value) -> Vec<u8> {
    let body = message.to_string();
    let mut bytes = format!("Content-Length: {}\r\n\r\n", body.len()).into_bytes();
    bytes.extend_from_slice(body.as_bytes());
    bytes
}

pub fn write_message<W: Write>(writer: &mut W, message: &Value) -> std::io::Result<()> {
    writer.write_all(&encode(message))?;
    writer.flush()
}

/// The largest message body accepted (a runaway server can't make us allocate without bound).
const MAX_BODY: usize = 256 * 1024 * 1024;

/// Reads one framed message. `Ok(None)` at a clean end of the stream.
pub fn read_frame<R: BufRead>(reader: &mut R) -> Result<Option<Value>, LspError> {
    let mut length: Option<usize> = None;
    let mut saw_header = false;
    loop {
        let mut line = String::new();
        let read = reader
            .read_line(&mut line)
            .map_err(|err| LspError::Protocol(err.to_string()))?;
        if read == 0 {
            return if saw_header {
                Err(LspError::Protocol("stream ended inside a header".into()))
            } else {
                Ok(None)
            };
        }
        let line = line.trim_end_matches(['\r', '\n']);
        if line.is_empty() {
            break;
        }
        saw_header = true;
        if let Some((name, value)) = line.split_once(':') {
            if name.eq_ignore_ascii_case("content-length") {
                length = value.trim().parse().ok();
            }
        }
    }
    let length = length.ok_or_else(|| LspError::Protocol("missing Content-Length".into()))?;
    if length > MAX_BODY {
        return Err(LspError::Protocol(format!("message of {length} bytes")));
    }
    let mut body = vec![0; length];
    reader
        .read_exact(&mut body)
        .map_err(|err| LspError::Protocol(err.to_string()))?;
    serde_json::from_slice(&body)
        .map(Some)
        .map_err(|err| LspError::Protocol(err.to_string()))
}

/// Sorts a decoded message into response / request / notification.
pub fn classify(message: Value) -> Result<Incoming, LspError> {
    let method = message
        .get("method")
        .and_then(Value::as_str)
        .map(str::to_string);
    let id = message.get("id").cloned();
    match (method, id) {
        (Some(method), Some(id)) => Ok(Incoming::Request {
            id,
            method,
            params: message.get("params").cloned().unwrap_or(Value::Null),
        }),
        (Some(method), None) => Ok(Incoming::Notification {
            method,
            params: message.get("params").cloned().unwrap_or(Value::Null),
        }),
        (None, Some(id)) => {
            let id = id
                .as_i64()
                .ok_or_else(|| LspError::Protocol("a response with a non-numeric id".into()))?;
            let result = match message.get("error") {
                Some(error) => Err(ResponseError {
                    code: error.get("code").and_then(Value::as_i64).unwrap_or(0),
                    message: error
                        .get("message")
                        .and_then(Value::as_str)
                        .unwrap_or("unknown error")
                        .to_string(),
                }),
                None => Ok(message.get("result").cloned().unwrap_or(Value::Null)),
            };
            Ok(Incoming::Response { id, result })
        }
        (None, None) => Err(LspError::Protocol("neither a method nor an id".into())),
    }
}

#[cfg(test)]
mod tests {
    use std::io::Cursor;

    use super::*;

    #[test]
    fn a_message_round_trips_through_the_framing() {
        let message = request_message(7, "textDocument/hover", &json!({"a": "é"}));
        let bytes = encode(&message);
        let text = String::from_utf8(bytes.clone()).expect("utf8");
        // The length counts bytes, not characters.
        assert!(text.starts_with(&format!(
            "Content-Length: {}\r\n\r\n",
            message.to_string().len()
        )));
        let decoded = read_frame(&mut Cursor::new(bytes)).expect("read");
        assert_eq!(decoded, Some(message));
    }

    #[test]
    fn two_frames_in_a_row_and_a_clean_end() {
        let mut bytes = encode(&json!({"jsonrpc": "2.0", "method": "a"}));
        bytes.extend(encode(&json!({"jsonrpc": "2.0", "method": "b"})));
        let mut cursor = Cursor::new(bytes);
        assert!(read_frame(&mut cursor).expect("first").is_some());
        assert!(read_frame(&mut cursor).expect("second").is_some());
        assert_eq!(read_frame(&mut cursor).expect("end"), None);
    }

    #[test]
    fn extra_headers_and_lowercase_names_are_accepted() {
        let body = r#"{"jsonrpc":"2.0","method":"x"}"#;
        let raw = format!(
            "content-type: application/vscode-jsonrpc; charset=utf-8\r\ncontent-length: {}\r\n\r\n{body}",
            body.len()
        );
        assert!(read_frame(&mut Cursor::new(raw.into_bytes()))
            .expect("read")
            .is_some());
    }

    #[test]
    fn a_missing_length_and_a_truncated_body_are_errors() {
        assert!(read_frame(&mut Cursor::new(b"X: 1\r\n\r\n{}".to_vec())).is_err());
        assert!(read_frame(&mut Cursor::new(b"Content-Length: 50\r\n\r\n{}".to_vec())).is_err());
    }

    #[test]
    fn messages_are_classified() {
        assert_eq!(
            classify(json!({"id": 3, "result": {"ok": true}})).expect("response"),
            Incoming::Response {
                id: 3,
                result: Ok(json!({"ok": true}))
            }
        );
        assert_eq!(
            classify(json!({"id": 4, "error": {"code": -32601, "message": "no"}})).expect("error"),
            Incoming::Response {
                id: 4,
                result: Err(ResponseError {
                    code: -32601,
                    message: "no".into()
                })
            }
        );
        assert!(matches!(
            classify(json!({"id": "a", "method": "workspace/configuration", "params": {}}))
                .expect("request"),
            Incoming::Request { .. }
        ));
        assert!(matches!(
            classify(json!({"method": "window/logMessage"})).expect("note"),
            Incoming::Notification { .. }
        ));
        assert!(classify(json!({})).is_err());
    }
}
