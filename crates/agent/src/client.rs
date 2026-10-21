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

#[cfg(test)]
mod tests {
    //! `HttpModel` is the one transport a turn's chat/completions call goes through, whether it talks to
    //! the local engine (often no key) or a configured provider such as OpenMindAI Cloud (always a
    //! developer API key, sent as `Authorization: Bearer <key>`). These tests drive it against a real
    //! loopback server — loopback is always reached directly, so this is also how `openmind_ai::transport`
    //! itself is tested — and never a live network host.
    use super::*;
    use serde_json::json;
    use std::io::{Read, Write};
    use std::net::TcpListener;
    use std::sync::atomic::Ordering;
    use std::sync::{Arc, Mutex};
    use std::time::{Duration, Instant};

    /// Accepts one connection, hands the raw request bytes to `captured`, and writes `response` as the
    /// whole reply (status line, headers and body included by the caller).
    fn serve_once(
        response: &'static str,
        captured: Arc<Mutex<Option<String>>>,
    ) -> std::net::SocketAddr {
        let listener = TcpListener::bind("127.0.0.1:0").expect("bind");
        let addr = listener.local_addr().expect("addr");
        std::thread::spawn(move || {
            let (mut socket, _) = listener.accept().expect("accept");
            socket
                .set_read_timeout(Some(Duration::from_secs(2)))
                .expect("read timeout");
            let mut buf = [0u8; 8192];
            let read = socket.read(&mut buf).unwrap_or(0);
            *captured.lock().expect("lock") =
                Some(String::from_utf8_lossy(&buf[..read]).into_owned());
            let _ = socket.write_all(response.as_bytes());
            // A graceful close, not an abrupt drop: signal "no more data from us" (FIN) and then wait for
            // the client's own EOF before the socket goes away. Dropping the TcpStream right after the
            // write raced the client's read on Windows -- an unacknowledged send buffer at drop time can
            // turn into an RST ("connection forcibly closed", os error 10054) instead of a clean close.
            let _ = socket.shutdown(std::net::Shutdown::Write);
            let _ = socket.set_read_timeout(Some(Duration::from_secs(2)));
            while socket.read(&mut buf).unwrap_or(0) > 0 {}
        });
        addr
    }

    #[test]
    fn the_developer_api_key_is_sent_as_a_bearer_token_and_never_as_anything_else() {
        let captured = Arc::new(Mutex::new(None));
        let addr = serve_once(
            "HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nConnection: close\r\nContent-Length: 0\r\n\r\n",
            Arc::clone(&captured),
        );
        let model = HttpModel {
            base_url: format!("http://{addr}"),
            key: "dev-key-abc123".into(),
        };
        let cancel = AtomicBool::new(false);
        let _ = model.stream(&json!({"model": "openmindai-lite"}), &cancel, &mut |_| true);
        let request = captured
            .lock()
            .expect("lock")
            .take()
            .expect("a request arrived");
        // ureq writes header names in lowercase on the wire; the value itself is what matters.
        assert!(
            request
                .to_lowercase()
                .contains("authorization: bearer dev-key-abc123\r\n"),
            "expected a Bearer header, got:\n{request}"
        );
        assert!(!request.to_lowercase().contains("x-api-key"));
        assert!(request.starts_with("POST /chat/completions"));
    }

    #[test]
    fn an_empty_key_sends_no_authorization_header_the_same_transport_either_way() {
        // The local engine often runs with no key at all; this is the exact same `HttpModel` the cloud path
        // uses, so this proves local and cloud share one correct code path rather than diverging.
        let captured = Arc::new(Mutex::new(None));
        let addr = serve_once(
            "HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nConnection: close\r\nContent-Length: 0\r\n\r\n",
            Arc::clone(&captured),
        );
        let model = HttpModel {
            base_url: format!("http://{addr}"),
            key: String::new(),
        };
        let cancel = AtomicBool::new(false);
        let _ = model.stream(&json!({}), &cancel, &mut |_| true);
        let request = captured
            .lock()
            .expect("lock")
            .take()
            .expect("a request arrived");
        assert!(!request.to_lowercase().contains("authorization"));
    }

    #[test]
    fn streamed_lines_reach_on_line_in_order_until_the_server_closes() {
        let captured = Arc::new(Mutex::new(None));
        let addr = serve_once(
            "HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nConnection: close\r\n\r\n\
             data: {\"choices\":[{\"delta\":{\"content\":\"hi\"}}]}\n\n\
             data: [DONE]\n\n",
            Arc::clone(&captured),
        );
        let model = HttpModel {
            base_url: format!("http://{addr}"),
            key: "k".into(),
        };
        let cancel = AtomicBool::new(false);
        let mut lines = Vec::new();
        let result = model.stream(&json!({}), &cancel, &mut |line| {
            lines.push(line.to_string());
            true
        });
        assert!(result.is_ok(), "{result:?}");
        // SSE's blank line between events is delivered too (filtering it is the caller's job, same as the
        // real session's stream reader); only the two data lines matter here, in order.
        let data_lines: Vec<&String> = lines.iter().filter(|l| !l.is_empty()).collect();
        assert_eq!(data_lines.len(), 2, "{lines:?}");
        assert!(data_lines[0].contains("\"content\":\"hi\""));
        assert_eq!(data_lines[1], "data: [DONE]");
    }

    #[test]
    fn a_server_error_is_a_clean_result_err_with_the_key_redacted() {
        let captured = Arc::new(Mutex::new(None));
        let addr = serve_once(
            "HTTP/1.1 401 Unauthorized\r\nContent-Type: application/json\r\nConnection: close\r\nContent-Length: 30\r\n\r\n{\"message\":\"Unauthenticated.\"}",
            Arc::clone(&captured),
        );
        let model = HttpModel {
            base_url: format!("http://{addr}"),
            key: "super-secret-key".into(),
        };
        let cancel = AtomicBool::new(false);
        let result = model.stream(&json!({}), &cancel, &mut |_| true);
        let err = result.expect_err("a 401 must not be reported as success");
        assert!(
            !err.contains("super-secret-key"),
            "the key leaked into the error: {err}"
        );
    }

    #[test]
    fn cancelling_mid_stream_returns_promptly_instead_of_waiting_for_the_server() {
        let listener = TcpListener::bind("127.0.0.1:0").expect("bind");
        let addr = listener.local_addr().expect("addr");
        let (ready_tx, ready_rx) = std::sync::mpsc::channel::<()>();
        std::thread::spawn(move || {
            let (mut socket, _) = listener.accept().expect("accept");
            let mut buf = [0u8; 4096];
            let _ = socket.read(&mut buf);
            socket
                .write_all(
                    b"HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nConnection: close\r\n\r\n",
                )
                .expect("send headers");
            ready_tx.send(()).expect("signal headers sent");
            // No body follows for a long time; the caller must not wait for this.
            std::thread::sleep(Duration::from_millis(1_800));
        });
        let model = HttpModel {
            base_url: format!("http://{addr}"),
            key: "k".into(),
        };
        let cancel = Arc::new(AtomicBool::new(false));
        let flag = Arc::clone(&cancel);
        let stop = std::thread::spawn(move || {
            ready_rx
                .recv_timeout(Duration::from_secs(3))
                .expect("stream started");
            flag.store(true, Ordering::Release);
        });
        let started = Instant::now();
        let result = model.stream(&json!({}), &cancel, &mut |_| true);
        assert_eq!(result, Err("cancelled".to_string()));
        stop.join().expect("stop thread");
        assert!(
            started.elapsed() < Duration::from_millis(750),
            "Stop must not wait for the blocked HTTP reader, took {:?}",
            started.elapsed()
        );
    }
}
