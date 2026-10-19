//! Keeps a turn moving until the work is done. Small local models sometimes repeat the same call (read one file dozens
//! of times), keep retrying a change that can't be applied, or stop while their own task list still has open items.
//! The guard never ends a turn: a repeated look whose result is still in the conversation is answered without running,
//! a call repeated again and again (or edits to a file that keep failing) is refused with what to do instead, and a
//! model that stops early is told to finish (a few times per turn). The turn ends when the model is done, the user stops
//! it or declines an action, or the step limit is reached. Failed changes are counted, so a turn that ends without
//! applying any of them can say so instead of leaving only the model's own summary.

use std::collections::HashMap;

use serde_json::Value;

use crate::events::AgentEvent;
use crate::tools::{self, Outcome, Todo, ToolKind};
use crate::wire::{Message, ToolCall};

use super::{AgentHost, Session};

/// The same call (same tool, same arguments, nothing changed in between) is refused from this run on.
const REFUSE_FROM_REPEAT: u32 = 3;
/// Failed changes to one file (without reading it again) before further changes to it are refused.
const REFUSE_AFTER_FAILED_CHANGES: u32 = 3;
/// How often one turn reminds a model that stopped early to finish its work.
const MAX_FINISH_NUDGES: u32 = 3;

impl Session {
    /// Asks the guard about the next call before anything is prepared or asked. `true` = handled here (not run).
    pub(super) fn guarded(
        &mut self,
        call: &ToolCall,
        arguments: &str,
        host: &dyn AgentHost,
    ) -> bool {
        let kind = tools::kind_of(&call.name);
        let verdict = self.guard.check(
            &call.name,
            arguments,
            kind,
            &change_target(arguments),
            &self.messages,
        );
        let (ok, summary, answer) = match verdict {
            Verdict::Run => return false,
            Verdict::Skip(answer) => (true, "Already done in this turn; not repeated", answer),
            Verdict::Refuse(answer) => (false, "Not run: repeated without progress", answer),
        };
        let (title, target) = look_label(&call.name, arguments);
        host.emit(AgentEvent::ToolStart {
            id: call.id.clone(),
            name: call.name.clone(),
            kind,
            title,
            target,
        });
        host.emit(AgentEvent::ToolEnd {
            id: call.id.clone(),
            ok,
            summary: summary.into(),
            preview: String::new(),
            diff: None,
            changed: None,
        });
        self.messages.push(Message::Tool {
            tool_call_id: call.id.clone(),
            content: answer,
        });
        self.guard
            .record(&call.name, arguments, kind, &call.id, false);
        true
    }

    /// Tells the guard what a call did. A change that was not applied says so first, so the model can't mistake it.
    pub(super) fn after_call(
        &mut self,
        call: &ToolCall,
        arguments: &str,
        kind: ToolKind,
        outcome: &mut Outcome,
    ) {
        match kind {
            ToolKind::Edit | ToolKind::Delete if outcome.change.is_some() => self.guard.changed(),
            ToolKind::Edit | ToolKind::Delete if !outcome.ok => {
                self.guard.change_failed(&change_target(arguments));
                outcome.for_model = format!(
                    "Not applied: the file was not changed. {}",
                    outcome.for_model
                );
            }
            ToolKind::Command => self.guard.command_ran(),
            _ => {}
        }
        if let Some(items) = &outcome.todos {
            self.guard.todos = items.clone();
        }
        self.guard
            .record(&call.name, arguments, kind, &call.id, true);
    }

    /// The model answered without a tool call. When its work looks unfinished, tells it to go on (returns `true`).
    pub(super) fn keep_going(&mut self, answer: &str) -> bool {
        match self.guard.finish_nudge(answer, self.policy.read_only()) {
            Some(nudge) => {
                self.messages.push(Message::User { content: nudge });
                true
            }
            None => false,
        }
    }
}

/// What the session does with the next call.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum Verdict {
    /// Run it.
    Run,
    /// Don't run it: its result is already in the conversation. Answered with this text (not a failure).
    Skip(String),
    /// Don't run it: repeating it can't help. Answered with this text, which says what to do instead.
    Refuse(String),
}

#[derive(Debug, Default)]
struct Seen {
    count: u32,
    /// The id of the last run of this exact call: its result may still be in the conversation.
    call_id: String,
    kind: Option<ToolKind>,
}

#[derive(Debug, Default)]
pub(crate) struct TurnGuard {
    seen: HashMap<String, Seen>,
    failed_by_target: HashMap<String, u32>,
    failed_changes: usize,
    /// The model's task list as of its last update in this turn.
    todos: Vec<Todo>,
    nudges: u32,
}

/// A call's identity: the tool and its arguments with object keys sorted (the model may reorder them).
pub(crate) fn signature(name: &str, arguments: &str) -> String {
    fn canonical(value: &Value) -> Value {
        match value {
            Value::Object(map) => {
                let mut keys: Vec<&String> = map.keys().collect();
                keys.sort();
                let mut sorted = serde_json::Map::new();
                for key in keys {
                    if let Some(inner) = map.get(key) {
                        sorted.insert(key.clone(), canonical(inner));
                    }
                }
                Value::Object(sorted)
            }
            Value::Array(items) => Value::Array(items.iter().map(canonical).collect()),
            other => other.clone(),
        }
    }
    match serde_json::from_str::<Value>(arguments) {
        Ok(value) => format!("{name}:{}", canonical(&value)),
        Err(_) => format!("{name}:{}", arguments.trim()),
    }
}

fn argument(arguments: &str, field: &str) -> String {
    serde_json::from_str::<Value>(arguments)
        .ok()
        .and_then(|value| value.get(field).and_then(Value::as_str).map(str::to_string))
        .unwrap_or_default()
}

/// The file a change call is about, as the model named it.
pub(crate) fn change_target(arguments: &str) -> String {
    argument(arguments, "path").trim().to_string()
}

/// What the panel shows for a call answered without running: the same verb and target as a real one.
pub(crate) fn look_label(name: &str, arguments: &str) -> (String, String) {
    let (title, field) = match name {
        "read_file" => ("Read", "path"),
        "list_dir" => ("List", "path"),
        "find_files" => ("Find", "pattern"),
        "search" => ("Search", "query"),
        "edit_file" => ("Update", "path"),
        "write_file" => ("Write", "path"),
        "delete_file" => ("Delete", "path"),
        "run_command" => ("Run", "command"),
        other => (other, "path"),
    };
    (title.to_string(), argument(arguments, field))
}

fn result_still_present(messages: &[Message], call_id: &str) -> bool {
    !call_id.is_empty()
        && messages.iter().any(|m| {
            matches!(m, Message::Tool { tool_call_id, content } if tool_call_id == call_id
                && !content.contains("[Output compacted."))
        })
}

impl TurnGuard {
    pub fn failed_changes(&self) -> usize {
        self.failed_changes
    }

    /// Decides about a call before it runs. `target` is the file a change is about ("" for anything else).
    pub fn check(
        &self,
        name: &str,
        arguments: &str,
        kind: ToolKind,
        target: &str,
        messages: &[Message],
    ) -> Verdict {
        // Asking a background command for new output again and again is how it is meant to be used.
        if kind == ToolKind::Meta || name == "command_output" {
            return Verdict::Run;
        }
        if matches!(kind, ToolKind::Edit | ToolKind::Delete) && !target.is_empty() {
            let failed = self.failed_by_target.get(target).copied().unwrap_or(0);
            if failed >= REFUSE_AFTER_FAILED_CHANGES {
                return Verdict::Refuse(format!(
                    "Not run: {failed} changes to {target} failed in this turn. Read the file again to get its exact \
                     current text before you change it, or, if it can't be changed (for example it has unsaved changes \
                     in the editor), leave it and tell the user in your final answer what is blocking you."
                ));
            }
        }
        let Some(seen) = self.seen.get(&signature(name, arguments)) else {
            return Verdict::Run;
        };
        if seen.count + 1 >= REFUSE_FROM_REPEAT {
            return Verdict::Refuse(format!(
                "Not run: you already made this exact {name} call {} times in this turn and nothing has changed since, \
                 so repeating it can't help. Do the next step of the task with a different action, or, if the task is \
                 done, give your final answer.",
                seen.count
            ));
        }
        if seen.kind == Some(ToolKind::Read) && result_still_present(messages, &seen.call_id) {
            return Verdict::Skip(format!(
                "Not run again: you already called {name} with exactly these arguments in this turn and nothing has \
                 changed since, so its result above is still current. Use that result and go on with the task."
            ));
        }
        Verdict::Run
    }

    /// Remembers that a call was run (or answered without running).
    pub fn record(
        &mut self,
        name: &str,
        arguments: &str,
        kind: ToolKind,
        call_id: &str,
        ran: bool,
    ) {
        if kind == ToolKind::Meta {
            return;
        }
        if ran && name == "read_file" {
            // Having read the file again, the model may try its change once more.
            self.failed_by_target.remove(&change_target(arguments));
        }
        let seen = self.seen.entry(signature(name, arguments)).or_default();
        seen.count += 1;
        seen.kind = Some(kind);
        if ran {
            seen.call_id = call_id.to_string();
        }
    }

    /// After a change was applied: every earlier look may now be out of date.
    pub fn changed(&mut self) {
        self.seen.clear();
        self.failed_by_target.clear();
    }

    /// After a command ran: it may have changed files, so earlier looks are no longer skipped. Repeats of the command
    /// itself still count.
    pub fn command_ran(&mut self) {
        self.seen
            .retain(|_, seen| seen.kind != Some(ToolKind::Read));
    }

    /// After a change could not be applied.
    pub fn change_failed(&mut self, target: &str) {
        self.failed_changes += 1;
        if !target.is_empty() {
            *self.failed_by_target.entry(target.to_string()).or_default() += 1;
        }
    }

    /// What to tell a model that answered without a tool call while its work looks unfinished: open items on its task
    /// list (not in plan mode, where the list is the plan), or no answer at all. `None` = the turn may end.
    pub fn finish_nudge(&mut self, answer: &str, plan_mode: bool) -> Option<String> {
        if self.nudges >= MAX_FINISH_NUDGES {
            return None;
        }
        let open: Vec<&str> = self
            .todos
            .iter()
            .filter(|todo| todo.status != "completed")
            .map(|todo| todo.content.as_str())
            .collect();
        let nudge = if !plan_mode && !open.is_empty() {
            format!(
                "Your task list still has unfinished items: {}. Keep working until each one is done, and update the \
                 list as you go. If one can't be done, say why in your final answer.",
                open.join("; ")
            )
        } else if answer.trim().is_empty() {
            "You stopped without answering. If the task isn't finished, continue it now; when it is, reply with a \
             short summary of what you did."
                .to_string()
        } else {
            return None;
        };
        self.nudges += 1;
        Some(nudge)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tool_result(id: &str, content: &str) -> Message {
        Message::Tool {
            tool_call_id: id.into(),
            content: content.into(),
        }
    }

    fn todo(content: &str, status: &str) -> Todo {
        Todo {
            content: content.into(),
            status: status.into(),
        }
    }

    #[test]
    fn signatures_ignore_key_order_and_spacing() {
        assert_eq!(
            signature("read_file", r#"{"path":"a.js","offset":1}"#),
            signature("read_file", r#"{ "offset": 1, "path": "a.js" }"#)
        );
        assert_ne!(
            signature("read_file", r#"{"path":"a.js"}"#),
            signature("read_file", r#"{"path":"b.js"}"#)
        );
    }

    #[test]
    fn a_repeated_read_is_answered_then_refused_but_never_ends_anything() {
        let mut guard = TurnGuard::default();
        let args = r#"{"path":"test.js"}"#;
        assert_eq!(
            guard.check("read_file", args, ToolKind::Read, "", &[]),
            Verdict::Run
        );
        guard.record("read_file", args, ToolKind::Read, "c1", true);
        let messages = vec![tool_result("c1", "1\tconst x = 1;")];
        assert!(matches!(
            guard.check("read_file", args, ToolKind::Read, "", &messages),
            Verdict::Skip(_)
        ));
        // Once compaction removed (or shortened) the earlier result, reading again is legitimate.
        assert_eq!(
            guard.check("read_file", args, ToolKind::Read, "", &[]),
            Verdict::Run
        );
        let compacted = vec![tool_result(
            "c1",
            "1\tconst\n[Output compacted. Read the file …]",
        )];
        assert_eq!(
            guard.check("read_file", args, ToolKind::Read, "", &compacted),
            Verdict::Run
        );
        guard.record("read_file", args, ToolKind::Read, "c2", false);
        assert!(matches!(
            guard.check("read_file", args, ToolKind::Read, "", &messages),
            Verdict::Refuse(_)
        ));
    }

    #[test]
    fn the_same_command_again_and_again_is_refused_until_something_changes() {
        let mut guard = TurnGuard::default();
        let args = r#"{"command":"node test.js"}"#;
        for n in 0..2 {
            assert_eq!(
                guard.check("run_command", args, ToolKind::Command, "", &[]),
                Verdict::Run,
                "run {n}"
            );
            guard.record(
                "run_command",
                args,
                ToolKind::Command,
                &format!("c{n}"),
                true,
            );
            guard.command_ran();
        }
        assert!(matches!(
            guard.check("run_command", args, ToolKind::Command, "", &[]),
            Verdict::Refuse(_)
        ));
        guard.changed();
        assert_eq!(
            guard.check("run_command", args, ToolKind::Command, "", &[]),
            Verdict::Run
        );
    }

    #[test]
    fn a_command_makes_earlier_reads_current_again() {
        let mut guard = TurnGuard::default();
        let args = r#"{"path":"out.txt"}"#;
        guard.record("read_file", args, ToolKind::Read, "c1", true);
        guard.command_ran();
        let messages = vec![tool_result("c1", "old")];
        assert_eq!(
            guard.check("read_file", args, ToolKind::Read, "", &messages),
            Verdict::Run
        );
    }

    #[test]
    fn edits_that_keep_failing_are_refused_until_the_file_is_read_again() {
        let mut guard = TurnGuard::default();
        for n in 0..3 {
            let args = format!(r#"{{"path":"stats.js","old_string":"v{n}"}}"#);
            assert_eq!(
                guard.check("edit_file", &args, ToolKind::Edit, "stats.js", &[]),
                Verdict::Run
            );
            guard.record("edit_file", &args, ToolKind::Edit, "e", true);
            guard.change_failed("stats.js");
        }
        assert_eq!(guard.failed_changes(), 3);
        let next = r#"{"path":"stats.js","old_string":"new"}"#;
        assert!(matches!(
            guard.check("edit_file", next, ToolKind::Edit, "stats.js", &[]),
            Verdict::Refuse(_)
        ));
        assert_eq!(
            guard.check(
                "edit_file",
                r#"{"path":"b.js"}"#,
                ToolKind::Edit,
                "b.js",
                &[]
            ),
            Verdict::Run
        );
        guard.record(
            "read_file",
            r#"{"path":"stats.js"}"#,
            ToolKind::Read,
            "r",
            true,
        );
        assert_eq!(
            guard.check("edit_file", next, ToolKind::Edit, "stats.js", &[]),
            Verdict::Run
        );
    }

    #[test]
    fn todo_updates_are_never_limited() {
        let mut guard = TurnGuard::default();
        for _ in 0..10 {
            guard.record("todo_write", "{}", ToolKind::Meta, "t", true);
        }
        assert_eq!(
            guard.check("todo_write", "{}", ToolKind::Meta, "", &[]),
            Verdict::Run
        );
    }

    #[test]
    fn an_early_stop_is_sent_back_a_few_times_then_the_turn_may_end() {
        let mut guard = TurnGuard {
            todos: vec![
                todo("Fix the bug", "completed"),
                todo("Run the tests", "pending"),
            ],
            ..TurnGuard::default()
        };
        let nudge = guard
            .finish_nudge("I fixed the bug.", false)
            .expect("open item");
        assert!(nudge.contains("Run the tests") && !nudge.contains("Fix the bug"));
        // In plan mode the list is the plan, so open items are expected.
        assert_eq!(guard.finish_nudge("Here is the plan.", true), None);
        assert!(
            guard.finish_nudge("", true).is_some(),
            "but an empty answer is not an answer"
        );
        assert!(guard.finish_nudge("Still not done.", false).is_some());
        assert_eq!(
            guard.finish_nudge("Giving up.", false),
            None,
            "at most three reminders per turn"
        );
    }

    #[test]
    fn a_finished_list_and_a_real_answer_end_the_turn() {
        let mut guard = TurnGuard {
            todos: vec![todo("Fix the bug", "completed")],
            ..TurnGuard::default()
        };
        assert_eq!(guard.finish_nudge("Fixed and tested.", false), None);
    }
}
