//! Project dependencies and environments (Milestones 22.4-22.6): the Dependencies view and the missing-package card
//! use the same three steps — `deps_scan` reads the workspace's manifests, `deps_plan` turns a request into the exact
//! program, arguments, folder and target (shown to the user), and `deps_run` re-plans that same request here (the
//! frontend never sends a command) and starts the program as a terminal's own process, so its exit code is the real
//! one. Python packages go into the project's environment or OpenMind's portable Python, named by absolute path — never
//! the user's own Python, never `--user`; npm/pnpm/yarn/Composer stay project-local; nothing is global.

use std::path::{Path, PathBuf};

use openmind_deps::{DepsSnapshot, Op, Plan, PlanContext, Resolved};
use openmind_network::packages::{project_dir, NODE_MARKERS, PYTHON_MARKERS};
use openmind_runner::{RunEnvironment, RuntimeSource};
use openmind_terminal::{CreateTerminalRequest, ShellKind, TerminalRegistry, TerminalSessionInfo};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, State};

use crate::app_state::AppState;

pub(crate) const NO_OPENMIND_PYTHON: &str = openmind_deps::plan::NO_OPENMIND_PYTHON;

/// OpenMind's active portable Python interpreter, if installed.
async fn portable_python(state: &AppState) -> Option<PathBuf> {
    let exe = if cfg!(windows) {
        "python.exe"
    } else {
        "bin/python3"
    };
    state
        .runtime
        .installed_dir("python")
        .await
        .map(|dir| dir.join(exe))
        .filter(|path| path.is_file())
}

/// The Python a package for `project` goes into: the project's environment, else OpenMind's active portable Python.
pub(crate) async fn python_target(
    state: &AppState,
    project: &Path,
) -> Result<(PathBuf, &'static str), String> {
    if let Some(env) = openmind_deps::python::environments(project).first() {
        return Ok((PathBuf::from(&env.interpreter), "projectVenv"));
    }
    match portable_python(state).await {
        Some(path) => Ok((path, "openmindPython")),
        None => Err(NO_OPENMIND_PYTHON.to_string()),
    }
}

/// The folder to start from: `base` is a file (its folder) or a folder; absolute, existing, no NUL.
fn start_dir(base: &str) -> Result<PathBuf, String> {
    let path = PathBuf::from(base);
    if !path.is_absolute() || base.contains('\0') || !path.exists() {
        return Err("The file or folder of the failed program isn't available.".to_string());
    }
    Ok(if path.is_dir() {
        path
    } else {
        path.parent().map(Path::to_path_buf).unwrap_or(path)
    })
}

async fn workspace_root(
    state: &AppState,
    window: &tauri::Window,
) -> Result<Option<PathBuf>, String> {
    Ok(crate::windows::window_workspace(state, window.label())
        .await?
        .map(|workspace| PathBuf::from(workspace.path)))
}

/// The project folder for `start`, never above the window's open folder.
async fn project_of(
    state: &AppState,
    window: &tauri::Window,
    start: &Path,
    markers: &[&str],
) -> Result<PathBuf, String> {
    let stop = workspace_root(state, window)
        .await?
        .filter(|root| start.starts_with(root))
        .unwrap_or_else(|| start.to_path_buf());
    Ok(project_dir(start, &stop, markers))
}

/// pip's download cache for installs OpenMind starts: `<app>/cache/pip`, never the user's own pip cache.
pub(crate) fn pip_cache_dir(state: &AppState) -> PathBuf {
    let downloads = state.runtime.paths().downloads_dir();
    downloads
        .parent()
        .map_or(downloads.clone(), Path::to_path_buf)
        .join("pip")
}

/// Package-manager download caches for the processes OpenMind starts: inside `<app>/cache`, like pip's, instead of the
/// user's own `%LOCALAPPDATA%\npm-cache` / Composer cache. Only that one process's environment; nothing global changes.
fn cache_env(manager: &str, cache: &Path) -> Vec<(String, String)> {
    let dir = |name: &str| cache.join(name).to_string_lossy().into_owned();
    match manager {
        "npm" => vec![("npm_config_cache".into(), dir("npm"))],
        "composer" => vec![("COMPOSER_CACHE_DIR".into(), dir("composer"))],
        _ => Vec::new(),
    }
}

/// The files that mark a project for each kind of operation.
fn markers(op: &Op) -> &'static [&'static str] {
    match op {
        Op::PythonCreateEnv
        | Op::PythonInstallRequirements
        | Op::PythonInstallPyproject
        | Op::PythonAdd { .. }
        | Op::PythonRemove { .. }
        | Op::PythonUpdate { .. } => PYTHON_MARKERS,
        Op::NodeInstall
        | Op::NodeAdd { .. }
        | Op::NodeRemove { .. }
        | Op::NodeUpdate { .. }
        | Op::NodeRunScript { .. } => NODE_MARKERS,
        Op::ComposerInstall
        | Op::ComposerRequire { .. }
        | Op::ComposerRemove { .. }
        | Op::ComposerUpdate { .. }
        | Op::ComposerDumpAutoload => &["composer.json"],
        Op::Cargo { .. } => &["Cargo.toml"],
        Op::Maven { .. } | Op::Gradle { .. } => &["pom.xml", "build.gradle", "build.gradle.kts"],
        Op::CmakeConfigure { .. } | Op::CmakeBuild | Op::CmakeClean => &["CMakeLists.txt"],
    }
}

/// What the Dependencies view or the card asks for: an operation, in the project that contains `base`.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DepsRequest {
    /// A file or folder inside the project (the project folder itself from the view, the failed program from the card).
    base: String,
    op: Op,
    /// `openmind` or an environment folder name of the project.
    #[serde(default)]
    python_env: Option<String>,
    /// The package manager the user chose when the project's lock files disagree.
    #[serde(default)]
    node_manager: Option<String>,
}

/// Finds a program: OpenMind's runtimes and bundled tools first, then the system PATH. Project-local copies are not
/// used for package managers (a project can't swap in its own `npm`).
fn resolver(environment: RunEnvironment) -> impl Fn(&str) -> Option<Resolved> {
    let system = std::env::var_os("PATH");
    move |name| {
        openmind_runner::runtime::resolve_executable(name, &environment, &[], system.as_deref())
            .map(|found| Resolved {
                path: found.path,
                source: match found.source {
                    RuntimeSource::Portable => "OpenMind runtime",
                    RuntimeSource::Project => "project",
                    RuntimeSource::System => "system PATH",
                }
                .into(),
            })
    }
}

async fn make_plan(
    state: &AppState,
    window: &tauri::Window,
    request: &DepsRequest,
) -> Result<(Plan, RunEnvironment), String> {
    let start = start_dir(&request.base)?;
    let project = project_of(state, window, &start, markers(&request.op)).await?;
    let environment = crate::commands::run::environment(state).await;
    let tool = resolver(environment.clone());
    let ctx = PlanContext {
        project: &project,
        python_env: request.python_env.clone(),
        portable_python: portable_python(state).await,
        node_manager: request.node_manager.clone(),
        tool: &tool,
        pip_cache: pip_cache_dir(state),
        wheelhouse: crate::commands::network_offline::cache(state).wheelhouse(),
    };
    let plan = openmind_deps::plan(&request.op, &ctx).map_err(|err| err.to_string())?;
    Ok((plan, environment))
}

/// The projects and dependencies of the folder `root` (also the canonical state's per-workspace dependency domain).
pub(crate) async fn scan_at(state: &AppState, root: PathBuf) -> Result<DepsSnapshot, String> {
    let python = portable_python(state)
        .await
        .and_then(|exe| exe.parent().map(Path::to_path_buf));
    tauri::async_runtime::spawn_blocking(move || openmind_deps::inspect(&root, python.as_deref()))
        .await
        .map_err(|err| err.to_string())
}

/// Exactly what `request` would run, for the confirmation. Nothing is executed.
#[tauri::command]
pub async fn deps_plan(
    request: DepsRequest,
    window: tauri::Window,
    state: State<'_, AppState>,
) -> Result<Plan, String> {
    Ok(make_plan(&state, &window, &request).await?.0)
}

/// Runs `request` (after the user confirmed its plan) as a new terminal's own program in the project folder: the
/// terminal's output is the program's and its exit code is reported. Planned again here, from the request.
#[tauri::command]
pub async fn deps_run(
    request: DepsRequest,
    cols: u16,
    rows: u16,
    window: tauri::Window,
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<TerminalSessionInfo, String> {
    let (plan, runtime) = make_plan(&state, &window, &request).await?;
    let mut env = openmind_terminal::default_environment();
    env.extend(runtime.vars);
    let cache = pip_cache_dir(&state)
        .parent()
        .map_or_else(|| state.app_root.join("cache"), Path::to_path_buf);
    env.extend(cache_env(&plan.manager, &cache));
    let owner = window.label().to_string();
    let id = TerminalRegistry::generate_id();
    state.editor_windows.track_terminal(&id, &owner);
    let terminal = CreateTerminalRequest {
        shell: Some(ShellKind::PowerShell),
        cwd: Some(PathBuf::from(&plan.cwd)),
        cols,
        rows,
        env,
        path_prepend: runtime.path_prepend,
        program: Some(PathBuf::from(&plan.program)),
        args: plan.args.clone(),
    };
    tracing::info!(manager = %plan.manager, action = %plan.action, cwd = %plan.cwd, "running a confirmed dependency operation");
    crate::commands::terminal::start_session(&state, app, id, owner, terminal)
}

/// What the missing-package card can offer for `base`: the Python and npm project folders and their manifests, and
/// whether OpenMind's Python (or a project environment) is there to install into. Local reads only.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectInfo {
    python_project: String,
    requirements_txt: Option<String>,
    pyproject_toml: Option<String>,
    /// Where Python packages would go: `projectVenv`, `openmindPython`, or `null` (nowhere safe: install Python first).
    python_target: Option<&'static str>,
    node_project: String,
    package_json: Option<String>,
}

#[tauri::command]
pub async fn deps_project_info(
    base: String,
    window: tauri::Window,
    state: State<'_, AppState>,
) -> Result<ProjectInfo, String> {
    let start = start_dir(&base)?;
    let python = project_of(&state, &window, &start, PYTHON_MARKERS).await?;
    let node = project_of(&state, &window, &start, NODE_MARKERS).await?;
    let file = |dir: &Path, name: &str| {
        let path = dir.join(name);
        path.is_file().then(|| path.display().to_string())
    };
    Ok(ProjectInfo {
        requirements_txt: file(&python, "requirements.txt"),
        pyproject_toml: file(&python, "pyproject.toml"),
        python_target: python_target(&state, &python)
            .await
            .ok()
            .map(|(_, target)| target),
        python_project: python.display().to_string(),
        package_json: file(&node, "package.json"),
        node_project: node.display().to_string(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_start_folder_is_checked() {
        assert!(start_dir("relative/file.py").is_err());
        assert!(start_dir("C:\\nope\\missing\\x.py").is_err());
        let dir = tempfile::tempdir().expect("tmp");
        let file = dir.path().join("main.py");
        std::fs::write(&file, "import requests\n").expect("write");
        assert_eq!(
            start_dir(&file.display().to_string()).expect("dir"),
            dir.path()
        );
        assert_eq!(
            start_dir(&dir.path().display().to_string()).expect("dir"),
            dir.path()
        );
    }

    #[test]
    fn the_message_without_openmind_python_names_the_runtime_manager_and_never_the_users_python() {
        assert!(NO_OPENMIND_PYTHON.contains("Runtime Manager"));
        assert!(NO_OPENMIND_PYTHON.contains("never installed into your own Python"));
    }

    #[test]
    fn package_manager_caches_stay_in_the_app_folder() {
        let cache = Path::new(r"E:\My Apps\OpenMind Studio\cache");
        assert_eq!(
            cache_env("npm", cache),
            [(
                "npm_config_cache".to_string(),
                r"E:\My Apps\OpenMind Studio\cache\npm".to_string()
            )]
        );
        assert_eq!(cache_env("composer", cache)[0].0, "COMPOSER_CACHE_DIR");
        // pip gets --cache-dir in its arguments; the others keep their own behaviour.
        assert!(cache_env("pip", cache).is_empty());
        assert!(cache_env("cargo", cache).is_empty());
    }

    #[test]
    fn requests_arrive_as_operations_never_as_commands() {
        let request: DepsRequest = serde_json::from_str(
            r#"{"base":"E:\\p","op":{"op":"nodeAdd","package":"lodash","dev":true},"nodeManager":"pnpm"}"#,
        )
        .expect("request");
        assert_eq!(
            request.op,
            Op::NodeAdd {
                package: "lodash".into(),
                dev: true
            }
        );
        // A request can't carry a program, arguments or an unknown operation.
        for bad in [
            r#"{"base":"E:\\p","op":{"op":"shell","command":"calc"}}"#,
            r#"{"base":"E:\\p","op":{"op":"nodeInstall"},"program":"calc.exe","args":["/c"]}"#,
        ] {
            assert!(serde_json::from_str::<DepsRequest>(bad).is_err(), "{bad}");
        }
        for op in [
            Op::CmakeBuild,
            Op::Cargo {
                command: "check".into(),
            },
            Op::PythonCreateEnv,
            Op::ComposerInstall,
        ] {
            assert!(!markers(&op).is_empty());
        }
    }
}
