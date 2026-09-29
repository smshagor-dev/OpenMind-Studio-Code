//! Plans and inspection over real temporary folders (paths with spaces): what each operation would run, where the
//! packages go, and that nothing global, unsafe or unvalidated gets through.

use std::fs;
use std::path::{Path, PathBuf};

use openmind_deps::{inspect, plan, Network, Op, PlanContext, Resolved, SetupKind};

struct Fx {
    _temp: tempfile::TempDir,
    root: PathBuf,
    portable: PathBuf,
}

fn fx() -> Fx {
    let temp = tempfile::tempdir().expect("tempdir");
    let root = temp.path().join("My Projects");
    let portable = temp
        .path()
        .join("OpenMind Studio/runtimes/python/versions/3.14.7/python.exe");
    fs::create_dir_all(portable.parent().expect("parent")).expect("dir");
    fs::write(&portable, "MZ").expect("python");
    fs::create_dir_all(&root).expect("root");
    Fx {
        _temp: temp,
        root,
        portable,
    }
}

fn write(path: &Path, text: &str) {
    fs::create_dir_all(path.parent().expect("parent")).expect("dir");
    fs::write(path, text).expect("write");
}

/// Every tool exists as `<name>.cmd` in a fake folder, except those in `missing`.
fn tools(missing: &'static [&'static str]) -> impl Fn(&str) -> Option<Resolved> {
    move |name: &str| {
        (!missing.contains(&name)).then(|| Resolved {
            path: PathBuf::from(format!(r"C:\tools\{name}.cmd")),
            source: "system".into(),
        })
    }
}

fn ctx<'a>(
    fx: &'a Fx,
    project: &'a Path,
    tool: &'a dyn Fn(&str) -> Option<Resolved>,
) -> PlanContext<'a> {
    PlanContext {
        project,
        python_env: None,
        portable_python: Some(fx.portable.clone()),
        node_manager: None,
        tool,
        pip_cache: PathBuf::from(r"C:\app\cache\pip"),
        wheelhouse: fx.root.join("no-wheels"),
    }
}

fn make_venv(project: &Path, name: &str) {
    write(
        &project.join(name).join("pyvenv.cfg"),
        "home = C:\\app\\runtimes\\python\\versions\\3.14.7\nversion = 3.14.7\n",
    );
    write(&project.join(name).join("Scripts").join("python.exe"), "MZ");
    write(
        &project
            .join(name)
            .join("Lib/site-packages/requests-2.34.2.dist-info/METADATA"),
        "",
    );
}

#[test]
fn python_packages_go_into_the_project_environment_else_openmind_python_never_the_user() {
    let fx = fx();
    let project = fx.root.join("py app");
    write(&project.join("requirements.txt"), "requests\nnumpy>=2\n");
    let tool = tools(&[]);

    let without_env = plan(
        &Op::PythonAdd {
            packages: "requests".into(),
            offline: false,
        },
        &ctx(&fx, &project, &tool),
    )
    .expect("plan");
    assert_eq!(without_env.program, fx.portable.to_string_lossy());
    assert!(without_env.target.starts_with("OpenMind's portable Python"));
    assert_eq!(
        without_env.args,
        [
            "-m",
            "pip",
            "install",
            r"--cache-dir=C:\app\cache\pip",
            "requests"
        ]
    );

    make_venv(&project, ".venv");
    let with_env = plan(
        &Op::PythonAdd {
            packages: "requests pandas==3.0".into(),
            offline: false,
        },
        &ctx(&fx, &project, &tool),
    )
    .expect("plan");
    assert!(
        with_env.program.ends_with(r".venv\Scripts\python.exe")
            || with_env.program.ends_with(".venv/Scripts/python.exe")
    );
    assert!(with_env.target.ends_with("(project environment)"));
    assert_eq!(with_env.cwd, project.to_string_lossy());
    for plan in [&without_env, &with_env] {
        assert!(!plan
            .args
            .iter()
            .any(|a| a == "--user" || a.starts_with("--target") || a.starts_with("--prefix")));
        assert_eq!(plan.network, Network::Required);
    }

    let requirements =
        plan(&Op::PythonInstallRequirements, &ctx(&fx, &project, &tool)).expect("plan");
    assert_eq!(
        &requirements.args[2..],
        [
            "install",
            r"--cache-dir=C:\app\cache\pip",
            "-r",
            "requirements.txt"
        ]
    );
    let remove = plan(
        &Op::PythonRemove {
            package: "requests".into(),
        },
        &ctx(&fx, &project, &tool),
    )
    .expect("plan");
    assert_eq!(remove.args, ["-m", "pip", "uninstall", "-y", "requests"]);
    let update = plan(
        &Op::PythonUpdate {
            package: "requests".into(),
        },
        &ctx(&fx, &project, &tool),
    )
    .expect("plan");
    assert_eq!(
        &update.args[2..],
        [
            "install",
            r"--cache-dir=C:\app\cache\pip",
            "--upgrade",
            "requests"
        ]
    );
}

#[test]
fn python_names_and_environments_are_validated() {
    let fx = fx();
    let project = fx.root.join("py");
    write(&project.join("requirements.txt"), "x\n");
    let tool = tools(&[]);
    let c = ctx(&fx, &project, &tool);
    for bad in [
        "requests; calc",
        "--user requests",
        "-e .",
        "https://evil/x.whl",
        "../x",
        "a&b",
        "",
    ] {
        assert!(
            plan(
                &Op::PythonAdd {
                    packages: bad.into(),
                    offline: false
                },
                &c
            )
            .is_err(),
            "{bad:?}"
        );
    }
    assert!(plan(
        &Op::PythonRemove {
            package: "requests==1".into()
        },
        &c
    )
    .is_err());
    assert!(plan(
        &Op::PythonAdd {
            packages: "tkinter".into(),
            offline: false
        },
        &c
    )
    .expect_err("stdlib")
    .0
    .contains("part of Python"));
    let mut chosen = ctx(&fx, &project, &tool);
    chosen.python_env = Some("..\\elsewhere".into());
    assert!(plan(
        &Op::PythonAdd {
            packages: "x".into(),
            offline: false
        },
        &chosen
    )
    .is_err());
    let mut none = ctx(&fx, &project, &tool);
    none.portable_python = None;
    let refused = plan(
        &Op::PythonAdd {
            packages: "x".into(),
            offline: false,
        },
        &none,
    )
    .expect_err("no python");
    assert!(refused.0.contains("never installed into your own Python"));
    // Offline needs the wheelhouse.
    assert!(plan(
        &Op::PythonAdd {
            packages: "x".into(),
            offline: true
        },
        &c
    )
    .expect_err("no wheels")
    .0
    .contains("wheel"));
}

#[test]
fn a_project_environment_is_created_from_openmind_python_only_and_never_over_an_existing_one() {
    let fx = fx();
    let project = fx.root.join("new app");
    write(
        &project.join("pyproject.toml"),
        "[project]\nname = \"x\"\ndependencies = [\"httpx>=0.27\", \"rich\"]\n",
    );
    let tool = tools(&[]);
    let create = plan(&Op::PythonCreateEnv, &ctx(&fx, &project, &tool)).expect("plan");
    assert_eq!(create.program, fx.portable.to_string_lossy());
    assert_eq!(create.args, ["-m", "venv", ".venv"]);
    assert_eq!(create.network, Network::None);
    let pyproject = plan(&Op::PythonInstallPyproject, &ctx(&fx, &project, &tool)).expect("plan");
    assert_eq!(pyproject.packages, ["httpx>=0.27", "rich"]);
    assert!(
        !pyproject.args.iter().any(|a| a == "." || a == "-e"),
        "the project itself is never built"
    );
    make_venv(&project, ".venv");
    assert!(plan(&Op::PythonCreateEnv, &ctx(&fx, &project, &tool)).is_err());
}

#[test]
fn node_commands_are_project_local_for_each_package_manager_and_conflicts_are_not_guessed() {
    let fx = fx();
    let project = fx.root.join("web app");
    write(
        &project.join("package.json"),
        r#"{"dependencies":{"left-pad":"^1.3.0"},"scripts":{"dev":"vite","bad name":"x","x&calc":"y"}}"#,
    );
    let tool = tools(&[]);
    let c = ctx(&fx, &project, &tool);
    let add = plan(
        &Op::NodeAdd {
            package: "lodash".into(),
            dev: true,
        },
        &c,
    )
    .expect("plan");
    assert_eq!(
        (add.manager.as_str(), add.args.clone()),
        (
            "npm",
            vec!["install".to_string(), "--save-dev".into(), "lodash".into()]
        )
    );
    let run = plan(
        &Op::NodeRunScript {
            script: "dev".into(),
        },
        &c,
    )
    .expect("plan");
    assert_eq!(run.args, ["run", "dev"]);
    for script in ["bad name", "x&calc", "missing"] {
        assert!(
            plan(
                &Op::NodeRunScript {
                    script: script.into()
                },
                &c
            )
            .is_err(),
            "{script}"
        );
    }
    for bad in ["-g", "lodash -g", "lodash&calc", "../x", "Lodash", "\"x\""] {
        assert!(
            plan(
                &Op::NodeAdd {
                    package: bad.into(),
                    dev: false
                },
                &c
            )
            .is_err(),
            "{bad}"
        );
    }
    write(&project.join("pnpm-lock.yaml"), "");
    let pnpm = plan(
        &Op::NodeAdd {
            package: "lodash".into(),
            dev: true,
        },
        &ctx(&fx, &project, &tool),
    )
    .expect("plan");
    assert_eq!(
        (pnpm.manager.as_str(), pnpm.args.clone()),
        (
            "pnpm",
            vec!["add".to_string(), "-D".into(), "lodash".into()]
        )
    );
    write(&project.join("yarn.lock"), "");
    let conflict = plan(&Op::NodeInstall, &ctx(&fx, &project, &tool)).expect_err("conflict");
    assert!(conflict.0.contains("choose the package manager"));
    let mut chosen = ctx(&fx, &project, &tool);
    chosen.node_manager = Some("yarn".into());
    let yarn = plan(
        &Op::NodeUpdate {
            package: "left-pad".into(),
        },
        &chosen,
    )
    .expect("plan");
    assert_eq!(yarn.args, ["upgrade", "left-pad"]);
    for plan in [&add, &pnpm, &yarn, &run] {
        assert!(!plan
            .args
            .iter()
            .any(|a| a == "-g" || a == "--global" || a == "global"));
        assert_eq!(plan.cwd, project.to_string_lossy());
    }
    let missing = tools(&["npm"]);
    let mut no_npm = ctx(&fx, &project, &missing);
    no_npm.node_manager = Some("npm".into());
    assert!(plan(&Op::NodeInstall, &no_npm)
        .expect_err("missing")
        .0
        .contains("Runtime Manager"));
}

#[test]
fn composer_cargo_maven_gradle_and_cmake_plans() {
    let fx = fx();
    let tool = tools(&[]);
    let php = fx.root.join("php app");
    write(
        &php.join("composer.json"),
        r#"{"require":{"monolog/monolog":"^3"}}"#,
    );
    let require = plan(
        &Op::ComposerRequire {
            package: "psr/log".into(),
            dev: true,
        },
        &ctx(&fx, &php, &tool),
    )
    .expect("plan");
    assert_eq!(require.args, ["require", "--dev", "psr/log"]);
    assert!(plan(
        &Op::ComposerRequire {
            package: "psr/log&calc".into(),
            dev: false
        },
        &ctx(&fx, &php, &tool)
    )
    .is_err());
    assert!(!require.args.iter().any(|a| a == "global"));

    let rust = fx.root.join("rust app");
    write(
        &rust.join("Cargo.toml"),
        "[package]\nname = \"a\"\nversion = \"0.1.0\"\n",
    );
    assert_eq!(
        plan(
            &Op::Cargo {
                command: "check".into()
            },
            &ctx(&fx, &rust, &tool)
        )
        .expect("plan")
        .args,
        ["check"]
    );
    assert!(plan(
        &Op::Cargo {
            command: "install".into()
        },
        &ctx(&fx, &rust, &tool)
    )
    .is_err());
    let no_cargo = tools(&["cargo"]);
    assert!(plan(
        &Op::Cargo {
            command: "build".into()
        },
        &ctx(&fx, &rust, &no_cargo)
    )
    .expect_err("rustup")
    .0
    .contains("rustup"));

    let java = fx.root.join("java app");
    write(&java.join("pom.xml"), "<project/>");
    write(&java.join("build.gradle"), "");
    write(
        &java.join(if cfg!(windows) {
            "gradlew.bat"
        } else {
            "gradlew"
        }),
        "",
    );
    let gradle = plan(
        &Op::Gradle {
            task: "build".into(),
        },
        &ctx(&fx, &java, &tool),
    )
    .expect("plan");
    assert_eq!(
        gradle.source, "project Gradle wrapper",
        "the wrapper is preferred"
    );
    assert_eq!(
        plan(
            &Op::Maven {
                goal: "package".into()
            },
            &ctx(&fx, &java, &tool)
        )
        .expect("plan")
        .args,
        ["package"]
    );
    assert!(plan(
        &Op::Maven {
            goal: "deploy".into()
        },
        &ctx(&fx, &java, &tool)
    )
    .is_err());

    let native = fx.root.join("c app");
    write(&native.join("CMakeLists.txt"), "project(x)");
    let configure = plan(
        &Op::CmakeConfigure { preset: None },
        &ctx(&fx, &native, &tool),
    )
    .expect("plan");
    assert_eq!(
        configure.args[..4],
        [
            "-S".to_string(),
            native.to_string_lossy().into_owned(),
            "-B".into(),
            native.join("build").to_string_lossy().into_owned()
        ]
    );
    assert!(plan(&Op::CmakeBuild, &ctx(&fx, &native, &tool))
        .expect_err("configure first")
        .0
        .contains("Configure"));
    assert!(plan(
        &Op::CmakeConfigure {
            preset: Some("nope".into())
        },
        &ctx(&fx, &native, &tool)
    )
    .is_err());
}

#[test]
fn inspection_finds_projects_skips_dependency_folders_and_reports_setup_gaps() {
    let fx = fx();
    write(
        &fx.root.join("py app/requirements.txt"),
        "requests\nnumpy\n",
    );
    write(
        &fx.root.join("web app/package.json"),
        r#"{"dependencies":{"left-pad":"1.3.0"},"scripts":{"dev":"vite"}}"#,
    );
    write(
        &fx.root.join("done app/package.json"),
        r#"{"dependencies":{"deep-pkg":"1"}}"#,
    );
    write(
        &fx.root.join("done app/node_modules/deep-pkg/package.json"),
        r#"{"version":"1.0.4","dependencies":{"x":"1"}}"#,
    );
    write(
        &fx.root.join("php app/composer.json"),
        r#"{"require":{"monolog/monolog":"^3"}}"#,
    );
    write(
        &fx.root.join("vendor/other/composer.json"),
        r#"{"require":{"a/b":"1"}}"#,
    );
    make_venv(&fx.root.join("env app"), ".venv");
    write(
        &fx.root.join("env app/requirements.txt"),
        "requests\nflask\n",
    );

    let snapshot = inspect(&fx.root, Some(fx.portable.parent().expect("dir")));
    let roots: Vec<&str> = snapshot.projects.iter().map(|p| p.root.as_str()).collect();
    assert!(
        roots.contains(&"py app")
            && roots.contains(&"web app")
            && roots.contains(&"php app")
            && roots.contains(&"env app"),
        "{roots:?}"
    );
    assert!(
        !roots
            .iter()
            .any(|r| r.contains("node_modules") || r.starts_with("vendor")),
        "{roots:?}"
    );
    let by = |root: &str| {
        snapshot
            .projects
            .iter()
            .find(|p| p.root == root)
            .expect(root)
    };
    assert_eq!(by("py app").setup[0].kind, SetupKind::PythonNoEnv);
    assert_eq!(by("web app").setup[0].kind, SetupKind::NodeNotInstalled);
    assert_eq!(by("php app").setup[0].kind, SetupKind::ComposerNotInstalled);
    let installed = by("done app").node.as_ref().expect("node");
    assert!(by("done app").setup.is_empty());
    assert_eq!(
        installed.dependencies[0].installed.as_deref(),
        Some("1.0.4")
    );
    let env = by("env app").python.as_ref().expect("python");
    assert!(by("env app").setup.is_empty());
    assert_eq!(env.environments[0].name, ".venv");
    assert!(env.environments[0].from_openmind);
    assert_eq!(env.missing, ["flask"]);
    assert_eq!(env.requirements[0].installed.as_deref(), Some("2.34.2"));
}

#[test]
fn malformed_manifests_are_reported_not_trusted() {
    let fx = fx();
    let project = fx.root.join("broken");
    write(&project.join("package.json"), "{ not json");
    write(&project.join("pyproject.toml"), "[project\n");
    write(&project.join("composer.json"), "[1,2");
    let snapshot = inspect(&fx.root, None);
    let broken = snapshot
        .projects
        .iter()
        .find(|p| p.root == "broken")
        .expect("broken");
    assert!(broken.node.as_ref().expect("node").notes[0].contains("isn't valid JSON"));
    assert!(broken.python.as_ref().expect("python").notes[0].contains("isn't valid TOML"));
    assert!(broken.php.as_ref().expect("php").require.is_empty());
}
