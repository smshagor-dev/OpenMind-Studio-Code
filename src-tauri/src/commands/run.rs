use std::sync::Arc;

use std::hash::{Hash, Hasher};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, SystemTime};

use openmind_runner::{
    detect, plan, shell_chain, shell_command_line, Detection, RunEnvironment, RunError, RunInfo,
    RunRequest, RunnableKind, ShellStyle, BUILD_ROOT,
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
    /// Absolute path of the interpreter a run would start.
    pub resolved: Option<String>,
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
            resolved: None,
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
    pub resolved: String,
    pub language: String,
}

/// The environment for a process OpenMind starts: the active bundled tools (`<app>/tools`), then the portable
/// runtimes. It is only ever applied to that process; the system PATH is never changed.
pub(crate) async fn environment(state: &AppState) -> RunEnvironment {
    let mut environment = match state.runtime.environment().await {
        Ok(environment) => RunEnvironment {
            path_prepend: environment.path_prepend,
            vars: environment.vars,
        },
        Err(err) => {
            tracing::warn!(?err, "could not read the runtime environment for a run");
            RunEnvironment::default()
        }
    };
    // OpenMind's own launchers (`openmind-fetch`) first, then the bundled tools and the portable runtimes.
    let mut path_prepend = vec![state.broker.shims_dir().to_path_buf()];
    path_prepend.extend(crate::commands::toolchains::bundled_dirs(state).await);
    path_prepend.extend(std::mem::take(&mut environment.path_prepend));
    state.broker.set_tool_dirs(&path_prepend);
    environment.path_prepend = path_prepend;
    // Package tools pointed at the package gateway, for this process only.
    environment
        .vars
        .extend(crate::commands::network::process_env(state).await);
    environment
}

/// `<app>/cache/run-builds`: where C, C++, Java and Rust files are compiled. Never the project folder.
fn build_root(state: &AppState) -> PathBuf {
    state.app_root.join("cache").join(BUILD_ROOT)
}

/// Which build folder a plan gets.
enum BuildFolder {
    /// Only for checking whether the file can run: nothing is created.
    Check,
    /// A folder of its own for a Run Code run, removed when the run ends.
    Run,
    /// One folder per file for runs typed into a terminal, reused (and overwritten) by the next one.
    Terminal,
}

static BUILD_COUNTER: AtomicU64 = AtomicU64::new(0);

fn build_dir(state: &AppState, file: &Path, folder: &BuildFolder) -> PathBuf {
    let root = build_root(state);
    match folder {
        BuildFolder::Check => root.join("check"),
        BuildFolder::Run => {
            let millis = SystemTime::now()
                .duration_since(SystemTime::UNIX_EPOCH)
                .map(|elapsed| elapsed.as_millis())
                .unwrap_or_default();
            let n = BUILD_COUNTER.fetch_add(1, Ordering::SeqCst);
            root.join(format!("run-{millis}-{n}"))
        }
        BuildFolder::Terminal => {
            let stem: String = file
                .file_stem()
                .map(|stem| stem.to_string_lossy().into_owned())
                .unwrap_or_default()
                .chars()
                .filter(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_'))
                .take(40)
                .collect();
            // A folder name only (a clash would just share a folder), so the std hasher is enough.
            let mut hasher = std::collections::hash_map::DefaultHasher::new();
            file.hash(&mut hasher);
            root.join("terminal")
                .join(format!("{stem}-{:016x}", hasher.finish()))
        }
    }
}

/// Run folders left behind by a crash (a normal run removes its own): anything older than a day goes.
fn sweep_stale_builds(root: &Path) {
    let Ok(entries) = std::fs::read_dir(root) else {
        return;
    };
    let day = Duration::from_secs(24 * 60 * 60);
    for entry in entries.flatten() {
        let name = entry.file_name();
        if !name.to_string_lossy().starts_with("run-") {
            continue;
        }
        let old = entry
            .metadata()
            .and_then(|meta| meta.modified())
            .ok()
            .and_then(|modified| modified.elapsed().ok())
            .is_some_and(|age| age > day);
        if old {
            let _ = std::fs::remove_dir_all(entry.path());
        }
    }
}

async fn make_plan(
    request: &RunRequest,
    state: &AppState,
    folder: BuildFolder,
) -> Result<openmind_runner::RunPlan, RunError> {
    let environment = environment(state).await;
    plan(
        request,
        &environment,
        &state.app_root,
        std::env::var_os("PATH"),
        &build_dir(state, &request.file, &folder),
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
    Ok(
        match make_plan(&request, &state, BuildFolder::Check).await {
            Ok(plan) => RunAvailability {
                runnable: true,
                kind: Some(plan.kind),
                language: Some(plan.kind.display_name().to_string()),
                reason: None,
                previewable: false,
                runtime_missing: false,
                runtime: Some(plan.runtime_label),
                command: Some(plan.display),
                resolved: Some(plan.resolved.to_string_lossy().into_owned()),
            },
            Err(err) => {
                let missing = matches!(
                    err,
                    RunError::RuntimeMissing { .. }
                        | RunError::NoTypeScriptRunner
                        | RunError::CompilerMissing(_)
                );
                RunAvailability::refused(err.to_string(), false, missing)
            }
        },
    )
}

/// Starts the run in a managed child process; output arrives as `run:event`s.
#[tauri::command]
pub async fn run_start(
    request: RunRequest,
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<RunInfo, String> {
    sweep_stale_builds(&build_root(&state));
    let plan = make_plan(&request, &state, BuildFolder::Run)
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
    let plan = make_plan(&request, &state, BuildFolder::Terminal)
        .await
        .map_err(|err| err.to_string())?;
    let (line, display) = match &plan.build {
        Some(build) => {
            // The compiler writes into this folder, so it must exist before the line runs in the terminal.
            std::fs::create_dir_all(&build.dir).map_err(|err| err.to_string())?;
            (
                shell_chain(&[build.argv.clone(), plan.argv.clone()], shell),
                format!("{} && {}", build.display, plan.display),
            )
        }
        None => (shell_command_line(&plan.argv, shell), plan.display.clone()),
    };
    let line = line.map_err(|err| err.to_string())?;
    Ok(TerminalCommand {
        line,
        display,
        runtime: plan.runtime_label,
        resolved: plan.resolved.to_string_lossy().into_owned(),
        language: plan.kind.display_name().to_string(),
    })
}
