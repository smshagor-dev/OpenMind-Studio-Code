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
    /// When a tool is missing: the Runtime Manager item that provides it (`assembly`, `python` ...), so Run Code can
    /// offer to install it. `None` for tools OpenMind doesn't install (Rust).
    pub install_runtime: Option<String>,
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
            install_runtime: None,
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
    let tools = crate::commands::toolchains::injection(state).await;
    let path_prepend = path_order(
        state.broker.shims_dir(),
        tools.path_prepend,
        std::mem::take(&mut environment.path_prepend),
    );
    // Variables an installed tool needs (absolute paths inside the app folder), for this process only.
    environment.vars.extend(
        tools
            .env
            .into_iter()
            .map(|(name, path)| (name, path.display().to_string())),
    );
    state.broker.set_tool_dirs(&path_prepend);
    let mut search = path_prepend.clone();
    if let Some(path) = std::env::var_os("PATH") {
        search.extend(std::env::split_paths(&path));
    }
    let composer = crate::commands::broker::real_composer(&search, state.broker.shims_dir());
    environment.path_prepend = path_prepend;
    // Package tools pointed at the package gateway, for this process only.
    environment
        .vars
        .extend(crate::commands::network::process_env(state).await);
    environment.vars.extend(composer);
    environment
}

/// The folders put in front of a process's inherited PATH, in the order that decides which tool runs: OpenMind's own
/// launchers (`openmind-fetch`, `composer`), then bundled tools, then the portable runtimes. The inherited PATH comes
/// after all of them and is never changed.
pub(crate) fn path_order(
    shims: &Path,
    bundled: Vec<PathBuf>,
    runtimes: Vec<PathBuf>,
) -> Vec<PathBuf> {
    let mut order = vec![shims.to_path_buf()];
    order.extend(bundled);
    order.extend(runtimes);
    order
}

/// `<app>/cache/run-builds` (this computer's `cache/run-builds` in the per-computer data scope): where C, C++, Java and
/// Rust files are compiled. Never the project folder.
fn build_root(state: &AppState) -> PathBuf {
    state.paths.machine_cache_dir.join(BUILD_ROOT)
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
    let mut request = request.clone();
    if matches!(
        detect(&request.file),
        Detection::Runnable(RunnableKind::Assembly)
    ) {
        request.assembly = crate::commands::assembly::options(state);
    }
    plan(
        &request,
        &environment,
        &state.app_root,
        std::env::var_os("PATH"),
        &build_dir(state, &request.file, &folder),
    )
}

/// The Runtime Manager item that provides what `file` needs to run (none for Rust: rustup manages it).
fn installable_runtime(file: &Path) -> Option<String> {
    match detect(file) {
        Detection::Runnable(RunnableKind::Rust) => None,
        Detection::Runnable(kind) => Some(kind.runtime_id().to_string()),
        Detection::NotRunnable { .. } => None,
    }
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
                install_runtime: None,
            },
            Err(err) => {
                let missing = matches!(
                    err,
                    RunError::RuntimeMissing { .. }
                        | RunError::NoTypeScriptRunner
                        | RunError::CompilerMissing(_)
                );
                let mut availability = RunAvailability::refused(err.to_string(), false, missing);
                if missing {
                    availability.install_runtime = installable_runtime(&request.file);
                }
                availability
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
    debugger: Option<bool>,
    state: State<'_, AppState>,
) -> Result<TerminalCommand, String> {
    let mut plan = make_plan(&request, &state, BuildFolder::Terminal)
        .await
        .map_err(|err| err.to_string())?;
    if debugger == Some(true) {
        under_gdb(&mut plan, &state).await?;
    }
    let (line, display) = match &plan.build {
        Some(build) => {
            // The compiler writes into this folder, so it must exist before the line runs in the terminal.
            std::fs::create_dir_all(&build.dir).map_err(|err| err.to_string())?;
            // Assemble, link (a two-step build), then run: each only after the one before succeeded.
            let mut steps = vec![build.argv.clone()];
            let mut shown = vec![build.display.clone()];
            if let Some(link) = &build.link {
                steps.push(link.argv.clone());
                shown.push(link.display.clone());
            }
            steps.push(plan.argv.clone());
            shown.push(plan.display.clone());
            (shell_chain(&steps, shell), shown.join(" && "))
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

/// Debug in GDB (Terminal): the program's last step becomes `gdb --args <program> <arguments>` (Assembly only: other
/// languages debug through the debugger view).
async fn under_gdb(plan: &mut openmind_runner::RunPlan, state: &AppState) -> Result<(), String> {
    if plan.kind != RunnableKind::Assembly {
        return Err("Debug in GDB is available for assembly files.".into());
    }
    let environment = environment(state).await;
    let arch = crate::commands::assembly::options(state).arch;
    let system_path = std::env::var_os("PATH");
    plan.argv =
        openmind_runner::assembly::debugger_argv(plan, &environment, system_path.as_deref(), arch)
            .map_err(|err| err.to_string())?;
    plan.display = format!("gdb --args {}", plan.display);
    Ok(())
}

#[cfg(test)]
mod path_tests {
    use super::*;

    /// A file named like a program in `dir`.
    fn program(dir: &Path, name: &str) -> PathBuf {
        std::fs::create_dir_all(dir).expect("dir");
        let file = dir.join(name);
        std::fs::write(&file, "@echo off\r\n").expect("write");
        file
    }

    #[test]
    fn shims_then_bundled_then_runtimes_then_the_inherited_path() {
        let tmp = tempfile::tempdir().expect("tmp");
        let shims = tmp.path().join("shims");
        let bundled = tmp.path().join("tools").join("git");
        let runtime = tmp.path().join("runtimes").join("python");
        let system = tmp.path().join("system");
        let order = path_order(&shims, vec![bundled.clone()], vec![runtime.clone()]);
        assert_eq!(order, vec![shims.clone(), bundled.clone(), runtime.clone()]);

        // The first folder holding a program is the one a process gets, like Windows' own lookup.
        let first = |name: &str, dirs: &[PathBuf]| {
            dirs.iter()
                .map(|dir| dir.join(name))
                .find(|file| file.is_file())
        };
        let mut search = order.clone();
        search.push(system.clone());
        let system_python = program(&system, "python.exe");
        assert_eq!(first("python.exe", &search), Some(system_python));
        let portable_python = program(&runtime, "python.exe");
        assert_eq!(
            first("python.exe", &search),
            Some(portable_python),
            "the portable runtime beats the system"
        );
        let bundled_python = program(&bundled, "python.exe");
        assert_eq!(
            first("python.exe", &search),
            Some(bundled_python),
            "a bundled tool beats the runtime"
        );

        // OpenMind's composer launcher wins the lookup, but the real Composer it runs is the next one found.
        let launcher = program(&shims, "composer.cmd");
        let system_composer = program(&system, "composer.bat");
        assert_eq!(first("composer.cmd", &search), Some(launcher));
        let vars = crate::commands::broker::real_composer(&search, &shims);
        assert_eq!(
            vars.first().map(|(_, value)| value.clone()),
            Some(system_composer.display().to_string())
        );
    }
}
