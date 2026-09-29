//! Dependency helper: the command that installs a missing Python or npm package for a project. Only a plan is made
//! here — the argument list, the folder and where the package goes; the user sees it in a confirmation and the app
//! types it into a new OpenMind terminal (which has the proxy and `PYTHONNOUSERSITE=1`). Python packages go into the
//! project's virtual environment or OpenMind's portable Python, named by absolute path — never the user's own Python,
//! never `--user`, never `npm -g`. Nothing is installed without that confirmation.

use std::path::{Path, PathBuf};

use openmind_network::packages::{
    npm_install_argv, pip_install_argv, pip_offline_argv, pip_requirements_argv, project_dir,
    venv_python, with_pip_cache, NODE_MARKERS, PYTHON_MARKERS,
};
use openmind_network::wheelhouse::parse_requirements;
use serde::Serialize;
use tauri::State;

use crate::app_state::AppState;

/// Where an install goes and the exact command.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InstallPlan {
    argv: Vec<String>,
    /// The project folder the command runs in.
    cwd: String,
    /// `projectVenv`, `openmindPython` or `npm`.
    target: &'static str,
    /// The interpreter a Python package goes into.
    interpreter: Option<String>,
}

pub(crate) const NO_OPENMIND_PYTHON: &str = "OpenMind's Python runtime isn't installed. Install Python from the Runtime \
     Manager (or create a .venv in the project) — packages are never installed into your own Python.";

/// The Python a package for `project` goes into: the project's `.venv`/`venv`, else OpenMind's active portable Python.
pub(crate) async fn python_target(
    state: &AppState,
    project: &Path,
) -> Result<(PathBuf, &'static str), String> {
    if let Some(venv) = venv_python(project) {
        return Ok((venv, "projectVenv"));
    }
    let exe = if cfg!(windows) {
        "python.exe"
    } else {
        "bin/python3"
    };
    match state.runtime.installed_dir("python").await {
        Some(dir) if dir.join(exe).is_file() => Ok((dir.join(exe), "openmindPython")),
        _ => Err(NO_OPENMIND_PYTHON.to_string()),
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

/// The project folder for `start`, never above the window's open folder.
async fn project_of(
    state: &AppState,
    window: &tauri::Window,
    start: &Path,
    markers: &[&str],
) -> Result<PathBuf, String> {
    let workspace = crate::windows::window_workspace(state, window.label())
        .await?
        .map(|workspace| PathBuf::from(workspace.path));
    let stop = workspace
        .filter(|root| start.starts_with(root))
        .unwrap_or_else(|| start.to_path_buf());
    Ok(project_dir(start, &stop, markers))
}

/// pip's download cache for installs the helper starts: `<app>/cache/pip`, never the user's own pip cache.
pub(crate) fn pip_cache_dir(state: &AppState) -> PathBuf {
    let downloads = state.runtime.paths().downloads_dir();
    downloads
        .parent()
        .map_or(downloads.clone(), Path::to_path_buf)
        .join("pip")
}

/// The install plan for `kind`: `pip` / `pipOffline` (packages, space- or comma-separated), `pipRequirements`
/// (the project's requirements.txt), `npm` (one package) or `npmProject` (the project's package.json).
#[tauri::command]
pub async fn deps_install_plan(
    kind: String,
    packages: Option<String>,
    base: String,
    window: tauri::Window,
    state: State<'_, AppState>,
) -> Result<InstallPlan, String> {
    let start = start_dir(&base)?;
    let plan = match kind.as_str() {
        "pip" | "pipOffline" | "pipRequirements" => {
            let project = project_of(&state, &window, &start, PYTHON_MARKERS).await?;
            let (interpreter, target) = python_target(&state, &project).await?;
            let argv = match kind.as_str() {
                "pipRequirements" => {
                    if !project.join("requirements.txt").is_file() {
                        return Err("This project has no requirements.txt.".to_string());
                    }
                    pip_requirements_argv(&interpreter)
                }
                _ => {
                    let requirements = parse_requirements(packages.as_deref().unwrap_or_default())
                        .map_err(|err| err.to_string())?;
                    if kind == "pipOffline" {
                        let wheelhouse =
                            crate::commands::network_offline::cache(&state).wheelhouse();
                        if !wheelhouse.is_dir() {
                            return Err("No wheels are imported yet. Import a wheel folder first."
                                .to_string());
                        }
                        pip_offline_argv(&interpreter, &wheelhouse, &requirements)
                    } else {
                        pip_install_argv(&interpreter, &requirements)
                    }
                    .map_err(|err| err.to_string())?
                }
            };
            InstallPlan {
                argv: with_pip_cache(argv, &pip_cache_dir(&state)),
                cwd: project.display().to_string(),
                target,
                interpreter: Some(interpreter.display().to_string()),
            }
        }
        "npm" | "npmProject" => {
            let project = project_of(&state, &window, &start, NODE_MARKERS).await?;
            let package = if kind == "npm" {
                Some(packages.as_deref().map(str::trim).unwrap_or_default())
            } else {
                if !project.join("package.json").is_file() {
                    return Err("This project has no package.json.".to_string());
                }
                None
            };
            InstallPlan {
                argv: npm_install_argv(package).map_err(|err| err.to_string())?,
                cwd: project.display().to_string(),
                target: "npm",
                interpreter: None,
            }
        }
        _ => return Err(format!("Unknown install kind: {kind}")),
    };
    tracing::info!(target = plan.target, cwd = %plan.cwd, "dependency install planned");
    Ok(plan)
}

/// What the dependency card can offer for `base`: the Python and npm project folders and their manifests, and whether
/// OpenMind's Python (or a project venv) is there to install into. Local reads only.
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
}
