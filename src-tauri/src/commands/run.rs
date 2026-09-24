use std::sync::Arc;

use openmind_runner::{
    detect, plan, shell_command_line, Detection, RunEnvironment, RunError, RunInfo, RunRequest,
    RunnableKind, ShellStyle,
};
use serde::Serialize;
use tauri::{AppHandle, Emitter, State};

use crate::app_state::AppState;

const RUN_EVENT: &str = "run:event";

/// Whether the file can be run right now, and if not, exactly why — what the
/// Run button's enabled state and tooltip are built from.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RunAvailability {
    pub runnable: bool,
    pub kind: Option<RunnableKind>,
    pub language: Option<String>,
    pub reason: Option<String>,
    /// A preview exists instead (Markdown, HTML).
    pub previewable: bool,
    /// The reason is a missing interpreter (the Runtime Manager can fix it).
    pub runtime_missing: bool,
    pub runtime: Option<String>,
    pub command: Option<String>,
}

impl RunAvailability {
    fn refused(reason: String, previewable: bool, runtime_missing: bool) -> Self {
        Self {
            runnable: false,
            kind: None,
            language: None,
            reason: Some(reason),
            previewable,
            runtime_missing,
            runtime: None,
            command: None,
        }
    }
}

/// A command line ready to be typed into a terminal, plus what it will use.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalCommand {
    pub line: String,
    pub display: String,
    pub runtime: String,
    pub language: String,
}

async fn environment(state: &AppState) -> RunEnvironment {
    match state.runtime.environment().await {
        Ok(environment) => RunEnvironment {
            path_prepend: environment.path_prepend,
            vars: environment.vars,
        },
        Err(err) => {
            tracing::warn!(?err, "could not read the runtime environment for a run");
            RunEnvironment::default()
        }
    }
}

async fn make_plan(
    request: &RunRequest,
    state: &AppState,
) -> Result<openmind_runner::RunPlan, RunError> {
    let environment = environment(state).await;
    plan(
        request,
        &environment,
        &state.app_root,
        std::env::var_os("PATH"),
    )
}

#[tauri::command]
pub async fn run_resolve(
    request: RunRequest,
    state: State<'_, AppState>,
) -> Result<RunAvailability, String> {
    if let Detection::NotRunnable {
        reason,
        previewable,
    } = detect(&request.file)
    {
        return Ok(RunAvailability::refused(reason, previewable, false));
    }
    Ok(match make_plan(&request, &state).await {
        Ok(plan) => RunAvailability {
            runnable: true,
            kind: Some(plan.kind),
            language: Some(plan.kind.display_name().to_string()),
            reason: None,
            previewable: false,
            runtime_missing: false,
            runtime: Some(plan.runtime_label),
            command: Some(plan.display),
        },
        Err(err) => {
            let missing = matches!(
                err,
                RunError::RuntimeMissing { .. } | RunError::NoTypeScriptRunner
            );
            RunAvailability::refused(err.to_string(), false, missing)
        }
    })
}

/// Starts the run in a managed child process; output arrives as `run:event`s.
#[tauri::command]
pub async fn run_start(
    request: RunRequest,
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<RunInfo, String> {
    let plan = make_plan(&request, &state)
        .await
        .map_err(|err| err.to_string())?;
    let sink: openmind_runner::EventSink = Arc::new(move |event| {
        if let Err(err) = app.emit(RUN_EVENT, event) {
            tracing::error!(?err, "failed to emit a run event");
        }
    });
    state
        .runner
        .start(&plan, sink)
        .map_err(|err| err.to_string())
}

#[tauri::command]
pub fn run_stop(run_id: String, state: State<'_, AppState>) -> bool {
    state.runner.stop(&run_id)
}

#[tauri::command]
pub fn run_active(state: State<'_, AppState>) -> Vec<RunInfo> {
    state.runner.active()
}

/// The command to type into a terminal, quoted for `shell` so nothing in a
/// file name can act as a command. Nothing is executed here.
#[tauri::command]
pub async fn run_terminal_command(
    request: RunRequest,
    shell: ShellStyle,
    state: State<'_, AppState>,
) -> Result<TerminalCommand, String> {
    let plan = make_plan(&request, &state)
        .await
        .map_err(|err| err.to_string())?;
    let line = shell_command_line(&plan.argv, shell).map_err(|err| err.to_string())?;
    Ok(TerminalCommand {
        line,
        display: plan.display,
        runtime: plan.runtime_label,
        language: plan.kind.display_name().to_string(),
    })
}
