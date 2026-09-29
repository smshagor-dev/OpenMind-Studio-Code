//! The Unified Download Broker: every artifact (a wheel, an npm tarball, a Go module zip, an `openmind-fetch` file) is
//! downloaded by the Download Manager's own code — `openmind_runtime_manager::download` (resume from `.part`, HTTPS
//! only) with `verify_sha256` and the `with_mirrors` retry policy — through its client (`UreqClient`: the proxy route
//! and TLS of every OpenMind download). The broker adds what package traffic needs on top: temporary staging, one
//! download for concurrent requests of the same artifact, cancellation, progress events and cleanup once the artifact
//! has been handed over.

use std::collections::HashMap;
use std::fs::File;
use std::io::{self, Read};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Condvar, Mutex};
use std::time::Duration;

use openmind_network::problem::{NetError, NetProblem};
use openmind_network::retry::{with_mirrors, RetryPolicy};
use openmind_runtime_manager::download::{download, verify_sha256};
use openmind_runtime_manager::{HttpClient, HttpResponse, RuntimeError};

use crate::error::{BrokerError, FailureKind};
use crate::events::{EventSink, Phase, Reporter};
use crate::staging::{Provider, Slot, Staging};

/// One artifact to download.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ArtifactRequest {
    pub provider: Provider,
    pub url: String,
    /// Other addresses of the same file, tried after `url`.
    pub mirrors: Vec<String>,
    /// The SHA-256 the index published (hex), checked before anything is handed over.
    pub sha256: Option<String>,
    /// The expected size, when known (sizes the time allowed for the body).
    pub size: Option<u64>,
}

/// A downloaded, verified artifact in staging. Its folder is removed when the last holder lets go of it.
pub struct Artifact {
    path: PathBuf,
    len: u64,
    slot: Mutex<Option<Slot>>,
}

impl Artifact {
    pub fn path(&self) -> &Path {
        &self.path
    }

    pub fn len(&self) -> u64 {
        self.len
    }

    pub fn is_empty(&self) -> bool {
        self.len == 0
    }

    pub fn open(&self) -> io::Result<File> {
        File::open(&self.path)
    }
}

impl Drop for Artifact {
    fn drop(&mut self) {
        if let Some(slot) = self.slot.get_mut().ok().and_then(Option::take) {
            slot.remove();
        }
    }
}

pub type Lease = Arc<Artifact>;

#[derive(Default)]
struct Flight {
    result: Mutex<Option<Result<Lease, BrokerError>>>,
    done: Condvar,
}

type Sleeper = Box<dyn Fn(Duration) + Send + Sync>;

pub struct Broker {
    staging: Staging,
    client: Arc<dyn HttpClient>,
    events: EventSink,
    policy: RetryPolicy,
    sleep: Sleeper,
    next_id: AtomicU64,
    flights: Mutex<HashMap<String, Arc<Flight>>>,
    cancels: Mutex<HashMap<u64, Arc<AtomicBool>>>,
}

/// The Download Manager's client with a cancel switch: the body stops at the next read once the switch is on.
struct Cancellable<'a> {
    inner: &'a dyn HttpClient,
    cancelled: Arc<AtomicBool>,
}

struct CancelRead {
    inner: Box<dyn Read + Send>,
    cancelled: Arc<AtomicBool>,
}

impl Read for CancelRead {
    fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
        if self.cancelled.load(Ordering::Relaxed) {
            return Err(io::Error::new(io::ErrorKind::Interrupted, "cancelled"));
        }
        self.inner.read(buf)
    }
}

impl HttpClient for Cancellable<'_> {
    fn get(&self, url: &str, range_from: Option<u64>) -> Result<HttpResponse, RuntimeError> {
        self.get_sized(url, range_from, None)
    }

    fn get_sized(
        &self,
        url: &str,
        range_from: Option<u64>,
        expected_bytes: Option<u64>,
    ) -> Result<HttpResponse, RuntimeError> {
        let response = self.inner.get_sized(url, range_from, expected_bytes)?;
        Ok(HttpResponse {
            status: response.status,
            content_length: response.content_length,
            body: Box::new(CancelRead {
                inner: response.body,
                cancelled: Arc::clone(&self.cancelled),
            }),
        })
    }
}

fn net_of(error: &RuntimeError) -> NetError {
    match error {
        RuntimeError::Network(net) => net.clone(),
        RuntimeError::ChecksumMismatch { .. } => {
            NetError::new(NetProblem::Checksum, error.to_string())
        }
        RuntimeError::InsecureUrl(_) => NetError::new(NetProblem::InsecureUrl, error.to_string()),
        // A local file problem (disk full, no permission) won't get better on another address.
        _ => NetError::new(NetProblem::Cancelled, error.to_string()),
    }
}

impl Broker {
    pub fn new(staging: Staging, client: Arc<dyn HttpClient>, events: EventSink) -> Self {
        Broker {
            staging,
            client,
            events,
            policy: RetryPolicy::default(),
            sleep: Box::new(std::thread::sleep),
            next_id: AtomicU64::new(1),
            flights: Mutex::new(HashMap::new()),
            cancels: Mutex::new(HashMap::new()),
        }
    }

    /// The same broker with another retry policy and pause (tests don't wait).
    pub fn with_retry(mut self, policy: RetryPolicy, sleep: Sleeper) -> Self {
        self.policy = policy;
        self.sleep = sleep;
        self
    }

    pub fn staging(&self) -> &Staging {
        &self.staging
    }

    pub fn events(&self) -> &EventSink {
        &self.events
    }

    /// A fresh operation id (also used by the gateway for pass-through transfers).
    pub fn next_id(&self) -> u64 {
        self.next_id.fetch_add(1, Ordering::Relaxed)
    }

    /// Stops a running download at its next read. `false` when no such operation runs.
    pub fn cancel(&self, id: u64) -> bool {
        let flag = self
            .cancels
            .lock()
            .ok()
            .and_then(|map| map.get(&id).cloned());
        match flag {
            Some(flag) => {
                flag.store(true, Ordering::Relaxed);
                true
            }
            None => false,
        }
    }

    /// Stops every running download (app shutdown).
    pub fn cancel_all(&self) {
        if let Ok(map) = self.cancels.lock() {
            for flag in map.values() {
                flag.store(true, Ordering::Relaxed);
            }
        }
    }

    /// The artifact, downloaded and verified. Requests for the same artifact made while it downloads wait for that one
    /// download and share its result.
    pub fn fetch(&self, request: &ArtifactRequest) -> Result<Lease, BrokerError> {
        let key = format!("{}|{}", request.provider.dir(), request.url);
        let (flight, owner) = {
            let mut flights = self
                .flights
                .lock()
                .map_err(|_| BrokerError::new(FailureKind::Other, "broker lock poisoned"))?;
            match flights.get(&key) {
                Some(flight) => (Arc::clone(flight), false),
                None => {
                    let flight = Arc::new(Flight::default());
                    flights.insert(key.clone(), Arc::clone(&flight));
                    (flight, true)
                }
            }
        };
        if !owner {
            return wait(&flight);
        }
        let result = self.download(request);
        if let Ok(mut slot) = flight.result.lock() {
            *slot = Some(result.clone());
        }
        flight.done.notify_all();
        if let Ok(mut flights) = self.flights.lock() {
            flights.remove(&key);
        }
        result
    }

    fn download(&self, request: &ArtifactRequest) -> Result<Lease, BrokerError> {
        let id = self.next_id();
        let name = crate::staging::safe_file_name(&request.url);
        let mut reporter = Reporter::new(Arc::clone(&self.events), id, request.provider, &name);
        let cancelled = Arc::new(AtomicBool::new(false));
        if let Ok(mut map) = self.cancels.lock() {
            map.insert(id, Arc::clone(&cancelled));
        }
        let result = self.download_into(request, &mut reporter, &cancelled);
        if let Ok(mut map) = self.cancels.lock() {
            map.remove(&id);
        }
        match &result {
            Ok(artifact) => {
                reporter.phase(Phase::Complete);
                tracing::info!(id, url = %request.url, bytes = artifact.len(), "broker download complete");
            }
            Err(error) => {
                reporter.failed(error.kind, &error.detail);
                tracing::warn!(id, url = %request.url, kind = ?error.kind, detail = %error.detail, "broker download failed");
            }
        }
        result
    }

    fn download_into(
        &self,
        request: &ArtifactRequest,
        reporter: &mut Reporter,
        cancelled: &Arc<AtomicBool>,
    ) -> Result<Lease, BrokerError> {
        reporter.phase(Phase::Connecting);
        let slot = self
            .staging
            .slot(request.provider, &request.url, &request.url)
            .map_err(|err| {
                if err.kind() == io::ErrorKind::WouldBlock {
                    BrokerError::new(
                        FailureKind::Other,
                        "another OpenMind Studio is downloading this file right now",
                    )
                } else {
                    BrokerError::io(&err, "staging folder")
                }
            })?;
        let dest = slot.file().to_path_buf();
        let client = Cancellable {
            inner: self.client.as_ref(),
            cancelled: Arc::clone(cancelled),
        };
        let mut urls = vec![request.url.clone()];
        urls.extend(request.mirrors.iter().cloned());
        let mut last: Option<BrokerError> = None;
        let mut attempts = 0u32;
        let outcome = with_mirrors(
            &urls,
            self.policy,
            &mut |pause| (self.sleep)(pause),
            &|| cancelled.load(Ordering::Relaxed),
            &mut |url| {
                attempts += 1;
                if attempts > 1 {
                    reporter.retry(attempts);
                }
                let result = download(&client, url, &dest, request.size, &mut |done, total| {
                    reporter.bytes(done, total)
                })
                .and_then(|()| match &request.sha256 {
                    Some(expected) => {
                        reporter.phase(Phase::Verifying);
                        verify_sha256(&dest, expected, &mut |_, _| {})
                    }
                    None => Ok(()),
                });
                result.map_err(|error| {
                    last = Some(BrokerError::runtime(&error));
                    net_of(&error)
                })
            },
        );
        if cancelled.load(Ordering::Relaxed) {
            slot.keep_for_resume();
            return Err(BrokerError::new(FailureKind::Cancelled, "cancelled"));
        }
        if let Err(net) = outcome {
            slot.keep_for_resume();
            return Err(last.unwrap_or_else(|| BrokerError::net(&net)));
        }
        reporter.phase(Phase::Finalizing);
        slot.mark_ready();
        let len = std::fs::metadata(&dest)
            .map(|m| m.len())
            .map_err(|err| BrokerError::io(&err, "staged file"))?;
        Ok(Arc::new(Artifact {
            path: dest,
            len,
            slot: Mutex::new(Some(slot)),
        }))
    }
}

fn wait(flight: &Flight) -> Result<Lease, BrokerError> {
    let mut guard = flight
        .result
        .lock()
        .map_err(|_| BrokerError::new(FailureKind::Other, "broker lock poisoned"))?;
    loop {
        if let Some(result) = guard.as_ref() {
            return result.clone();
        }
        guard = flight
            .done
            .wait(guard)
            .map_err(|_| BrokerError::new(FailureKind::Other, "broker lock poisoned"))?;
    }
}

#[cfg(test)]
#[path = "broker_tests.rs"]
mod tests;
