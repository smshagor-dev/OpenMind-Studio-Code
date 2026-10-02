//! Failure recovery and secrecy over real loopback sockets: a client that goes away mid-download doesn't break
//! another client of the same artifact, and no token, password or signed-address query ever reaches the logs or
//! the UI events.

use std::collections::HashMap;
use std::io::{BufRead, BufReader, Cursor, Read, Write};
use std::net::TcpStream;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use openmind_broker::gateway::{UpRequest, UpResponse, Upstream};
use openmind_broker::{
    Broker, BrokerError, BrokerEvent, FailureKind, Gateway, GatewayConfig, Staging,
};
use openmind_network::problem::NetError;
use openmind_network::retry::RetryPolicy;
use openmind_runtime_manager::{HttpClient, HttpResponse, RuntimeError};

struct NoPages;

impl Upstream for NoPages {
    fn send(&self, request: UpRequest) -> Result<UpResponse, BrokerError> {
        Err(BrokerError::new(
            FailureKind::Dns,
            format!("no page {}", request.url),
        ))
    }
}

/// A body that arrives slowly, 4 KiB at a time.
struct Slow(Cursor<Vec<u8>>);

impl Read for Slow {
    fn read(&mut self, buf: &mut [u8]) -> std::io::Result<usize> {
        std::thread::sleep(Duration::from_millis(15));
        let end = buf.len().min(4096);
        self.0.read(&mut buf[..end])
    }
}

struct SlowFiles {
    files: HashMap<String, Vec<u8>>,
}

impl HttpClient for SlowFiles {
    fn get(&self, url: &str, range_from: Option<u64>) -> Result<HttpResponse, RuntimeError> {
        let body = self
            .files
            .get(url.split('?').next().unwrap_or(url))
            .cloned()
            .ok_or_else(|| RuntimeError::Network(NetError::status(404, url)))?;
        let from = range_from.unwrap_or(0) as usize;
        let rest = body[from.min(body.len())..].to_vec();
        Ok(HttpResponse {
            status: if from > 0 { 206 } else { 200 },
            content_length: Some(rest.len() as u64),
            body: Box::new(Slow(Cursor::new(rest))),
        })
    }
}

fn start(
    files: HashMap<String, Vec<u8>>,
    events: Arc<Mutex<Vec<BrokerEvent>>>,
) -> (Gateway, tempfile::TempDir) {
    let tmp = tempfile::tempdir().expect("tmp");
    let broker = Broker::new(
        Staging::new(tmp.path()),
        Arc::new(SlowFiles { files }),
        Arc::new(move |event: &BrokerEvent| events.lock().expect("lock").push(event.clone())),
    )
    .with_retry(RetryPolicy::default(), Box::new(|_| {}));
    let gateway = Gateway::start(
        Arc::new(broker),
        Arc::new(NoPages),
        GatewayConfig::default(),
    )
    .expect("gateway");
    (gateway, tmp)
}

fn request(port: u16, path: &str) -> TcpStream {
    let mut stream = TcpStream::connect(("127.0.0.1", port)).expect("connect");
    stream
        .write_all(
            format!("GET {path} HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nConnection: close\r\n\r\n")
                .as_bytes(),
        )
        .expect("send");
    stream
}

/// Status and body of an answer: Content-Length, or chunked (a download still arriving is passed on as it comes;
/// an empty body means the chunked answer was cut off before its end).
fn answer(stream: TcpStream) -> (u16, Vec<u8>) {
    let mut reader = BufReader::new(stream);
    let mut line = String::new();
    reader.read_line(&mut line).expect("status");
    let status = line
        .split(' ')
        .nth(1)
        .and_then(|code| code.parse().ok())
        .expect("code");
    let mut length = 0;
    let mut chunked = false;
    loop {
        let mut line = String::new();
        reader.read_line(&mut line).expect("header");
        let line = line.trim_end().to_ascii_lowercase();
        if line.is_empty() {
            break;
        }
        if let Some(value) = line.strip_prefix("content-length:") {
            length = value.trim().parse().expect("length");
        }
        chunked |= line == "transfer-encoding: chunked";
    }
    if !chunked {
        let mut body = vec![0; length];
        reader.read_exact(&mut body).expect("body");
        return (status, body);
    }
    let mut body = Vec::new();
    loop {
        let mut size = String::new();
        if reader.read_line(&mut size).unwrap_or(0) == 0 {
            return (status, Vec::new());
        }
        let size = usize::from_str_radix(size.trim(), 16).expect("hex size");
        let mut chunk = vec![0; size + 2];
        if reader.read_exact(&mut chunk).is_err() {
            return (status, Vec::new());
        }
        if size == 0 {
            return (status, body);
        }
        body.extend_from_slice(&chunk[..size]);
    }
}

#[test]
fn a_client_that_goes_away_never_breaks_another_client_of_the_same_download() {
    let url = "https://example.org/tools/big.zip";
    let data: Vec<u8> = (0..200_000u32).map(|i| (i % 251) as u8).collect();
    let events = Arc::new(Mutex::new(Vec::new()));
    let (gateway, _tmp) = start(HashMap::from([(url.to_string(), data.clone())]), events);
    let port = gateway.port();
    let path = format!(
        "/{}/fetch?url=https%3A%2F%2Fexample.org%2Ftools%2Fbig.zip",
        gateway.token()
    );
    let leaver = request(port, &path);
    std::thread::sleep(Duration::from_millis(60));
    let stayer = request(port, &path);
    std::thread::sleep(Duration::from_millis(60));
    drop(leaver);
    let (status, body) = answer(stayer);
    assert_eq!(status, 200);
    assert_eq!(body.len(), data.len());
    assert!(body == data, "the body arrives whole and unchanged");
    // The gateway keeps serving afterwards.
    let (status, again) = answer(request(port, &path));
    assert_eq!((status, again.len()), (200, data.len()));
}

/// Collects every log line of the test.
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

#[test]
fn no_token_password_or_signed_query_reaches_the_logs_or_the_events() {
    let captured = Captured::default();
    let writer = captured.clone();
    let subscriber = tracing_subscriber::fmt()
        .with_max_level(tracing::Level::TRACE)
        .with_ansi(false)
        .with_writer(move || writer.clone())
        .finish();
    // Global: the gateway logs from its own threads. The only test in this binary that installs one.
    tracing::subscriber::set_global_default(subscriber).expect("subscriber");

    let signed = "https://files.example/pkg.whl";
    let events = Arc::new(Mutex::new(Vec::new()));
    let (gateway, _tmp) = start(
        HashMap::from([(signed.to_string(), b"wheel".to_vec())]),
        events.clone(),
    );
    let port = gateway.port();
    let token = gateway.token().to_string();
    // A signed address (the query is the secret), one with a user and password, and one that fails.
    for url in [
        "https%3A%2F%2Ffiles.example%2Fpkg.whl%3FX-Amz-Signature%3Dq5ecretSig",
        "https%3A%2F%2Fivan%3Ap4ssw0rdX%40files.example%2Fpkg.whl",
        "https%3A%2F%2Fmissing.example%2Fnone.whl%3Ftoken%3Dq5ecretTok",
    ] {
        let _ = answer(request(port, &format!("/{token}/fetch?url={url}")));
    }
    // A wrong gateway token and an Authorization header the gateway must not echo.
    let mut stream = TcpStream::connect(("127.0.0.1", port)).expect("connect");
    stream
        .write_all(
            format!(
                "GET /not-the-token/status HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\n\
                 Authorization: Basic aXZhbjpwNHNzdzByZFg=\r\nConnection: close\r\n\r\n"
            )
            .as_bytes(),
        )
        .expect("send");
    let mut rest = Vec::new();
    let _ = stream.read_to_end(&mut rest);
    std::thread::sleep(Duration::from_millis(100));

    let logs = String::from_utf8_lossy(&captured.0.lock().expect("lock")).into_owned();
    let events = format!("{:?}", events.lock().expect("lock"));
    for secret in [
        token.as_str(),
        "q5ecretSig",
        "q5ecretTok",
        "p4ssw0rdX",
        "aXZhbjpwNHNzdzByZFg",
    ] {
        assert!(!logs.contains(secret), "log leaks {secret}:\n{logs}");
        assert!(!events.contains(secret), "events leak {secret}: {events}");
    }
    assert!(
        logs.contains("files.example"),
        "the logs still say what happened:\n{logs}"
    );
}
