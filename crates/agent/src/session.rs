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
const PREVIEW_CHARS: usize = 1_200;

/// The panel: shows events and answers permission questions.
pub trait AgentHost: Send + Sync {
    fn emit(&self, event: AgentEvent);
    fn external_tools(&self) -> Vec<crate::external::ExternalTool> {
        Vec::new()
    }
    fn external_call(&self, _call: &crate::wire::ToolCall, _cancel: &AtomicBool) -> tools::Outcome {
        tools::Outcome::failed("Tool unavailable")
    }
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
    options: crate::SessionOptions,
    model_context: u32,
    memory: String,
    goal: String,
    /// The changes of each turn that changed something, newest last (for Undo).
    turns: Vec<Vec<Change>>,
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
            model_context: context_tokens,
            options: crate::SessionOptions::default().bounded(context_tokens),
            memory: String::new(),
            goal: String::new(),
            messages: vec![Message::System { content: system }],
            policy: Policy::new(mode),
            turns: Vec::new(),
        }
    }

    /// History never creates system instructions or unmatched tool calls.
    pub fn add_history(&mut self, role: &str, content: &str) {
        match role {
            "user" => self.messages.push(Message::User {
                content: content.into(),
            }),
            "assistant" => self.messages.push(Message::Assistant {
                content: content.into(),
                tool_calls: Vec::new(),
            }),
            _ => {}
        }
    }

    pub fn mode(&self) -> Mode {
        self.policy.mode
    }

    pub fn set_mode(&mut self, mode: Mode) {
        if self.policy.mode != mode {
            self.policy = Policy::new(mode);
        }
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

    pub fn set_options(&mut self, options: crate::SessionOptions) {
        self.options = options.bounded(self.model_context);
        self.context_tokens = self.options.context_tokens;
    }

    fn fit_context(&mut self, tools: &Value, host: &dyn AgentHost) -> Result<(), String> {
        let schema = tools.to_string().len().div_ceil(2);
        let budget = (self.context_tokens as usize)
            .saturating_sub(self.options.max_output_tokens as usize + schema + 512);
        let (before_tokens, after_tokens) =
            crate::context::compact(&mut self.messages, &mut self.memory, &self.goal, budget)?;
        if before_tokens > after_tokens {
            host.emit(AgentEvent::Compacted {
                before_tokens,
                after_tokens,
            });
        }
        Ok(())
    }

    fn stream_step(
        &mut self,
        client: &dyn ModelClient,
        host: &dyn AgentHost,
        cancel: &AtomicBool,
        tools: &Value,
    ) -> Result<StreamState, String> {
        let messages = crate::context::with_memory(&self.messages, &self.memory);
        let mut body = request_body(
            &self.model,
            &messages,
            tools,
            self.options.max_output_tokens,
        );
        body["temperature"] = serde_json::json!(self.options.temperature);
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
        result?;
        if state.finish_reason.is_none() && !cancel.load(Ordering::Relaxed) {
            return Err(
                "The response stream ended before completion. Continue the task to retry.".into(),
            );
        }
        Ok(state)
    }

    /// Runs one user message to the end of the agent's work.
    pub fn run_turn(
        &mut self,
        text: &str,
        client: &dyn ModelClient,
        host: &dyn AgentHost,
        input: &TurnInput<'_>,
    ) {
        self.goal = text.to_string();
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
        let mut continuations = 0;
        for step in 0..self.options.max_steps {
            if input.cancel.load(Ordering::Relaxed) {
                return ("cancelled".into(), None);
            }
            host.emit(AgentEvent::Thinking { step });
            let mut tools = tools::specs(self.policy.read_only());
            if let Some(list) = tools.as_array_mut() {
                list.extend(
                    host.external_tools()
                        .iter()
                        .filter(|tool| !self.policy.read_only() || tool.read_only)
                        .map(crate::external::ExternalTool::schema),
                );
            }
            if let Err(message) = self.fit_context(&tools, host) {
                return ("limit".into(), Some(message));
            }
            let state = match self.stream_step(client, host, input.cancel, &tools) {
                Ok(state) => state,
                Err(_) if input.cancel.load(Ordering::Relaxed) => {
                    return ("cancelled".into(), None)
                }
                Err(message) => return ("error".into(), Some(message)),
            };
            if state.finish_reason.as_deref() == Some("length") {
                self.messages.push(Message::Assistant {
                    content: state.text.clone(),
                    tool_calls: Vec::new(),
                });
                if !self.options.auto_continue || continuations >= self.options.max_continuations {
                    return (
                        "limit".into(),
                        Some("Output limit reached. Continue the task to finish.".into()),
                    );
                }
                continuations += 1;
                host.emit(AgentEvent::Continuing {
                    attempt: continuations,
                });
                self.messages.push(Message::User { content: "Continue the original task from where you stopped. Incomplete tool arguments were discarded; issue complete tool calls again if needed.".into() });
                continue;
            }
            let calls = state.tool_calls(step);
            self.messages.push(Message::Assistant {
                content: state.text.clone(),
                tool_calls: calls.clone(),
            });
            if calls.is_empty() {
                return (
                    if input.cancel.load(Ordering::Relaxed) {
                        "cancelled"
                    } else {
                        "done"
                    }
                    .into(),
                    None,
                );
            }
            if let Some(end) = self.run_calls(&calls, host, &ctx, changes) {
                return end;
            }
        }
        (
            "limit".into(),
            Some(
                "The agent reached its configured step limit. Send a message to let it continue."
                    .into(),
            ),
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
            if ctx.cancel.load(Ordering::Relaxed) {
                ending = Some(("cancelled".into(), None));
            }
            if ending.is_some() {
                self.messages.push(Message::Tool {
                    tool_call_id: call.id.clone(),
                    content: "Skipped: this turn was stopped or an earlier action was declined."
                        .into(),
                });
                continue;
            }
            if let Some(tool) = host
                .external_tools()
                .iter()
                .find(|tool| tool.name == call.name && (!self.policy.read_only() || tool.read_only))
            {
                ending = crate::external::run(
                    call,
                    tool,
                    &mut self.policy,
                    host,
                    ctx.cancel,
                    &mut self.messages,
                );
                continue;
            }
            let arguments = self.command_arguments(call);
            let prepared = tools::prepare(&call.name, &arguments, ctx, self.policy.read_only());
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

    fn command_arguments(&self, call: &crate::wire::ToolCall) -> String {
        if call.name != "run_command" {
            return call.arguments.clone();
        }
        let Ok(mut args) = serde_json::from_str::<Value>(&call.arguments) else {
            return call.arguments.clone();
        };
        if let Some(map) = args.as_object_mut() {
            let timeout = map
                .get("timeout_seconds")
                .and_then(Value::as_u64)
                .unwrap_or(self.options.command_timeout_seconds)
                .min(self.options.command_timeout_seconds);
            map.insert("timeout_seconds".into(), serde_json::json!(timeout));
        }
        args.to_string()
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
                check(&change.path).map_err(std::io::Error::other)?;
                let ws = Workspace::new(&change.root).map_err(std::io::Error::other)?;
                let target = ws
                    .resolve_for_change(&change.path.to_string_lossy())
                    .map_err(std::io::Error::other)?;
                if target != change.path {
                    return Err(std::io::Error::other("the path now resolves elsewhere"));
                }
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
