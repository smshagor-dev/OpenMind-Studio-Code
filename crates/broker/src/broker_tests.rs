use std::collections::HashMap;
use std::io::Cursor;
use std::sync::atomic::AtomicUsize;
use std::sync::mpsc;

use sha2::{Digest, Sha256};

use super::*;
use crate::events::BrokerEvent;

/// Serves files from memory, honours `Range`, counts requests; a gate can hold a body until released.
#[derive(Default)]
struct Server {
    files: HashMap<String, Vec<u8>>,
    requests: Mutex<Vec<(String, Option<u64>)>>,
    /// Bytes of each body sent before waiting on `gate` (None: no waiting).
    hold_after: Option<usize>,
    gate: Mutex<Option<mpsc::Receiver<()>>>,
}

struct Gated {
    data: Cursor<Vec<u8>>,
    sent: usize,
    hold_after: Option<usize>,
    gate: Option<mpsc::Receiver<()>>,
}

impl Read for Gated {
    fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
        if let (Some(limit), Some(gate)) = (self.hold_after, self.gate.as_ref()) {
            if self.sent >= limit {
                let _ = gate.recv_timeout(Duration::from_secs(5));
                self.gate = None;
            }
        }
        let max = match self.hold_after {
            Some(limit) if self.gate.is_some() => {
                buf.len().min(limit.saturating_sub(self.sent).max(1))
            }
            _ => buf.len(),
        };
        let read = self.data.read(&mut buf[..max])?;
        self.sent += read;
        Ok(read)
    }
}

impl HttpClient for Server {
    fn get(&self, url: &str, range_from: Option<u64>) -> Result<HttpResponse, RuntimeError> {
        self.requests
            .lock()
            .expect("lock")
            .push((url.to_string(), range_from));
        let Some(data) = self.files.get(url) else {
            return Err(RuntimeError::Network(NetError::status(404, url)));
        };
        let start = range_from.unwrap_or(0) as usize;
        let body = data[start.min(data.len())..].to_vec();
        Ok(HttpResponse {
            status: if range_from.is_some() { 206 } else { 200 },
            content_length: Some(body.len() as u64),
            body: Box::new(Gated {
                data: Cursor::new(body),
                sent: 0,
                hold_after: self.hold_after,
                gate: self.gate.lock().expect("lock").take(),
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

fn broker(server: Server, dir: &Path) -> (Broker, Arc<Mutex<Vec<BrokerEvent>>>) {
    let seen = Arc::new(Mutex::new(Vec::new()));
    let sink = Arc::clone(&seen);
    let broker = Broker::new(
        Staging::new(dir),
        Arc::new(server),
        Arc::new(move |event: &BrokerEvent| sink.lock().expect("lock").push(event.clone())),
    )
    .with_retry(RetryPolicy::default(), Box::new(|_| {}));
    (broker, seen)
}

fn request(url: &str, body: &[u8]) -> ArtifactRequest {
    ArtifactRequest {
        provider: Provider::Pypi,
        url: url.to_string(),
        mirrors: Vec::new(),
        sha256: Some(sha(body)),
        size: Some(body.len() as u64),
    }
}

const WHEEL: &str = "https://files.example/p/six-1.17.0-py2.py3-none-any.whl";

#[test]
fn an_artifact_is_downloaded_verified_and_cleaned_up_once_released() {
    let tmp = tempfile::tempdir().expect("tmp");
    let body = b"wheel bytes".to_vec();
    let server = Server {
        files: HashMap::from([(WHEEL.to_string(), body.clone())]),
        ..Server::default()
    };
    let (broker, events) = broker(server, tmp.path());
    let lease = broker.fetch(&request(WHEEL, &body)).expect("fetch");
    assert_eq!(std::fs::read(lease.path()).expect("read"), body);
    assert!(lease.path().starts_with(tmp.path().join("pypi")));
    let dir = lease.path().parent().expect("dir").to_path_buf();
    drop(lease);
    assert!(
        !dir.exists(),
        "the staging folder goes once the artifact is handed over"
    );
    let phases: Vec<Phase> = events
        .lock()
        .expect("lock")
        .iter()
        .map(|e| e.phase)
        .collect();
    for phase in [
        Phase::Connecting,
        Phase::Downloading,
        Phase::Verifying,
        Phase::Complete,
    ] {
        assert!(phases.contains(&phase), "{phase:?} in {phases:?}");
    }
}

#[test]
fn a_file_that_fails_its_checksum_is_deleted_and_the_mirror_is_used() {
    let tmp = tempfile::tempdir().expect("tmp");
    let good = b"good".to_vec();
    let mirror = "https://mirror.example/six.whl";
    let server = Server {
        files: HashMap::from([
            (WHEEL.to_string(), b"evil".to_vec()),
            (mirror.to_string(), good.clone()),
        ]),
        ..Server::default()
    };
    let (broker, _) = broker(server, tmp.path());
    let mut req = request(WHEEL, &good);
    req.mirrors = vec![mirror.to_string()];
    let lease = broker.fetch(&req).expect("the mirror has the right file");
    assert_eq!(std::fs::read(lease.path()).expect("read"), good);

    req.mirrors.clear();
    drop(lease);
    let error = match broker.fetch(&req) {
        Err(error) => error,
        Ok(_) => panic!("a wrong file must never be handed over"),
    };
    assert_eq!(error.kind, FailureKind::Checksum);
}

#[test]
fn an_address_that_isnt_https_is_refused_before_any_request() {
    let tmp = tempfile::tempdir().expect("tmp");
    let (broker, _) = broker(Server::default(), tmp.path());
    let req = request("http://files.example/a.whl", b"x");
    let error = broker.fetch(&req).err().expect("refused");
    assert_eq!(error.kind, FailureKind::Refused);
}

#[test]
fn a_missing_file_is_not_found_and_leaves_no_folder() {
    let tmp = tempfile::tempdir().expect("tmp");
    let (broker, _) = broker(Server::default(), tmp.path());
    let error = broker.fetch(&request(WHEEL, b"x")).err().expect("missing");
    assert_eq!(error.kind, FailureKind::NotFound);
    let left = std::fs::read_dir(tmp.path().join("pypi"))
        .map(|dir| dir.count())
        .unwrap_or(0);
    assert_eq!(left, 0);
}

#[test]
fn concurrent_requests_for_one_artifact_share_one_download() {
    let tmp = tempfile::tempdir().expect("tmp");
    let body = vec![7u8; 4096];
    let (release, gate) = mpsc::channel();
    let server = Arc::new(Server {
        files: HashMap::from([(WHEEL.to_string(), body.clone())]),
        hold_after: Some(1024),
        gate: Mutex::new(Some(gate)),
        ..Server::default()
    });
    let events: EventSink = Arc::new(|_| {});
    let broker = Arc::new(
        Broker::new(Staging::new(tmp.path()), server.clone(), events)
            .with_retry(RetryPolicy::default(), Box::new(|_| {})),
    );
    let started = Arc::new(AtomicUsize::new(0));
    let handles: Vec<_> = (0..3)
        .map(|_| {
            let broker = Arc::clone(&broker);
            let started = Arc::clone(&started);
            let req = request(WHEEL, &body);
            std::thread::spawn(move || {
                started.fetch_add(1, Ordering::SeqCst);
                broker.fetch(&req).map(|lease| lease.len())
            })
        })
        .collect();
    while started.load(Ordering::SeqCst) < 3 {
        std::thread::yield_now();
    }
    std::thread::sleep(Duration::from_millis(200));
    release.send(()).expect("release");
    for handle in handles {
        assert_eq!(handle.join().expect("join").expect("fetch"), 4096);
    }
    assert_eq!(
        server.requests.lock().expect("lock").len(),
        1,
        "one download served all three requests"
    );
}

#[test]
fn a_cancelled_download_keeps_its_part_and_the_next_request_resumes_it() {
    let tmp = tempfile::tempdir().expect("tmp");
    let body: Vec<u8> = (0..200_000u32).map(|i| (i % 251) as u8).collect();
    let (release, gate) = mpsc::channel::<()>();
    let server = Arc::new(Server {
        files: HashMap::from([(WHEEL.to_string(), body.clone())]),
        hold_after: Some(70_000),
        gate: Mutex::new(Some(gate)),
        ..Server::default()
    });
    let events: EventSink = Arc::new(|_| {});
    let broker = Arc::new(
        Broker::new(Staging::new(tmp.path()), server.clone(), events)
            .with_retry(RetryPolicy::default(), Box::new(|_| {})),
    );
    let worker = {
        let broker = Arc::clone(&broker);
        let req = request(WHEEL, &body);
        std::thread::spawn(move || broker.fetch(&req).map(|lease| lease.len()))
    };
    // Wait until the download is under way, then cancel it and let the body continue.
    loop {
        let running = broker.cancels.lock().expect("lock").keys().next().copied();
        if let Some(id) = running {
            std::thread::sleep(Duration::from_millis(100));
            assert!(broker.cancel(id));
            break;
        }
        std::thread::yield_now();
    }
    release.send(()).expect("release");
    let error = worker.join().expect("join").expect_err("cancelled");
    assert_eq!(error.kind, FailureKind::Cancelled);
    let report = broker
        .staging()
        .recover(crate::staging::now_secs(), crate::staging::PARTIAL_MAX_AGE);
    assert_eq!(report.kept_partial, 1, "the partial download is kept");

    let lease = broker.fetch(&request(WHEEL, &body)).expect("resumed");
    assert_eq!(std::fs::read(lease.path()).expect("read"), body);
    let requests = server.requests.lock().expect("lock").clone();
    assert!(
        requests
            .iter()
            .any(|(_, from)| from.is_some_and(|start| start > 0)),
        "the second request resumed with a Range: {requests:?}"
    );
}

#[test]
fn no_more_than_the_limit_download_at_once_and_the_rest_are_queued() {
    let tmp = tempfile::tempdir().expect("tmp");
    let files: HashMap<String, Vec<u8>> = (0..5)
        .map(|i| {
            (
                format!("https://files.example/{i}.whl"),
                vec![i as u8; 2048],
            )
        })
        .collect();
    let seen = Arc::new(Mutex::new(Vec::new()));
    let sink = Arc::clone(&seen);
    let broker = Arc::new(
        Broker::new(
            Staging::new(tmp.path()),
            Arc::new(Server {
                files: files.clone(),
                ..Server::default()
            }),
            Arc::new(move |event: &BrokerEvent| sink.lock().expect("lock").push(event.clone())),
        )
        .with_retry(RetryPolicy::default(), Box::new(|_| {}))
        .with_max_active(2),
    );
    let handles: Vec<_> = files
        .iter()
        .map(|(url, body)| {
            let broker = Arc::clone(&broker);
            let req = request(url, body);
            std::thread::spawn(move || broker.fetch(&req).map(|lease| lease.len()))
        })
        .collect();
    for handle in handles {
        assert_eq!(handle.join().expect("join").expect("fetch"), 2048);
    }
    // Replay the events: never more than two operations between Connecting and Complete at once.
    let events = seen.lock().expect("lock").clone();
    let mut running = std::collections::HashSet::new();
    let mut most = 0;
    for event in &events {
        match event.phase {
            Phase::Connecting => {
                running.insert(event.id);
            }
            Phase::Complete | Phase::Failed | Phase::Cancelled => {
                running.remove(&event.id);
            }
            _ => {}
        }
        most = most.max(running.len());
    }
    assert!(most <= 2, "at most two at once, saw {most}");
    assert_eq!(
        *broker.active.lock().expect("lock"),
        0,
        "every place is given back"
    );
}

/// A client that panics, as a bug in a download would.
struct Panics;

impl HttpClient for Panics {
    fn get(&self, _url: &str, _range_from: Option<u64>) -> Result<HttpResponse, RuntimeError> {
        std::thread::sleep(Duration::from_millis(200));
        panic!("simulated bug in a download");
    }
}

#[test]
fn a_download_that_stops_unexpectedly_never_leaves_a_waiter_hanging() {
    let tmp = tempfile::tempdir().expect("tmp");
    let events: EventSink = Arc::new(|_| {});
    let broker = Arc::new(Broker::new(
        Staging::new(tmp.path()),
        Arc::new(Panics),
        events,
    ));
    let owner = {
        let broker = Arc::clone(&broker);
        std::thread::spawn(move || broker.fetch(&request(WHEEL, b"x")).map(|lease| lease.len()))
    };
    std::thread::sleep(Duration::from_millis(50));
    let waiter = {
        let broker = Arc::clone(&broker);
        std::thread::spawn(move || broker.fetch(&request(WHEEL, b"x")).map(|lease| lease.len()))
    };
    assert!(owner.join().is_err(), "the owner's thread panicked");
    let result = waiter.join().expect("the waiter returns");
    let error = result.expect_err("an error, not a hang");
    assert_eq!(error.detail, "the download stopped unexpectedly");
    // The next request starts afresh (the flight is gone) instead of waiting.
    assert!(broker.flights.lock().expect("lock").is_empty());
}

#[test]
fn a_download_interrupted_by_a_crash_is_kept_to_resume_and_clear_removes_everything() {
    let tmp = tempfile::tempdir().expect("tmp");
    let staging = Staging::new(tmp.path());
    // A slot dropped in the middle (what a crash leaves): its record still says "downloading".
    let slot = staging
        .slot(Provider::Npm, "https://r/a.tgz", "a.tgz")
        .expect("slot");
    std::fs::write(slot.dir().join("a.tgz.part"), b"half").expect("part");
    drop(slot);
    let report = staging.recover(crate::staging::now_secs(), crate::staging::PARTIAL_MAX_AGE);
    assert_eq!(report.kept_partial, 1);
    let cleared = staging.clear();
    assert_eq!(cleared.removed, 1);
    let left = std::fs::read_dir(tmp.path().join("npm"))
        .map(|d| d.count())
        .unwrap_or(0);
    assert_eq!(left, 0);
}
