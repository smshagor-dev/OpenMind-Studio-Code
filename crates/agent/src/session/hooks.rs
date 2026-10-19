//! The after-edit check, a small form of Claude Code's hooks: a command the user set in the agent settings (a linter, a
//! type check, the tests) runs when the model finishes a turn that changed files. When it fails, its output goes back to
//! the model, which keeps working until it passes (at most `MAX_RUNS` checks a turn). The command is the user's own
//! setting, never something the project decides, and it is asked about like any command (the same "don't ask again").

use serde_json::json;

use crate::events::{AgentEvent, PermissionRequest};
use crate::tools::{self, Change, ToolContext, ToolKind};
use crate::wire::Message;
use crate::Decision;

use super::{AgentHost, Session};

/// Checks one turn runs at most.
const MAX_RUNS: u32 = 3;

impl Session {
    /// Runs the after-edit check when files changed since the last one. `true` = it failed and the model was told to
    /// fix it (the turn goes on).
    pub(super) fn after_edit_check(
        &mut self,
        changes: &[Change],
        host: &dyn AgentHost,
        ctx: &ToolContext<'_>,
    ) -> bool {
        let command = self.options.after_edit_command.trim().to_string();
        if command.is_empty()
            || self.policy.read_only()
            || changes.len() <= self.guard.hook_seen
            || self.guard.hook_runs >= MAX_RUNS
        {
            return false;
        }
        self.guard.hook_seen = changes.len();
        self.guard.hook_runs += 1;
        let id = format!("hook_{}", self.guard.hook_runs);
        host.emit(AgentEvent::ToolStart {
            id: id.clone(),
            name: "after_edit_check".into(),
            kind: ToolKind::Command,
            title: "Hook".into(),
            target: command.clone(),
        });
        if self.policy.must_ask(ToolKind::Command, &command) {
            let decision = host.ask(
                PermissionRequest {
                    id: id.clone(),
                    kind: ToolKind::Command,
                    title: "Hook".into(),
                    target: command.clone(),
                    diff: None,
                },
                ctx.cancel,
            );
            if matches!(decision, Decision::Deny { .. }) {
                // Declined: no more checks this turn, and the turn may end.
                self.guard.hook_runs = MAX_RUNS;
                host.emit(AgentEvent::ToolEnd {
                    id,
                    ok: false,
                    summary: "Declined".into(),
                    preview: String::new(),
                    diff: None,
                    changed: None,
                });
                return false;
            }
            self.policy.remember(ToolKind::Command, &command, &decision);
        }
        let prepared = tools::prepare(
            "run_command",
            &json!({ "command": command }).to_string(),
            ctx,
            false,
        );
        let outcome = tools::execute(prepared, ctx);
        host.emit(AgentEvent::ToolEnd {
            id,
            ok: outcome.ok,
            summary: outcome.summary.clone(),
            preview: outcome.for_model.chars().take(1_200).collect(),
            diff: None,
            changed: None,
        });
        if outcome.ok || self.guard.hook_runs >= MAX_RUNS {
            return false;
        }
        self.messages.push(Message::User {
            content: format!(
                "The after-edit check `{command}` failed after your changes. Fix what it reports, then finish.\n{}",
                outcome.for_model
            ),
        });
        true
    }
}
