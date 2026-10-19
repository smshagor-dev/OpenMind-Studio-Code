//! What the agent tells the panel while it works (sent to the window as `agent:event`), and the permission question.

use serde::{Deserialize, Serialize};

use crate::diff::FileDiff;
use crate::tools::{ChangeKind, Todo, ToolKind};

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChangedFile {
    pub path: String,
    pub rel: String,
    pub kind: ChangeKind,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum AgentEvent {
    Asset {
        name: String,
        data: String,
    },
    /// A turn started (`step` 0) or the model was asked again after tools ran.
    Compacted {
        before_tokens: usize,
        after_tokens: usize,
    },
    Continuing {
        attempt: usize,
    },
    Thinking {
        step: usize,
    },
    Reasoning {
        text: String,
    },
    Text {
        text: String,
    },
    ToolStart {
        id: String,
        name: String,
        kind: ToolKind,
        title: String,
        target: String,
    },
    ToolEnd {
        id: String,
        ok: bool,
        summary: String,
        /// A short look at what came back (command output, a search's first lines).
        preview: String,
        diff: Option<FileDiff>,
        changed: Option<ChangedFile>,
    },
    Todos {
        items: Vec<Todo>,
    },
    Usage {
        prompt_tokens: u64,
        completion_tokens: u64,
        context_tokens: u32,
    },
    /// The turn ended without applying a change, although the model tried `failed` changes that could not be applied
    /// (`failed: 0` = a plan-mode turn, where nothing may change).
    Unchanged {
        failed: usize,
    },
    /// The turn ended: `done`, `cancelled`, `rejected`, `limit`, `repeating` (the same action kept coming back) or
    /// `error`.
    TurnEnd {
        reason: String,
        message: Option<String>,
    },
}

/// What the user is asked before a change or a command.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PermissionRequest {
    pub id: String,
    pub kind: ToolKind,
    pub title: String,
    pub target: String,
    pub diff: Option<FileDiff>,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(tag = "decision", rename_all = "camelCase")]
pub enum Decision {
    /// Yes, this once.
    Allow,
    /// Yes, and don't ask again for this kind of action in this conversation.
    AllowSession,
    /// No; optionally with what to do instead.
    Deny { feedback: Option<String> },
}
