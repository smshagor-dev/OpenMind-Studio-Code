//! Nothing an API key touches may reach a log. This runs alone in its own process with one global subscriber, so
//! every log line the providers write while it runs is captured.

use std::io::{BufRead, BufReader, Read, Write};
use std::net::{TcpListener, TcpStream};
use std::sync::atomic::AtomicBool;
use std::sync::{Arc, Mutex};

use openmind_ai::wire::{ChatMessage, ChatRequest};
use openmind_ai::{chat, ProviderConfig, ProviderKind};

const KEY: &str = "sk-test-secret-1234";

fn drain(stream: &mut TcpStream) {
    let mut reader = BufReader::new(stream.try_clone().expect("clone"));
    let mut length = 0usize;
    loop {
        let mut line = String::new();
        reader.read_line(&mut line).expect("line");
        let line = line.trim_end().to_ascii_lowercase();
        if line.is_empty() {
            break;
        }
        if let Some(value) = line.strip_prefix("content-length:") {
            length = value.trim().parse().unwrap_or(0);
        }
    }
    let mut body = vec![0u8; length];
    reader.read_exact(&mut body).expect("body");
}

fn serve(replies: Vec<(u16, &'static str, String)>) -> u16 {
    let listener = TcpListener::bind("127.0.0.1:0").expect("bind");
    let port = listener.local_addr().expect("addr").port();
    std::thread::spawn(move || {
        for (status, content_type, body) in replies {
            let (mut stream, _) = listener.accept().expect("accept");
            drain(&mut stream);
            let head = format!(
                "HTTP/1.1 {status} X\r\nContent-Type: {content_type}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                body.len()
            );
            stream.write_all(head.as_bytes()).expect("head");
            stream.write_all(body.as_bytes()).expect("body");
        }
    });
    port
}

fn provider(port: u16) -> ProviderConfig {
    ProviderConfig {
        id: "mock".into(),
        name: "Mock".into(),
        kind: ProviderKind::OpenAiCompatible,
        base_url: format!("http://127.0.0.1:{port}"),
        model: "test-model".into(),
        models: vec![],
        enabled: true,
        source: None,
        capabilities: vec![],
    }
    .normalized()
    .expect("valid")
}

fn request() -> ChatRequest {
    ChatRequest {
        model: "test-model".into(),
        system: None,
        messages: vec![ChatMessage {
            role: "user".into(),
            content: "hello".into(),
        }],
        max_tokens: 100,
    }
}

/// A `tracing` writer that keeps everything logged.
#[derive(Clone, Default)]
struct Captured(Arc<Mutex<Vec<u8>>>);

impl Write for Captured {
    fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
        self.0.lock().expect("lock").extend_from_slice(buf);
        Ok(buf.len())
    }
    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}

impl<'a> tracing_subscriber::fmt::MakeWriter<'a> for Captured {
    type Writer = Captured;
    fn make_writer(&'a self) -> Self::Writer {
        self.clone()
    }
}

#[test]
fn the_api_key_and_the_message_never_reach_a_log_on_success_or_failure() {
    let captured = Captured::default();
    tracing::subscriber::set_global_default(
        tracing_subscriber::fmt()
            .with_writer(captured.clone())
            .with_max_level(tracing::Level::TRACE)
            .finish(),
    )
    .expect("the only subscriber of this process");

    let sse = "data: {\"choices\":[{\"delta\":{\"content\":\"ok\"}}]}\n\ndata: [DONE]\n\n";
    let port = serve(vec![
        (200, "text/event-stream", sse.to_string()),
        (
            401,
            "application/json",
            format!(r#"{{"error":{{"message":"bad key {KEY}"}}}}"#),
        ),
    ]);
    let cfg = provider(port);
    let cancel = AtomicBool::new(false);
    chat(&cfg, KEY, &request(), true, &cancel, &mut |_| {}).expect("first");
    let err = chat(&cfg, KEY, &request(), true, &cancel, &mut |_| {}).expect_err("second");
    assert!(!err.to_string().contains(KEY));

    let logged = String::from_utf8(captured.0.lock().expect("lock").clone()).expect("utf8");
    assert!(
        logged.contains("ai chat request"),
        "the request is logged: {logged}"
    );
    assert!(logged.contains("127.0.0.1"), "the host is logged: {logged}");
    assert!(
        !logged.contains(KEY),
        "the key must not be logged: {logged}"
    );
    assert!(
        !logged.contains("hello"),
        "message text must not be logged: {logged}"
    );
}
