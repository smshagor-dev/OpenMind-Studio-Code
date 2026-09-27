//! Tasks from the open folder's `.openmind/tasks.json` and `.vscode/tasks.json` (Milestone 19). Listing only reads
//! the files; a task runs only through `task_run_step`, which the UI calls after the user confirmed it. The backend
//! plans the step itself (the UI sends only which task and which step), so a page can never make this start a
//! program of its choosing. A step runs as the program of a new integrated terminal (its exit code ends the terminal),
//! with OpenMind's runtimes in front of that terminal's PATH only.

use std::path::{Path, PathBuf};

use openmind_core::vars::VarContext;
use openmind_tasks::{
    execution_order, plan, Diagnostic, MatcherInfo, TaskDef, TaskFile, TaskShell, TaskStep,
};
use openmind_terminal::{CreateTerminalRequest, ShellKind, TerminalRegistry, TerminalSessionInfo};
use serde::Serialize;
use serde_json::Value;
use tauri::{AppHandle, State};

use crate::app_state::AppState;
use crate::windows::window_workspace;

const MAX_FILE: u64 = 1024 * 1024;
const MAX_OUTPUT: usize = 4 * 1024 * 1024;

/// A task as the picker shows it.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskInfo {
    id: String,
    label: String,
    source: String,
    type_name: String,
    command_line: Option<String>,
    cwd: Option<String>,
    group: Option<String>,
    is_default: bool,
    depends_on: Vec<String>,
    is_background: bool,
    matchers: Vec<MatcherInfo>,
    notes: Vec<String>,
    /// Why it can't run now (unsupported type, a variable it needs, a folder outside the open folder ...).
    problem: Option<String>,
    detail: Option<String>,
    hide: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskFileInfo {
    path: String,
    error: Option<String>,
    notes: Vec<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskListing {
    folder: Option<String>,
    files: Vec<TaskFileInfo>,
    tasks: Vec<TaskInfo>,
}

/// The steps a task runs, dependencies first.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskPlan {
    steps: Vec<TaskStep>,
}

fn task_id(task: &TaskDef) -> String {
    format!("{}::{}", task.source, task.label)
}

fn read_files(folder: &Path) -> Vec<TaskFile> {
    openmind_tasks::TASK_FILES
        .iter()
        .map(|relative| folder.join(relative))
        .filter(|path| path.is_file())
        .map(|path| {
            let display = path.display().to_string().replace('\\', "/");
            match std::fs::metadata(&path) {
                Ok(meta) if meta.len() > MAX_FILE => TaskFile {
                    path: display,
                    tasks: Vec::new(),
                    notes: Vec::new(),
                    error: Some("tasks.json is larger than 1 MB and was not read.".into()),
                },
                _ => match std::fs::read_to_string(&path) {
                    Ok(text) => openmind_tasks::parse(&display, &text),
                    Err(err) => TaskFile {
                        path: display,
                        tasks: Vec::new(),
                        notes: Vec::new(),
                        error: Some(format!("tasks.json could not be read: {err}")),
                    },
                },
            }
        })
        .collect()
}

async fn folder_of(state: &AppState, window: &tauri::Window) -> Result<Option<PathBuf>, String> {
    Ok(window_workspace(state, window.label())
        .await?
        .map(|w| PathBuf::from(w.path)))
}

fn context(folder: &Path, active_file: Option<String>) -> VarContext {
    VarContext {
        workspace_folder: Some(folder.display().to_string().replace('\\', "/")),
        file: active_file.filter(|f| !f.contains('\0')),
    }
}

fn info(task: &TaskDef, context: &VarContext) -> TaskInfo {
    let planned = plan(task, context, TaskShell::PowerShell);
    let (command_line, cwd, problem) = match &planned {
        Ok(step) => (
            Some(step.command_line.clone()).filter(|c| !c.is_empty()),
            Some(step.cwd.clone()),
            None,
        ),
        Err(err) => (
            task.command.clone(),
            task.cwd.clone(),
            Some(err.to_string()),
        ),
    };
    TaskInfo {
        id: task_id(task),
        label: task.label.clone(),
        source: task.source.clone(),
        type_name: task.type_name.clone(),
        command_line,
        cwd,
        group: task.group.as_ref().map(|g| g.kind.clone()),
        is_default: task.group.as_ref().is_some_and(|g| g.is_default),
        depends_on: task.depends_on.clone(),
        is_background: task.is_background,
        matchers: openmind_tasks::describe(&task.problem_matchers),
        notes: task.notes.clone(),
        problem,
        detail: task.detail.clone(),
        hide: task.hide,
    }
}

/// The open folder's tasks (nothing runs).
#[tauri::command]
pub async fn tasks_list(
    active_file: Option<String>,
    window: tauri::Window,
    state: State<'_, AppState>,
) -> Result<TaskListing, String> {
    let Some(folder) = folder_of(&state, &window).await? else {
        return Ok(TaskListing {
            folder: None,
            files: Vec::new(),
            tasks: Vec::new(),
        });
    };
    let files = read_files(&folder);
    let context = context(&folder, active_file);
    let tasks = files
        .iter()
        .flat_map(|f| f.tasks.iter())
        .map(|t| info(t, &context))
        .collect();
    Ok(TaskListing {
        folder: Some(folder.display().to_string()),
        files: files
            .iter()
            .map(|f| TaskFileInfo {
                path: f.path.clone(),
                error: f.error.clone(),
                notes: f.notes.clone(),
            })
            .collect(),
        tasks,
    })
}

fn task_shell(shell: Option<ShellKind>) -> TaskShell {
    match shell {
        Some(ShellKind::GitBash) if ShellKind::GitBash.executable().is_some() => TaskShell::GitBash,
        _ => TaskShell::PowerShell,
    }
}

fn plan_all(
    folder: &Path,
    id: &str,
    active_file: Option<String>,
    shell: TaskShell,
) -> Result<Vec<TaskStep>, String> {
    let all: Vec<TaskDef> = read_files(folder)
        .into_iter()
        .flat_map(|f| f.tasks)
        .collect();
    let start = all
        .iter()
        .position(|t| task_id(t) == id)
        .ok_or("That task no longer exists (tasks.json changed). Pick it again.")?;
    let order = execution_order(&all, start).map_err(|err| err.to_string())?;
    let context = context(folder, active_file);
    let mut steps = Vec::new();
    for (position, index) in order.iter().enumerate() {
        let task = &all[*index];
        if task.is_background && position + 1 < order.len() {
            return Err(format!(
                "\"{}\" is a background task and can't be a dependency: OpenMind can't tell when it is ready.",
                task.label
            ));
        }
        steps.push(plan(task, &context, shell).map_err(|err| err.to_string())?);
    }
    Ok(steps)
}

/// What running a task would do: every step with its command, folder, environment, risks and problem matchers.
#[tauri::command]
pub async fn tasks_plan(
    id: String,
    active_file: Option<String>,
    shell: Option<ShellKind>,
    window: tauri::Window,
    state: State<'_, AppState>,
) -> Result<TaskPlan, String> {
    let folder = folder_of(&state, &window)
        .await?
        .ok_or("Open a folder to run its tasks.")?;
    Ok(TaskPlan {
        steps: plan_all(&folder, &id, active_file, task_shell(shell))?,
    })
}

/// The program of a process task: an absolute path, or found in the runtimes' folders, then the system PATH.
fn resolve_program(program: &str, prepend: &[PathBuf], cwd: &Path) -> Result<PathBuf, String> {
    let direct = Path::new(program);
    if direct.is_absolute() {
        return direct
            .is_file()
            .then(|| direct.to_path_buf())
            .ok_or_else(|| format!("{program} doesn't exist."));
    }
    if program.contains(['/', '\\']) {
        let path = cwd.join(program);
        return path
            .is_file()
            .then_some(path)
            .ok_or_else(|| format!("{program} doesn't exist."));
    }
    let system: Vec<PathBuf> = std::env::var_os("PATH")
        .map(|p| std::env::split_paths(&p).collect())
        .unwrap_or_default();
    let names: Vec<String> = if Path::new(program).extension().is_some() {
        vec![program.to_string()]
    } else {
        ["exe", "cmd", "bat", "com"]
            .iter()
            .map(|ext| format!("{program}.{ext}"))
            .collect()
    };
    prepend
        .iter()
        .chain(system.iter())
        .flat_map(|dir| names.iter().map(move |name| dir.join(name)))
        .find(|path| path.is_file())
        .ok_or_else(|| {
            format!("{program} was not found (looked in OpenMind's runtimes and the system PATH).")
        })
}

/// Runs step `label` of task `id` in a new terminal (after the user confirmed the plan).
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn task_run_step(
    id: String,
    label: String,
    active_file: Option<String>,
    shell: Option<ShellKind>,
    cols: u16,
    rows: u16,
    window: tauri::Window,
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<TerminalSessionInfo, String> {
    let folder = folder_of(&state, &window)
        .await?
        .ok_or("Open a folder to run its tasks.")?;
    let task_shell = task_shell(shell);
    let steps = plan_all(&folder, &id, active_file, task_shell)?;
    let step = steps
        .into_iter()
        .find(|s| s.label == label)
        .ok_or("That step is not part of the task.")?;
    if step.program.is_empty() {
        return Err("This task only runs its dependencies.".into());
    }
    let runtime = crate::commands::run::environment(&state).await;
    let cwd = PathBuf::from(&step.cwd);
    let (kind, program) = match step.kind {
        openmind_tasks::TaskKind::Shell => {
            let kind = if task_shell == TaskShell::GitBash {
                ShellKind::GitBash
            } else {
                ShellKind::PowerShell
            };
            (
                kind,
                kind.executable()
                    .ok_or("The shell for tasks isn't available on this machine.")?,
            )
        }
        openmind_tasks::TaskKind::Process => (
            ShellKind::PowerShell,
            resolve_program(&step.program, &runtime.path_prepend, &cwd)?,
        ),
    };
    let mut env = openmind_terminal::default_environment();
    env.extend(runtime.vars);
    env.extend(step.env.clone());
    let owner = window.label().to_string();
    let terminal_id = TerminalRegistry::generate_id();
    state.editor_windows.track_terminal(&terminal_id, &owner);
    let request = CreateTerminalRequest {
        shell: Some(kind),
        cwd: Some(cwd),
        cols,
        rows,
        env,
        path_prepend: runtime.path_prepend,
        program: Some(program),
        args: step.args.clone(),
    };
    tracing::info!(task = %step.label, "running a task the user confirmed");
    crate::commands::terminal::start_session(&state, app, terminal_id, owner, request)
}

/// The problems a finished task's output shows, by its problem matchers.
#[tauri::command]
pub fn tasks_problems(matchers: Vec<Value>, output: String, cwd: String) -> Vec<Diagnostic> {
    // Only the end of a very long output is read (the problems of a build are at its end).
    let mut start = output.len().saturating_sub(MAX_OUTPUT);
    while !output.is_char_boundary(start) {
        start += 1;
    }
    openmind_tasks::problems(&matchers, &output[start..], &cwd)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn process_programs_are_found_by_name_with_their_extension() {
        let dir = tempfile::tempdir().expect("tempdir");
        std::fs::write(dir.path().join("tool.cmd"), "@echo off").expect("tool");
        let found =
            resolve_program("tool", &[dir.path().to_path_buf()], dir.path()).expect("found");
        assert_eq!(found, dir.path().join("tool.cmd"));
        assert!(resolve_program("definitely-not-a-program-xyz", &[], dir.path()).is_err());
        assert!(resolve_program("./missing.exe", &[], dir.path()).is_err());
    }

    #[test]
    fn plans_come_from_the_files_on_disk_in_dependency_order() {
        let dir = tempfile::tempdir().expect("tempdir");
        std::fs::create_dir(dir.path().join(".vscode")).expect("mkdir");
        std::fs::write(
            dir.path().join(".vscode/tasks.json"),
            r#"{"version": "2.0.0", "tasks": [
                {"label": "prep", "type": "shell", "command": "echo prep"},
                {"label": "build", "type": "shell", "command": "echo build", "dependsOn": "prep"},
                {"label": "watch", "type": "shell", "command": "echo w", "isBackground": true},
                {"label": "after", "type": "shell", "command": "echo a", "dependsOn": "watch"}
            ]}"#,
        )
        .expect("tasks");
        let source = format!("{}/.vscode/tasks.json", dir.path().display()).replace('\\', "/");
        let steps = plan_all(
            dir.path(),
            &format!("{source}::build"),
            None,
            TaskShell::PowerShell,
        )
        .expect("plan");
        assert_eq!(
            steps.iter().map(|s| s.label.as_str()).collect::<Vec<_>>(),
            ["prep", "build"]
        );
        let refused = plan_all(
            dir.path(),
            &format!("{source}::after"),
            None,
            TaskShell::PowerShell,
        );
        assert!(refused.unwrap_err().contains("background task"));
        assert!(plan_all(dir.path(), "nope::x", None, TaskShell::PowerShell).is_err());
    }
}
