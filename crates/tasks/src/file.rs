//! `tasks.json` (`.vscode/tasks.json` and `.openmind/tasks.json`): the version 2.0.0 format, as far as OpenMind
//! Studio runs it. Every field that is not used is named in the task's `notes`, and a task that can't run carries
//! the reason in `problem` — nothing is silently dropped.

use std::collections::BTreeMap;

use serde::Serialize;
use serde_json::{Map, Value};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum TaskKind {
    /// A command line run by a shell.
    Shell,
    /// A program started directly with its arguments.
    Process,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum DependsOrder {
    Parallel,
    Sequence,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskGroup {
    /// `build`, `test` or another name.
    pub kind: String,
    pub is_default: bool,
}

/// One task of a `tasks.json`.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskDef {
    pub label: String,
    /// The `tasks.json` it comes from.
    pub source: String,
    /// `None` when the type isn't one OpenMind runs (`problem` says why).
    pub kind: Option<TaskKind>,
    pub type_name: String,
    pub command: Option<String>,
    pub args: Vec<String>,
    pub cwd: Option<String>,
    pub env: BTreeMap<String, String>,
    pub group: Option<TaskGroup>,
    pub depends_on: Vec<String>,
    pub depends_order: DependsOrder,
    pub is_background: bool,
    /// The `problemMatcher` entries as written (names or objects).
    pub problem_matchers: Vec<Value>,
    pub detail: Option<String>,
    pub hide: bool,
    /// Fields that are ignored or not supported.
    pub notes: Vec<String>,
    /// Why the task can't run, if it can't.
    pub problem: Option<String>,
}

/// A parsed `tasks.json`.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskFile {
    pub path: String,
    pub tasks: Vec<TaskDef>,
    /// About the file as a whole (version, `inputs`, skipped entries).
    pub notes: Vec<String>,
    /// The file can't be read at all (not JSON, no `tasks` list).
    pub error: Option<String>,
}

const TASK_FIELDS: &[&str] = &[
    "label",
    "taskName",
    "type",
    "command",
    "args",
    "options",
    "group",
    "dependsOn",
    "dependsOrder",
    "isBackground",
    "problemMatcher",
    "detail",
    "windows",
    "hide",
];
const IGNORED_FIELDS: &[(&str, &str)] = &[
    (
        "presentation",
        "presentation options are ignored (a task always gets its own terminal tab)",
    ),
    ("icon", "the task icon is ignored"),
    ("promptOnClose", "promptOnClose is ignored"),
    ("linux", "Linux-only settings are ignored on Windows"),
    ("osx", "macOS-only settings are ignored on Windows"),
];

fn text(value: &Value) -> Option<String> {
    match value {
        Value::String(s) => Some(s.clone()),
        Value::Object(map) => map.get("value").and_then(Value::as_str).map(str::to_string),
        _ => None,
    }
}

fn strings(value: Option<&Value>) -> Vec<String> {
    match value {
        Some(Value::Array(items)) => items.iter().filter_map(text).collect(),
        Some(single) => text(single).into_iter().collect(),
        None => Vec::new(),
    }
}

fn group(value: Option<&Value>) -> Option<TaskGroup> {
    match value? {
        Value::String(kind) => Some(TaskGroup {
            kind: kind.clone(),
            is_default: false,
        }),
        Value::Object(map) => Some(TaskGroup {
            kind: map.get("kind").and_then(Value::as_str)?.to_string(),
            is_default: map
                .get("isDefault")
                .and_then(Value::as_bool)
                .unwrap_or(false),
        }),
        _ => None,
    }
}

/// `options`: `cwd` and `env`; `shell` isn't used (tasks run in PowerShell or Git Bash).
fn apply_options(task: &mut TaskDef, options: &Map<String, Value>) {
    if let Some(cwd) = options.get("cwd").and_then(Value::as_str) {
        task.cwd = Some(cwd.to_string());
    }
    if let Some(Value::Object(env)) = options.get("env") {
        for (key, value) in env {
            if let Some(value) = value.as_str() {
                task.env.insert(key.clone(), value.to_string());
            }
        }
    }
    if options.contains_key("shell") {
        task.notes.push("options.shell is not supported: shell tasks run in PowerShell (or Git Bash when it is your terminal).".into());
    }
}

/// The platform part that applies on Windows (`windows`), over the general fields.
fn apply_windows(task: &mut TaskDef, windows: &Map<String, Value>) {
    if let Some(command) = windows.get("command").and_then(text) {
        task.command = Some(command);
    }
    if windows.contains_key("args") {
        task.args = strings(windows.get("args"));
    }
    if let Some(Value::Object(options)) = windows.get("options") {
        apply_options(task, options);
    }
}

fn kind_for(type_name: &str) -> Result<TaskKind, String> {
    match type_name {
        "shell" => Ok(TaskKind::Shell),
        "process" => Ok(TaskKind::Process),
        other => Err(format!(
            "Task type \"{other}\" comes from a task provider; OpenMind Studio runs \"shell\" and \"process\" tasks from tasks.json."
        )),
    }
}

fn parse_task(entry: &Map<String, Value>, source: &str) -> Option<TaskDef> {
    let label = entry
        .get("label")
        .or_else(|| entry.get("taskName"))
        .and_then(Value::as_str)?
        .to_string();
    let type_name = entry
        .get("type")
        .and_then(Value::as_str)
        .unwrap_or("process")
        .to_string();
    let depends_order = match entry.get("dependsOrder").and_then(Value::as_str) {
        Some("sequence") => DependsOrder::Sequence,
        _ => DependsOrder::Parallel,
    };
    let mut task = TaskDef {
        label,
        source: source.to_string(),
        kind: None,
        type_name: type_name.clone(),
        command: entry.get("command").and_then(text),
        args: strings(entry.get("args")),
        cwd: None,
        env: BTreeMap::new(),
        group: group(entry.get("group")),
        depends_on: strings(entry.get("dependsOn")),
        depends_order,
        is_background: entry
            .get("isBackground")
            .and_then(Value::as_bool)
            .unwrap_or(false),
        problem_matchers: match entry.get("problemMatcher") {
            Some(Value::Array(items)) => items.clone(),
            Some(single) => vec![single.clone()],
            None => Vec::new(),
        },
        detail: entry
            .get("detail")
            .and_then(Value::as_str)
            .map(str::to_string),
        hide: entry.get("hide").and_then(Value::as_bool).unwrap_or(false),
        notes: Vec::new(),
        problem: None,
    };
    if let Some(Value::Object(options)) = entry.get("options") {
        apply_options(&mut task, options);
    }
    if let Some(Value::Object(windows)) = entry.get("windows") {
        apply_windows(&mut task, windows);
    }
    note_fields(&mut task, entry);
    check_runnable(&mut task);
    Some(task)
}

fn note_fields(task: &mut TaskDef, entry: &Map<String, Value>) {
    for key in entry.keys() {
        if TASK_FIELDS.contains(&key.as_str()) {
            continue;
        }
        match IGNORED_FIELDS.iter().find(|(name, _)| name == key) {
            Some((_, note)) => task.notes.push((*note).to_string()),
            None => task.notes.push(format!(
                "the field \"{key}\" is not supported and was ignored"
            )),
        }
    }
    if task.depends_order == DependsOrder::Parallel && task.depends_on.len() > 1 {
        task.notes.push(
            "dependsOn tasks run one after another (in the order listed), not in parallel".into(),
        );
    }
}

fn check_runnable(task: &mut TaskDef) {
    match kind_for(&task.type_name) {
        Ok(kind) => task.kind = Some(kind),
        Err(reason) => task.problem = Some(reason),
    }
    let command_missing = task.command.as_deref().is_none_or(|c| c.trim().is_empty());
    if task.problem.is_none() && command_missing && task.depends_on.is_empty() {
        task.problem = Some("The task has no command.".into());
    }
}

/// Reads a `tasks.json` (JSON with comments) found at `path`.
pub fn parse(path: &str, text: &str) -> TaskFile {
    let mut file = TaskFile {
        path: path.to_string(),
        tasks: Vec::new(),
        notes: Vec::new(),
        error: None,
    };
    let root: Value = match serde_json::from_str(&openmind_core::jsonc::strip(text)) {
        Ok(value) => value,
        Err(err) => {
            file.error = Some(format!(
                "tasks.json is not valid JSON (line {}, column {}).",
                err.line(),
                err.column()
            ));
            return file;
        }
    };
    let Some(root) = root.as_object() else {
        file.error = Some("tasks.json must be a JSON object.".into());
        return file;
    };
    match root.get("version").and_then(Value::as_str) {
        Some("2.0.0") => {}
        Some(other) => file.notes.push(format!(
            "version \"{other}\": only the 2.0.0 format is supported; the file is read as 2.0.0"
        )),
        None => file
            .notes
            .push("the file has no version; it is read as 2.0.0".into()),
    }
    if root.contains_key("inputs") {
        file.notes
            .push("inputs (${input:...}) are not supported: tasks that use them can't run".into());
    }
    if root.contains_key("command") {
        file.notes
            .push("a top-level command (the old 0.1.0 format) is not supported".into());
    }
    let Some(entries) = root.get("tasks").and_then(Value::as_array) else {
        file.error = Some("tasks.json has no \"tasks\" list.".into());
        return file;
    };
    for entry in entries {
        match entry.as_object().and_then(|map| parse_task(map, path)) {
            Some(task) => file.tasks.push(task),
            None => file.notes.push("a task without a label was skipped".into()),
        }
    }
    file
}

#[cfg(test)]
mod tests {
    use super::*;

    const SAMPLE: &str = r#"{
      // the build
      "version": "2.0.0",
      "tasks": [
        {
          "label": "build",
          "type": "shell",
          "command": "npm run build",
          "args": ["--", {"value": "a b", "quoting": "strong"}],
          "options": {"cwd": "${workspaceFolder}/web", "env": {"MODE": "ci"}},
          "group": {"kind": "build", "isDefault": true},
          "problemMatcher": "$tsc",
          "presentation": {"reveal": "always"},
          "windows": {"command": "npm.cmd run build"},
          "runOptions": {"runOn": "folderOpen"},
        },
        {"label": "test", "type": "process", "command": "python", "args": ["-m", "pytest"], "group": "test", "dependsOn": ["build"]},
        {"label": "npm: lint", "type": "npm", "script": "lint"},
        {"type": "shell", "command": "echo no label"},
        {"label": "all", "dependsOn": ["build", "test"]}
      ]
    }"#;

    #[test]
    fn a_tasks_file_is_read_with_windows_overrides_and_notes() {
        let file = parse("C:/w/.vscode/tasks.json", SAMPLE);
        assert_eq!(file.error, None);
        assert_eq!(file.tasks.len(), 4);
        assert!(file.notes.iter().any(|n| n.contains("without a label")));
        let build = &file.tasks[0];
        assert_eq!(build.kind, Some(TaskKind::Shell));
        assert_eq!(build.command.as_deref(), Some("npm.cmd run build"));
        assert_eq!(build.args, ["--", "a b"]);
        assert_eq!(build.cwd.as_deref(), Some("${workspaceFolder}/web"));
        assert_eq!(build.env.get("MODE").map(String::as_str), Some("ci"));
        assert_eq!(
            build.group,
            Some(TaskGroup {
                kind: "build".into(),
                is_default: true
            })
        );
        assert_eq!(build.problem_matchers, [Value::String("$tsc".into())]);
        assert!(build.notes.iter().any(|n| n.contains("presentation")));
        assert!(build
            .notes
            .iter()
            .any(|n| n.contains("\"runOptions\" is not supported")));
        let test = &file.tasks[1];
        assert_eq!(test.kind, Some(TaskKind::Process));
        assert_eq!(test.depends_on, ["build"]);
        assert_eq!(test.group.as_ref().map(|g| g.kind.as_str()), Some("test"));
        let npm = &file.tasks[2];
        assert!(npm
            .problem
            .as_deref()
            .is_some_and(|p| p.contains("\"npm\"")));
        let all = &file.tasks[3];
        assert_eq!(all.problem, None, "a task with only dependencies can run");
        assert!(all.notes.iter().any(|n| n.contains("not in parallel")));
    }

    #[test]
    fn broken_files_say_why() {
        let bad = parse("t.json", "{ \"tasks\": [ }");
        assert!(bad.error.as_deref().is_some_and(|e| e.contains("line 1")));
        assert!(parse("t.json", "[]").error.is_some());
        assert!(parse("t.json", "{}")
            .error
            .as_deref()
            .is_some_and(|e| e.contains("no \"tasks\"")));
        let old = parse(
            "t.json",
            r#"{"version": "0.1.0", "command": "x", "tasks": [{"label": "a"}]}"#,
        );
        assert!(old.notes.iter().any(|n| n.contains("0.1.0")));
        assert_eq!(
            old.tasks[0].problem.as_deref(),
            Some("The task has no command.")
        );
    }
}
