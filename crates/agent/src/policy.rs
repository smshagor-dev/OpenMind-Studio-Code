//! When the agent must ask. Looking never asks. By default every change, deletion and command asks; "Accept edits"
//! lets file edits through (deletions and commands still ask); plan mode allows no change at all. "Yes, don't ask
//! again" lasts for the conversation: for edits, for deletions, or for that exact command.

use std::collections::HashSet;

use serde::{Deserialize, Serialize};

use crate::events::Decision;
use crate::tools::ToolKind;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Mode {
    /// Ask before every change and command.
    #[default]
    Ask,
    /// Apply file edits without asking.
    AcceptEdits,
    /// Look and plan only; nothing is changed.
    Plan,
}

#[derive(Debug, Clone, Default)]
pub struct Policy {
    pub mode: Mode,
    edits: bool,
    deletes: bool,
    commands: HashSet<String>,
}

impl Policy {
    pub fn new(mode: Mode) -> Self {
        Self {
            mode,
            ..Self::default()
        }
    }

    pub fn read_only(&self) -> bool {
        self.mode == Mode::Plan
    }

    pub fn must_ask(&self, kind: ToolKind, target: &str) -> bool {
        match kind {
            ToolKind::Read | ToolKind::Meta => false,
            ToolKind::Edit => !(self.edits || self.mode == Mode::AcceptEdits),
            ToolKind::Delete => !self.deletes,
            ToolKind::Command => !self.commands.contains(target.trim()),
        }
    }

    /// Remembers a "don't ask again" answer.
    pub fn remember(&mut self, kind: ToolKind, target: &str, decision: &Decision) {
        if *decision != Decision::AllowSession {
            return;
        }
        match kind {
            ToolKind::Edit => self.edits = true,
            ToolKind::Delete => self.deletes = true,
            ToolKind::Command => {
                self.commands.insert(target.trim().to_string());
            }
            ToolKind::Read | ToolKind::Meta => {}
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn by_default_every_change_asks_and_looking_never_does() {
        let policy = Policy::new(Mode::Ask);
        assert!(!policy.must_ask(ToolKind::Read, "a"));
        assert!(!policy.must_ask(ToolKind::Meta, ""));
        assert!(policy.must_ask(ToolKind::Edit, "a"));
        assert!(policy.must_ask(ToolKind::Delete, "a"));
        assert!(policy.must_ask(ToolKind::Command, "npm test"));
    }

    #[test]
    fn accept_edits_still_asks_for_deletes_and_commands() {
        let policy = Policy::new(Mode::AcceptEdits);
        assert!(!policy.must_ask(ToolKind::Edit, "a"));
        assert!(policy.must_ask(ToolKind::Delete, "a"));
        assert!(policy.must_ask(ToolKind::Command, "npm test"));
    }

    #[test]
    fn dont_ask_again_covers_only_what_was_allowed() {
        let mut policy = Policy::new(Mode::Ask);
        policy.remember(ToolKind::Command, "npm test", &Decision::AllowSession);
        assert!(!policy.must_ask(ToolKind::Command, " npm test "));
        assert!(policy.must_ask(ToolKind::Command, "npm test && rm -rf x"));
        assert!(policy.must_ask(ToolKind::Edit, "a"));
        policy.remember(ToolKind::Edit, "a", &Decision::Allow);
        assert!(policy.must_ask(ToolKind::Edit, "a"));
        policy.remember(ToolKind::Edit, "a", &Decision::AllowSession);
        assert!(!policy.must_ask(ToolKind::Edit, "b"));
        assert!(policy.must_ask(ToolKind::Delete, "b"));
    }
}
