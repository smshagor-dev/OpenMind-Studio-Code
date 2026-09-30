//! Progress of broker operations, for the app's download UI. Only addresses and sizes — never headers or credentials.

use std::sync::Arc;
use std::time::Instant;

use serde::Serialize;

use crate::error::FailureKind;
use crate::staging::Provider;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Phase {
    /// Waiting for a free download place.
    Queued,
    Resolving,
    Connecting,
    Downloading,
    Verifying,
    Finalizing,
    Cleaning,
    Complete,
    Failed,
    Cancelled,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BrokerEvent {
    pub id: u64,
    pub provider: Provider,
    /// The artifact's file name (or what is being resolved).
    pub artifact: String,
    pub phase: Phase,
    pub bytes: u64,
    pub total: Option<u64>,
    /// Bytes per second over the download so far.
    pub speed: u64,
    /// The attempt number when an address is being tried again.
    pub retry: Option<u32>,
    pub failure: Option<FailureKind>,
    pub detail: Option<String>,
}

pub type EventSink = Arc<dyn Fn(&BrokerEvent) + Send + Sync>;

/// Builds the events of one operation.
pub struct Reporter {
    sink: EventSink,
    event: BrokerEvent,
    started: Instant,
    resumed_from: u64,
}

impl Reporter {
    pub fn new(sink: EventSink, id: u64, provider: Provider, artifact: &str) -> Self {
        Reporter {
            sink,
            event: BrokerEvent {
                id,
                provider,
                artifact: artifact.to_string(),
                phase: Phase::Resolving,
                bytes: 0,
                total: None,
                speed: 0,
                retry: None,
                failure: None,
                detail: None,
            },
            started: Instant::now(),
            resumed_from: 0,
        }
    }

    pub fn id(&self) -> u64 {
        self.event.id
    }

    pub fn phase(&mut self, phase: Phase) {
        self.event.phase = phase;
        (self.sink)(&self.event);
    }

    pub fn retry(&mut self, attempt: u32) {
        self.event.retry = Some(attempt);
        (self.sink)(&self.event);
    }

    pub fn bytes(&mut self, done: u64, total: Option<u64>) {
        if self.event.phase != Phase::Downloading {
            self.event.phase = Phase::Downloading;
            self.resumed_from = done;
            self.started = Instant::now();
        }
        let seconds = self.started.elapsed().as_secs_f64();
        self.event.speed = if seconds > 0.2 {
            ((done.saturating_sub(self.resumed_from)) as f64 / seconds) as u64
        } else {
            0
        };
        self.event.bytes = done;
        self.event.total = total;
        (self.sink)(&self.event);
    }

    pub fn failed(&mut self, kind: FailureKind, detail: &str) {
        self.event.phase = if kind == FailureKind::Cancelled {
            Phase::Cancelled
        } else {
            Phase::Failed
        };
        self.event.failure = Some(kind);
        // No credentials, tokens or signed-address queries reach the UI.
        self.event.detail = Some(crate::redact::text(detail));
        (self.sink)(&self.event);
    }
}
