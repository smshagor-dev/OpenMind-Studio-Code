//! The panel side of a running agent turn: events go to the window that asked (`agent:event`), and a permission
//! question waits for that window's answer (`agent_answer`) — or for Stop, which counts as "no".

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{self, RecvTimeoutError};
use std::sync::{Mutex, PoisonError};
use std::time::Duration;

use openmind_agent::{AgentEvent, AgentHost, Decision, PermissionRequest};
use serde::Serialize;
use tauri::{AppHandle, Emitter};

/// Questions waiting for an answer, by tool call id.
#[derive(Default)]
pub struct Pending {
    waiting: Mutex<HashMap<String, mpsc::Sender<Decision>>>,
}

impl Pending {
    pub fn answer(&self, id: &str, decision: Decision) -> bool {
        let sender = self
            .waiting
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .remove(id);
        sender.is_some_and(|s| s.send(decision).is_ok())
    }

    fn register(&self, id: &str) -> mpsc::Receiver<Decision> {
        let (tx, rx) = mpsc::channel();
        self.waiting
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .insert(id.to_string(), tx);
        rx
    }

    fn forget(&self, id: &str) {
        self.waiting
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .remove(id);
    }
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct PermissionEvent<'a> {
    #[serde(rename = "type")]
    kind: &'static str,
    request: &'a PermissionRequest,
}

pub struct WindowHost<'a> {
    pub app: AppHandle,
    pub label: String,
    pub pending: &'a Pending,
}

impl WindowHost<'_> {
    pub fn send<T: Serialize + Clone>(&self, payload: &T) {
        if let Err(err) = self
            .app
            .emit_to(self.label.as_str(), "agent:event", payload.clone())
        {
            tracing::warn!(%err, "could not send an agent event to the window");
        }
    }
}

impl AgentHost for WindowHost<'_> {
    fn emit(&self, event: AgentEvent) {
        self.send(&event);
    }

    fn ask(&self, request: PermissionRequest, cancel: &AtomicBool) -> Decision {
        let rx = self.pending.register(&request.id);
        self.send(&PermissionEvent {
            kind: "permission",
            request: &request,
        });
        loop {
            if cancel.load(Ordering::Relaxed) {
                self.pending.forget(&request.id);
                return Decision::Deny { feedback: None };
            }
            match rx.recv_timeout(Duration::from_millis(100)) {
                Ok(decision) => return decision,
                Err(RecvTimeoutError::Timeout) => {}
                Err(RecvTimeoutError::Disconnected) => return Decision::Deny { feedback: None },
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_answer_reaches_the_waiting_question_once() {
        let pending = Pending::default();
        let rx = pending.register("c1");
        assert!(pending.answer("c1", Decision::Allow));
        assert_eq!(rx.recv().ok(), Some(Decision::Allow));
        assert!(!pending.answer("c1", Decision::Allow), "answered already");
        assert!(!pending.answer("unknown", Decision::Allow));
    }
}
