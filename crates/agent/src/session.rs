//! One conversation with the agent and its loop: send the conversation, stream the answer to the panel, run the tool
//! calls it asked for (asking the user first where the policy says so), send the results back, and repeat until the
//! model answers without a tool call, the user stops it or declines an action, or the step limit is reached.

use std::sync::atomic::{AtomicBool, Ordering};

use serde_json::Value;

use crate::client::ModelClient;
use crate::events::{AgentEvent, ChangedFile, Decision, PermissionRequest};
use crate::paths::Workspace;
use crate::policy::{Mode, Policy};
use crate::tools::{self, Change, ChangeKind, CommandEnv, ToolContext};
use crate::wire::{request_body, Delta, Message, StreamState};

/// Model calls in one turn before the agent stops and asks the user to continue.
const MAX_STEPS: usize = 40;
const MAX_ANSWER_TOKENS: u32 = 8_192;
const PREVIEW_CHARS: usize = 1_200;

/// The panel: shows events and answers permission questions.
pub trait AgentHost: Send + Sync {
    fn emit(&self, event: AgentEvent);
    /// Blocks until the user answers (or `cancel` is set, which counts as a refusal).
    fn ask(&self, request: PermissionRequest, cancel: &AtomicBool) -> Decision;
    /// A live editor-state check, after approval and immediately before filesystem mutation.
    fn check_change(&self, _path: &std::path::Path, _cancel: &AtomicBool) -> Result<(), String> {
        Ok(())
    }
}

pub struct TurnInput<'a> {
    pub ws: &'a Workspace,
    pub env: &'a CommandEnv,
    pub unsaved: &'a [std::path::PathBuf],
    pub cancel: &'a AtomicBool,
}

pub struct Session {
    pub model: String,
    pub context_tokens: u32,
    messages: Vec<Message>,
    policy: Policy,
    /// The changes of each turn that changed something, newest last (for Undo).
    turns: Vec<Vec<Change>>,
}

fn estimate_tokens(messages: &[Message]) -> usize {
    let chars: usize = messages
        .iter()
        .map(|m| match m {
            Message::System { content } | Message::User { content } => content.len(),
            Message::Assistant {
                content,
                tool_calls,
            } => {
                content.len()
                    + tool_calls
                        .iter()
                        .map(|c| c.arguments.len() + 40)
                        .sum::<usize>()
            }
            Message::Tool { content, .. } => content.len(),
        })
        .sum();
    chars / 3
}

fn preview(text: &str) -> String {
    let count = text.chars().count();
    if count <= PREVIEW_CHARS {
        text.to_string()
    } else {
        let head: String = text.chars().take(PREVIEW_CHARS).collect();
        format!("{head}\n…")
    }
}

impl Session {
    pub fn new(system: String, model: String, context_tokens: u32, mode: Mode) -> Self {
        Self {
            model,
            context_tokens,
            messages: vec![Message::System { content: system }],
            policy: Policy::new(mode),
            turns: Vec::new(),
        }
    }

    pub fn mode(&self) -> Mode {
        self.policy.mode
    }

    pub fn set_mode(&mut self, mode: Mode) {
        self.policy.mode = mode;
    }

    /// Replaces the system prompt (the mode or the project changed).
    pub fn set_system(&mut self, system: String) {
        if let Some(Message::System { content }) = self.messages.first_mut() {
            *content = system;
        }
    }

    pub fn messages(&self) -> &[Message] {
        &self.messages
    }

    pub fn can_undo(&self) -> bool {
        !self.turns.is_empty()
    }

    /// Keeps the conversation inside the context window: old tool output goes first, then the oldest exchanges.
    fn fit_context(&mut self) {
        let budget = (self.context_tokens as usize).saturating_mul(7) / 10;
        let keep_recent = 8;
        let len = self.messages.len();
        for i in 1..len.saturating_sub(keep_recent) {
            if estimate_tokens(&self.messages) <= budget {
                return;
            }
            if let Message::Tool { content, .. } = &mut self.messages[i] {
                if content.len() > 200 {
                    *content = "[older tool output removed to save space]".into();
                }
            }
        }
        while estimate_tokens(&self.messages) > budget && self.messages.len() > keep_recent + 1 {
            self.messages.remove(1);
            // A conversation may not start with a tool result or a reply to one.
            while matches!(
                self.messages.get(1),
                Some(Message::Tool { .. } | Message::Assistant { .. })
            ) {
                self.messages.remove(1);
            }
        }
    }

    fn stream_step(
        &mut self,
        client: &dyn ModelClient,
        host: &dyn AgentHost,
        cancel: &AtomicBool,
        tools: &Value,
    ) -> Result<StreamState, String> {
        let body = request_body(&self.model, &self.messages, tools, MAX_ANSWER_TOKENS);
        let mut state = StreamState::default();
        let mut failure = None;
        let result = client.stream(&body, cancel, &mut |line| {
            for delta in state.feed(line) {
                match delta {
                    Delta::Text(text) => host.emit(AgentEvent::Text { text }),
                    Delta::Reasoning(text) => host.emit(AgentEvent::Reasoning { text }),
                    Delta::Usage(usage) => host.emit(AgentEvent::Usage {
                        prompt_tokens: usage.prompt_tokens,
                        completion_tokens: usage.completion_tokens,
                        context_tokens: self.context_tokens,
                    }),
                    Delta::Error(message) => failure = Some(message),
                    Delta::Done => return false,
                    Delta::ToolStarted { .. } | Delta::Nothing => {}
                }
            }
            failure.is_none()
        });
        if let Some(message) = failure {
            return Err(message);
        }
        result.map(|()| state)
    }

    /// Runs one user message to the end of the agent's work.
    pub fn run_turn(
        &mut self,
        text: &str,
        client: &dyn ModelClient,
        host: &dyn AgentHost,
        input: &TurnInput<'_>,
    ) {
        self.messages.push(Message::User {
            content: text.to_string(),
        });
        let mut changes: Vec<Change> = Vec::new();
        let (reason, message) = self.turn_loop(client, host, input, &mut changes);
        if !changes.is_empty() {
            self.turns.push(changes);
        }
        host.emit(AgentEvent::TurnEnd { reason, message });
    }

    fn turn_loop(
        &mut self,
        client: &dyn ModelClient,
        host: &dyn AgentHost,
        input: &TurnInput<'_>,
        changes: &mut Vec<Change>,
    ) -> (String, Option<String>) {
        let ctx = ToolContext {
            ws: input.ws,
            env: input.env,
            cancel: input.cancel,
            unsaved: input.unsaved,
        };
        for step in 0..MAX_STEPS {
            host.emit(AgentEvent::Thinking { step });
            self.fit_context();
            let tools = tools::specs(self.policy.read_only());
            let state = match self.stream_step(client, host, input.cancel, &tools) {
                Ok(state) => state,
                Err(_) if input.cancel.load(Ordering::Relaxed) => {
                    return ("cancelled".into(), None)
                }
                Err(message) => return ("error".into(), Some(message)),
            };
            let calls = state.tool_calls(step);
            self.messages.push(Message::Assistant {
                content: state.text.clone(),
                tool_calls: calls.clone(),
            });
            if input.cancel.load(Ordering::Relaxed) {
                return ("cancelled".into(), None);
            }
            if calls.is_empty() {
                let cut = state.finish_reason.as_deref() == Some("length");
                return (
                    "done".into(),
                    cut.then(|| "The answer reached the length limit and was cut.".to_string()),
                );
            }
            if let Some(end) = self.run_calls(&calls, host, &ctx, changes) {
                return end;
            }
        }
        (
            "limit".into(),
            Some(format!(
                "The agent stopped after {MAX_STEPS} steps. Send a message to let it continue."
            )),
        )
    }

    /// Runs the calls of one answer. Returns how the turn ends when it must end here.
    fn run_calls(
        &mut self,
        calls: &[crate::wire::ToolCall],
        host: &dyn AgentHost,
        ctx: &ToolContext<'_>,
        changes: &mut Vec<Change>,
    ) -> Option<(String, Option<String>)> {
        let mut ending: Option<(String, Option<String>)> = None;
        for call in calls {
            if ending.is_some() {
                self.messages.push(Message::Tool {
                    tool_call_id: call.id.clone(),
                    content: "Skipped: the user declined an earlier action.".into(),
                });
                continue;
            }
            let prepared =
                tools::prepare(&call.name, &call.arguments, ctx, self.policy.read_only());
            host.emit(AgentEvent::ToolStart {
                id: call.id.clone(),
                name: call.name.clone(),
                kind: prepared.kind,
                title: prepared.title.clone(),
                target: prepared.target.clone(),
            });
            let (kind, target) = (prepared.kind, prepared.target.clone());
            if !prepared.is_finished() && self.policy.must_ask(kind, &target) {
                let decision = host.ask(
                    PermissionRequest {
                        id: call.id.clone(),
                        kind,
                        title: prepared.title.clone(),
                        target: target.clone(),
                        diff: prepared.diff.clone(),
                    },
                    ctx.cancel,
                );
                if ctx.cancel.load(Ordering::Relaxed) {
                    self.declined(host, &call.id, None);
                    ending = Some(("cancelled".into(), None));
                    continue;
                }
                if let Decision::Deny { feedback } = &decision {
                    self.declined(host, &call.id, feedback.as_deref());
                    ending = Some(("rejected".into(), None));
                    continue;
                }
                self.policy.remember(kind, &target, &decision);
            }
            let checked = prepared
                .change_path()
                .map_or(Ok(()), |path| host.check_change(path, ctx.cancel));
            let outcome = match checked {
                Ok(()) => tools::execute(prepared, ctx),
                Err(e) => tools::Outcome::failed(e),
            };
            if let Some(items) = outcome.todos.clone() {
                host.emit(AgentEvent::Todos { items });
            }
            let changed = outcome.change.as_ref().map(|c| ChangedFile {
                path: c.path.to_string_lossy().into_owned(),
                rel: c.rel.clone(),
                kind: c.kind,
            });
            host.emit(AgentEvent::ToolEnd {
                id: call.id.clone(),
                ok: outcome.ok,
                summary: outcome.summary.clone(),
                preview: if matches!(kind, tools::ToolKind::Command | tools::ToolKind::Read) {
                    preview(&outcome.for_model)
                } else {
                    String::new()
                },
                diff: outcome.diff.clone(),
                changed,
            });
            if let Some(change) = outcome.change {
                changes.push(change);
            }
            self.messages.push(Message::Tool {
                tool_call_id: call.id.clone(),
                content: outcome.for_model,
            });
        }
        ending
    }

    fn declined(&mut self, host: &dyn AgentHost, id: &str, feedback: Option<&str>) {
        let mut content =
            "The user declined this action. Don't retry it; wait for the user's instructions."
                .to_string();
        if let Some(feedback) = feedback.filter(|f| !f.trim().is_empty()) {
            content = format!("The user declined this action and said: {feedback}");
        }
        host.emit(AgentEvent::ToolEnd {
            id: id.into(),
            ok: false,
            summary: "Declined".into(),
            preview: String::new(),
            diff: None,
            changed: None,
        });
        self.messages.push(Message::Tool {
            tool_call_id: id.into(),
            content,
        });
    }

    /// Puts back what the last turn that changed files changed. Returns the files restored and those that couldn't be.
    pub fn undo_last(&mut self) -> (Vec<String>, Vec<String>) {
        self.undo_last_checked(&|_| Ok(()))
    }

    pub fn undo_last_checked(
        &mut self,
        check: &dyn Fn(&std::path::Path) -> Result<(), String>,
    ) -> (Vec<String>, Vec<String>) {
        let Some(changes) = self.turns.pop() else {
            return (Vec::new(), Vec::new());
        };
        let mut restored = Vec::new();
        let mut failed = Vec::new();
        let mut retained = Vec::new();
        let mut blocked = std::collections::HashSet::new();
        for change in changes.iter().rev() {
            let result = (|| {
                if blocked.contains(&change.path) {
                    return Err(std::io::Error::other(
                        "a later change to this file could not be undone",
                    ));
                }
                let ws = Workspace::new(&change.root).map_err(std::io::Error::other)?;
                let target = ws
                    .resolve_for_change(&change.path.to_string_lossy())
                    .map_err(std::io::Error::other)?;
                if target != change.path {
                    return Err(std::io::Error::other("the path now resolves elsewhere"));
                }
                check(&change.path).map_err(std::io::Error::other)?;
                if let Ok(meta) = std::fs::metadata(&change.path) {
                    if change
                        .after
                        .as_ref()
                        .is_none_or(|bytes| meta.len() != bytes.len() as u64)
                    {
                        return Err(std::io::Error::other(
                            "the file has later changes; Undo refused",
                        ));
                    }
                }
                let current = match std::fs::read(&change.path) {
                    Ok(bytes) => Some(bytes),
                    Err(e) if e.kind() == std::io::ErrorKind::NotFound => None,
                    Err(e) => return Err(e),
                };
                if current != change.after {
                    return Err(std::io::Error::other(
                        "the file has later changes; Undo refused",
                    ));
                }
                match (change.kind, &change.before) {
                    (ChangeKind::Created, _) => std::fs::remove_file(&change.path),
                    (_, Some(bytes)) => crate::textfile::write_bytes(&change.path, bytes)
                        .map_err(std::io::Error::other),
                    (_, None) => Err(std::io::Error::other("restore it from the Recycle Bin")),
                }
            })();
            match result {
                Ok(()) => restored.push(change.rel.clone()),
                Err(err) => {
                    blocked.insert(change.path.clone());
                    retained.push(change.clone());
                    failed.push(format!("{} ({err})", change.rel));
                }
            }
        }
        if !retained.is_empty() {
            retained.reverse();
            self.turns.push(retained);
        }
        self.messages.push(Message::User {
            content: format!(
                "[Undo restored: {}. Not restored (conflicts or unavailable backups): {}.]",
                restored.join(", "),
                failed.join(", ")
            ),
        });
        self.messages.push(Message::Assistant {
            content: "Understood.".into(),
            tool_calls: Vec::new(),
        });
        (restored, failed)
    }
}

#[cfg(test)]
mod tests;
