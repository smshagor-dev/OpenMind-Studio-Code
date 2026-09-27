//! What a task runs, exactly: variables expanded, the folder checked, the command line built for the shell, the
//! risks named and a fingerprint (the user's "don't ask again" is remembered per fingerprint, so a changed task asks
//! again). Nothing here starts a process.

use std::collections::BTreeMap;

use openmind_core::vars::{self, VarContext};
use serde::Serialize;
use sha2::{Digest, Sha256};

use crate::file::{TaskDef, TaskKind};
use crate::matcher::{describe, MatcherInfo};

/// The shell a shell task runs in (the user's terminal shell when it is Git Bash, otherwise PowerShell).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum TaskShell {
    PowerShell,
    GitBash,
}

/// One task, ready to run.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskStep {
    pub label: String,
    pub source: String,
    pub kind: TaskKind,
    /// What the user reads: the command line as written (variables expanded).
    pub command_line: String,
    /// `powershell` / `bash` for a shell task, or the program of a process task (resolved by the caller).
    pub program: String,
    pub args: Vec<String>,
    pub cwd: String,
    /// Variables set on top of the terminal's environment.
    pub env: BTreeMap<String, String>,
    pub is_background: bool,
    pub matchers: Vec<MatcherInfo>,
    pub problem_matchers: Vec<serde_json::Value>,
    pub risks: Vec<String>,
    pub notes: Vec<String>,
    pub fingerprint: String,
}

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum PlanError {
    #[error("{0}")]
    NotRunnable(String),
    #[error("Task \"{label}\": {reason}")]
    Variable { label: String, reason: String },
    #[error("Task \"{0}\" runs in a folder outside the open folder: {1}")]
    OutsideFolder(String, String),
    #[error("Task \"{0}\" needs an open folder.")]
    NoFolder(String),
}

fn expand(label: &str, text: &str, context: &VarContext) -> Result<String, PlanError> {
    vars::expand(text, context).map_err(|err| PlanError::Variable {
        label: label.to_string(),
        reason: err.to_string(),
    })
}

fn quote_powershell(arg: &str) -> String {
    if !arg.is_empty()
        && arg
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || "-_./:=\\,+@".contains(c))
    {
        arg.to_string()
    } else {
        format!("'{}'", arg.replace('\'', "''"))
    }
}

fn quote_bash(arg: &str) -> String {
    if !arg.is_empty()
        && arg
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || "-_./:=,+@".contains(c))
    {
        arg.to_string()
    } else {
        format!("'{}'", arg.replace('\'', "'\\''"))
    }
}

/// The start of the line a task prints before it runs (problem matchers skip it).
pub const ECHO_PREFIX: &str = "* Executing task:";

/// PowerShell's `-EncodedCommand` payload: the script as UTF-16LE in base64, so no quoting can break it. The script
/// echoes the task, runs it and exits with the program's own exit code (1 when a PowerShell command failed).
fn powershell_args(line: &str) -> Vec<String> {
    let echo = line.replace('\'', "''");
    let script = format!(
        "Write-Host ' * Executing task: {echo}'; Write-Host ''\n{line}\n$ok = $?\nif ($LASTEXITCODE) {{ exit $LASTEXITCODE }}\nif (-not $ok) {{ exit 1 }}\nexit 0\n"
    );
    let bytes: Vec<u8> = script.encode_utf16().flat_map(u16::to_le_bytes).collect();
    vec![
        "-NoLogo".into(),
        "-NoProfile".into(),
        "-EncodedCommand".into(),
        base64(&bytes),
    ]
}

fn base64(bytes: &[u8]) -> String {
    const TABLE: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for chunk in bytes.chunks(3) {
        let n = chunk
            .iter()
            .enumerate()
            .fold(0u32, |acc, (i, &b)| acc | (u32::from(b) << (16 - 8 * i)));
        for i in 0..4 {
            if i <= chunk.len() {
                out.push(char::from(TABLE[((n >> (18 - 6 * i)) & 63) as usize]));
            } else {
                out.push('=');
            }
        }
    }
    out
}

const NETWORK: &[&str] = &[
    "npm install",
    "npm i ",
    "npm ci",
    "pnpm install",
    "pnpm add",
    "yarn add",
    "pip install",
    "pip3 install",
    "curl ",
    "wget ",
    "invoke-webrequest",
    "iwr ",
    "git clone",
    "git pull",
    "git push",
    "git fetch",
    "cargo install",
    "cargo add",
    "docker pull",
    "docker push",
    "composer install",
    "composer require",
    "go get",
    "go install",
    "dotnet add",
];
const DESTRUCTIVE: &[&str] = &[
    "rm -rf",
    "rm -r ",
    "rmdir /s",
    "rd /s",
    "del /s",
    "del /q",
    "remove-item",
    "rimraf",
    "format ",
    "git clean",
    "git reset --hard",
];
const ELEVATION: &[&str] = &["sudo ", "runas ", "-verb runas", "start-process -verb"];

/// What the user should know before the task runs.
pub fn risks(
    step_line: &str,
    cwd: &str,
    folder: Option<&str>,
    env: &BTreeMap<String, String>,
) -> Vec<String> {
    let line = format!(" {} ", step_line.to_ascii_lowercase());
    let mut notes = Vec::new();
    if NETWORK.iter().any(|word| line.contains(word)) {
        notes.push("It may download from or upload to the network.".to_string());
    }
    if DESTRUCTIVE.iter().any(|word| line.contains(word)) {
        notes.push("It deletes or resets files.".to_string());
    }
    if ELEVATION.iter().any(|word| line.contains(word)) {
        notes.push("It asks for administrator rights.".to_string());
    }
    if folder.is_some_and(|f| !vars::is_inside(cwd, f)) {
        notes.push("It runs outside the open folder.".to_string());
    }
    if env.keys().any(|k| k.eq_ignore_ascii_case("PATH")) {
        notes.push("It changes PATH (for this task only).".to_string());
    }
    notes
}

fn fingerprint(step: &TaskStep) -> String {
    let text = serde_json::json!([
        step.source,
        step.label,
        step.kind,
        step.program,
        step.command_line,
        step.cwd,
        step.env
    ])
    .to_string();
    Sha256::digest(text.as_bytes())
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
}

/// Builds the step for `task`. `folder` is the open folder, `file` the file in front.
pub fn plan(task: &TaskDef, context: &VarContext, shell: TaskShell) -> Result<TaskStep, PlanError> {
    if let Some(problem) = &task.problem {
        return Err(PlanError::NotRunnable(format!(
            "Task \"{}\": {problem}",
            task.label
        )));
    }
    let folder = context
        .workspace_folder
        .clone()
        .ok_or_else(|| PlanError::NoFolder(task.label.clone()))?;
    let kind = task.kind.unwrap_or(TaskKind::Shell);
    let label = task.label.as_str();
    let command = expand(label, task.command.as_deref().unwrap_or(""), context)?;
    let args: Vec<String> = task
        .args
        .iter()
        .map(|a| expand(label, a, context))
        .collect::<Result<_, _>>()?;
    let cwd = match &task.cwd {
        Some(cwd) => vars::absolute(&expand(label, cwd, context)?, &folder),
        None => folder.clone(),
    };
    if !vars::is_inside(&cwd, &folder) {
        return Err(PlanError::OutsideFolder(task.label.clone(), cwd));
    }
    let mut env = BTreeMap::new();
    for (key, value) in &task.env {
        env.insert(key.clone(), expand(label, value, context)?);
    }
    let (program, run_args, command_line) = match (kind, shell) {
        (TaskKind::Process, _) => {
            let line = std::iter::once(command.clone())
                .chain(args.iter().map(|a| quote_powershell(a)))
                .collect::<Vec<_>>()
                .join(" ");
            (command.clone(), args.clone(), line)
        }
        (TaskKind::Shell, TaskShell::PowerShell) => {
            let line = std::iter::once(command.clone())
                .chain(args.iter().map(|a| quote_powershell(a)))
                .collect::<Vec<_>>()
                .join(" ");
            ("powershell".to_string(), powershell_args(&line), line)
        }
        (TaskKind::Shell, TaskShell::GitBash) => {
            let line = std::iter::once(command.clone())
                .chain(args.iter().map(|a| quote_bash(a)))
                .collect::<Vec<_>>()
                .join(" ");
            ("bash".to_string(), vec!["-c".into(), line.clone()], line)
        }
    };
    let mut step = TaskStep {
        label: task.label.clone(),
        source: task.source.clone(),
        kind,
        risks: risks(&command_line, &cwd, Some(&folder), &env),
        command_line,
        program,
        args: run_args,
        cwd,
        env,
        is_background: task.is_background,
        matchers: describe(&task.problem_matchers),
        problem_matchers: task.problem_matchers.clone(),
        notes: task.notes.clone(),
        fingerprint: String::new(),
    };
    if task.command.as_deref().is_none_or(|c| c.trim().is_empty()) {
        step.command_line = String::new();
        step.program = String::new();
        step.args.clear();
    }
    step.fingerprint = fingerprint(&step);
    Ok(step)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::file::parse;

    fn context() -> VarContext {
        VarContext {
            workspace_folder: Some("C:/My Work".into()),
            file: Some("C:/My Work/src/a.py".into()),
        }
    }

    fn task(json: &str) -> TaskDef {
        parse(
            "C:/My Work/.vscode/tasks.json",
            &format!(r#"{{"tasks": [{json}]}}"#),
        )
        .tasks
        .remove(0)
    }

    #[test]
    fn a_shell_task_runs_through_encoded_powershell_with_its_exit_code() {
        let t = task(
            r#"{"label": "b", "type": "shell", "command": "npm run build", "args": ["--out", "my dir"], "options": {"cwd": "${workspaceFolder}/web", "env": {"MODE": "${fileBasename}"}}}"#,
        );
        let step = plan(&t, &context(), TaskShell::PowerShell).unwrap();
        assert_eq!(step.program, "powershell");
        assert_eq!(step.command_line, "npm run build --out 'my dir'");
        assert_eq!(step.cwd, "C:/My Work/web");
        assert_eq!(step.env.get("MODE").map(String::as_str), Some("a.py"));
        assert_eq!(
            &step.args[..3],
            ["-NoLogo", "-NoProfile", "-EncodedCommand"]
        );
        assert!(step.risks.is_empty());
        assert_eq!(step.fingerprint.len(), 64);
        let bash = plan(&t, &context(), TaskShell::GitBash).unwrap();
        assert_eq!(bash.args, ["-c", "npm run build --out 'my dir'"]);
    }

    #[test]
    fn base64_matches_the_standard_alphabet() {
        assert_eq!(base64(b"Man"), "TWFu");
        assert_eq!(base64(b"Ma"), "TWE=");
        assert_eq!(base64(b"M"), "TQ==");
        assert_eq!(base64(b""), "");
    }

    #[test]
    fn process_tasks_keep_their_arguments_and_risks_are_named() {
        let t = task(
            r#"{"label": "i", "type": "process", "command": "npm", "args": ["install", "left-pad"], "options": {"env": {"PATH": "x"}}}"#,
        );
        let step = plan(&t, &context(), TaskShell::PowerShell).unwrap();
        assert_eq!(step.program, "npm");
        assert_eq!(step.args, ["install", "left-pad"]);
        assert!(step.risks.iter().any(|r| r.contains("network")));
        assert!(step.risks.iter().any(|r| r.contains("PATH")));
        let rm = plan(
            &task(r#"{"label": "c", "type": "shell", "command": "Remove-Item -Recurse dist"}"#),
            &context(),
            TaskShell::PowerShell,
        )
        .unwrap();
        assert!(rm.risks.iter().any(|r| r.contains("deletes")));
    }

    #[test]
    fn outside_folders_unsupported_variables_and_changed_tasks() {
        let outside = task(
            r#"{"label": "o", "type": "shell", "command": "dir", "options": {"cwd": "C:/Windows"}}"#,
        );
        assert!(matches!(
            plan(&outside, &context(), TaskShell::PowerShell),
            Err(PlanError::OutsideFolder(..))
        ));
        let input = task(r#"{"label": "p", "type": "shell", "command": "echo ${input:name}"}"#);
        assert!(plan(&input, &context(), TaskShell::PowerShell)
            .unwrap_err()
            .to_string()
            .contains("${input:name}"));
        let npm = task(r#"{"label": "n", "type": "npm", "script": "x"}"#);
        assert!(matches!(
            plan(&npm, &context(), TaskShell::PowerShell),
            Err(PlanError::NotRunnable(_))
        ));
        let a = plan(
            &task(r#"{"label": "x", "type": "shell", "command": "echo 1"}"#),
            &context(),
            TaskShell::PowerShell,
        )
        .unwrap();
        let b = plan(
            &task(r#"{"label": "x", "type": "shell", "command": "echo 2"}"#),
            &context(),
            TaskShell::PowerShell,
        )
        .unwrap();
        assert_ne!(a.fingerprint, b.fingerprint);
        assert!(matches!(
            plan(&a_task(), &VarContext::default(), TaskShell::PowerShell),
            Err(PlanError::NoFolder(_))
        ));
    }

    fn a_task() -> TaskDef {
        task(r#"{"label": "x", "type": "shell", "command": "echo 1"}"#)
    }
}
