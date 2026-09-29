//! The gateway end to end over real loopback sockets, with a fake upstream (index and registry pages) and a fake
//! Download Manager client (the artifact files), so nothing leaves this computer.

use std::collections::HashMap;
use std::io::{BufRead, BufReader, Cursor, Read, Write};
use std::net::TcpStream;
use std::sync::{Arc, Mutex};

use openmind_broker::gateway::{UpRequest, UpResponse, Upstream};
use openmind_broker::{Broker, BrokerError, FailureKind, Gateway, GatewayConfig, Staging};
use openmind_network::problem::NetError;
use openmind_network::retry::RetryPolicy;
use openmind_runtime_manager::{HttpClient, HttpResponse, RuntimeError};
use sha2::{Digest, Sha256};

#[derive(Default)]
struct FakeUpstream {
    pages: HashMap<String, (u16, String, Vec<u8>)>,
    seen: Mutex<Vec<UpRequest>>,
}

impl Upstream for FakeUpstream {
    fn send(&self, request: UpRequest) -> Result<UpResponse, BrokerError> {
        self.seen.lock().expect("lock").push(request.clone());
        let Some((status, content_type, body)) = self.pages.get(&request.url).cloned() else {
            return Err(BrokerError::new(
                FailureKind::Dns,
                format!("no page {}", request.url),
            ));
        };
        Ok(UpResponse {
            status,
            headers: vec![("Content-Type".into(), content_type)],
            body: Box::new(Cursor::new(body)),
        })
    }
}

#[derive(Default)]
struct FakeFiles {
    files: HashMap<String, Vec<u8>>,
    seen: Mutex<Vec<String>>,
}

impl HttpClient for FakeFiles {
    fn get(&self, url: &str, _range_from: Option<u64>) -> Result<HttpResponse, RuntimeError> {
        self.seen.lock().expect("lock").push(url.to_string());
        let body = self
            .files
            .get(url)
            .cloned()
            .ok_or_else(|| RuntimeError::Network(NetError::status(404, url)))?;
        Ok(HttpResponse {
            status: 200,
            content_length: Some(body.len() as u64),
            body: Box::new(Cursor::new(body)),
        })
    }
}

struct Setup {
    gateway: Gateway,
    upstream: Arc<FakeUpstream>,
    files: Arc<FakeFiles>,
    _tmp: tempfile::TempDir,
}

fn start(upstream: FakeUpstream, files: FakeFiles) -> Setup {
    let tmp = tempfile::tempdir().expect("tmp");
    let upstream = Arc::new(upstream);
    let files = Arc::new(files);
    let broker = Broker::new(Staging::new(tmp.path()), files.clone(), Arc::new(|_| {}))
        .with_retry(RetryPolicy::default(), Box::new(|_| {}));
    let gateway = Gateway::start(Arc::new(broker), upstream.clone(), GatewayConfig::default())
        .expect("gateway");
    Setup {
        gateway,
        upstream,
        files,
        _tmp: tmp,
    }
}

struct Answer {
    status: u16,
    headers: Vec<(String, String)>,
    body: Vec<u8>,
}

impl Answer {
    fn text(&self) -> String {
        String::from_utf8_lossy(&self.body).into_owned()
    }
}

/// Reads one response (Content-Length or chunked).
fn read_answer(reader: &mut BufReader<TcpStream>) -> Answer {
    let mut line = String::new();
    reader.read_line(&mut line).expect("status");
    let status: u16 = line
        .split(' ')
        .nth(1)
        .expect("code")
        .parse()
        .expect("number");
    let mut headers = Vec::new();
    loop {
        let mut line = String::new();
        reader.read_line(&mut line).expect("header");
        let line = line.trim_end();
        if line.is_empty() {
            break;
        }
        let (name, value) = line.split_once(':').expect("colon");
        headers.push((name.trim().to_ascii_lowercase(), value.trim().to_string()));
    }
    let header = |name: &str| {
        headers
            .iter()
            .find(|(n, _)| n == name)
            .map(|(_, v)| v.clone())
    };
    let mut body = Vec::new();
    if let Some(length) = header("content-length") {
        body.resize(length.parse().expect("length"), 0);
        reader.read_exact(&mut body).expect("body");
    } else if header("transfer-encoding").as_deref() == Some("chunked") {
        loop {
            let mut size = String::new();
            reader.read_line(&mut size).expect("size");
            let size = usize::from_str_radix(size.trim(), 16).expect("hex");
            let mut chunk = vec![0; size + 2];
            reader.read_exact(&mut chunk).expect("chunk");
            if size == 0 {
                break;
            }
            body.extend_from_slice(&chunk[..size]);
        }
    }
    Answer {
        status,
        headers,
        body,
    }
}

fn ask(port: u16, raw: &str) -> Answer {
    let stream = TcpStream::connect(("127.0.0.1", port)).expect("connect");
    let mut writer = stream.try_clone().expect("clone");
    writer.write_all(raw.as_bytes()).expect("send");
    read_answer(&mut BufReader::new(stream))
}

fn get(port: u16, path: &str, extra: &str) -> Answer {
    ask(
        port,
        &format!(
            "GET {path} HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\n{extra}Connection: close\r\n\r\n"
        ),
    )
}

fn sha(data: &[u8]) -> String {
    Sha256::digest(data)
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
}

const FILES: &str = "https://files.pythonhosted.org/";

#[test]
fn a_foreign_host_or_a_wrong_token_is_refused() {
    let setup = start(FakeUpstream::default(), FakeFiles::default());
    let port = setup.gateway.port();
    let token = setup.gateway.token().to_string();
    let answer = ask(
        port,
        &format!("GET /{token}/status HTTP/1.1\r\nHost: evil.example:{port}\r\n\r\n"),
    );
    assert_eq!(answer.status, 403);
    assert_eq!(get(port, "/wrongtoken/status", "").status, 403);
    assert_eq!(get(port, "/status", "").status, 403);
    let ok = get(port, &format!("/{token}/status"), "");
    assert_eq!((ok.status, ok.text()), (200, "ok".to_string()));
}

#[test]
fn pip_gets_rewritten_index_pages_and_verified_files_through_the_broker() {
    let wheel = b"six wheel".to_vec();
    let hash = sha(&wheel);
    let file = format!("{FILES}packages/aa/bb/six-1.17.0-py2.py3-none-any.whl");
    let bad = format!("{FILES}packages/aa/bb/six-1.17.0.tar.gz");
    let page = format!(
        "<a href=\"{file}#sha256={hash}\">six-1.17.0-py2.py3-none-any.whl</a>\
         <a href=\"{bad}#sha256={}\">six-1.17.0.tar.gz</a>",
        "0".repeat(64)
    );
    let mut upstream = FakeUpstream::default();
    upstream.pages.insert(
        "https://pypi.org/simple/six/".into(),
        (200, "text/html".into(), page.into_bytes()),
    );
    let mut files = FakeFiles::default();
    files.files.insert(file.clone(), wheel.clone());
    files.files.insert(bad.clone(), b"tampered".to_vec());
    let setup = start(upstream, files);
    let port = setup.gateway.port();
    let base = setup.gateway.base();

    let index = get(
        port,
        &format!(
            "{}/pypi/simple/six/",
            base.trim_start_matches(&format!("http://127.0.0.1:{port}"))
        ),
        "Accept: text/html\r\n",
    );
    assert_eq!(index.status, 200);
    let text = index.text();
    assert!(!text.contains(FILES), "{text}");
    let local =
        format!("{base}/pypi/files/packages/aa/bb/six-1.17.0-py2.py3-none-any.whl#sha256={hash}");
    assert!(text.contains(&local), "{text}");
    let seen = setup.upstream.seen.lock().expect("lock").clone();
    assert_eq!(
        seen[0].headers,
        vec![("Accept".to_string(), "text/html".to_string())]
    );

    let path = local
        .split_once(&format!(":{port}"))
        .expect("port")
        .1
        .split('#')
        .next()
        .expect("path")
        .to_string();
    let download = get(port, &path, "");
    assert_eq!(download.status, 200);
    assert_eq!(download.body, wheel);

    // A file whose bytes don't match the page's hash is never handed to pip.
    let path = format!(
        "{}/pypi/files/packages/aa/bb/six-1.17.0.tar.gz",
        base.split_once(&format!(":{port}")).expect("port").1
    );
    let refused = get(port, &path, "");
    assert_eq!(refused.status, 502);
    assert!(
        refused.text().contains("checksum mismatch"),
        "{}",
        refused.text()
    );

    // Paths outside the package tree are refused before any request.
    let before = setup.files.seen.lock().expect("lock").len();
    let token = setup.gateway.token();
    assert_eq!(
        get(port, &format!("/{token}/pypi/files/../../etc"), "").status,
        400
    );
    assert_eq!(
        get(port, &format!("/{token}/pypi/simple/../x/"), "").status,
        400
    );
    assert_eq!(setup.files.seen.lock().expect("lock").len(), before);
}

#[test]
fn json_index_pages_record_hashes_too() {
    let wheel = b"requests".to_vec();
    let file = format!("{FILES}packages/c/requests-2.32.3-py3-none-any.whl");
    let page = serde_json::json!({
        "meta": {"api-version": "1.1"},
        "name": "requests",
        "files": [{"filename": "requests-2.32.3-py3-none-any.whl", "url": file, "hashes": {"sha256": "1".repeat(64)}}]
    });
    let mut upstream = FakeUpstream::default();
    upstream.pages.insert(
        "https://pypi.org/simple/requests/".into(),
        (
            200,
            "application/vnd.pypi.simple.v1+json".into(),
            page.to_string().into_bytes(),
        ),
    );
    let mut files = FakeFiles::default();
    files.files.insert(file.clone(), wheel);
    let setup = start(upstream, files);
    let port = setup.gateway.port();
    let token = setup.gateway.token().to_string();
    let index = get(port, &format!("/{token}/pypi/simple/requests/"), "");
    assert!(index.text().contains("/pypi/files/packages/c/requests"));
    // The recorded hash doesn't match these bytes: refused.
    let answer = get(
        port,
        &format!("/{token}/pypi/files/packages/c/requests-2.32.3-py3-none-any.whl"),
        "",
    );
    assert_eq!(answer.status, 502);
}

#[test]
fn npm_keeps_registry_urls_while_pnpm_gets_local_tarballs_and_writes_are_refused() {
    let packument = r#"{"name":"left-pad","versions":{"1.3.0":{"dist":{"tarball":"https://registry.npmjs.org/left-pad/-/left-pad-1.3.0.tgz","integrity":"sha512-x"}}}}"#;
    let mut upstream = FakeUpstream::default();
    upstream.pages.insert(
        "https://registry.npmjs.org/left-pad".into(),
        (
            200,
            "application/vnd.npm.install-v1+json".into(),
            packument.as_bytes().to_vec(),
        ),
    );
    let mut files = FakeFiles::default();
    files.files.insert(
        "https://registry.npmjs.org/left-pad/-/left-pad-1.3.0.tgz".into(),
        b"tgz".to_vec(),
    );
    let setup = start(upstream, files);
    let npm = setup.gateway.npm_port();

    let plain = get(npm, "/left-pad", "User-Agent: npm/11.13.0 node/v24\r\n");
    assert_eq!(plain.status, 200);
    assert!(
        plain
            .text()
            .contains("https://registry.npmjs.org/left-pad/-/"),
        "npm keeps the registry address"
    );

    let pnpm = get(
        npm,
        "/left-pad",
        "User-Agent: pnpm/9.0.0 npm/? node/v24\r\n",
    );
    assert!(
        pnpm.text().contains(&format!(
            "http://127.0.0.1:{npm}/left-pad/-/left-pad-1.3.0.tgz"
        )),
        "{}",
        pnpm.text()
    );

    let tarball = get(npm, "/left-pad/-/left-pad-1.3.0.tgz", "");
    assert_eq!(
        (tarball.status, tarball.body.as_slice()),
        (200, b"tgz".as_slice())
    );

    let publish = ask(npm, &format!("PUT /left-pad HTTP/1.1\r\nHost: 127.0.0.1:{npm}\r\nContent-Length: 2\r\nConnection: close\r\n\r\n{{}}"));
    assert_eq!(publish.status, 405);
    // The npm port only answers to its own address, like the main one.
    let foreign = ask(
        npm,
        "GET /left-pad HTTP/1.1\r\nHost: registry.npmjs.org\r\n\r\n",
    );
    assert_eq!(foreign.status, 403);
}

#[test]
fn explicit_fetch_downloads_through_the_broker_and_checks_a_given_hash() {
    let data = b"archive".to_vec();
    let mut files = FakeFiles::default();
    files
        .files
        .insert("https://example.org/tools/a.zip".into(), data.clone());
    let setup = start(FakeUpstream::default(), files);
    let port = setup.gateway.port();
    let token = setup.gateway.token().to_string();
    let url = "https%3A%2F%2Fexample.org%2Ftools%2Fa.zip";
    let ok = get(
        port,
        &format!("/{token}/fetch?url={url}&sha256={}", sha(&data)),
        "",
    );
    assert_eq!((ok.status, ok.body.clone()), (200, data));
    assert!(ok
        .headers
        .iter()
        .any(|(n, v)| n == "content-disposition" && v.contains("a.zip")));
    let wrong = get(
        port,
        &format!("/{token}/fetch?url={url}&sha256={}", "0".repeat(64)),
        "",
    );
    assert_eq!(wrong.status, 502);
    let insecure = get(
        port,
        &format!("/{token}/fetch?url=http%3A%2F%2Fexample.org%2Fa"),
        "",
    );
    assert_eq!(insecure.status, 400);
}

#[test]
fn several_requests_share_one_kept_alive_connection() {
    let setup = start(FakeUpstream::default(), FakeFiles::default());
    let port = setup.gateway.port();
    let token = setup.gateway.token().to_string();
    let stream = TcpStream::connect(("127.0.0.1", port)).expect("connect");
    let mut writer = stream.try_clone().expect("clone");
    let mut reader = BufReader::new(stream);
    for _ in 0..3 {
        writer
            .write_all(
                format!("GET /{token}/status HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\n\r\n")
                    .as_bytes(),
            )
            .expect("send");
        assert_eq!(read_answer(&mut reader).status, 200);
    }
}
