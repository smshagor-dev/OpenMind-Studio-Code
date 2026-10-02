//! Large downloads reach the tool while they arrive. pip gave up on TensorFlow's wheel ("ReadTimeoutError ... read
//! timeout=15") because the gateway sent nothing until the broker had the whole file. Here the fake Download Manager
//! client delivers slowly, and the "tool" reads with a timeout shorter than the whole download, as pip does.

use std::io::{BufRead, BufReader, Read, Write};
use std::net::TcpStream;
use std::sync::Arc;
use std::time::{Duration, Instant};

use openmind_broker::gateway::{UpRequest, UpResponse, Upstream};
use openmind_broker::{Broker, BrokerError, FailureKind, Gateway, GatewayConfig, Staging};
use openmind_network::problem::NetError;
use openmind_network::retry::RetryPolicy;
use openmind_runtime_manager::{HttpClient, HttpResponse, RuntimeError};
use sha2::{Digest, Sha256};

/// Pages are not needed: the explicit fetch endpoint goes straight to the broker.
struct NoPages;

impl Upstream for NoPages {
    fn send(&self, request: UpRequest) -> Result<UpResponse, BrokerError> {
        Err(BrokerError::new(
            FailureKind::Dns,
            format!("no page {}", request.url),
        ))
    }
}

/// A body that arrives in pieces with a pause before each.
struct Slow {
    pieces: Vec<Vec<u8>>,
    gap: Duration,
}

impl Read for Slow {
    fn read(&mut self, buf: &mut [u8]) -> std::io::Result<usize> {
        if self.pieces.is_empty() {
            return Ok(0);
        }
        std::thread::sleep(self.gap);
        let piece = self.pieces.remove(0);
        assert!(piece.len() <= buf.len());
        buf[..piece.len()].copy_from_slice(&piece);
        Ok(piece.len())
    }
}

struct SlowFiles {
    data: Vec<u8>,
    gap: Duration,
}

impl HttpClient for SlowFiles {
    fn get(&self, url: &str, _range_from: Option<u64>) -> Result<HttpResponse, RuntimeError> {
        if !url.ends_with("big.whl") {
            return Err(RuntimeError::Network(NetError::status(404, url)));
        }
        let pieces = self.data.chunks(16 * 1024).map(<[u8]>::to_vec).collect();
        Ok(HttpResponse {
            status: 200,
            content_length: Some(self.data.len() as u64),
            body: Box::new(Slow {
                pieces,
                gap: self.gap,
            }),
        })
    }
}

fn sha(data: &[u8]) -> String {
    Sha256::digest(data)
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
}

fn start(data: Vec<u8>, gap: Duration) -> (Gateway, tempfile::TempDir) {
    let tmp = tempfile::tempdir().expect("tmp");
    let files = Arc::new(SlowFiles { data, gap });
    let broker = Broker::new(Staging::new(tmp.path()), files, Arc::new(|_| {}))
        .with_retry(RetryPolicy::default(), Box::new(|_| {}));
    let gateway = Gateway::start(
        Arc::new(broker),
        Arc::new(NoPages),
        GatewayConfig::default(),
    )
    .expect("gateway");
    (gateway, tmp)
}

/// What the tool got: the status, the body bytes, whether the chunked body ended properly, and when the first body
/// byte came. Every single read must come within `read_timeout` (pip's rule), else the call panics.
struct Received {
    status: u16,
    body: Vec<u8>,
    complete: bool,
    first_byte: Duration,
}

fn download(gateway: &Gateway, sha256: &str, read_timeout: Duration) -> Received {
    let port = gateway.port();
    let token = gateway.token();
    let stream = TcpStream::connect(("127.0.0.1", port)).expect("connect");
    stream
        .set_read_timeout(Some(read_timeout))
        .expect("timeout");
    let mut writer = stream.try_clone().expect("clone");
    let url = "https%3A%2F%2Fexample.org%2Fdist%2Fbig.whl";
    write!(
        writer,
        "GET /{token}/fetch?url={url}&sha256={sha256} HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nConnection: close\r\n\r\n"
    )
    .expect("send");
    let asked = Instant::now();
    let mut reader = BufReader::new(stream);
    let mut line = String::new();
    reader
        .read_line(&mut line)
        .expect("status line within the read timeout");
    let status: u16 = line
        .split(' ')
        .nth(1)
        .expect("code")
        .parse()
        .expect("number");
    let mut chunked = false;
    loop {
        let mut header = String::new();
        reader.read_line(&mut header).expect("header");
        let header = header.trim_end().to_ascii_lowercase();
        if header.is_empty() {
            break;
        }
        chunked |= header == "transfer-encoding: chunked";
    }
    assert!(chunked, "a slow download is passed on chunked");
    let mut body = Vec::new();
    let mut first_byte = None;
    loop {
        let mut size = String::new();
        match reader.read_line(&mut size) {
            Ok(0) | Err(_) if first_byte.is_some() || status != 200 => {
                return Received {
                    status,
                    body,
                    complete: false,
                    first_byte: first_byte.unwrap_or_default(),
                }
            }
            Ok(_) => {}
            Err(error) => panic!("read timed out before any byte: {error}"),
        }
        let size = usize::from_str_radix(size.trim(), 16).expect("hex size");
        let mut chunk = vec![0; size + 2];
        if reader.read_exact(&mut chunk).is_err() {
            return Received {
                status,
                body,
                complete: false,
                first_byte: first_byte.unwrap_or_default(),
            };
        }
        if size == 0 {
            return Received {
                status,
                body,
                complete: true,
                first_byte: first_byte.unwrap_or_default(),
            };
        }
        first_byte.get_or_insert_with(|| asked.elapsed());
        body.extend_from_slice(&chunk[..size]);
    }
}

fn big() -> Vec<u8> {
    (0..20 * 16 * 1024).map(|i| (i % 251) as u8).collect()
}

#[test]
fn a_download_slower_than_the_tools_read_timeout_arrives_complete() {
    // 20 pieces, 250 ms apart: about 5 s in all, while the "tool" never waits more than 2 s for a read.
    let data = big();
    let (gateway, _tmp) = start(data.clone(), Duration::from_millis(250));
    let got = download(&gateway, &sha(&data), Duration::from_secs(2));
    assert_eq!(got.status, 200);
    assert!(got.complete, "the chunked body ends properly");
    assert_eq!(got.body, data);
    assert!(
        got.first_byte < Duration::from_secs(2),
        "bytes come before the download ends: {:?}",
        got.first_byte
    );
}

#[test]
fn a_file_that_fails_its_checksum_is_cut_off_and_never_completes() {
    let data = big();
    let (gateway, _tmp) = start(data.clone(), Duration::from_millis(100));
    let got = download(&gateway, &"0".repeat(64), Duration::from_secs(5));
    assert_eq!(got.status, 200, "the answer had started");
    assert!(
        !got.complete,
        "no final chunk: the tool sees a broken transfer, not a finished file"
    );
    assert!(got.body.len() <= data.len());
}

#[test]
fn a_file_already_downloaded_is_answered_with_its_length() {
    // A fast download ends before the first-byte wait: the old answer, with Content-Length.
    let data = b"small wheel".to_vec();
    let (gateway, _tmp) = start(data.clone(), Duration::ZERO);
    let port = gateway.port();
    let stream = TcpStream::connect(("127.0.0.1", port)).expect("connect");
    let mut writer = stream.try_clone().expect("clone");
    write!(
        writer,
        "GET /{}/fetch?url=https%3A%2F%2Fexample.org%2Fdist%2Fbig.whl&sha256={} HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nConnection: close\r\n\r\n",
        gateway.token(),
        sha(&data)
    )
    .expect("send");
    let mut answer = String::new();
    BufReader::new(stream)
        .read_to_string(&mut answer)
        .expect("answer");
    assert!(answer.starts_with("HTTP/1.1 200"), "{answer}");
    assert!(
        answer
            .to_ascii_lowercase()
            .contains(&format!("content-length: {}", data.len())),
        "{answer}"
    );
    assert!(answer.ends_with("small wheel"), "{answer}");
}
