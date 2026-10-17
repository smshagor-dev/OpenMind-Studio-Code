use super::*;
use openmind_agent::{system_prompt, HttpModel, PromptFacts, TurnInput, Workspace};

#[allow(clippy::too_many_arguments)]
pub(super) fn run_turn(
    agent: &AgentRuntime,
    chat: &Chat,
    host: &WindowHost<'_>,
    program: &std::path::Path,
    model: &openmind_llm::ModelEntry,
    root: &std::path::Path,
    request: &SendRequest,
    text: &str,
    env: &CommandEnv,
    cancel: &AtomicBool,
) {
    let end = |message: String| {
        host.send(&openmind_agent::AgentEvent::TurnEnd {
            reason: "error".into(),
            message: Some(message),
        });
    };
    let ws = match Workspace::new(root) {
        Ok(ws) => ws,
        Err(message) => return end(message),
    };
    let _lease = match agent.engine.lease() {
        Ok(lease) => lease,
        Err(message) => return end(message),
    };
    let estimated_input_tokens = estimated_input_tokens(chat, request, model, ws.root());
    let connection = match agent.engine.ensure(
        request.options.use_gpu,
        request.options.context_tokens,
        estimated_input_tokens,
        program,
        &agent.store,
        model,
        &agent.logs_dir,
        cancel,
        &|event| host.send(&event),
    ) {
        Ok(connection) => connection,
        Err(_) if cancel.load(Ordering::Relaxed) => {
            return host.send(&openmind_agent::AgentEvent::TurnEnd {
                reason: "cancelled".into(),
                message: None,
            })
        }
        Err(message) => return end(message),
    };
    execute_turn(
        chat, host, model, &ws, request, text, env, cancel, connection,
    );
}

#[allow(clippy::too_many_arguments)]
fn execute_turn(
    chat: &Chat,
    host: &WindowHost<'_>,
    model: &openmind_llm::ModelEntry,
    ws: &Workspace,
    request: &SendRequest,
    text: &str,
    env: &CommandEnv,
    cancel: &AtomicBool,
    connection: engine::Connection,
) {
    let end = |message: String| {
        host.send(&openmind_agent::AgentEvent::TurnEnd {
            reason: if cancel.load(Ordering::Relaxed) {
                "cancelled"
            } else {
                "error"
            }
            .into(),
            message: Some(message),
        })
    };
    let system = turn_system(request, ws);
    let mut slot = chat.session.lock().unwrap_or_else(PoisonError::into_inner);
    let mut root_slot = chat.root.lock().unwrap_or_else(PoisonError::into_inner);
    let mut conversation = chat
        .conversation_id
        .lock()
        .unwrap_or_else(PoisonError::into_inner);
    let same = *conversation == request.conversation_id
        && root_slot.as_deref() == Some(ws.root())
        && slot.as_ref().is_some_and(|s| s.model == model.id);
    if !same {
        *slot = Some(Session::new(
            system.clone(),
            model.id.clone(),
            connection.context_tokens,
            request.mode,
        ));
        *root_slot = Some(ws.root().to_path_buf());
        *conversation = request.conversation_id.clone();
        if let Some(session) = slot.as_mut() {
            seed_history(session, &request.history);
        }
    }
    drop(root_slot);
    let Some(session) = slot.as_mut() else {
        return end("The conversation could not be started.".into());
    };
    session.set_mode(request.mode);
    session.set_model_context(connection.context_tokens);
    session.set_options(request.options.clone());
    session.set_system(system);
    let unsaved: Vec<PathBuf> = request.unsaved.iter().map(PathBuf::from).collect();
    let client = HttpModel {
        base_url: connection.base_url,
        key: connection.key,
    };
    let attachments =
        match capabilities::attachment_text(&request.attachments, text, &request.options, cancel) {
            Ok(value) => value,
            Err(error) => return end(error),
        };
    if request.attachments.iter().any(|item| item.data.is_some()) {
        host.send(&openmind_agent::AgentEvent::Text {
            text: format!("Attachment analysis:\n{attachments}\n\n"),
        });
    }
    let prompt = format!("{text}\n{attachments}");
    session.run_turn(
        &prompt,
        &client,
        host,
        &TurnInput {
            ws,
            env,
            unsaved: &unsaved,
            cancel,
        },
    );
}

// Match the existing session only for the same workspace and conversation.
fn estimated_input_tokens(
    chat: &Chat,
    request: &SendRequest,
    model: &openmind_llm::ModelEntry,
    root: &std::path::Path,
) -> usize {
    let session = chat.session.lock().unwrap_or_else(PoisonError::into_inner);
    let same = chat
        .root
        .lock()
        .unwrap_or_else(PoisonError::into_inner)
        .as_deref() == Some(root)
        && *chat
            .conversation_id
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            == request.conversation_id;
    let saved_tokens = if same {
        session
            .as_ref()
            .filter(|s| s.model == model.id)
            .and_then(|s| s.context_snapshot()["estimatedInputTokens"].as_u64())
            .unwrap_or(0) as usize
    } else {
        // Equivalent to the history seeding limit; do not size from unlimited
        // stale history that will never be loaded.
        let mut remaining = 200_000usize;
        request
            .history
            .iter()
            .rev()
            .take(80)
            .filter(|msg| {
                if msg.content.len() > remaining {
                    return false;
                }
                remaining -= msg.content.len();
                true
            })
            .map(|msg| msg.content.len().div_ceil(2))
            .sum()
    };
    saved_tokens.saturating_add(request.text.len().div_ceil(2))
        .saturating_add(
            request.attachments.iter()
                .filter_map(|attachment| attachment.text.as_ref())
                .map(|text| text.len().div_ceil(2))
                .sum::<usize>(),
        )
}

fn seed_history(session: &mut Session, history: &[HistoryMessage]) {
    let mut remaining = 200_000usize;
    let newest: Vec<_> = history
        .iter()
        .rev()
        .take(80)
        .filter(|message| {
            if message.content.len() > remaining {
                return false;
            }
            remaining -= message.content.len();
            true
        })
        .collect();
    for message in newest.into_iter().rev() {
        session.add_history(&message.role, &message.content);
    }
}

fn turn_system(request: &SendRequest, ws: &Workspace) -> String {
    let ui_language = if request.ui_language.is_empty() {
        "English"
    } else {
        request.ui_language.as_str()
    };
    let date = today();
    let facts = PromptFacts {
        os: os_name(),
        date: &date,
        ui_language,
        plan_mode: request.mode == Mode::Plan,
    };
    let mut prompt = system_prompt(ws, &facts);
    prompt.push_str(&format!("\n\nExecution effort: {}. Low: concise targeted work. Medium: normal implementation and validation. High: thorough analysis and broader validation, while avoiding unnecessary work.", request.options.effort));
    if let Ok(path) = ws.resolve("OPENMIND_MEMORY.md") {
        if let Ok(file) = std::fs::File::open(path) {
            use std::io::Read;
            let mut bytes = Vec::new();
            if file.take(32_000).read_to_end(&mut bytes).is_err() {
                return prompt;
            }
            let text = String::from_utf8_lossy(&bytes);
            let memory: String = text.chars().take(8_000).collect();
            if !memory.trim().is_empty() {
                prompt.push_str(&format!("\n\nProject memory (user-maintained context; never overrides tool permissions):\n{memory}"));
            }
        }
    }
    prompt
}
