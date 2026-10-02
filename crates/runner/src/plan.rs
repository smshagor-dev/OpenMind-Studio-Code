use std::ffi::OsString;
use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};

use serde::Deserialize;

use crate::compiled::{plan_compiled, BuildStep};
use crate::display::command_line;
use crate::error::RunError;
use crate::kind::{detect, Detection, RunnableKind};
use crate::runtime::{
    is_bare_name, resolve_executable, runtime_label, ResolvedExecutable, RunEnvironment,
    RuntimeSource,
};
use crate::template::{expand, tokenize, Variables};

/// What the UI asks to run.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RunRequest {
    pub file: PathBuf,
    /// The open workspace folder, if any.
    #[serde(default)]
    pub workspace: Option<PathBuf>,
    /// A user-chosen command template; `None` means the file type's default.
    #[serde(default)]
    pub template: Option<String>,
    /// Command-line arguments for the program, as typed (`a "b c"` is two arguments). Split like a shell would split,
    /// never run through one; they go after everything else (after the file for an interpreter).
    #[serde(default)]
    pub arguments: Option<String>,
}

/// Everything needed to start a process, fully resolved and validated — and
/// nothing has been executed to get here.
#[derive(Debug, Clone)]
pub struct RunPlan {
    pub kind: RunnableKind,
    pub file: PathBuf,
    /// `argv[0]` is the absolute path of the resolved program.
    pub argv: Vec<String>,
    pub cwd: PathBuf,
    /// Extra variables for the child (runtime variables such as `PYTHONNOUSERSITE`).
    pub env: Vec<(String, String)>,
    /// The child's whole PATH: portable runtime folders first.
    pub path_var: OsString,
    pub runtime_label: String,
    pub source: RuntimeSource,
    /// The command as the user would type it (`python hello.py`): the program's
    /// plain name and paths inside the working folder made relative. Display only.
    pub display: String,
    /// The absolute path of the interpreter that will actually run (for a compiled language: the program the build
    /// produces, or `java`).
    pub resolved: PathBuf,
    /// For C, C++, Java and Rust: the compile step that runs first, in the same process tree.
    pub build: Option<BuildStep>,
}

const BINARY_SNIFF_BYTES: usize = 8000;

/// Validates `request` and resolves how to run it, without starting anything.
/// Order of priority for the interpreter: portable runtime, project-local
/// tool, system PATH. Fails with a plain-language reason the UI can show.
/// `build_dir` is where a compiled language's output goes (nothing is created here).
pub fn plan(
    request: &RunRequest,
    environment: &RunEnvironment,
    app_root: &Path,
    system_path: Option<OsString>,
    build_dir: &Path,
) -> Result<RunPlan, RunError> {
    let arguments = program_arguments(request.arguments.as_deref())?;
    let mut plan = plan_command(request, environment, app_root, system_path, build_dir)?;
    if !arguments.is_empty() {
        plan.display = format!("{} {}", plan.display, command_line(&arguments));
        plan.argv.extend(arguments);
    }
    Ok(plan)
}

/// Longest argument text Run Code accepts.
const MAX_ARGUMENTS: usize = 8 * 1024;

/// The program's own arguments from what the user typed: quote-aware splitting only (no variables, no shell); empty
/// text is no arguments. A line break is refused (it can't be typed into a terminal line safely).
pub fn program_arguments(text: Option<&str>) -> Result<Vec<String>, RunError> {
    let Some(text) = text.filter(|text| !text.trim().is_empty()) else {
        return Ok(Vec::new());
    };
    if text.len() > MAX_ARGUMENTS {
        return Err(RunError::BadArguments("they are longer than 8 KB".into()));
    }
    if text.contains(['\n', '\r', '\0']) {
        return Err(RunError::BadArguments("they contain a line break".into()));
    }
    tokenize(text).map_err(|err| match err {
        RunError::BadCommand(reason) => RunError::BadArguments(reason),
        other => other,
    })
}

fn plan_command(
    request: &RunRequest,
    environment: &RunEnvironment,
    app_root: &Path,
    system_path: Option<OsString>,
    build_dir: &Path,
) -> Result<RunPlan, RunError> {
    let file = validate_file(&request.file)?;
    let kind = match detect(&file) {
        Detection::Runnable(kind) => kind,
        Detection::NotRunnable { reason, .. } => return Err(RunError::NotRunnable(reason)),
    };
    let cwd = working_directory(request.workspace.as_deref(), &file, app_root)?;
    if kind.is_compiled() {
        if request.template.is_some() {
            return Err(RunError::BadCommand(format!(
                "a custom run command isn't supported for {} files",
                kind.display_name()
            )));
        }
        return plan_compiled(kind, &file, cwd, environment, system_path, build_dir);
    }

    let custom = request.template.is_some();
    let template = request
        .template
        .clone()
        .unwrap_or_else(|| kind.default_template().to_string());
    let variables = Variables {
        file: &file,
        workspace: request.workspace.as_deref().filter(|w| w.is_dir()),
    };
    let mut tokens = Vec::new();
    for token in tokenize(&template)? {
        tokens.push(expand(&token, &variables)?);
    }

    // A Python file inside a project with its own environment runs with that environment (where the Dependencies
    // view and the missing-package card install packages), before OpenMind's portable Python.
    let venv = (kind == RunnableKind::Python && tokens.first().is_some_and(|p| p == "python"))
        .then(|| project_python(&file, request.workspace.as_deref()))
        .flatten();
    let project_dirs: Vec<PathBuf> = match &venv {
        Some(interpreter) => interpreter
            .parent()
            .map(Path::to_path_buf)
            .into_iter()
            .collect(),
        None => request
            .workspace
            .iter()
            .map(|workspace| workspace.join("node_modules").join(".bin"))
            .collect(),
    };
    let resolved = match venv {
        Some(path) => ResolvedExecutable {
            path,
            source: RuntimeSource::Project,
        },
        None => resolve_program(
            kind,
            custom,
            &tokens,
            environment,
            &project_dirs,
            system_path.as_deref(),
        )?,
    };

    let display = friendly_command(&tokens, &cwd);
    let mut argv = tokens;
    argv[0] = resolved.path.to_string_lossy().into_owned();

    let mut env = environment.vars.clone();
    env.extend(
        kind.extra_env()
            .iter()
            .map(|(key, value)| ((*key).to_string(), (*value).to_string())),
    );
    let path_var = child_path(environment, &project_dirs, &resolved, system_path)?;

    Ok(RunPlan {
        kind,
        display,
        resolved: resolved.path.clone(),
        runtime_label: runtime_label(kind, &resolved),
        source: resolved.source,
        file,
        argv,
        cwd,
        env,
        path_var,
        build: None,
    })
}

/// Folder names a project's own Python environment is looked for in (a folder with `pyvenv.cfg`).
const PYTHON_ENVS: [&str; 3] = [".venv", "venv", "env"];

/// The project's own Python environment for `file`: in the file's folder or a parent, never above the workspace (without
/// a workspace, only the file's own folder). Links are not followed.
pub fn project_python(file: &Path, workspace: Option<&Path>) -> Option<PathBuf> {
    let mut dir = file.parent();
    while let Some(current) = dir {
        for name in PYTHON_ENVS {
            let env = current.join(name);
            let interpreter = if cfg!(windows) {
                env.join("Scripts").join("python.exe")
            } else {
                env.join("bin").join("python")
            };
            let real =
                |path: &Path| fs::symlink_metadata(path).is_ok_and(|m| !m.file_type().is_symlink());
            if env.join("pyvenv.cfg").is_file() && interpreter.is_file() && real(&env) {
                return Some(interpreter);
            }
        }
        match workspace {
            Some(root) if current != root && current.starts_with(root) => dir = current.parent(),
            _ => break,
        }
    }
    None
}

/// `python "C:\ws\hello.py"` in `C:\ws` -> `python hello.py`.
fn friendly_command(tokens: &[String], cwd: &Path) -> String {
    let shown: Vec<String> = tokens
        .iter()
        .enumerate()
        .map(|(index, token)| {
            if index == 0 {
                return token.clone();
            }
            match Path::new(token).strip_prefix(cwd) {
                Ok(relative) if !relative.as_os_str().is_empty() => {
                    relative.to_string_lossy().into_owned()
                }
                _ => token.clone(),
            }
        })
        .collect();
    command_line(&shown)
}

fn validate_file(file: &Path) -> Result<PathBuf, RunError> {
    if file.as_os_str().is_empty() || file.to_string_lossy().contains('\0') || !file.is_absolute() {
        return Err(RunError::FileMissing(file.to_path_buf()));
    }
    if !file.is_file() {
        return Err(RunError::FileMissing(file.to_path_buf()));
    }
    let mut head = vec![0u8; BINARY_SNIFF_BYTES];
    let read = fs::File::open(file)
        .and_then(|mut handle| handle.read(&mut head))
        .map_err(|_| RunError::FileMissing(file.to_path_buf()))?;
    if openmind_fs::looks_binary(&head[..read]) {
        return Err(RunError::BinaryFile(file.to_path_buf()));
    }
    Ok(file.to_path_buf())
}

/// The open workspace folder, else the file's own folder, else the app's.
fn working_directory(
    workspace: Option<&Path>,
    file: &Path,
    app_root: &Path,
) -> Result<PathBuf, RunError> {
    let candidates = [workspace, file.parent(), Some(app_root)];
    for candidate in candidates.into_iter().flatten() {
        if candidate.is_dir() {
            return Ok(candidate.to_path_buf());
        }
    }
    Err(RunError::BadWorkingDirectory(app_root.to_path_buf()))
}

fn resolve_program(
    kind: RunnableKind,
    custom: bool,
    tokens: &[String],
    environment: &RunEnvironment,
    project_dirs: &[PathBuf],
    system_path: Option<&std::ffi::OsStr>,
) -> Result<ResolvedExecutable, RunError> {
    let program = tokens.first().map(String::as_str).unwrap_or_default();
    if !is_bare_name(program) {
        return Err(RunError::BadCommand(format!(
            "the program \"{program}\" must be a plain command name (python, node, ...), not a path"
        )));
    }
    let lookup = |name: &str| resolve_executable(name, environment, project_dirs, system_path);
    if let Some(found) = lookup(program) {
        // PHP is only run from an OpenMind portable runtime: a machine's XAMPP/WAMP
        // PHP is never presented as the runtime, and nothing here installs one yet.
        if kind == RunnableKind::Php && found.source != RuntimeSource::Portable {
            return Err(RunError::RuntimeMissing {
                runtime: kind.display_name().to_string(),
            });
        }
        return Ok(found);
    }
    // TypeScript has no built-in interpreter: try the other well-known runner.
    if kind == RunnableKind::TypeScript && !custom {
        if let Some(found) = lookup("ts-node") {
            return Ok(found);
        }
        return Err(RunError::NoTypeScriptRunner);
    }
    let runtime = if program.eq_ignore_ascii_case(default_program(kind)) {
        kind.display_name().to_string()
    } else {
        program.to_string()
    };
    Err(RunError::RuntimeMissing { runtime })
}

fn default_program(kind: RunnableKind) -> &'static str {
    match kind {
        RunnableKind::Python => "python",
        RunnableKind::Node => "node",
        RunnableKind::Php => "php",
        RunnableKind::TypeScript => "tsx",
        RunnableKind::C => "clang",
        RunnableKind::Cpp => "clang++",
        RunnableKind::Java => "javac",
        RunnableKind::Rust => "rustc",
        RunnableKind::Fortran => "gfortran",
        RunnableKind::Pascal => "fpc64",
        RunnableKind::MariaDb => "mysqld",
    }
}

/// Portable runtime folders, then (for a project-local tool) the project's
/// `.bin`, then the existing PATH. Built for this child only.
pub(crate) fn child_path(
    environment: &RunEnvironment,
    project_dirs: &[PathBuf],
    resolved: &ResolvedExecutable,
    system_path: Option<OsString>,
) -> Result<OsString, RunError> {
    let mut dirs: Vec<PathBuf> = environment.path_prepend.clone();
    if resolved.source == RuntimeSource::Project {
        dirs.extend(project_dirs.iter().cloned());
    }
    openmind_core::path_env::prepend_path(&dirs, system_path.as_deref()).ok_or_else(|| {
        RunError::BadCommand("a PATH folder contains a '\"' or other invalid character".into())
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn program_arguments_are_split_like_a_shell_but_never_run_through_one() {
        assert!(program_arguments(None).expect("none").is_empty());
        assert!(program_arguments(Some("   ")).expect("blank").is_empty());
        assert_eq!(
            program_arguments(Some(r#"3 "two words" 'a&b|c' $HOME"#)).expect("args"),
            ["3", "two words", "a&b|c", "$HOME"]
        );
        let unclosed = program_arguments(Some("a \"open")).expect_err("unclosed quote");
        assert_eq!(
            unclosed.to_string(),
            "The program arguments aren't valid: a quote is never closed. Change them with Run Code with Arguments..."
        );
        assert!(program_arguments(Some("a\nb")).is_err());
        assert!(program_arguments(Some(&"x".repeat(9000))).is_err());
    }

    struct Fixture {
        dir: tempfile::TempDir,
        env: RunEnvironment,
        system: OsString,
    }

    fn exe(dir: &Path, name: &str) -> PathBuf {
        fs::create_dir_all(dir).expect("dir");
        let path = dir.join(if cfg!(windows) {
            format!("{name}.exe")
        } else {
            name.into()
        });
        fs::write(&path, b"x").expect("exe");
        path
    }

    fn fixture() -> Fixture {
        let dir = tempfile::tempdir().expect("tempdir");
        let portable = dir
            .path()
            .join("runtimes")
            .join("python")
            .join("versions")
            .join("3.14.7");
        exe(&portable, "python");
        exe(&dir.path().join("system"), "python");
        exe(&dir.path().join("system"), "node");
        let env = RunEnvironment {
            path_prepend: vec![portable],
            vars: vec![("PYTHONNOUSERSITE".into(), "1".into())],
        };
        let system = std::env::join_paths([dir.path().join("system")]).expect("join");
        Fixture { dir, env, system }
    }

    fn script(dir: &Path, name: &str, body: &str) -> PathBuf {
        fs::create_dir_all(dir).expect("dir");
        let path = dir.join(name);
        fs::write(&path, body).expect("script");
        path
    }

    fn request(file: PathBuf, workspace: Option<PathBuf>) -> RunRequest {
        RunRequest {
            file,
            arguments: None,
            workspace,
            template: None,
        }
    }

    fn make(fx: &Fixture, req: &RunRequest) -> Result<RunPlan, RunError> {
        plan(
            req,
            &fx.env,
            fx.dir.path(),
            Some(fx.system.clone()),
            &fx.dir.path().join("build"),
        )
    }

    #[test]
    fn a_python_file_in_a_project_with_its_own_environment_runs_with_it() {
        let fx = fixture();
        let workspace = fx.dir.path().join("My Work");
        let project = workspace.join("py app");
        let file = script(&project.join("src"), "main.py", "import requests");
        let env = project.join(".venv");
        let interpreter = if cfg!(windows) {
            exe(&env.join("Scripts"), "python")
        } else {
            exe(&env.join("bin"), "python")
        };
        // Without pyvenv.cfg it isn't an environment.
        let portable = make(&fx, &request(file.clone(), Some(workspace.clone()))).expect("plan");
        assert_eq!(portable.source, RuntimeSource::Portable);
        fs::write(env.join("pyvenv.cfg"), "version = 3.14.7\n").expect("cfg");

        let plan = make(&fx, &request(file.clone(), Some(workspace.clone()))).expect("plan");
        assert_eq!(plan.resolved, interpreter);
        assert_eq!(plan.source, RuntimeSource::Project);
        assert_eq!(plan.runtime_label, "Project environment .venv");
        let dirs: Vec<PathBuf> = std::env::split_paths(&plan.path_var).collect();
        assert_eq!(
            dirs[1],
            interpreter.parent().expect("dir"),
            "portable first, then the environment's folder"
        );

        // Never above the workspace: an environment beside the workspace isn't the project's.
        let outside = fx.dir.path().join("elsewhere");
        let loose = script(&outside.join("deep"), "a.py", "1");
        let env2 = outside.join(".venv");
        if cfg!(windows) {
            exe(&env2.join("Scripts"), "python");
        } else {
            exe(&env2.join("bin"), "python");
        }
        fs::write(env2.join("pyvenv.cfg"), "").expect("cfg");
        let other = make(&fx, &request(loose, Some(outside.join("deep")))).expect("plan");
        assert_eq!(other.source, RuntimeSource::Portable);
    }

    #[test]
    fn python_runs_with_the_portable_interpreter_and_its_environment() {
        let fx = fixture();
        let file = script(&fx.dir.path().join("proj"), "hello.py", "print(1)");

        let plan = make(
            &fx,
            &request(file.clone(), Some(fx.dir.path().join("proj"))),
        )
        .expect("plan");

        assert_eq!(plan.kind, RunnableKind::Python);
        assert_eq!(plan.source, RuntimeSource::Portable);
        assert!(plan.argv[0].contains("versions"), "{:?}", plan.argv);
        assert_eq!(plan.argv[1], file.to_string_lossy());
        assert_eq!(plan.runtime_label, "OpenMind portable Python 3.14.7");
        assert!(plan.env.contains(&("PYTHONNOUSERSITE".into(), "1".into())));
        assert!(plan.env.contains(&("PYTHONUNBUFFERED".into(), "1".into())));
    }

    #[test]
    fn the_child_path_starts_with_the_portable_folders_then_the_system_path() {
        let fx = fixture();
        let file = script(fx.dir.path(), "a.py", "1");

        let plan = make(&fx, &request(file, None)).expect("plan");

        let dirs: Vec<PathBuf> = std::env::split_paths(&plan.path_var).collect();
        assert_eq!(dirs[0], fx.env.path_prepend[0]);
        assert_eq!(dirs[1], fx.dir.path().join("system"));
    }

    #[test]
    fn without_a_portable_runtime_the_system_one_is_used_and_labelled_so() {
        let fx = fixture();
        let file = script(fx.dir.path(), "a.js", "1");

        let plan = make(&fx, &request(file, None)).expect("plan");

        assert_eq!(plan.source, RuntimeSource::System);
        assert_eq!(plan.runtime_label, "System Node.js");
        assert_eq!(plan.resolved, fx.dir.path().join("system").join(node_exe()));
    }

    fn node_exe() -> &'static str {
        if cfg!(windows) {
            "node.exe"
        } else {
            "node"
        }
    }

    #[test]
    fn the_display_command_is_friendly_and_the_resolved_interpreter_is_separate() {
        let fx = fixture();
        let workspace = fx.dir.path().join("My Projects");
        let file = script(&workspace.join("sub"), "hello.py", "1");

        let plan = make(&fx, &request(file.clone(), Some(workspace))).expect("plan");

        assert_eq!(
            plan.display,
            format!("python sub{}hello.py", std::path::MAIN_SEPARATOR)
        );
        assert!(plan.resolved.is_absolute());
        assert!(plan.resolved.to_string_lossy().contains("versions"));
        assert_eq!(plan.argv[0], plan.resolved.to_string_lossy());
        // What actually runs still gets the absolute file path.
        assert_eq!(plan.argv[1], file.to_string_lossy());
    }

    #[test]
    fn a_machine_php_is_never_used_only_a_portable_one() {
        let mut fx = fixture();
        // A XAMPP-style PHP on the system PATH.
        exe(&fx.dir.path().join("system"), "php");
        let file = script(fx.dir.path(), "index.php", "<?php");

        let error = make(&fx, &request(file.clone(), None)).expect_err("system php refused");
        assert_eq!(error.to_string(), "PHP runtime is not installed yet.");

        // A portable PHP is used, and labelled as portable.
        let portable = fx
            .dir
            .path()
            .join("runtimes")
            .join("php")
            .join("versions")
            .join("8.4.1");
        exe(&portable, "php");
        fx.env.path_prepend.push(portable);
        let plan = make(&fx, &request(file, None)).expect("portable php");
        assert_eq!(plan.source, RuntimeSource::Portable);
        assert_eq!(plan.runtime_label, "OpenMind portable PHP 8.4.1");
    }

    #[test]
    fn a_missing_runtime_is_a_clear_error_naming_it() {
        let fx = fixture();
        let file = script(fx.dir.path(), "index.php", "<?php");

        let error = make(&fx, &request(file, None)).expect_err("must fail");

        assert!(matches!(&error, RunError::RuntimeMissing { runtime } if runtime == "PHP"));
        assert_eq!(error.to_string(), "PHP runtime is not installed yet.");
    }

    #[test]
    fn typescript_needs_a_runner_and_says_so_otherwise() {
        let fx = fixture();
        let file = script(fx.dir.path(), "a.ts", "1");

        let error = make(&fx, &request(file.clone(), None)).expect_err("must fail");
        assert!(matches!(error, RunError::NoTypeScriptRunner));

        // A project-local tsx makes it runnable.
        let workspace = fx.dir.path().join("proj");
        exe(&workspace.join("node_modules").join(".bin"), "tsx");
        exe(&fx.dir.path().join("system"), "tsx");
        let plan = make(&fx, &request(file, Some(workspace.clone()))).expect("plan");
        assert_eq!(plan.source, RuntimeSource::Project);
        let dirs: Vec<PathBuf> = std::env::split_paths(&plan.path_var).collect();
        assert!(dirs.contains(&workspace.join("node_modules").join(".bin")));
    }

    #[test]
    fn unsupported_files_and_missing_files_are_refused_with_reasons() {
        let fx = fixture();
        let md = script(fx.dir.path(), "README.md", "# hi");
        let json = script(fx.dir.path(), "package.json", "{}");

        assert!(
            matches!(make(&fx, &request(md, None)), Err(RunError::NotRunnable(r)) if r.contains("preview"))
        );
        assert!(matches!(
            make(&fx, &request(json, None)),
            Err(RunError::NotRunnable(_))
        ));
        assert!(matches!(
            make(&fx, &request(fx.dir.path().join("gone.py"), None)),
            Err(RunError::FileMissing(_))
        ));
        assert!(matches!(
            make(&fx, &request(PathBuf::from("relative.py"), None)),
            Err(RunError::FileMissing(_))
        ));
    }

    #[test]
    fn a_binary_file_with_a_script_extension_is_never_run() {
        let fx = fixture();
        let file = fx.dir.path().join("fake.py");
        fs::write(&file, b"MZ\0\0\x90\0").expect("write");

        assert!(matches!(
            make(&fx, &request(file, None)),
            Err(RunError::BinaryFile(_))
        ));
    }

    #[test]
    fn the_working_directory_is_the_workspace_then_the_files_folder_then_the_app() {
        let fx = fixture();
        let workspace = fx.dir.path().join("ws");
        fs::create_dir_all(&workspace).expect("ws");
        let file = script(&fx.dir.path().join("elsewhere"), "a.py", "1");

        let with_workspace =
            make(&fx, &request(file.clone(), Some(workspace.clone()))).expect("plan");
        let without = make(&fx, &request(file.clone(), None)).expect("plan");
        let stale = make(&fx, &request(file, Some(fx.dir.path().join("deleted")))).expect("plan");

        assert_eq!(with_workspace.cwd, workspace);
        assert_eq!(without.cwd, fx.dir.path().join("elsewhere"));
        assert_eq!(stale.cwd, fx.dir.path().join("elsewhere"));
    }

    #[test]
    fn a_path_with_spaces_is_one_argument_and_the_command_line_shows_it_quoted() {
        let fx = fixture();
        let file = script(
            &fx.dir.path().join("My Projects").join("demo app"),
            "hello world.py",
            "1",
        );

        let plan = make(&fx, &request(file.clone(), None)).expect("plan");

        assert_eq!(plan.argv.len(), 2);
        assert_eq!(plan.argv[1], file.to_string_lossy());
        assert_eq!(plan.display, "python \"hello world.py\"");
    }

    #[test]
    fn a_custom_template_can_add_arguments_but_not_point_at_a_path_or_use_shell_syntax() {
        let fx = fixture();
        let file = script(fx.dir.path(), "a.py", "1");
        let with = |template: &str| RunRequest {
            file: file.clone(),
            workspace: None,
            template: Some(template.into()),
            arguments: None,
        };

        let ok = make(&fx, &with("python -u \"${file}\" --flag")).expect("plan");
        assert_eq!(&ok.argv[1..], ["-u", &file.to_string_lossy(), "--flag"]);

        let absolute = fx.env.path_prepend[0].join("python.exe");
        assert!(matches!(
            make(
                &fx,
                &with(&format!("\"{}\" \"${{file}}\"", absolute.display()))
            ),
            Err(RunError::BadCommand(_))
        ));
        assert!(matches!(make(&fx, &with("")), Err(RunError::BadCommand(_))));
        assert!(matches!(
            make(&fx, &with("python \"${nope}\"")),
            Err(RunError::BadCommand(_))
        ));
        // `&&` is just an argument to python, never a second command.
        let chained = make(&fx, &with("python \"${file}\" && calc")).expect("plan");
        assert_eq!(&chained.argv[2..], ["&&", "calc"]);
    }

    #[test]
    fn a_custom_program_that_does_not_exist_is_reported_by_name() {
        let fx = fixture();
        let file = script(fx.dir.path(), "a.py", "1");
        let req = RunRequest {
            file,
            arguments: None,
            workspace: None,
            template: Some("pypy \"${file}\"".into()),
        };

        let error = make(&fx, &req).expect_err("must fail");

        assert_eq!(error.to_string(), "pypy runtime is not installed yet.");
    }
}
