//! The agent's tools: what the model is told it can do (JSON schemas), and preparing / running each call. A call is
//! *prepared* first — arguments checked, paths resolved inside the open folder, and for a change the exact new text
//! and its diff computed — so the permission prompt shows precisely what will happen; it runs only after approval.

mod change;
mod command;
mod read;

use std::path::PathBuf;
use std::sync::atomic::AtomicBool;

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::diff::FileDiff;
use crate::paths::Workspace;
use crate::textfile::TextFile;

pub use command::CommandEnv;

/// What a tool does, which decides whether it needs the user's permission.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ToolKind {
    /// Looks only (read, list, find, search).
    Read,
    /// Creates or changes a file.
    Edit,
    /// Deletes a file or folder (to the Recycle Bin).
    Delete,
    /// Runs a command in the open folder.
    Command,
    /// Updates the panel only (the task list).
    Meta,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Todo {
    pub content: String,
    /// `pending`, `in_progress` or `completed`.
    pub status: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum ChangeKind {
    Created,
    Modified,
    Deleted,
}

/// A file the agent changed, with what was there before (for Undo).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Change {
    pub path: PathBuf,
    pub rel: String,
    pub kind: ChangeKind,
    /// The bytes before the change; `None` when the file didn't exist (or was a folder, which the Recycle Bin keeps).
    pub before: Option<Vec<u8>>,
}

/// What a finished call reports.
#[derive(Debug, Clone)]
pub struct Outcome {
    pub ok: bool,
    /// The text the model reads.
    pub for_model: String,
    /// One line for the panel ("Read 42 lines", "Added 3 lines, removed 1").
    pub summary: String,
    pub diff: Option<FileDiff>,
    pub change: Option<Change>,
    pub todos: Option<Vec<Todo>>,
}

impl Outcome {
    pub fn failed(message: impl Into<String>) -> Self {
        let message = message.into();
        Self {
            ok: false,
            for_model: format!("Error: {message}"),
            summary: message,
            diff: None,
            change: None,
            todos: None,
        }
    }

    pub(crate) fn done(for_model: String, summary: String) -> Self {
        Self {
            ok: true,
            for_model,
            summary,
            diff: None,
            change: None,
            todos: None,
        }
    }
}

pub(crate) enum Op {
    /// Already done while preparing (looking tools) or refused.
    Finished(Outcome),
    Write {
        path: PathBuf,
        before: Option<TextFile>,
        before_bytes: Option<Vec<u8>>,
        text: String,
    },
    Delete {
        path: PathBuf,
        before_bytes: Option<Vec<u8>>,
    },
    Command(command::Planned),
    Todos(Vec<Todo>),
}

/// A call ready to run (or already answered).
pub struct Prepared {
    pub kind: ToolKind,
    /// The verb the panel shows ("Read", "Update", "Create", "Delete", "Run").
    pub title: String,
    /// The file or command it acts on.
    pub target: String,
    pub diff: Option<FileDiff>,
    pub(crate) op: Op,
}

impl Prepared {
    pub(crate) fn finished(kind: ToolKind, title: &str, target: String, outcome: Outcome) -> Self {
        Self {
            kind,
            title: title.into(),
            target,
            diff: None,
            op: Op::Finished(outcome),
        }
    }

    /// Whether nothing is left to run (refused or a looking tool that already ran).
    pub fn is_finished(&self) -> bool {
        matches!(self.op, Op::Finished(_))
    }
}

pub struct ToolContext<'a> {
    pub ws: &'a Workspace,
    pub env: &'a CommandEnv,
    pub cancel: &'a AtomicBool,
    /// Files with unsaved edits in the editor: the agent must not change them under the user.
    pub unsaved: &'a [PathBuf],
}

impl ToolContext<'_> {
    pub fn is_unsaved(&self, path: &std::path::Path) -> bool {
        let key = |p: &std::path::Path| {
            let text = p.to_string_lossy().replace('\\', "/");
            if cfg!(windows) {
                text.to_lowercase()
            } else {
                text
            }
        };
        let wanted = key(path);
        self.unsaved.iter().any(|p| key(p) == wanted)
    }
}

fn function(name: &str, description: &str, parameters: Value) -> Value {
    json!({"type": "function", "function": {"name": name, "description": description, "parameters": parameters}})
}

/// The tools as the model is told about them. In plan mode only the looking tools are offered.
pub fn specs(read_only: bool) -> Value {
    let mut tools = vec![
        function(
            "read_file",
            "Read a text file of the project. Lines come numbered. For a long file pass offset (first line, 1-based) and limit.",
            json!({"type": "object", "properties": {
                "path": {"type": "string", "description": "Path relative to the project folder"},
                "offset": {"type": "integer", "description": "First line to read (1-based)"},
                "limit": {"type": "integer", "description": "How many lines to read (default 600)"}
            }, "required": ["path"]}),
        ),
        function(
            "list_dir",
            "List the files and folders in a folder of the project (folders end with /).",
            json!({"type": "object", "properties": {
                "path": {"type": "string", "description": "Folder relative to the project folder; empty for the project folder"}
            }}),
        ),
        function(
            "find_files",
            "Find files by name with a glob pattern such as **/*.py or src/**/*.ts. Ignored and build folders are skipped.",
            json!({"type": "object", "properties": {
                "pattern": {"type": "string", "description": "Glob pattern relative to the project folder"}
            }, "required": ["pattern"]}),
        ),
        function(
            "search",
            "Search the text of the project's files. Returns path:line: text for each match.",
            json!({"type": "object", "properties": {
                "query": {"type": "string", "description": "Text (or a regular expression when regex is true)"},
                "regex": {"type": "boolean"},
                "include": {"type": "string", "description": "Optional glob limiting which files are searched, e.g. **/*.rs"}
            }, "required": ["query"]}),
        ),
    ];
    if !read_only {
        tools.extend([
            function(
                "edit_file",
                "Change a file by replacing exact text. old_string must appear exactly once in the file (include enough surrounding lines to make it unique) unless replace_all is true. Read the file first.",
                json!({"type": "object", "properties": {
                    "path": {"type": "string"},
                    "old_string": {"type": "string", "description": "The exact text to replace, with its indentation"},
                    "new_string": {"type": "string", "description": "The text to put instead"},
                    "replace_all": {"type": "boolean"}
                }, "required": ["path", "old_string", "new_string"]}),
            ),
            function(
                "write_file",
                "Create a new file, or replace a whole file, with the given content. Prefer edit_file for changes to an existing file.",
                json!({"type": "object", "properties": {
                    "path": {"type": "string"},
                    "content": {"type": "string"}
                }, "required": ["path", "content"]}),
            ),
            function(
                "delete_file",
                "Delete a file or folder of the project (it goes to the Recycle Bin).",
                json!({"type": "object", "properties": {"path": {"type": "string"}}, "required": ["path"]}),
            ),
            function(
                "run_command",
                "Run a command in the project folder (PowerShell on Windows) and get its output, e.g. to run tests, a build or the program. Not for interactive programs.",
                json!({"type": "object", "properties": {
                    "command": {"type": "string"},
                    "timeout_seconds": {"type": "integer", "description": "Default 120, at most 600"}
                }, "required": ["command"]}),
            ),
        ]);
    }
    tools.push(function(
        "todo_write",
        "Keep a short task list for a bigger job and update it as you go. Send the whole list each time.",
        json!({"type": "object", "properties": {"todos": {"type": "array", "items": {"type": "object", "properties": {
            "content": {"type": "string"},
            "status": {"type": "string", "enum": ["pending", "in_progress", "completed"]}
        }, "required": ["content", "status"]}}}, "required": ["todos"]}),
    ));
    Value::Array(tools)
}

pub fn kind_of(name: &str) -> ToolKind {
    match name {
        "edit_file" | "write_file" => ToolKind::Edit,
        "delete_file" => ToolKind::Delete,
        "run_command" => ToolKind::Command,
        "todo_write" => ToolKind::Meta,
        _ => ToolKind::Read,
    }
}

fn arg_str<'a>(args: &'a Value, name: &str) -> Result<&'a str, String> {
    args.get(name)
        .and_then(Value::as_str)
        .ok_or_else(|| format!("The argument \"{name}\" is missing."))
}

/// Checks a call and works out exactly what it will do.
pub fn prepare(name: &str, arguments: &str, ctx: &ToolContext<'_>, read_only: bool) -> Prepared {
    let kind = kind_of(name);
    let args: Value = match serde_json::from_str(arguments) {
        Ok(value @ Value::Object(_)) => value,
        _ => {
            return Prepared::finished(
                kind,
                name,
                String::new(),
                Outcome::failed("The arguments were not a JSON object. Send them again as JSON."),
            )
        }
    };
    if read_only && matches!(kind, ToolKind::Edit | ToolKind::Delete | ToolKind::Command) {
        return Prepared::finished(
            kind,
            name,
            String::new(),
            Outcome::failed("Plan mode is on: only look at the project and describe the plan. Nothing may be changed."),
        );
    }
    match name {
        "read_file" => read::read_file(&args, ctx),
        "list_dir" => read::list_dir(&args, ctx),
        "find_files" => read::find_files(&args, ctx),
        "search" => read::search(&args, ctx),
        "edit_file" => change::edit_file(&args, ctx),
        "write_file" => change::write_file(&args, ctx),
        "delete_file" => change::delete_file(&args, ctx),
        "run_command" => command::prepare(&args, ctx),
        "todo_write" => todos(&args),
        other => Prepared::finished(
            ToolKind::Read,
            other,
            String::new(),
            Outcome::failed(format!("There is no tool called {other}.")),
        ),
    }
}

fn todos(args: &Value) -> Prepared {
    let list: Vec<Todo> = args
        .get("todos")
        .and_then(|t| serde_json::from_value(t.clone()).ok())
        .unwrap_or_default();
    let done = list.iter().filter(|t| t.status == "completed").count();
    Prepared {
        kind: ToolKind::Meta,
        title: "Update Todos".into(),
        target: format!("{done}/{} done", list.len()),
        diff: None,
        op: Op::Todos(list),
    }
}

/// Runs a prepared call (after the user allowed it, when it needed that).
pub fn execute(prepared: Prepared, ctx: &ToolContext<'_>) -> Outcome {
    match prepared.op {
        Op::Finished(outcome) => outcome,
        Op::Write {
            path,
            before,
            before_bytes,
            text,
        } => change::apply_write(ctx, path, before, before_bytes, &text, prepared.diff),
        Op::Delete { path, before_bytes } => change::apply_delete(ctx, path, before_bytes),
        Op::Command(planned) => command::run(&planned, ctx),
        Op::Todos(list) => {
            let mut outcome = Outcome::done(
                "The task list is updated.".into(),
                format!("{} tasks", list.len()),
            );
            outcome.todos = Some(list);
            outcome
        }
    }
}

#[cfg(test)]
mod tests;
