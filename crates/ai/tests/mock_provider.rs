//! The providers against a mock HTTP server on 127.0.0.1 — no real API, no key, no network.

use std::io::{BufRead, BufReader, Read, Write};
use std::net::{TcpListener, TcpStream};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use openmind_ai::wire::{ChatMessage, ChatRequest};
use openmind_ai::{
    chat, embed_text, list_embedding_models, list_models, AiError, Capability, ProviderConfig,
    ProviderKind,
};

#[derive(Clone, Debug)]
struct Recorded {
    path: String,
    headers: Vec<(String, String)>,
    body: String,
}

struct Reply {
    status: u16,
    content_type: &'static str,
    /// Pieces of the body with a pause before each.
    chunks: Vec<(String, Duration)>,
}

fn reply(status: u16, content_type: &'static str, body: &str) -> Reply {
    Reply {
        status,
        content_type,
        chunks: vec![(body.to_string(), Duration::ZERO)],
    }
}

fn read_request(stream: &mut TcpStream) -> Option<Recorded> {
    let mut reader = BufReader::new(stream.try_clone().ok()?);
    let mut first = String::new();
    reader.read_line(&mut first).ok()?;
    let path = first.split_whitespace().nth(1)?.to_string();
    let mut headers = Vec::new();
    let mut length = 0usize;
    loop {
        let mut line = String::new();
        reader.read_line(&mut line).ok()?;
        let line = line.trim_end().to_string();
        if line.is_empty() {
            break;
        }
        if let Some((name, value)) = line.split_once(':') {
            if name.eq_ignore_ascii_case("content-length") {
                length = value.trim().parse().unwrap_or(0);
            }
            headers.push((name.trim().to_ascii_lowercase(), value.trim().to_string()));
        }
    }
    let mut body = vec![0u8; length];
    reader.read_exact(&mut body).ok()?;
    Some(Recorded {
        path,
        headers,
        body: String::from_utf8_lossy(&body).into_owned(),
    })
}

/// Serves the replies one connection at a time; returns the port and what was received.
fn serve(replies: Vec<Reply>) -> (u16, Arc<Mutex<Vec<Recorded>>>) {
    let listener = TcpListener::bind("127.0.0.1:0").expect("bind");
    let port = listener.local_addr().expect("addr").port();
    let seen = Arc::new(Mutex::new(Vec::new()));
    let record = Arc::clone(&seen);
    std::thread::spawn(move || {
        for reply in replies {
            let Ok((mut stream, _)) = listener.accept() else {
                return;
            };
            if let Some(request) = read_request(&mut stream) {
                record.lock().expect("lock").push(request);
            }
            let head = format!(
                "HTTP/1.1 {} X\r\nContent-Type: {}\r\nCache-Control: no-cache\r\nConnection: close\r\n\r\n",
                reply.status, reply.content_type
            );
            if stream.write_all(head.as_bytes()).is_err() {
                continue;
            }
            for (chunk, pause) in reply.chunks {
                std::thread::sleep(pause);
                if stream.write_all(chunk.as_bytes()).is_err() || stream.flush().is_err() {
                    break;
                }
            }
        }
    });
    (port, seen)
}

fn provider(kind: ProviderKind, port: u16) -> ProviderConfig {
    ProviderConfig {
        id: "mock".into(),
        name: "Mock".into(),
        kind,
        base_url: format!("http://127.0.0.1:{port}"),
        model: "test-model".into(),
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
        model: "test-model".into(),
        system: Some("be brief".into()),
        messages: vec![ChatMessage {
            role: "user".into(),
            content: "hello".into(),
        }],
        max_tokens: 100,
    }
}

fn header(seen: &Recorded, name: &str) -> Option<String> {
    seen.headers
        .iter()
        .find(|(n, _)| n == name)
        .map(|(_, v)| v.clone())
}

const KEY: &str = "sk-test-secret-1234";

#[test]
fn openai_compatible_streams_chunks_with_the_right_request() {
    let sse = "data: {\"choices\":[{\"delta\":{\"content\":\"Hel\"}}]}\n\n\
               data: {\"choices\":[{\"delta\":{\"content\":\"lo\"}}]}\n\n\
               data: [DONE]\n\n";
    let (port, seen) = serve(vec![reply(200, "text/event-stream", sse)]);
    let mut pieces = Vec::new();
    let text = chat(
        &provider(ProviderKind::OpenAiCompatible, port),
        KEY,
        &request(),
        true,
        &AtomicBool::new(false),
        &mut |p| pieces.push(p.to_string()),
    )
    .expect("chat");
    assert_eq!(text, "Hello");
    assert_eq!(pieces, vec!["Hel", "lo"]);
    let got = seen.lock().expect("lock")[0].clone();
    assert_eq!(got.path, "/chat/completions");
    assert_eq!(
        header(&got, "authorization").as_deref(),
        Some("Bearer sk-test-secret-1234")
    );
    let body: serde_json::Value = serde_json::from_str(&got.body).expect("json");
    assert_eq!(body["stream"], true);
    assert_eq!(body["messages"][0]["role"], "system");
}

#[test]
fn claude_streams_and_sends_its_headers() {
    let sse = "event: content_block_delta\n\
               data: {\"type\":\"content_block_delta\",\"delta\":{\"type\":\"text_delta\",\"text\":\"Hi\"}}\n\n\
               data: {\"type\":\"message_stop\"}\n\n";
    let (port, seen) = serve(vec![reply(200, "text/event-stream", sse)]);
    let text = chat(
        &provider(ProviderKind::Claude, port),
        KEY,
        &request(),
        true,
        &AtomicBool::new(false),
        &mut |_| {},
    )
    .expect("chat");
    assert_eq!(text, "Hi");
    let got = seen.lock().expect("lock")[0].clone();
    assert_eq!(got.path, "/v1/messages");
    assert_eq!(header(&got, "x-api-key").as_deref(), Some(KEY));
    assert_eq!(
        header(&got, "anthropic-version").as_deref(),
        Some("2023-06-01")
    );
}

#[test]
fn gemini_answers_without_streaming_and_the_key_stays_out_of_the_url() {
    let json = r#"{"candidates":[{"content":{"parts":[{"text":"Gem"}]}}]}"#;
    let (port, seen) = serve(vec![reply(200, "application/json", json)]);
    let text = chat(
        &provider(ProviderKind::Gemini, port),
        KEY,
        &request(),
        false,
        &AtomicBool::new(false),
        &mut |_| {},
    )
    .expect("chat");
    assert_eq!(text, "Gem");
    let got = seen.lock().expect("lock")[0].clone();
    assert_eq!(got.path, "/v1beta/models/test-model:generateContent");
    assert!(!got.path.contains(KEY));
    assert_eq!(header(&got, "x-goog-api-key").as_deref(), Some(KEY));
}

#[test]
fn a_provider_error_is_readable_and_never_shows_the_key() {
    let body = format!(r#"{{"error":{{"message":"Incorrect API key provided: {KEY}"}}}}"#);
    let (port, _) = serve(vec![reply(401, "application/json", &body)]);
    let err = chat(
        &provider(ProviderKind::OpenAiCompatible, port),
        KEY,
        &request(),
        true,
        &AtomicBool::new(false),
        &mut |_| {},
    )
    .expect_err("401");
    let AiError::Provider { status, message } = &err else {
        panic!("expected a provider error, got {err:?}");
    };
    assert_eq!(*status, 401);
    assert!(message.contains("rejected"));
    assert!(!message.contains(KEY), "{message}");
    assert!(!err.to_string().contains(KEY));
}

#[test]
fn a_dead_server_is_a_network_error_without_the_key() {
    let port = {
        let listener = TcpListener::bind("127.0.0.1:0").expect("bind");
        listener.local_addr().expect("addr").port()
    };
    let err = chat(
        &provider(ProviderKind::OpenAiCompatible, port),
        KEY,
        &request(),
        true,
        &AtomicBool::new(false),
        &mut |_| {},
    )
    .expect_err("refused");
    assert!(matches!(err, AiError::Network(_)));
    assert!(!err.to_string().contains(KEY));
}

#[test]
fn cancelling_stops_a_slow_stream_quickly() {
    let first = "data: {\"choices\":[{\"delta\":{\"content\":\"one\"}}]}\n\n".to_string();
    let (port, _) = serve(vec![Reply {
        status: 200,
        content_type: "text/event-stream",
        chunks: vec![
            (first, Duration::ZERO),
            ("data: [DONE]\n\n".to_string(), Duration::from_secs(5)),
        ],
    }]);
    let cancel = Arc::new(AtomicBool::new(false));
    let flag = Arc::clone(&cancel);
    let started = Instant::now();
    let result = chat(
        &provider(ProviderKind::OpenAiCompatible, port),
        KEY,
        &request(),
        true,
        &cancel,
        &mut |_| flag.store(true, Ordering::Relaxed),
    );
    assert_eq!(result, Err(AiError::Cancelled));
    assert!(started.elapsed() < Duration::from_secs(3));
}

#[test]
fn a_key_is_required_unless_the_server_is_on_this_computer() {
    let cfg = provider(ProviderKind::OpenAiCompatible, 9);
    // a loopback endpoint needs none, so the missing-key error is about a remote provider:
    let mut remote = cfg.clone();
    remote.base_url = "https://api.example.com/v1".into();
    let remote = remote.normalized().expect("valid");
    let err = chat(
        &remote,
        "  ",
        &request(),
        true,
        &AtomicBool::new(false),
        &mut |_| {},
    )
    .expect_err("no key");
    assert!(matches!(err, AiError::NotConfigured(_)), "{err:?}");
}

#[test]
fn a_disabled_provider_is_refused_before_any_request() {
    let mut cfg = provider(ProviderKind::Local, 9);
    cfg.enabled = false;
    let err = chat(
        &cfg,
        "",
        &request(),
        true,
        &AtomicBool::new(false),
        &mut |_| {},
    )
    .expect_err("disabled");
    assert!(err.to_string().contains("turned off"));
}

#[test]
fn listing_models_doubles_as_the_connection_test() {
    let json = r#"{"data":[{"id":"gpt-a"},{"id":"text-embedding-x"}]}"#;
    let (port, seen) = serve(vec![
        reply(200, "application/json", json),
        reply(200, "application/json", json),
    ]);
    let cfg = provider(ProviderKind::OpenAiCompatible, port);
    let models = list_models(&cfg, KEY, &AtomicBool::new(false)).expect("models");
    assert_eq!(models.len(), 2);
    assert_eq!(seen.lock().expect("lock")[0].path, "/models");
    let embeddings = list_embedding_models(&cfg, KEY, &AtomicBool::new(false)).expect("embed");
    assert_eq!(embeddings, vec!["text-embedding-x"]);
}

#[test]
fn embedding_text_works_for_openai_compatible_and_is_unsupported_for_claude() {
    let (port, seen) = serve(vec![reply(
        200,
        "application/json",
        r#"{"data":[{"embedding":[0.25,0.5,0.75]}]}"#,
    )]);
    let cfg = provider(ProviderKind::OpenAiCompatible, port);
    let vector = embed_text(&cfg, KEY, "emb", "text", &AtomicBool::new(false)).expect("embed");
    assert_eq!(vector, vec![0.25, 0.5, 0.75]);
    assert_eq!(seen.lock().expect("lock")[0].path, "/embeddings");
    let claude = provider(ProviderKind::Claude, port);
    assert_eq!(
        embed_text(&claude, KEY, "emb", "t", &AtomicBool::new(false)),
        Err(AiError::Unsupported("embeddings"))
    );
}
