//! The panel side of a running agent turn: events go to the window that asked (`agent:event`), and a permission
//! question waits for that window's answer (`agent_answer`) — or for Stop, which counts as "no".

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{self, RecvTimeoutError};
use std::sync::{Mutex, PoisonError};
use std::time::Duration;

use openmind_agent::{AgentEvent, AgentHost, Decision, PermissionRequest};
use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager};

#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EditorState {
    pub root: Option<String>,
    pub unsaved: Vec<String>,
}

type GuardKey = (String, String);
type GuardSender = mpsc::Sender<EditorState>;

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct GuardRequest {
    id: String,
    owner: String,
}

/// Questions waiting for an answer, by tool call id.
#[derive(Default)]
pub struct Pending {
    waiting: Mutex<HashMap<String, mpsc::Sender<Decision>>>,
    guards: Mutex<HashMap<GuardKey, GuardSender>>,
}

impl Pending {
    pub fn editor_state(&self, id: &str, window: &str, state: EditorState) -> bool {
        self.guards
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .remove(&(id.into(), window.into()))
            .is_some_and(|tx| tx.send(state).is_ok())
    }

    fn check_window(
        &self,
        app: &AppHandle,
        owner: &str,
        window: &str,
        cancel: &AtomicBool,
    ) -> Result<EditorState, String> {
        static NEXT: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(1);
        let id = NEXT.fetch_add(1, Ordering::Relaxed).to_string();
        let key = (id.clone(), window.to_string());
        let (tx, rx) = mpsc::channel();
        self.guards
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .insert(key.clone(), tx);
        let result = (|| {
            app.emit_to(
                window,
                "agent:guard",
                GuardRequest {
                    id,
                    owner: owner.into(),
                },
            )
            .map_err(|e| e.to_string())?;
            let started = std::time::Instant::now();
            loop {
                if cancel.load(Ordering::Relaxed) {
                    return Err("Stopped.".into());
                }
                match rx.recv_timeout(Duration::from_millis(40)) {
                    Ok(state) => return Ok(state),
                    Err(RecvTimeoutError::Timeout) if started.elapsed() < Duration::from_secs(5) => {},
                    _ => return Err("An editor window did not confirm its current document state; no file was changed.".into()),
                }
            }
        })();
        self.guards
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .remove(&key);
        result
    }
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
    pub task_id: Option<&'a str>,
    pub options: Option<&'a openmind_agent::SessionOptions>,
}

impl WindowHost<'_> {
    pub fn send<T: Serialize>(&self, payload: &T) {
        let Ok(mut payload) = serde_json::to_value(payload) else {
            return;
        };
        if let (Some(id), Some(object)) = (self.task_id, payload.as_object_mut()) {
            object.insert("taskId".into(), serde_json::Value::String(id.into()));
        }
        if let Err(err) = self
            .app
            .emit_to(self.label.as_str(), "agent:event", payload)
        {
            tracing::warn!(%err, "could not send an agent event to the window");
        }
    }
}

impl AgentHost for WindowHost<'_> {
    fn external_tools(&self) -> Vec<openmind_agent::external::ExternalTool> {
        let mut tools = self
            .options
            .map(super::capabilities::specs)
            .unwrap_or_default();
        tools.extend(
            self.app
                .state::<super::AgentRuntime>()
                .chat(&self.label)
                .mcp
                .specs(),
        );
        tools
    }
    fn external_call(
        &self,
        call: &openmind_agent::wire::ToolCall,
        cancel: &AtomicBool,
    ) -> openmind_agent::tools::Outcome {
        if call.name.starts_with("mcp_") {
            return self
                .app
                .state::<super::AgentRuntime>()
                .chat(&self.label)
                .mcp
                .call(call, cancel);
        }
        match self.options {
            Some(options) => super::capabilities::call(self, options, call, cancel),
            None => openmind_agent::tools::Outcome::failed("Capability unavailable"),
        }
    }
    fn check_change(&self, path: &std::path::Path, cancel: &AtomicBool) -> Result<(), String> {
        let key = |p: &std::path::Path| {
            let s = p.to_string_lossy().replace('\\', "/");
            if cfg!(windows) {
                s.to_lowercase()
            } else {
                s
            }
        };
        let wanted = key(path);
        let mut origin_checked = false;
        for label in self
            .app
            .webview_windows()
            .keys()
            .filter(|l| l.as_str() == "main" || l.starts_with("window-"))
        {
            let state = self
                .pending
                .check_window(&self.app, &self.label, label, cancel)?;
            if label == &self.label {
                let root = state.root.ok_or("The project folder is no longer open.")?;
                let ws = openmind_agent::Workspace::new(std::path::Path::new(&root))?;
                ws.resolve_for_change(&path.to_string_lossy())?;
                origin_checked = true;
            }
            for dirty in state.unsaved {
                let dirty = std::path::PathBuf::from(dirty);
                let dirty = openmind_fs::normalize_path(&dirty).unwrap_or(dirty);
                let actual = key(&dirty);
                if actual == wanted || actual.starts_with(&format!("{wanted}/")) {
                    return Err("The file or a child document has unsaved edits in an editor window. Save or discard those edits first.".into());
                }
            }
        }
        if !origin_checked {
            return Err("The editor window closed; no file was changed.".into());
        }
        Ok(())
    }

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
    #[test]
    fn a_guard_reply_is_bound_to_the_window_and_consumed_once() {
        let pending = Pending::default();
        let (tx, rx) = mpsc::channel();
        pending
            .guards
            .lock()
            .expect("guards")
            .insert(("g1".into(), "main".into()), tx);
        let state = || EditorState {
            root: None,
            unsaved: vec!["dirty.ts".into()],
        };
        assert!(!pending.editor_state("g1", "window-2", state()));
        assert!(pending.editor_state("g1", "main", state()));
        assert_eq!(rx.recv().expect("answer").unsaved, vec!["dirty.ts"]);
        assert!(!pending.editor_state("g1", "main", state()));
    }
}
