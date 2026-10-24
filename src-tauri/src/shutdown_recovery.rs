//! Recovery acknowledgement from every editable renderer, including hidden editor windows.

use std::collections::{BTreeMap, HashMap};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;
use std::time::Duration;

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager};
use tokio::sync::oneshot;

use crate::app_state::AppState;

const REQUEST_EVENT: &str = "editor-shutdown-requested";
const FINISH_EVENT: &str = "editor-shutdown-finished";
const RECOVERY_TIMEOUT: Duration = Duration::from_secs(15);
static NEXT_REQUEST: AtomicU64 = AtomicU64::new(1);

struct Pending {
    token: String,
    reply: oneshot::Sender<bool>,
}

#[derive(Default)]
pub struct RecoveryState {
    pending: Mutex<HashMap<(String, String), Pending>>,
}

impl RecoveryState {
    fn register(
        &self,
        request: &str,
        label: &str,
        token: &str,
    ) -> Result<oneshot::Receiver<bool>, String> {
        let (reply, receiver) = oneshot::channel();
        self.pending
            .lock()
            .map_err(|err| err.to_string())?
            .insert(
                (request.into(), label.into()),
                Pending {
                    token: token.into(),
                    reply,
                },
            );
        Ok(receiver)
    }

    fn acknowledge(&self, request: &str, label: &str, token: &str, saved: bool) -> Result<(), String> {
        let key = (request.to_string(), label.to_string());
        let mut pending = self.pending.lock().map_err(|err| err.to_string())?;
        if !pending.get(&key).is_some_and(|entry| entry.token == token) {
            return Err("This shutdown recovery request is no longer active.".into());
        }
        if let Some(entry) = pending.remove(&key) {
            let _ = entry.reply.send(saved);
        }
        Ok(())
    }

    pub fn cancel_window(&self, label: &str) {
        if let Ok(mut pending) = self.pending.lock() {
            pending.retain(|(_, owner), _| owner != label);
        }
    }

    fn cancel_request(&self, request: &str) {
        if let Ok(mut pending) = self.pending.lock() {
            pending.retain(|(id, _), _| id != request);
        }
    }
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct Request {
    request_id: String,
    token: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct Finished {
    request_id: String,
    error: Option<String>,
}

/// Keep renderer input suspended until exit or installer completion; failures release every participant.
pub struct RecoveryGuard {
    app: AppHandle,
    request_id: String,
    targets: Vec<String>,
    error: Option<String>,
}

impl Drop for RecoveryGuard {
    fn drop(&mut self) {
        if let Some(state) = self.app.try_state::<AppState>() {
            state.editor_windows.shutdown.cancel_request(&self.request_id);
        }
        for label in &self.targets {
            let _ = self.app.emit_to(
                label.as_str(),
                FINISH_EVENT,
                Finished {
                    request_id: self.request_id.clone(),
                    error: self.error.clone(),
                },
            );
        }
    }
}

/// The caller holds the native window-operation lock throughout preparation and shutdown/install.
pub async fn prepare(app: &AppHandle) -> Result<RecoveryGuard, String> {
    let targets = crate::windows::ready_editors(app)?;
    let request_id = NEXT_REQUEST.fetch_add(1, Ordering::SeqCst).to_string();
    let mut guard = RecoveryGuard {
        app: app.clone(),
        request_id: request_id.clone(),
        targets: targets.keys().cloned().collect(),
        error: None,
    };
    let result = prepare_round(app, &request_id, &targets).await;
    if let Err(error) = result {
        guard.error = Some(error.clone());
        return Err(error);
    }
    Ok(guard)
}

async fn prepare_round(
    app: &AppHandle,
    request_id: &str,
    targets: &BTreeMap<String, String>,
) -> Result<(), String> {
    let state = app.state::<AppState>();
    let mut replies = Vec::new();
    for (label, token) in targets {
        let reply = state.editor_windows.shutdown.register(request_id, label, token)?;
        replies.push((label.clone(), reply));
    }
    if &crate::windows::ready_editors(app)? != targets {
        return Err("Quit was cancelled because an editor page changed before recovery began. Try again.".into());
    }
    for (label, token) in targets {
        app.emit_to(
            label.as_str(),
            REQUEST_EVENT,
            Request {
                request_id: request_id.into(),
                token: token.clone(),
            },
        )
        .map_err(|err| err.to_string())?;
    }
    await_replies(replies, RECOVERY_TIMEOUT).await?;
    if &crate::windows::ready_editors(app)? != targets {
        return Err("Quit was cancelled because an editor page changed during recovery. Try again.".into());
    }
    Ok(())
}

async fn await_replies(
    replies: Vec<(String, oneshot::Receiver<bool>)>,
    timeout: Duration,
) -> Result<(), String> {
    let mut waiting = tokio::task::JoinSet::new();
    for (label, reply) in replies {
        waiting.spawn(async move { (label, reply.await) });
    }
    tokio::time::timeout(timeout, async {
        while let Some(reply) = waiting.join_next().await {
            let (label, reply) = reply.map_err(|err| err.to_string())?;
            if !matches!(reply, Ok(true)) {
                return Err(format!("Quit was cancelled because {label} could not confirm its recovery data."));
            }
        }
        Ok::<(), String>(())
    })
    .await
    .map_err(|_| {
        "Quit was cancelled because an editor window did not respond to the recovery request. Try again.".to_string()
    })?
}

#[tauri::command]
pub fn window_shutdown_ack(
    request_id: String,
    token: String,
    saved: bool,
    window: tauri::Window,
    app: AppHandle,
) -> Result<(), String> {
    if crate::windows::ready_editors(&app)?.get(window.label()) != Some(&token) {
        return Err("The editor page changed during shutdown recovery.".into());
    }
    app.state::<AppState>()
        .editor_windows
        .shutdown
        .acknowledge(&request_id, window.label(), &token, saved)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn each_window_and_page_must_acknowledge_its_own_request() {
        let state = RecoveryState::default();
        let mut main = state.register("quit", "main", "main-page").unwrap();
        let mut extra = state.register("quit", "window-2", "extra-page").unwrap();
        assert!(state.acknowledge("quit", "window-3", "main-page", true).is_err());
        assert!(state.acknowledge("quit", "main", "old-page", true).is_err());
        state.acknowledge("quit", "main", "main-page", true).unwrap();
        assert!(matches!(main.try_recv(), Ok(true)));
        assert!(matches!(extra.try_recv(), Err(oneshot::error::TryRecvError::Empty)));
        state.acknowledge("quit", "window-2", "extra-page", false).unwrap();
        assert!(matches!(extra.try_recv(), Ok(false)));
        assert!(state.acknowledge("quit", "main", "main-page", true).is_err());
    }

    #[test]
    fn page_replacement_cancels_only_its_waiter() {
        let state = RecoveryState::default();
        let mut main = state.register("quit", "main", "page").unwrap();
        let mut extra = state.register("quit", "window-2", "extra").unwrap();
        state.cancel_window("main");
        assert!(matches!(main.try_recv(), Err(oneshot::error::TryRecvError::Closed)));
        assert!(matches!(extra.try_recv(), Err(oneshot::error::TryRecvError::Empty)));
    }

    #[test]
    fn late_replies_cannot_complete_a_replacement_shutdown() {
        let state = RecoveryState::default();
        let mut old = state.register("old", "main", "page").unwrap();
        state.cancel_request("old");
        let mut current = state.register("new", "main", "page").unwrap();
        assert!(state.acknowledge("old", "main", "page", true).is_err());
        assert!(matches!(old.try_recv(), Err(oneshot::error::TryRecvError::Closed)));
        assert!(matches!(current.try_recv(), Err(oneshot::error::TryRecvError::Empty)));
        state.acknowledge("new", "main", "page", true).unwrap();
        assert!(matches!(current.try_recv(), Ok(true)));
    }

    fn runtime() -> tokio::runtime::Runtime {
        tokio::runtime::Builder::new_current_thread()
            .enable_time()
            .build()
            .unwrap()
    }

    #[test]
    fn a_negative_reply_aborts_without_waiting_for_an_unresponsive_window() {
        runtime().block_on(async {
            let (_held, first) = oneshot::channel();
            let (reply, second) = oneshot::channel();
            reply.send(false).unwrap();
            let result = tokio::time::timeout(
                Duration::from_secs(1),
                await_replies(
                    vec![("main".into(), first), ("window-2".into(), second)],
                    Duration::from_secs(5),
                ),
            )
            .await
            .expect("negative reply must finish promptly");
            assert!(result.is_err());
        });
    }

    #[test]
    fn missing_replies_time_out_and_success_requires_all_windows() {
        runtime().block_on(async {
            let (_held, receiver) = oneshot::channel();
            assert!(await_replies(vec![("main".into(), receiver)], Duration::from_millis(5))
                .await
                .is_err());
            let (a, main) = oneshot::channel();
            let (b, extra) = oneshot::channel();
            b.send(true).unwrap();
            a.send(true).unwrap();
            assert!(await_replies(
                vec![("main".into(), main), ("window-2".into(), extra)],
                Duration::from_secs(1),
            )
            .await
            .is_ok());
        });
    }
}
