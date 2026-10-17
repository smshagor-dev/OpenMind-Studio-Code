//! The one place that touches the network. A request runs on a worker thread and its answer comes back over a
//! channel, so the caller can stop waiting the moment the user cancels (the worker ends when the server does, or
//! at its time limit). Redirects are never followed (an `Authorization` header must not travel to another host).

use std::io::{BufRead, BufReader, Read};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{self, RecvTimeoutError};
use std::time::Duration;

use crate::error::{redact, AiError};
use crate::wire::{describe_error, Method, WireRequest};

const POLL: Duration = Duration::from_millis(40);
/// A whole (non-streamed) answer is never read past this size.
const MAX_BODY: usize = 16 * 1024 * 1024;

enum Event {
    Head(u16),
    Line(String),
    Fail(String),
    End,
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Mode {
    /// Line by line (server-sent events).
    Lines,
    /// The whole body as one piece.
    Whole,
}

/// The agent for one request. It follows the proxy the user configured (`openmind_network::http`); a provider on
/// this computer (loopback) is always reached directly.
fn agent(url: &str) -> ureq::Agent {
    let builder = ureq::Agent::config_builder()
        .http_status_as_error(false)
        .max_redirects(0)
        .timeout_connect(Some(Duration::from_secs(15)))
        .timeout_recv_response(Some(Duration::from_secs(120)))
        .timeout_recv_body(Some(Duration::from_secs(600)));
    openmind_network::http::configure(builder, url)
        .build()
        .into()
}

fn spawn(req: WireRequest, mode: Mode) -> mpsc::Receiver<Event> {
    let (tx, rx) = mpsc::channel();
    std::thread::spawn(move || {
        let agent = agent(&req.url);
        let response = match (req.method, req.body.as_deref()) {
            (Method::Post, body) => {
                let mut builder = agent.post(&req.url);
                for (name, value) in &req.headers {
                    builder = builder.header(name, value);
                }
                builder.send(body.unwrap_or_default())
            }
            (Method::Get, _) => {
                let mut builder = agent.get(&req.url);
                for (name, value) in &req.headers {
                    builder = builder.header(name, value);
                }
                builder.call()
            }
        };
        let mut response = match response {
            Ok(response) => response,
            Err(err) => {
                let _ = tx.send(Event::Fail(err.to_string()));
                return;
            }
        };
        let status = response.status().as_u16();
        if tx.send(Event::Head(status)).is_err() {
            return;
        }
        let ok = (200..300).contains(&status);
        let mut reader = response.body_mut().as_reader();
        if mode == Mode::Lines && ok {
            for line in BufReader::new(reader).lines() {
                match line {
                    Ok(line) => {
                        if tx.send(Event::Line(line)).is_err() {
                            return;
                        }
                    }
                    Err(err) => {
                        let _ = tx.send(Event::Fail(err.to_string()));
                        return;
                    }
                }
            }
        } else {
            let mut body = String::new();
            let read = (&mut reader)
                .take(MAX_BODY as u64)
                .read_to_string(&mut body);
            match read {
                Ok(_) => {
                    let _ = tx.send(Event::Line(body));
                }
                Err(err) => {
                    let _ = tx.send(Event::Fail(err.to_string()));
                    return;
                }
            }
        }
        let _ = tx.send(Event::End);
    });
    rx
}

fn network_error(text: &str, key: &str) -> AiError {
    AiError::Network(format!(
        "The provider could not be reached: {}",
        redact(text, key)
    ))
}

fn drive(
    req: &WireRequest,
    key: &str,
    mode: Mode,
    cancel: &AtomicBool,
    on_line: &mut dyn FnMut(&str) -> Result<bool, AiError>,
) -> Result<(), AiError> {
    // A queued task may already be stopped before it reaches HTTP. Do not
    // create an unnecessary network thread for a cancelled request.
    if cancel.load(Ordering::Relaxed) {
        return Err(AiError::Cancelled);
    }
    let rx = spawn(req.clone(), mode);
    let mut status = 0u16;
    let mut error_body = String::new();
    loop {
        if cancel.load(Ordering::Relaxed) {
            return Err(AiError::Cancelled);
        }
        match rx.recv_timeout(POLL) {
            Ok(Event::Head(code)) => status = code,
            Ok(Event::Line(line)) if (200..300).contains(&status) => {
                if !on_line(&line)? {
                    return Ok(());
                }
            }
            Ok(Event::Line(body)) => error_body = body,
            Ok(Event::Fail(text)) => return Err(network_error(&text, key)),
            Ok(Event::End) | Err(RecvTimeoutError::Disconnected) => {
                if (200..300).contains(&status) {
                    return Ok(());
                }
                return Err(AiError::Provider {
                    status,
                    message: redact(&describe_error(status, &error_body), key),
                });
            }
            Err(RecvTimeoutError::Timeout) => {}
        }
    }
}

/// Sends `req` and returns the whole answer body.
pub fn send_json(req: &WireRequest, key: &str, cancel: &AtomicBool) -> Result<String, AiError> {
    let mut body = String::new();
    drive(req, key, Mode::Whole, cancel, &mut |line| {
        body.push_str(line);
        Ok(true)
    })?;
    Ok(body)
}

/// Sends `req` and calls `on_line` for every line of the answer until it returns `false` or the answer ends.
pub fn stream_lines(
    req: &WireRequest,
    key: &str,
    cancel: &AtomicBool,
    on_line: &mut dyn FnMut(&str) -> Result<bool, AiError>,
) -> Result<(), AiError> {
    drive(req, key, Mode::Lines, cancel, on_line)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{Read, Write};
    use std::net::TcpListener;
    use std::sync::{Arc, Mutex};
    use std::time::Instant;

    #[test]
    fn cancellation_unblocks_caller_while_http_stream_is_stalled() {
        let listener = TcpListener::bind("127.0.0.1:0").expect("bind local test server");
        let addr = listener.local_addr().expect("local address");
        listener.set_nonblocking(true).expect("nonblocking accept");
        let (ready_tx, ready_rx) = mpsc::channel();
        let server = std::thread::spawn(move || {
            let deadline = Instant::now() + Duration::from_secs(2);
            let (mut socket, _) = loop {
                match listener.accept() {
                    Ok(connection) => break connection,
                    Err(err) if err.kind() == std::io::ErrorKind::WouldBlock => {
                        assert!(Instant::now() < deadline, "local test client never connected");
                        std::thread::sleep(Duration::from_millis(10));
                    }
                    Err(err) => panic!("cannot accept local test request: {err}"),
                }
            };
            socket
                .set_read_timeout(Some(Duration::from_secs(2)))
                .expect("set timeout");
            let mut buf = [0u8; 4096];
            let _ = socket.read(&mut buf);
            socket
                .write_all(b"HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nConnection: close\r\n\r\n")
                .expect("send headers");
            ready_tx.send(()).expect("signal streaming response");
            // The server has no reply: caller must not wait for this sleep.
            std::thread::sleep(Duration::from_millis(1_800));
        });
        let req = WireRequest {
            method: Method::Get,
            url: format!("http://{addr}/v1/chat/completions"),
            headers: Vec::new(),
            body: None,
        };
        let cancel = Arc::new(AtomicBool::new(false));
        let flag = Arc::clone(&cancel);
        let cancelled_at = Arc::new(Mutex::new(None));
        let stop_timestamp = Arc::clone(&cancelled_at);
        let stop = std::thread::spawn(move || {
            // Guarantee that cancellation happens during the blocked body
            // read, not before a slow CI runner establishes the connection.
            ready_rx
                .recv_timeout(Duration::from_secs(3))
                .expect("local HTTP stream never started");
            flag.store(true, Ordering::Release);
            *stop_timestamp.lock().expect("timestamp") = Some(Instant::now());
        });
        let response = stream_lines(&req, "", &cancel, &mut |_line| Ok(true));
        assert!(
            matches!(&response, Err(AiError::Cancelled)),
            "{response:?}"
        );
        stop.join().expect("stop thread");
        let cancelled_at = cancelled_at
            .lock()
            .expect("timestamp")
            .as_ref()
            .copied()
            .expect("Stop was sent");
        assert!(
            cancelled_at.elapsed() < Duration::from_millis(750),
            "Stop must not wait for the blocked HTTP reader"
        );
        server.join().expect("test server");
    }

    #[test]
    fn already_cancelled_request_never_reports_a_successful_reply() {
        let cancel = AtomicBool::new(true);
        let req = WireRequest {
            method: Method::Get,
            url: "http://127.0.0.1:1/v1/chat/completions".into(),
            headers: Vec::new(),
            body: None,
        };
        assert!(matches!(
            stream_lines(&req, "", &cancel, &mut |_line| Ok(true)),
            Err(AiError::Cancelled)
        ));
    }
}
