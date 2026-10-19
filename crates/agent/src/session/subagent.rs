//! Sub-agents, as Claude Code's Task tool: the main agent hands a research question ("where is X handled?", "how do the
//! tests run?") to a separate agent with its own conversation, so the long search doesn't fill the main context. The
//! sub-agent works in plan mode — it can only look (read, list, find, search), never change a file or run a command —
//! with the same model and folder, at most `MAX_STEPS` steps, and answers with a short report. The panel shows it as one
//! "Agent" line; its own steps stay out of the main transcript. A sub-agent gets no `task` tool, so they don't nest.

use std::sync::atomic::AtomicBool;

use serde_json::{json, Value};

use crate::client::ModelClient;
use crate::events::{AgentEvent, Decision, PermissionRequest};
use crate::policy::Mode;
use crate::tools::{self, ToolContext, ToolKind};
use crate::wire::{Message, ToolCall};

use super::{AgentHost, Session, TurnInput};

pub(super) const TOOL: &str = "task";
/// Model calls one sub-agent may make.
const MAX_STEPS: usize = 30;
/// Characters of the report handed back.
const MAX_REPORT: usize = 8_000;

pub(super) fn spec() -> Value {
    json!({"type": "function", "function": {
        "name": TOOL,
        "description": "Hand a research question to a sub-agent with its own conversation: it searches and reads the project (it can't change anything or run commands) and answers with a short report. Use it for broad searches (\"find every place that handles login\", \"how is the config loaded?\") so they don't fill this conversation. Give it a complete, self-contained question.",
        "parameters": {"type": "object", "properties": {
            "description": {"type": "string", "description": "A few words for the panel, e.g. \"Find login handling\""},
            "prompt": {"type": "string", "description": "The full question and what the report should contain"}
        }, "required": ["description", "prompt"]}
    }})
}

/// The sub-agent's view of the app: it shows nothing in the panel and is never asked anything (plan mode changes
/// nothing); editor guards still come from the real host.
struct QuietHost<'a> {
    parent: &'a dyn AgentHost,
}

impl AgentHost for QuietHost<'_> {
    fn emit(&self, _event: AgentEvent) {}

    fn ask(&self, _request: PermissionRequest, _cancel: &AtomicBool) -> Decision {
        Decision::Deny { feedback: None }
    }

    fn check_change(&self, path: &std::path::Path, cancel: &AtomicBool) -> Result<(), String> {
        self.parent.check_change(path, cancel)
    }
}

fn instructions(main: &str) -> String {
    format!(
        "{main}\n\nYou are a sub-agent of OpenMindAI Agent. You were given one research question by the main agent. \
         Look at the project with the reading tools only (you can't change files or run commands), then answer with a \
         short report for the main agent: the facts it asked for, with file paths and line numbers. Don't ask \
         questions back; if something can't be found, say so."
    )
}

impl Session {
    /// Runs one `task` call: a separate read-only conversation that answers with a report.
    pub(super) fn run_subagent(
        &mut self,
        call: &ToolCall,
        client: &dyn ModelClient,
        host: &dyn AgentHost,
        ctx: &ToolContext<'_>,
    ) {
        let args: Value = serde_json::from_str(&call.arguments).unwrap_or(Value::Null);
        let description = args["description"]
            .as_str()
            .unwrap_or("Research")
            .trim()
            .to_string();
        let prompt = args["prompt"].as_str().unwrap_or("").trim().to_string();
        host.emit(AgentEvent::ToolStart {
            id: call.id.clone(),
            name: call.name.clone(),
            kind: ToolKind::Read,
            title: "Agent".into(),
            target: description.clone(),
        });
        let outcome = if prompt.is_empty() {
            tools::Outcome::failed("task needs a prompt: the full question for the sub-agent.")
        } else {
            self.subagent_report(&prompt, client, host, ctx)
        };
        host.emit(AgentEvent::ToolEnd {
            id: call.id.clone(),
            ok: outcome.ok,
            summary: outcome.summary.clone(),
            preview: outcome.for_model.chars().take(1_200).collect(),
            diff: None,
            changed: None,
        });
        self.messages.push(Message::Tool {
            tool_call_id: call.id.clone(),
            content: outcome.for_model,
        });
    }

    fn subagent_report(
        &self,
        prompt: &str,
        client: &dyn ModelClient,
        host: &dyn AgentHost,
        ctx: &ToolContext<'_>,
    ) -> tools::Outcome {
        let main = match self.messages.first() {
            Some(Message::System { content }) => content.clone(),
            _ => String::new(),
        };
        let mut sub = Session::new(
            instructions(&main),
            self.model.clone(),
            self.model_context,
            Mode::Plan,
        );
        let mut options = self.options.clone();
        options.max_steps = MAX_STEPS;
        sub.set_options(options);
        sub.subagent = true;
        let input = TurnInput {
            ws: ctx.ws,
            env: ctx.env,
            unsaved: ctx.unsaved,
            cancel: ctx.cancel,
        };
        let quiet = QuietHost { parent: host };
        let end = sub.run_turn_deferred(prompt, client, &quiet, &input);
        let steps = sub
            .messages
            .iter()
            .filter(|m| matches!(m, Message::Tool { .. }))
            .count();
        let report = sub
            .messages
            .iter()
            .rev()
            .find_map(|m| match m {
                Message::Assistant { content, .. } if !content.trim().is_empty() => {
                    Some(content.trim().to_string())
                }
                _ => None,
            })
            .unwrap_or_default();
        let reason = match &end {
            AgentEvent::TurnEnd { reason, .. } => reason.clone(),
            _ => String::new(),
        };
        if reason == "cancelled" {
            return tools::Outcome::failed("Stopped.");
        }
        if report.is_empty() {
            return tools::Outcome::failed(format!(
                "The sub-agent ended ({reason}) after {steps} steps without a report."
            ));
        }
        let report: String = report.chars().take(MAX_REPORT).collect();
        tools::Outcome {
            ok: true,
            for_model: format!("Report from the sub-agent ({steps} steps):\n{report}"),
            summary: format!("Done ({steps} steps)"),
            ..tools::Outcome::default()
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_sub_agent_is_told_it_only_looks_and_reports() {
        let text = instructions("MAIN RULES");
        assert!(text.starts_with("MAIN RULES"));
        assert!(text.contains("reading tools only") && text.contains("short report"));
        assert_eq!(spec()["function"]["name"], TOOL);
    }
}
