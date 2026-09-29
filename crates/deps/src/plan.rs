//! Plans for package and project operations: the exact program (an absolute path), its arguments, the folder, where
//! packages go and whether the network is needed. Built from validated input only; the app shows the plan, asks, and
//! only then starts the program (as an argument list, never through a shell). Nothing here installs anything
//! globally: no `pip --user`, no `npm -g`, no `pnpm add -g`, no `yarn global`, no Composer global commands.

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use openmind_network::packages::{valid_npm_package, with_pip_cache};
use openmind_network::wheelhouse::{parse_requirements, valid_requirement};

use crate::model::PythonEnv;
use crate::{node, others, python};

/// What the user asked for (the Dependencies view, the missing-package card or a setup hint).
#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Serialize)]
#[serde(tag = "op", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum Op {
    PythonCreateEnv,
    PythonInstallRequirements,
    PythonInstallPyproject,
    PythonAdd { packages: String, offline: bool },
    PythonRemove { package: String },
    PythonUpdate { package: String },
    NodeInstall,
    NodeAdd { package: String, dev: bool },
    NodeRemove { package: String },
    NodeUpdate { package: String },
    NodeRunScript { script: String },
    ComposerInstall,
    ComposerRequire { package: String, dev: bool },
    ComposerRemove { package: String },
    ComposerUpdate { package: String },
    ComposerDumpAutoload,
    Cargo { command: String },
    Maven { goal: String },
    Gradle { task: String },
    CmakeConfigure { preset: Option<String> },
    CmakeBuild,
    CmakeClean,
}

/// Whether the operation needs the network.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Network {
    /// Downloads from a package registry.
    Required,
    /// Uses only the offline wheelhouse.
    Offline,
    /// May download (a build fetching missing dependencies, a script).
    May,
    None,
}

/// A program found for a command name, and where it came from ("OpenMind portable", "project", "system").
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Resolved {
    pub path: PathBuf,
    pub source: String,
}

/// What the planner needs from the app.
pub struct PlanContext<'a> {
    pub project: &'a Path,
    /// The user's Python choice: an environment folder name or `openmind`; `None` = the project's environment, else
    /// OpenMind's.
    pub python_env: Option<String>,
    /// OpenMind's portable Python interpreter, when installed.
    pub portable_python: Option<PathBuf>,
    /// The user's package-manager choice (needed when the project's lock files disagree).
    pub node_manager: Option<String>,
    /// Finds a program by command name (OpenMind's runtimes first, then PATH).
    pub tool: &'a dyn Fn(&str) -> Option<Resolved>,
    pub pip_cache: PathBuf,
    pub wheelhouse: PathBuf,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Plan {
    /// "pip", "npm", "pnpm", "yarn", "composer", "cargo", "maven", "gradle", "cmake".
    pub manager: String,
    /// "install", "add", "remove", "update", "create environment", "run script" ...
    pub action: String,
    pub packages: Vec<String>,
    pub program: String,
    /// Where the program came from.
    pub source: String,
    pub args: Vec<String>,
    /// The whole command, for reading (arguments with spaces quoted). Display only.
    pub command: String,
    pub cwd: String,
    /// Where packages go / what changes.
    pub target: String,
    pub network: Network,
    pub notes: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
#[error("{0}")]
pub struct PlanError(pub String);

pub(crate) fn err<T>(message: impl Into<String>) -> Result<T, PlanError> {
    Err(PlanError(message.into()))
}

pub const NO_OPENMIND_PYTHON: &str = "OpenMind's Python runtime isn't installed. Install Python from the Runtime Manager — packages are never installed into your own Python.";
pub const RUST_EXTERNAL: &str = "Cargo was not found. Rust is managed outside OpenMind Studio: install it with rustup (https://rustup.rs), then restart OpenMind Studio.";

/// Arguments that would change meaning when a `.cmd`/`.bat` program is started (cmd.exe reads its command line).
fn batch_safe(program: &Path, args: &[String]) -> Result<(), PlanError> {
    let batch = program
        .extension()
        .is_some_and(|ext| ext.eq_ignore_ascii_case("cmd") || ext.eq_ignore_ascii_case("bat"));
    match args.iter().find(|arg| {
        arg.contains(['"', '%', '^', '&', '|', '<', '>', '!', '\r', '\n']) || arg.contains('\0')
    }) {
        Some(arg) if batch || arg.contains(['\r', '\n', '\0']) => {
            err(format!("\"{arg}\" can't be passed on safely."))
        }
        _ => Ok(()),
    }
}

/// The command as the user reads it (never executed as text).
pub fn command_line(program: &str, args: &[String]) -> String {
    std::iter::once(program)
        .chain(args.iter().map(String::as_str))
        .map(|part| {
            if part.is_empty() || part.contains([' ', '\t']) {
                format!("\"{part}\"")
            } else {
                part.to_string()
            }
        })
        .collect::<Vec<_>>()
        .join(" ")
}

#[allow(clippy::too_many_arguments)]
pub(crate) fn finish(
    ctx: &PlanContext<'_>,
    manager: &str,
    action: &str,
    packages: Vec<String>,
    program: Resolved,
    args: Vec<String>,
    target: String,
    network: Network,
    notes: Vec<String>,
) -> Result<Plan, PlanError> {
    batch_safe(&program.path, &args)?;
    let program_text = program.path.to_string_lossy().into_owned();
    Ok(Plan {
        manager: manager.into(),
        action: action.into(),
        packages,
        command: command_line(&program_text, &args),
        program: program_text,
        source: program.source,
        args,
        cwd: ctx.project.to_string_lossy().into_owned(),
        target,
        network,
        notes,
    })
}

/// A plain package name (for remove/update: no version, no extras).
fn plain_python_name(name: &str) -> bool {
    valid_requirement(name)
        && name
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-'))
}

/// The interpreter packages go into, and the words for where that is.
fn python_target(ctx: &PlanContext<'_>) -> Result<(Resolved, String), PlanError> {
    let envs: Vec<PythonEnv> = python::environments(ctx.project);
    let openmind = || -> Result<(Resolved, String), PlanError> {
        let Some(path) = ctx.portable_python.clone() else {
            return err(NO_OPENMIND_PYTHON);
        };
        let folder = path.parent().map(Path::to_path_buf).unwrap_or_default();
        Ok((
            Resolved {
                path,
                source: "OpenMind portable".into(),
            },
            format!("OpenMind's portable Python ({})", folder.display()),
        ))
    };
    let env_target = |env: &PythonEnv| {
        (
            Resolved {
                path: PathBuf::from(&env.interpreter),
                source: "project environment".into(),
            },
            format!(
                "{} (project environment)",
                ctx.project.join(&env.name).display()
            ),
        )
    };
    match ctx.python_env.as_deref() {
        Some("openmind") => openmind(),
        Some(name) => envs
            .iter()
            .find(|env| env.name == name)
            .map(env_target)
            .ok_or_else(|| PlanError(format!("The environment \"{name}\" isn't in this project."))),
        None => envs
            .first()
            .map_or_else(openmind, |env| Ok(env_target(env))),
    }
}

/// `.venv` in the project, made by OpenMind's portable Python (never by another Python, never over an existing one).
fn plan_create_env(ctx: &PlanContext<'_>) -> Result<Plan, PlanError> {
    let env = ctx.project.join(".venv");
    if env.exists() {
        return err("This project already has a .venv folder.");
    }
    let Some(base) = ctx.portable_python.clone() else {
        return err(NO_OPENMIND_PYTHON);
    };
    let args = vec!["-m".into(), "venv".into(), ".venv".into()];
    let target = format!("{} (new project environment)", env.display());
    let notes = vec!["The environment records OpenMind's Python by its full path: after moving the OpenMind Studio folder, create it again.".into()];
    let base = Resolved {
        path: base,
        source: "OpenMind portable".into(),
    };
    finish(
        ctx,
        "venv",
        "create environment",
        Vec::new(),
        base,
        args,
        target,
        Network::None,
        notes,
    )
}

/// `pyproject.toml`'s `[project] dependencies` as checked requirements, and the notes to show.
fn pyproject_requirements(project: &Path) -> Result<(Vec<String>, Vec<String>), PlanError> {
    let text = crate::files::read_small(&project.join("pyproject.toml"))
        .ok_or_else(|| PlanError("This project has no readable pyproject.toml.".into()))?;
    let (mut skipped, mut notes) = (Vec::new(), Vec::new());
    let wanted: Vec<String> = python::parse_pyproject(&text, &mut skipped, &mut notes)
        .into_iter()
        .map(|dep| format!("{}{}", dep.name, dep.spec.replace(' ', "")))
        .collect();
    if let Some(bad) = wanted.iter().find(|w| !valid_requirement(w)) {
        return err(format!(
            "\"{bad}\" in pyproject.toml can't be installed safely from here."
        ));
    }
    if wanted.is_empty() {
        return err(
            "pyproject.toml lists no [project] dependencies that can be installed from here.",
        );
    }
    notes.push("Only the listed dependencies are installed; the project itself isn't built (that would run its build backend).".into());
    Ok((wanted, notes))
}

fn plan_python(op: &Op, ctx: &PlanContext<'_>) -> Result<Plan, PlanError> {
    if *op == Op::PythonCreateEnv {
        return plan_create_env(ctx);
    }
    let (interpreter, target) = python_target(ctx)?;
    let pip = |rest: &[&str]| -> Vec<String> {
        ["-m", "pip"]
            .iter()
            .chain(rest)
            .map(|s| (*s).to_string())
            .collect()
    };
    let with_cache = |args: Vec<String>| {
        let mut full = vec![interpreter.path.to_string_lossy().into_owned()];
        full.extend(args);
        with_pip_cache(full, &ctx.pip_cache).split_off(1)
    };
    let (action, packages, args, network, notes) = match op {
        Op::PythonInstallRequirements => {
            if !ctx.project.join("requirements.txt").is_file() {
                return err("This project has no requirements.txt.");
            }
            let note = "pip follows requirements.txt as written (other -r files, index URLs and options in it apply).";
            (
                "install",
                Vec::new(),
                with_cache(pip(&["install", "-r", "requirements.txt"])),
                Network::Required,
                vec![note.to_string()],
            )
        }
        Op::PythonInstallPyproject => {
            let (wanted, notes) = pyproject_requirements(ctx.project)?;
            let mut args = pip(&["install"]);
            args.extend(wanted.iter().cloned());
            (
                "install",
                wanted,
                with_cache(args),
                Network::Required,
                notes,
            )
        }
        Op::PythonAdd { packages, offline } => {
            let list = parse_requirements(packages).map_err(|e| PlanError(e.to_string()))?;
            if let Some(stdlib) = list
                .iter()
                .find(|p| openmind_network::packages::is_python_stdlib(p))
            {
                return err(format!(
                    "{stdlib} is part of Python itself, not a pip package."
                ));
            }
            let mut args = pip(&["install"]);
            if *offline {
                if !ctx.wheelhouse.is_dir() {
                    return err("No wheels are imported yet. Import a wheel folder first.");
                }
                let url = openmind_network::packages::pip_offline_argv(
                    Path::new("python"),
                    &ctx.wheelhouse,
                    &list,
                )
                .map_err(|e| PlanError(e.to_string()))?;
                args = pip(&[]);
                args.extend(url.into_iter().skip(3));
            } else {
                args.extend(list.iter().cloned());
            }
            let network = if *offline {
                Network::Offline
            } else {
                Network::Required
            };
            ("add", list, with_cache(args), network, Vec::new())
        }
        Op::PythonRemove { package } | Op::PythonUpdate { package } => {
            if !plain_python_name(package) {
                return err(format!("\"{package}\" isn't a package name."));
            }
            if matches!(op, Op::PythonRemove { .. }) {
                (
                    "remove",
                    vec![package.clone()],
                    pip(&["uninstall", "-y", package]),
                    Network::None,
                    Vec::new(),
                )
            } else {
                (
                    "update",
                    vec![package.clone()],
                    with_cache(pip(&["install", "--upgrade", package])),
                    Network::Required,
                    Vec::new(),
                )
            }
        }
        _ => return err("Not a Python operation."),
    };
    finish(
        ctx,
        "pip",
        action,
        packages,
        interpreter,
        args,
        target,
        network,
        notes,
    )
}

fn node_manager(ctx: &PlanContext<'_>) -> Result<String, PlanError> {
    let info = node::read(ctx.project)
        .ok_or_else(|| PlanError("This project has no package.json.".into()))?;
    match ctx.node_manager.as_deref() {
        Some(chosen) if node::SUPPORTED.contains(&chosen) => Ok(chosen.to_string()),
        Some(chosen) => err(format!(
            "{chosen} isn't a package manager OpenMind supports."
        )),
        None => info.package_manager.ok_or_else(|| {
            PlanError(
                info.conflict
                    .unwrap_or_else(|| "Choose the package manager.".into()),
            )
        }),
    }
}

fn plan_node(op: &Op, ctx: &PlanContext<'_>) -> Result<Plan, PlanError> {
    let manager = node_manager(ctx)?;
    let program = (ctx.tool)(&manager).ok_or_else(|| {
        PlanError(if manager == "npm" {
            "npm was not found. Install Node.js from the Runtime Manager.".into()
        } else {
            format!("{manager} was not found. OpenMind doesn't install it; install it for this project or choose another package manager.")
        })
    })?;
    let package_ok = |package: &String| -> Result<(), PlanError> {
        if valid_npm_package(package) {
            Ok(())
        } else {
            err(format!("\"{package}\" isn't an npm package name."))
        }
    };
    let (npm, pnpm) = (manager == "npm", manager == "pnpm");
    let berry = manager == "yarn" && ctx.project.join(".yarnrc.yml").is_file();
    let words = |list: &[&str]| {
        list.iter()
            .map(|s| (*s).to_string())
            .collect::<Vec<String>>()
    };
    let lifecycle =
        "Packages' own install scripts run, as with any install by this package manager."
            .to_string();
    let (action, packages, args, network, notes) = match op {
        Op::NodeInstall => (
            "install",
            Vec::new(),
            words(&["install"]),
            Network::Required,
            vec![lifecycle],
        ),
        Op::NodeAdd { package, dev } => {
            package_ok(package)?;
            let mut args = words(&[if npm { "install" } else { "add" }]);
            if *dev {
                args.push(
                    if npm {
                        "--save-dev"
                    } else if pnpm {
                        "-D"
                    } else {
                        "--dev"
                    }
                    .into(),
                );
            }
            args.push(package.clone());
            (
                "add",
                vec![package.clone()],
                args,
                Network::Required,
                vec![lifecycle],
            )
        }
        Op::NodeRemove { package } => {
            package_ok(package)?;
            let verb = if npm { "uninstall" } else { "remove" };
            (
                "remove",
                vec![package.clone()],
                words(&[verb, package]),
                Network::May,
                Vec::new(),
            )
        }
        Op::NodeUpdate { package } => {
            package_ok(package)?;
            let verb = if npm || pnpm {
                "update"
            } else if berry {
                "up"
            } else {
                "upgrade"
            };
            (
                "update",
                vec![package.clone()],
                words(&[verb, package]),
                Network::Required,
                vec![lifecycle],
            )
        }
        Op::NodeRunScript { script } => {
            let known = node::read(ctx.project)
                .is_some_and(|info| info.scripts.iter().any(|s| &s.name == script && s.runnable));
            if !known {
                return err(format!(
                    "\"{script}\" isn't a script of this package.json that can be run from here."
                ));
            }
            let note = "The script runs the project's own command from package.json.".to_string();
            (
                "run script",
                Vec::new(),
                words(&["run", script]),
                Network::May,
                vec![note],
            )
        }
        _ => return err("Not a Node.js operation."),
    };
    let target = format!(
        "{} (this project's node_modules)",
        ctx.project.join("node_modules").display()
    );
    finish(
        ctx, &manager, action, packages, program, args, target, network, notes,
    )
}

fn plan_composer(op: &Op, ctx: &PlanContext<'_>) -> Result<Plan, PlanError> {
    if !ctx.project.join("composer.json").is_file() {
        return err("This project has no composer.json.");
    }
    let program = (ctx.tool)("composer").ok_or_else(|| {
        PlanError("Composer was not found. Install PHP and Composer from the Runtime Manager (PHP Server window > Config).".into())
    })?;
    let package_ok = |package: &String| -> Result<(), PlanError> {
        if others::valid_composer_package(package) {
            Ok(())
        } else {
            err(format!("\"{package}\" isn't a vendor/package name."))
        }
    };
    let words = |list: &[&str]| {
        list.iter()
            .map(|s| (*s).to_string())
            .collect::<Vec<String>>()
    };
    let scripts = "Composer runs the scripts composer.json defines for this event.".to_string();
    let (action, packages, args, network, notes) = match op {
        Op::ComposerInstall => (
            "install",
            Vec::new(),
            words(&["install"]),
            Network::Required,
            vec![scripts],
        ),
        Op::ComposerRequire { package, dev } => {
            package_ok(package)?;
            let mut args = words(&["require"]);
            if *dev {
                args.push("--dev".into());
            }
            args.push(package.clone());
            (
                "add",
                vec![package.clone()],
                args,
                Network::Required,
                vec![scripts],
            )
        }
        Op::ComposerRemove { package } => {
            package_ok(package)?;
            (
                "remove",
                vec![package.clone()],
                words(&["remove", package]),
                Network::May,
                Vec::new(),
            )
        }
        Op::ComposerUpdate { package } => {
            package_ok(package)?;
            (
                "update",
                vec![package.clone()],
                words(&["update", package]),
                Network::Required,
                vec![scripts],
            )
        }
        Op::ComposerDumpAutoload => (
            "dump-autoload",
            Vec::new(),
            words(&["dump-autoload"]),
            Network::None,
            Vec::new(),
        ),
        _ => return err("Not a Composer operation."),
    };
    let target = format!(
        "{} (this project's vendor)",
        ctx.project.join("vendor").display()
    );
    finish(
        ctx, "composer", action, packages, program, args, target, network, notes,
    )
}

/// The plan for `op` in `ctx.project`.
pub fn plan(op: &Op, ctx: &PlanContext<'_>) -> Result<Plan, PlanError> {
    match op {
        Op::PythonCreateEnv
        | Op::PythonInstallRequirements
        | Op::PythonInstallPyproject
        | Op::PythonAdd { .. }
        | Op::PythonRemove { .. }
        | Op::PythonUpdate { .. } => plan_python(op, ctx),
        Op::NodeInstall
        | Op::NodeAdd { .. }
        | Op::NodeRemove { .. }
        | Op::NodeUpdate { .. }
        | Op::NodeRunScript { .. } => plan_node(op, ctx),
        Op::ComposerInstall
        | Op::ComposerRequire { .. }
        | Op::ComposerRemove { .. }
        | Op::ComposerUpdate { .. }
        | Op::ComposerDumpAutoload => plan_composer(op, ctx),
        _ => crate::builds::plan_build(op, ctx),
    }
}
