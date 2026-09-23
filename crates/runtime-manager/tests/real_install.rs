//! Installs the real, built-in Python and Git manifests from the internet into
//! a temporary folder and exercises the result. Ignored by default (it
//! downloads ~55 MB); run with:
//!
//! `cargo test -p openmind-runtime-manager --test real_install -- --ignored --nocapture`

#![cfg(windows)]

use std::path::Path;
use std::process::Command;
use std::sync::Arc;

use openmind_db::Db;
use openmind_runtime_manager::manager::ProgressSink;
use openmind_runtime_manager::{
    current_platform, join_path, RuntimeEnvironment, RuntimeManager, RuntimePaths, RuntimeRegistry,
    UreqClient,
};

async fn manager(root: &Path) -> RuntimeManager {
    let db = Db::connect(&root.join("data").join("test.db"))
        .await
        .expect("db");
    RuntimeManager::new(
        db,
        RuntimePaths::new(root.join("runtimes"), root.join("cache")),
        RuntimeRegistry::builtin(),
        Arc::new(UreqClient::new()),
        current_platform(),
    )
}

fn no_progress() -> ProgressSink {
    Arc::new(|_| {})
}

/// Runs `program args` with the runtime environment's folders first on PATH.
fn run(
    program: &str,
    args: &[&str],
    environment: &RuntimeEnvironment,
    cwd: &Path,
) -> (bool, String) {
    // `pip` is a `.cmd` shim, which needs a shell to be found and run.
    let mut command = if program == "pip" {
        let mut command = Command::new("cmd");
        command.args(["/C", "pip"]);
        command
    } else {
        Command::new(program)
    };
    let output = command
        .args(args)
        .current_dir(cwd)
        .envs(environment.vars.iter().cloned())
        .env(
            "PATH",
            join_path(environment.path_prepend.clone(), std::env::var_os("PATH")),
        )
        .output()
        .expect("spawn");
    let text = format!(
        "{}{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
    (output.status.success(), text.trim().to_string())
}

#[tokio::test(flavor = "multi_thread")]
#[ignore = "downloads Python and Git from the internet"]
async fn python_installs_with_pip_and_venv_and_git_can_init_a_repo() {
    let dir = tempfile::tempdir().expect("tempdir");
    let manager = manager(dir.path()).await;

    let python = manager
        .install("python", None, no_progress())
        .await
        .expect("python install");
    assert!(python.healthy);
    assert!(python.features.iter().all(|f| f.available), "{python:?}");

    let git = manager
        .install("git", None, no_progress())
        .await
        .expect("git install");
    assert!(git.healthy);

    let environment = manager.environment().await.expect("environment");
    let dirs = &environment;
    let work = dir.path().join("work");
    std::fs::create_dir_all(&work).expect("work");

    let (ok, text) = run("python", &["--version"], dirs, &work);
    assert!(ok && text.starts_with("Python 3."), "{text}");
    let (ok, text) = run("pip", &["--version"], dirs, &work);
    assert!(ok && text.contains("pip "), "{text}");
    assert!(
        text.contains("runtimes"),
        "pip must come from the portable runtime: {text}"
    );
    let (ok, text) = run(
        "python",
        &["-c", "import site; print(site.ENABLE_USER_SITE)"],
        dirs,
        &work,
    );
    assert!(ok && text == "False", "user site must be off: {text}");
    let (ok, text) = run("python", &["-m", "venv", "venv"], dirs, &work);
    assert!(ok, "venv failed: {text}");
    assert!(work
        .join("venv")
        .join("Scripts")
        .join("python.exe")
        .is_file());

    let (ok, text) = run("git", &["--version"], dirs, &work);
    assert!(ok && text.starts_with("git version"), "{text}");
    let (ok, text) = run("git", &["init"], dirs, &work);
    assert!(ok, "git init failed: {text}");
    let (ok, text) = run("git", &["status"], dirs, &work);
    assert!(ok && text.contains("No commits yet"), "{text}");

    // Move the whole runtimes folder (as moving the app folder would) and check
    // that the commands keep working, from the new location, via a new manager.
    let moved_root = dir.path().join("moved");
    std::fs::create_dir_all(&moved_root).expect("moved");
    std::fs::rename(dir.path().join("runtimes"), moved_root.join("runtimes")).expect("move");
    let moved = RuntimeManager::new(
        Db::connect(&dir.path().join("data").join("test.db"))
            .await
            .expect("db"),
        RuntimePaths::new(moved_root.join("runtimes"), moved_root.join("cache")),
        RuntimeRegistry::builtin(),
        Arc::new(UreqClient::new()),
        current_platform(),
    );
    let moved_env = moved.environment().await.expect("moved environment");
    assert!(moved_env
        .path_prepend
        .iter()
        .all(|p| p.starts_with(&moved_root)));
    let moved_env = &moved_env;
    let (ok, text) = run("pip", &["--version"], moved_env, &work);
    assert!(ok && text.contains("moved"), "pip after the move: {text}");
    let (ok, text) = run(
        "pip",
        &["install", "six", "--disable-pip-version-check", "-q"],
        moved_env,
        &work,
    );
    assert!(ok, "pip install after the move: {text}");
    let (ok, text) = run("python", &["-m", "pip", "--version"], moved_env, &work);
    assert!(ok && text.contains("moved"), "{text}");
    let (ok, text) = run("git", &["--version"], moved_env, &work);
    assert!(
        ok && text.starts_with("git version"),
        "git after the move: {text}"
    );
    let manager = moved;

    manager
        .delete("python", &python.version)
        .await
        .expect("delete python");
    manager
        .delete("git", &git.version)
        .await
        .expect("delete git");
    assert!(!moved_root
        .join("runtimes")
        .join("python")
        .join("shims")
        .join(&python.version)
        .exists());
    assert!(!dir
        .path()
        .join("moved")
        .join("runtimes")
        .join("python")
        .join("versions")
        .join(&python.version)
        .exists());
    assert!(manager
        .environment()
        .await
        .expect("env")
        .path_prepend
        .is_empty());
}
