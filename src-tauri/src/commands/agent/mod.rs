//! The OpenMindAI Agent (Tauri side): one conversation per editor window, working in that window's open folder, on
//! the local Nemotron engine. A turn runs on its own thread; the panel follows it through `agent:event`, answers
//! permission questions with `agent_answer` and can stop it at any time. An existing setup is preloaded at editor
//! startup; a conversation starts only after the user sends a message. The engine stops with the app.

pub mod control;
mod engine;
mod mcp;
mod turn;
use turn::run_turn;
pub mod capabilities;
pub mod history;
mod host;
pub mod models;

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, PoisonError};

use openmind_agent::{AgentHost, CommandEnv, Decision, Mode, Session};
use openmind_llm::{Catalog, ModelStore};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, State};

use crate::app_state::AppState;
use engine::EngineSlot;
use host::{Pending, WindowHost};
use models::Downloads;

struct BusyGuard(Arc<Chat>);

impl Drop for BusyGuard {
    fn drop(&mut self) {
        self.0.busy.store(false, Ordering::SeqCst);
    }
}

/// The turnEnd event wakes the frontend task queue. Never send it while the
/// previous worker is busy or still holding the one shared inference lease.
fn complete_turn(
    chat: &Arc<Chat>,
    work: impl FnOnce() -> openmind_agent::AgentEvent,
    publish: impl FnOnce(openmind_agent::AgentEvent),
) {
    let terminal = {
        let _busy = BusyGuard(Arc::clone(chat));
        work()
    };
    publish(terminal);
}

/// A window's conversation.
#[derive(Default)]
pub struct Chat {
    session: Mutex<Option<Session>>,
    mcp: mcp::Registry,
    /// The folder the conversation works in (a new folder starts a new conversation).
    root: Mutex<Option<PathBuf>>,
    cancel: Mutex<Arc<AtomicBool>>,
    active_task: Mutex<Option<String>>,
    conversation_id: Mutex<Option<String>>,
    busy: AtomicBool,
    pending: Pending,
    mode: Mutex<Mode>,
    cancelled_tasks: Mutex<std::collections::VecDeque<String>>,
}

#[derive(Clone)]
pub struct AgentRuntime {
    pub catalog: Arc<Catalog>,
    pub store: ModelStore,
    pub engine: Arc<EngineSlot>,
    pub downloads: Arc<Downloads>,
    chats: Arc<Mutex<HashMap<String, Arc<Chat>>>>,
    logs_dir: PathBuf,
    shutdown: Arc<AtomicBool>,
}

impl AgentRuntime {
    pub fn new(models_dir: PathBuf, logs_dir: PathBuf) -> Self {
        let catalog = Catalog::builtin().unwrap_or_else(|err| {
            tracing::error!(%err, "the built-in model catalog is damaged");
            Catalog::empty()
        });
        Self {
            catalog: Arc::new(catalog),
            store: ModelStore::new(models_dir),
            engine: Arc::new(EngineSlot::default()),
            downloads: Arc::new(Downloads::default()),
            chats: Arc::new(Mutex::new(HashMap::new())),
            logs_dir,
            shutdown: Arc::new(AtomicBool::new(false)),
        }
    }

    fn chat(&self, label: &str) -> Arc<Chat> {
        Arc::clone(
            self.chats
                .lock()
                .unwrap_or_else(PoisonError::into_inner)
                .entry(label.to_string())
                .or_default(),
        )
    }

    /// Stops every turn, download and the engine (the app is closing).
    pub fn stop_all(&self) {
        self.shutdown.store(true, Ordering::Relaxed);
        for chat in self
            .chats
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .values()
        {
            chat.cancel
                .lock()
                .unwrap_or_else(PoisonError::into_inner)
                .store(true, Ordering::Relaxed);
        }
        self.downloads.cancel_all();
        self.engine.stop();
    }

    /// A window closed: its conversation goes.
    pub fn forget_window(&self, label: &str) {
        if let Some(chat) = self
            .chats
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .remove(label)
        {
            chat.cancel
                .lock()
                .unwrap_or_else(PoisonError::into_inner)
                .store(true, Ordering::Relaxed);
        }
    }
}

/// Today's date as `YYYY-MM-DD` (UTC), for the system prompt.
fn today() -> String {
    let days = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() / 86_400)
        .unwrap_or(0) as i64;
    // Howard Hinnant's civil-from-days.
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1_460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = yoe + era * 400 + i64::from(month <= 2);
    format!("{year:04}-{month:02}-{day:02}")
}

fn os_name() -> &'static str {
    match std::env::consts::OS {
        "windows" => "Windows",
        "macos" => "macOS",
        "linux" => "Linux",
        other => other,
    }
}

#[derive(Debug, Deserialize)]
pub struct HistoryMessage {
    role: String,
    content: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SendRequest {
    #[serde(default)]
    attachments: Vec<capabilities::Attachment>,
    #[serde(default)]
    conversation_id: Option<String>,
    #[serde(default)]
    history: Vec<HistoryMessage>,
    #[serde(default)]
    task_id: Option<String>,
    #[serde(default)]
    workspace: Option<String>,
    #[serde(default)]
    options: openmind_agent::SessionOptions,
    text: String,
    model_id: String,
    mode: Mode,
    /// Absolute paths of files with unsaved edits in this window.
    #[serde(default)]
    unsaved: Vec<String>,
    /// The UI language's English name ("English", "Russian") for the agent's first words.
    #[serde(default)]
    ui_language: String,
}

async fn command_env(state: &AppState) -> CommandEnv {
    let environment = crate::commands::run::environment(state).await;
    let mut vars = environment.vars;
    let mut path = environment.path_prepend;
    if let Some(existing) = std::env::var_os("PATH") {
        path.extend(std::env::split_paths(&existing));
    }
    if let Ok(joined) = std::env::join_paths(path) {
        vars.push(("PATH".into(), joined.to_string_lossy().into_owned()));
    }
    CommandEnv { vars }
}

/// Sends a message. The turn runs in the background; this returns once it started.
#[tauri::command]
pub async fn agent_send(
    request: SendRequest,
    window: tauri::Window,
    app: AppHandle,
    state: State<'_, AppState>,
    agent: State<'_, AgentRuntime>,
) -> Result<(), String> {
    let text = request.text.trim().to_string();
    if text.len() > 100000
        || request.task_id.as_ref().is_some_and(|id| id.len() > 128)
        || request.attachments.len() > 6
        || request.history.len() > 80
        || request
            .history
            .iter()
            .map(|m| m.content.len())
            .sum::<usize>()
            > 8 * 1024 * 1024
        || request
            .conversation_id
            .as_ref()
            .is_some_and(|id| id.is_empty() || id.len() > 80)
    {
        return Err("The request is too large.".into());
    }
    if text.is_empty() {
        return Err("Type a message first.".into());
    }
    let label = window.label().to_string();
    let folder = super::workspace::workspace_active_folder(
        Some("agent".into()),
        window.clone(),
        state.clone(),
    )
        .await?
        .ok_or("Your default agent workspace could not be opened.")?;
    if request.workspace.as_ref().is_some_and(|expected| {
        std::path::Path::new(expected) != std::path::Path::new(&folder.path)
    }) {
        return Err(
            "The open project changed. Reopen the task's original project before resuming.".into(),
        );
    }
    let model = agent
        .catalog
        .get(&request.model_id)
        .map_err(|e| e.to_string())?
        .clone();
    let program = state
        .runtime
        .installed_dir("llamacpp")
        .await
        .map(engine::program_in)
        .ok_or("The local AI engine (llama.cpp) is not installed yet. Install it from the panel first.")?;
    let env = command_env(&state).await;
    let chat = agent.chat(&label);
    if chat.busy.swap(true, Ordering::SeqCst) {
        return Err("The agent is still working on the last message. Stop it or wait.".into());
    }
    let cancel = Arc::new(AtomicBool::new(false));
    {
        let mut current = chat.cancel.lock().unwrap_or_else(PoisonError::into_inner);
        *current = Arc::clone(&cancel);
        *chat
            .active_task
            .lock()
            .unwrap_or_else(PoisonError::into_inner) = request.task_id.clone();
    }
    if let Some(id) = &request.task_id {
        let mut stopped = chat
            .cancelled_tasks
            .lock()
            .unwrap_or_else(PoisonError::into_inner);
        if let Some(index) = stopped.iter().position(|item| item == id) {
            stopped.remove(index);
            cancel.store(true, Ordering::Relaxed);
        }
    }
    *chat.mode.lock().unwrap_or_else(PoisonError::into_inner) = request.mode;
    let agent = agent.inner().clone();
    let root = PathBuf::from(&folder.path);
    std::thread::spawn(move || {
        let host = WindowHost {
            app,
            label,
            pending: &chat.pending,
            task_id: request.task_id.as_deref(),
            options: Some(&request.options),
        };
        complete_turn(
            &chat,
            || {
                run_turn(
                    &agent, &chat, &host, &program, &model, &root, &request, &text, &env, &cancel,
                )
            },
            |terminal| host.send(&terminal),
        );
    });
    Ok(())
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Answer {
    id: String,
    #[serde(flatten)]
    decision: Decision,
}

#[tauri::command]
pub fn agent_answer(answer: Answer, window: tauri::Window, agent: State<'_, AgentRuntime>) -> bool {
    agent
        .chat(window.label())
        .pending
        .answer(&answer.id, answer.decision)
}

#[tauri::command]
pub fn agent_guard_answer(
    id: String,
    owner: String,
    editor: host::EditorState,
    window: tauri::Window,
    agent: State<'_, AgentRuntime>,
) -> bool {
    agent
        .chat(&owner)
        .pending
        .editor_state(&id, window.label(), editor)
}

/// Stops the running turn (a waiting question counts as "no").
#[tauri::command]
pub fn agent_stop(task_id: Option<String>, window: tauri::Window, agent: State<'_, AgentRuntime>) {
    let chat = agent.chat(window.label());
    let id = task_id.filter(|id| id.len() <= 128);
    if let Some(id) = &id {
        let mut stopped = chat
            .cancelled_tasks
            .lock()
            .unwrap_or_else(PoisonError::into_inner);
        if stopped.len() >= 256 {
            stopped.pop_front();
        }
        stopped.push_back(id.clone());
    }
    let current = chat.cancel.lock().unwrap_or_else(PoisonError::into_inner);
    let active = chat
        .active_task
        .lock()
        .unwrap_or_else(PoisonError::into_inner);
    if id.is_none() || id == *active {
        current.store(true, Ordering::Relaxed);
    }
}

#[tauri::command]
pub async fn agent_wait_idle(
    window: tauri::Window,
    agent: State<'_, AgentRuntime>,
) -> Result<(), String> {
    let chat = agent.chat(window.label());
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(10);
    while chat.busy.load(Ordering::SeqCst) {
        if std::time::Instant::now() >= deadline {
            return Err("The previous task is still stopping.".into());
        }
        tokio::time::sleep(std::time::Duration::from_millis(20)).await;
    }
    Ok(())
}

/// Starts a new conversation (the old one is dropped; files stay as they are).
#[tauri::command]
pub async fn agent_reset(
    window: tauri::Window,
    agent: State<'_, AgentRuntime>,
) -> Result<(), String> {
    let chat = agent.chat(window.label());
    tokio::task::spawn_blocking(move || reset_chat(chat))
        .await
        .map_err(|e| e.to_string())?
}

fn reset_chat(chat: Arc<Chat>) -> Result<(), String> {
    chat.cancel
        .lock()
        .unwrap_or_else(PoisonError::into_inner)
        .store(true, Ordering::Relaxed);
    let started = std::time::Instant::now();
    while chat
        .busy
        .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
        .is_err()
    {
        if started.elapsed() > std::time::Duration::from_secs(10) {
            return Err(
                "The agent has not stopped yet. Try New Chat again once it finishes.".into(),
            );
        }
        std::thread::sleep(std::time::Duration::from_millis(20));
    }
    let _busy = BusyGuard(Arc::clone(&chat));
    *chat.session.lock().unwrap_or_else(PoisonError::into_inner) = None;
    Ok(())
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UndoResult {
    restored: Vec<String>,
    failed: Vec<String>,
    can_undo: bool,
}

/// Puts back the files the last turn changed.
#[tauri::command]
pub async fn agent_undo(
    window: tauri::Window,
    app: AppHandle,
    agent: State<'_, AgentRuntime>,
) -> Result<UndoResult, String> {
    let chat = agent.chat(window.label());
    if chat
        .busy
        .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
        .is_err()
    {
        return Err("Stop the agent first.".into());
    }
    tokio::task::spawn_blocking(move || {
        let _busy = BusyGuard(Arc::clone(&chat));
        let host = WindowHost {
            app,
            label: window.label().to_string(),
            pending: &chat.pending,
            task_id: None,
            options: None,
        };
        let cancel = AtomicBool::new(false);
        let mut slot = chat.session.lock().unwrap_or_else(PoisonError::into_inner);
        let session = slot.as_mut().ok_or("There is nothing to undo.")?;
        if !session.can_undo() {
            return Err("There is nothing to undo.".to_string());
        }
        let (restored, failed) =
            session.undo_last_checked(&|path| host.check_change(path, &cancel));
        Ok(UndoResult {
            restored,
            failed,
            can_undo: session.can_undo(),
        })
    })
    .await
    .map_err(|err| err.to_string())?
}

/// Preloads an existing setup at editor startup. Never installs or downloads anything.
#[tauri::command]
pub async fn agent_engine_start(
    id: String,
    use_gpu: Option<bool>,
    context_tokens: Option<u32>,
    app: AppHandle,
    state: State<'_, AppState>,
    agent: State<'_, AgentRuntime>,
) -> Result<bool, String> {
    let model = agent.catalog.get(&id).map_err(|e| e.to_string())?.clone();
    let program = state
        .runtime
        .installed_dir("llamacpp")
        .await
        .map(engine::program_in)
        .ok_or("The agent runtime is not installed.")?;
    let agent = agent.inner().clone();
    tokio::task::spawn_blocking(move || {
        // Another window may already be loading or using the shared engine.
        // Do not replace it or interrupt its active turn.
        let Ok(_lease) = agent.engine.lease() else {
            return Ok(false);
        };
        if agent.shutdown.load(Ordering::Relaxed) {
            return Err("The editor is closing.".to_string());
        }
        agent.engine.ensure(
            use_gpu.unwrap_or(true),
            context_tokens.unwrap_or(0),
            0,
            &program,
            &agent.store,
            &model,
            &agent.logs_dir,
            &agent.shutdown,
            &|event| {
                let _ = app.emit("agent:engine", event);
            },
        )?;
        Ok(true)
    })
    .await
    .map_err(|err| err.to_string())?
}

/// Stops the local engine (it frees its memory; the next message starts it again).
#[tauri::command]
pub async fn agent_engine_stop(agent: State<'_, AgentRuntime>) -> Result<(), String> {
    let engine = Arc::clone(&agent.engine);
    tokio::task::spawn_blocking(move || {
        let _lease = engine.lease()?;
        engine.stop();
        Ok(())
    })
    .await
    .map_err(|err| err.to_string())?
}

#[cfg(test)]
mod completion_tests {
    use super::*;

    #[test]
    fn queued_next_turn_is_not_notified_until_busy_guard_and_lease_are_released() {
        let chat = Arc::new(Chat::default());
        let engine = Arc::new(EngineSlot::default());
        chat.busy.store(true, Ordering::SeqCst);
        complete_turn(
            &chat,
            || {
                let _lease = engine.lease().expect("first turn owns engine");
                assert!(chat.busy.load(Ordering::SeqCst));
                assert!(engine.lease().is_err());
                openmind_agent::AgentEvent::TurnEnd {
                    reason: "cancelled".into(),
                    message: None,
                }
            },
            |terminal| {
                assert!(!chat.busy.load(Ordering::SeqCst));
                assert!(engine.lease().is_ok());
                assert!(matches!(
                    terminal,
                    openmind_agent::AgentEvent::TurnEnd { reason, .. } if reason == "cancelled"
                ));
            },
        );
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn today_is_an_iso_date() {
        let date = today();
        assert_eq!(date.len(), 10);
        assert!(date.starts_with("20"));
        assert_eq!(&date[4..5], "-");
    }

    #[test]
    fn a_send_request_carries_the_mode_and_unsaved_files() {
        let request: SendRequest = serde_json::from_str(
            r#"{"text":"fix it","modelId":"nemotron-3-nano-4b-q4","mode":"acceptEdits","unsaved":["C:/a.ts"]}"#,
        )
        .expect("parse");
        assert_eq!(request.mode, Mode::AcceptEdits);
        assert_eq!(request.unsaved, vec!["C:/a.ts".to_string()]);
        let answer: Answer =
            serde_json::from_str(r#"{"id":"c1","decision":"deny","feedback":"no"}"#)
                .expect("answer");
        assert_eq!(
            answer.decision,
            Decision::Deny {
                feedback: Some("no".into())
            }
        );
    }

    #[test]
    fn closing_a_window_drops_its_conversation() {
        let dir = tempfile::tempdir().expect("tmp");
        let agent = AgentRuntime::new(dir.path().join("models"), dir.path().join("logs"));
        let chat = agent.chat("window-2");
        agent.forget_window("window-2");
        assert!(chat.cancel.lock().expect("lock").load(Ordering::Relaxed));
        assert!(!Arc::ptr_eq(&chat, &agent.chat("window-2")));
    }
}

#[cfg(test)]
mod reset_tests {
    use super::*;
    #[test]
    fn reset_waits_for_cancelled_worker_to_release_busy() {
        let chat = Arc::new(Chat::default());
        chat.busy.store(true, Ordering::SeqCst);
        let worker = Arc::clone(&chat);
        let thread = std::thread::spawn(move || {
            while !worker
                .cancel
                .lock()
                .expect("cancel")
                .load(Ordering::Relaxed)
            {
                std::thread::yield_now();
            }
            std::thread::sleep(std::time::Duration::from_millis(40));
            worker.busy.store(false, Ordering::SeqCst);
        });
        reset_chat(Arc::clone(&chat)).expect("reset");
        thread.join().expect("worker");
        assert!(!chat.busy.load(Ordering::SeqCst));
    }
}

