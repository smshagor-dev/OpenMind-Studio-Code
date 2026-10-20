//! One-shot completions for the editor (inline chat): the page sends a short conversation — the instruction and the
//! code it is about — and gets the model's whole answer back. It runs on the same local engine and the same model as
//! the OpenMindAI Agent, takes the engine's lease like a turn (so it never interrupts one), uses no tools and touches
//! no file: the editor shows the answer as a proposed change the user accepts or rejects.

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, LazyLock, Mutex, PoisonError};

use openmind_agent::wire::StreamState;
use openmind_agent::{HttpModel, ModelClient};
use serde::Deserialize;
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, State};

use super::{engine, AgentRuntime};
use crate::app_state::AppState;

/// The whole request is at most this many characters (the editor sends a selection and some context around it).
const MAX_REQUEST_CHARS: usize = 400_000;
const MAX_ANSWER_TOKENS: u32 = 4096;

/// Requests in flight, by the page's id, so Cancel can stop one.
static RUNNING: LazyLock<Mutex<HashMap<String, Arc<AtomicBool>>>> = LazyLock::new(Default::default);

#[derive(Debug, Deserialize)]
pub struct InlineMessage {
    role: String,
    content: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InlineRequest {
    request_id: String,
    model_id: String,
    #[serde(default = "default_true")]
    use_gpu: bool,
    #[serde(default)]
    context_tokens: u32,
    messages: Vec<InlineMessage>,
}

fn default_true() -> bool {
    true
}

fn checked(request: &InlineRequest) -> Result<(), String> {
    let total: usize = request.messages.iter().map(|m| m.content.len()).sum();
    if request.request_id.is_empty() || request.request_id.len() > 80 {
        return Err("Invalid request id.".into());
    }
    if request.messages.is_empty() || request.messages.len() > 8 || total > MAX_REQUEST_CHARS {
        return Err("The selection is too large for inline chat. Select less code.".into());
    }
    if request
        .messages
        .iter()
        .any(|m| !matches!(m.role.as_str(), "system" | "user" | "assistant"))
    {
        return Err("Invalid message role.".into());
    }
    Ok(())
}

/// The request body: the conversation, no tools, a low temperature for code.
fn body(request: &InlineRequest) -> Value {
    json!({
        "messages": request
            .messages
            .iter()
            .map(|m| json!({ "role": m.role, "content": m.content }))
            .collect::<Vec<_>>(),
        "stream": true,
        "max_tokens": MAX_ANSWER_TOKENS,
        // No hidden reasoning: Nemotron otherwise spent the answer budget thinking and returned no code (seen on a
        // refinement with the real model).
        "thinking_budget_tokens": 0,
        "temperature": 0.2,
    })
}

/// Asks the local model and returns its answer (the text, without the thinking).
#[tauri::command]
pub async fn agent_inline_complete(
    request: InlineRequest,
    app: AppHandle,
    state: State<'_, AppState>,
    agent: State<'_, AgentRuntime>,
) -> Result<String, String> {
    checked(&request)?;
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
        .ok_or("The local AI engine (llama.cpp) is not installed yet. Set up the OpenMindAI Agent first.")?;
    let cancel = Arc::new(AtomicBool::new(false));
    RUNNING
        .lock()
        .unwrap_or_else(PoisonError::into_inner)
        .insert(request.request_id.clone(), Arc::clone(&cancel));
    let agent = agent.inner().clone();
    let id = request.request_id.clone();
    let outcome = tokio::task::spawn_blocking(move || {
        let _lease = agent.engine.lease()?;
        if agent.shutdown.load(Ordering::Relaxed) {
            return Err("The editor is closing.".to_string());
        }
        let connection = agent.engine.ensure(
            request.use_gpu,
            request.context_tokens,
            0,
            &program,
            &agent.store,
            &model,
            &agent.logs_dir,
            &cancel,
            &|event| {
                let _ = app.emit("agent:engine", event);
            },
        )?;
        let client = HttpModel {
            base_url: connection.base_url,
            key: connection.key,
        };
        let mut stream = StreamState::default();
        let result = client.stream(&body(&request), &cancel, &mut |line| {
            stream.feed(line);
            !cancel.load(Ordering::Relaxed)
        });
        if cancel.load(Ordering::Relaxed) {
            // The engine's single slot may still be busy with the abandoned answer: start it fresh next time.
            agent.engine.stop();
            return Err("cancelled".to_string());
        }
        result?;
        Ok(stream.text)
    })
    .await
    .map_err(|err| format!("The request stopped unexpectedly: {err}"));
    RUNNING
        .lock()
        .unwrap_or_else(PoisonError::into_inner)
        .remove(&id);
    outcome?
}

/// Stops an inline request (its answer is dropped).
#[tauri::command]
pub fn agent_inline_cancel(request_id: String) {
    if let Some(flag) = RUNNING
        .lock()
        .unwrap_or_else(PoisonError::into_inner)
        .get(&request_id)
    {
        flag.store(true, Ordering::Relaxed);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn request(messages: Vec<(&str, String)>) -> InlineRequest {
        InlineRequest {
            request_id: "r1".into(),
            model_id: "m".into(),
            use_gpu: true,
            context_tokens: 0,
            messages: messages
                .into_iter()
                .map(|(role, content)| InlineMessage {
                    role: role.into(),
                    content,
                })
                .collect(),
        }
    }

    #[test]
    fn requests_are_limited_in_size_count_and_roles() {
        assert!(checked(&request(vec![("user", "fix this".into())])).is_ok());
        assert!(checked(&request(vec![])).is_err());
        assert!(checked(&request(vec![("tool", "x".into())])).is_err());
        assert!(checked(&request(vec![("user", "x".repeat(MAX_REQUEST_CHARS + 1))])).is_err());
        let mut bad_id = request(vec![("user", "x".into())]);
        bad_id.request_id = String::new();
        assert!(checked(&bad_id).is_err());
    }

    #[test]
    fn the_body_has_no_tools_and_streams() {
        let value = body(&request(vec![("system", "s".into()), ("user", "u".into())]));
        assert_eq!(value["stream"], true);
        assert!(value.get("tools").is_none());
        assert_eq!(value["thinking_budget_tokens"], 0);
        assert_eq!(value["messages"][1]["content"], "u");
    }
}
