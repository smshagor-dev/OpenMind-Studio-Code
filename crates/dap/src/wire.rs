//! The DAP wire format: `Content-Length` framing (the same as LSP's) around JSON messages that
//! are requests, responses or events, each with a sequence number.

use std::io::{BufRead, Write};

use serde_json::{json, Value};

use crate::error::DapError;

/// One message from the debug adapter.
#[derive(Debug, Clone, PartialEq)]
pub enum Incoming {
    Response {
        request_seq: i64,
        success: bool,
        command: String,
        message: Option<String>,
        body: Value,
    },
    Event {
        event: String,
        body: Value,
    },
    /// The adapter asks the client to do something (`startDebugging`, `runInTerminal`).
    Request {
        seq: i64,
        command: String,
        arguments: Value,
    },
}

pub fn request_message(seq: i64, command: &str, arguments: &Value) -> Value {
    json!({ "seq": seq, "type": "request", "command": command, "arguments": arguments })
}

pub fn response_message(
    seq: i64,
    request_seq: i64,
    command: &str,
    result: Result<Value, String>,
) -> Value {
    match result {
        Ok(body) => json!({
            "seq": seq, "type": "response", "request_seq": request_seq,
            "success": true, "command": command, "body": body
        }),
        Err(message) => json!({
            "seq": seq, "type": "response", "request_seq": request_seq,
            "success": false, "command": command, "message": message
        }),
    }
}

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

const MAX_BODY: usize = 256 * 1024 * 1024;

/// Reads one framed message; `Ok(None)` at a clean end of the stream.
pub fn read_frame<R: BufRead>(reader: &mut R) -> Result<Option<Value>, DapError> {
    let mut length: Option<usize> = None;
    let mut saw_header = false;
    loop {
        let mut line = String::new();
        let read = reader
            .read_line(&mut line)
            .map_err(|err| DapError::Protocol(err.to_string()))?;
        if read == 0 {
            return if saw_header {
                Err(DapError::Protocol("stream ended inside a header".into()))
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
    let length = length.ok_or_else(|| DapError::Protocol("missing Content-Length".into()))?;
    if length > MAX_BODY {
        return Err(DapError::Protocol(format!("message of {length} bytes")));
    }
    let mut body = vec![0; length];
    reader
        .read_exact(&mut body)
        .map_err(|err| DapError::Protocol(err.to_string()))?;
    serde_json::from_slice(&body)
        .map(Some)
        .map_err(|err| DapError::Protocol(err.to_string()))
}

pub fn classify(message: &Value) -> Result<Incoming, DapError> {
    let text = |key: &str| message.get(key).and_then(Value::as_str).map(str::to_string);
    let body = || message.get("body").cloned().unwrap_or(Value::Null);
    match message.get("type").and_then(Value::as_str) {
        Some("response") => Ok(Incoming::Response {
            request_seq: message
                .get("request_seq")
                .and_then(Value::as_i64)
                .ok_or_else(|| DapError::Protocol("a response without request_seq".into()))?,
            success: message
                .get("success")
                .and_then(Value::as_bool)
                .unwrap_or(false),
            command: text("command").unwrap_or_default(),
            message: text("message"),
            body: body(),
        }),
        Some("event") => Ok(Incoming::Event {
            event: text("event")
                .ok_or_else(|| DapError::Protocol("an event without a name".into()))?,
            body: body(),
        }),
        Some("request") => Ok(Incoming::Request {
            seq: message.get("seq").and_then(Value::as_i64).unwrap_or(0),
            command: text("command")
                .ok_or_else(|| DapError::Protocol("a request without a command".into()))?,
            arguments: message.get("arguments").cloned().unwrap_or(Value::Null),
        }),
        other => Err(DapError::Protocol(format!(
            "unknown message type {other:?}"
        ))),
    }
}

#[cfg(test)]
mod tests {
    use std::io::Cursor;

    use super::*;

    #[test]
    fn a_request_is_framed_by_byte_length_and_read_back() {
        let message = request_message(
            3,
            "setBreakpoints",
            &json!({ "source": { "path": "C:/My ü/a.py" } }),
        );
        let bytes = encode(&message);
        let head = format!("Content-Length: {}\r\n\r\n", message.to_string().len());
        assert!(String::from_utf8(bytes.clone())
            .expect("utf8")
            .starts_with(&head));
        assert_eq!(
            read_frame(&mut Cursor::new(bytes)).expect("read"),
            Some(message)
        );
    }

    #[test]
    fn truncated_and_headerless_streams_are_errors_and_an_empty_one_is_the_end() {
        assert_eq!(read_frame(&mut Cursor::new(Vec::new())).expect("end"), None);
        assert!(read_frame(&mut Cursor::new(b"X: 1\r\n\r\n{}".to_vec())).is_err());
        assert!(read_frame(&mut Cursor::new(b"Content-Length: 9\r\n\r\n{}".to_vec())).is_err());
    }

    #[test]
    fn responses_events_and_reverse_requests_are_told_apart() {
        let ok = classify(&json!({ "type": "response", "request_seq": 4, "success": true, "command": "next", "body": { "a": 1 } })).expect("ok");
        assert_eq!(
            ok,
            Incoming::Response {
                request_seq: 4,
                success: true,
                command: "next".into(),
                message: None,
                body: json!({ "a": 1 })
            }
        );
        let failed = classify(&json!({ "type": "response", "request_seq": 5, "success": false, "command": "evaluate", "message": "boom" })).expect("failed");
        assert!(
            matches!(failed, Incoming::Response { success: false, message: Some(m), .. } if m == "boom")
        );
        assert!(matches!(
            classify(&json!({ "type": "event", "event": "stopped", "body": { "reason": "step" } })).expect("event"),
            Incoming::Event { event, .. } if event == "stopped"
        ));
        assert!(matches!(
            classify(&json!({ "type": "request", "seq": 9, "command": "startDebugging", "arguments": {} })).expect("reverse"),
            Incoming::Request { seq: 9, .. }
        ));
        assert!(classify(&json!({ "type": "nonsense" })).is_err());
        assert!(classify(&json!({ "type": "response" })).is_err());
    }

    #[test]
    fn a_failure_response_carries_the_message() {
        let failed = response_message(2, 9, "runInTerminal", Err("no".into()));
        assert_eq!(failed["success"], false);
        assert_eq!(failed["message"], "no");
        assert_eq!(response_message(2, 9, "x", Ok(json!({})))["success"], true);
    }
}
