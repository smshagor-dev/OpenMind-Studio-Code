//! Installing the downloadable tools of Runtime Manager > Language Tools into `<app>/tools/<id>/<version>/` (see
//! `openmind_toolchains::recipes`): npm tools from their pinned lockfile, pip tools on OpenMind's Python, PHP archives
//! and rustup-init checked by SHA-256, gopls with `go install`, the Rust toolchain with `rustup toolchain install`.
//! Everything is staged in `tools/<id>/.installing` and renamed into place only once the program is there; the install
//! is then recorded in `tools/installed.json`, which the tool list reads like the shipped manifest. Downloads go through
//! the app's network route and package gateway. Nothing is added to the system PATH or the Registry: the folders go on
//! the PATH of processes OpenMind starts only, and rustup is never "self-installed" (that would register it in Windows).

use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;

use openmind_lsp::process::{run_to_end, SpawnSpec};
use openmind_toolchains::manifest::{self, Manifest, ManifestTool, ManifestVersion};
use openmind_toolchains::recipes::{launcher, program_env, program_path, tool_dir};
use openmind_toolchains::{current_platform, known, recipe, Packs, Recipe, RecipeKind};
use tauri::{AppHandle, State};

use crate::app_state::AppState;
use crate::commands::run::environment;

/// npm, pip and go finish in minutes; the Rust toolchain downloads a few hundred MB.
const STEP_TIMEOUT: Duration = Duration::from_secs(30 * 60);

/// How long an install waits for another computer's tool install (a network installation shares `tools/`).
const SHARED_WAIT: Duration = Duration::from_secs(60 * 60);
/// The cross-computer lock file of `tools/` (see [`shared_lock`]).
const SHARED_LOCK: &str = ".install.lock";

/// The operating-system lock on `tools/.install.lock`, held for a whole install or removal: on a network installation
/// every computer shares `tools/` and its `installed.json`, so two computers must never stage, rename or record at the
/// same time. The OS releases it when the process ends (also after a crash or a lost network), so it never outlives
/// its owner; a computer that finds it held waits, then reuses what the other one installed.
fn shared_lock(root: &Path) -> Result<openmind_core::profile_lock::ProfileLock, String> {
    let file = root.join("tools").join(SHARED_LOCK);
    openmind_core::profile_lock::ProfileLock::acquire_file(&file, SHARED_WAIT).map_err(|err| {
        format!(
            "Another computer is installing a tool into {} and didn't finish in time, or the folder can't be locked: {err}",
            file.parent().map(Path::display).map(|d| d.to_string()).unwrap_or_default()
        )
    })
}

/// One tool install or removal at a time in this process (the shared lock covers other processes and computers).
fn lock() -> &'static tokio::sync::Mutex<()> {
    static LOCK: OnceLock<tokio::sync::Mutex<()>> = OnceLock::new();
    LOCK.get_or_init(|| tokio::sync::Mutex::new(()))
}

/// Collects a program's output; the last lines go into the error message when it fails.
#[derive(Clone, Default)]
struct Output(Arc<Mutex<Vec<String>>>);

impl Output {
    fn push(&self, line: &str) {
        tracing::info!(target: "tool_install", "{line}");
        if let Ok(mut lines) = self.0.lock() {
            lines.push(line.to_string());
            let excess = lines.len().saturating_sub(40);
            lines.drain(..excess);
        }
    }

    fn tail(&self) -> String {
        let lines = self.0.lock().map(|lines| lines.clone()).unwrap_or_default();
        let start = lines.len().saturating_sub(6);
        lines[start..].join(" | ")
    }
}

/// Runs one step of an install and turns a failure into a sentence with the program's last output lines.
fn run(spec: &SpawnSpec, what: &str) -> Result<(), String> {
    let output = Output::default();
    let sink = output.clone();
    match run_to_end(spec, STEP_TIMEOUT, move |line| sink.push(line)) {
        Ok(Some(0)) => Ok(()),
        Ok(Some(code)) => Err(format!("{what} exited with code {code}: {}", output.tail())),
        Ok(None) => Err(format!("{what} was stopped.")),
        Err(err) => Err(format!("{what} could not run: {err}")),
    }
}

/// Downloads `url` into the download cache (resumable, through the app's network route) and checks its SHA-256; a
/// cached copy that still matches is reused. Returns the verified file.
pub(crate) fn fetch_verified(cache: &Path, url: &str, sha256: &str) -> Result<PathBuf, String> {
    use openmind_runtime_manager::download::{download, verify_sha256};
    std::fs::create_dir_all(cache).map_err(|err| err.to_string())?;
    let name = url.rsplit('/').next().unwrap_or("download");
    let file = cache.join(format!("{}-{name}", &sha256[..12]));
    if file.is_file() && verify_sha256(&file, sha256, &mut |_, _| {}).is_ok() {
        return Ok(file);
    }
    let client = openmind_runtime_manager::UreqClient::new();
    download(&client, url, &file, None, &mut |_, _| {}).map_err(|err| err.user_message())?;
    verify_sha256(&file, sha256, &mut |_, _| {}).map_err(|err| err.user_message())?;
    Ok(file)
}

/// Where the installer takes its tools from.
struct Context {
    root: PathBuf,
    /// Mutable caches (pip, npm, Go): this computer's own cache folder.
    cache_root: PathBuf,
    /// The PATH folders and variables of a process OpenMind starts (portable runtimes, gateway settings).
    path_prepend: Vec<PathBuf>,
    vars: Vec<(String, String)>,
    node: Result<openmind_lsp::NodeExecutable, String>,
    python: Result<PathBuf, String>,
}

impl Context {
    fn spec(
        &self,
        program: PathBuf,
        args: Vec<String>,
        cwd: &Path,
        extra: Vec<(String, String)>,
    ) -> SpawnSpec {
        let mut vars = self.vars.clone();
        vars.extend(extra);
        SpawnSpec {
            program,
            args,
            cwd: cwd.to_path_buf(),
            vars,
            path_prepend: self.path_prepend.clone(),
        }
    }

    /// A tool's own cache: this computer's (never the shared folder another computer writes at the same time).
    fn cache(&self, name: &str) -> String {
        self.cache_root.join(name).display().to_string()
    }

    /// The first `name.exe` in the PATH OpenMind gives its processes (portable runtimes first), then the system PATH.
    fn find(&self, name: &str) -> Option<PathBuf> {
        let file = format!("{name}.exe");
        let system = std::env::var_os("PATH");
        self.path_prepend
            .iter()
            .cloned()
            .chain(system.iter().flat_map(std::env::split_paths))
            .map(|dir| dir.join(&file))
            .find(|path| path.is_file())
    }
}

fn install_npm(
    ctx: &Context,
    staging: &Path,
    package_json: &str,
    package_lock: &str,
) -> Result<(), String> {
    let node = ctx.node.as_ref().map_err(Clone::clone)?;
    let npm = node
        .npm_cli()
        .ok_or("npm was not found next to Node.js. Repair the Node.js runtime.")?;
    std::fs::write(staging.join("package.json"), package_json).map_err(|err| err.to_string())?;
    std::fs::write(staging.join("package-lock.json"), package_lock)
        .map_err(|err| err.to_string())?;
    let mut args = openmind_lsp::install::npm_args(&npm);
    args.retain(|arg| arg != "--loglevel=error");
    let spec = ctx.spec(
        node.path.clone(),
        args,
        staging,
        vec![
            ("npm_config_cache".into(), ctx.cache("npm")),
            ("npm_config_update_notifier".into(), "false".into()),
        ],
    );
    run(&spec, "npm")
}

fn install_pip(ctx: &Context, staging: &Path, requirement: &str) -> Result<(), String> {
    let python = ctx.python.as_ref().map_err(Clone::clone)?;
    let requirements = staging.join("requirements.txt");
    std::fs::write(&requirements, format!("{requirement}\n")).map_err(|err| err.to_string())?;
    let cache = ctx.cache_root.join("pip");
    let args =
        openmind_lsp::install::pip_args(&requirements, &staging.join("lib"), &cache, &ctx.vars);
    let mut spec = ctx.spec(
        python.clone(),
        args,
        staging,
        vec![("PYTHONNOUSERSITE".into(), "1".into())],
    );
    // `pip_args` already passes OpenMind's pip settings as options; pip's own variables stay out of its environment.
    spec.vars
        .retain(|(key, _)| !key.to_ascii_uppercase().starts_with("PIP_"));
    run(&spec, "pip")?;
    let _ = std::fs::remove_file(requirements);
    Ok(())
}

fn install_go(ctx: &Context, staging: &Path, module: &str, version: &str) -> Result<(), String> {
    let go = ctx
        .find("go")
        .ok_or("The Go SDK was not found. Install Go in the Runtimes tab first.")?;
    let extra = vec![
        ("GOBIN".into(), staging.display().to_string()),
        ("GOPATH".into(), ctx.cache("go/path")),
        ("GOMODCACHE".into(), ctx.cache("go/mod")),
        ("GOCACHE".into(), ctx.cache("go/build")),
        ("GOTOOLCHAIN".into(), "local".into()),
        ("GOTELEMETRY".into(), "off".into()),
        ("GOFLAGS".into(), "-modcacherw".into()),
    ];
    let spec = ctx.spec(
        go,
        vec!["install".into(), format!("{module}@v{version}")],
        staging,
        extra,
    );
    run(&spec, "go install")
}

/// The proxies rustup makes for itself: one copy of the rustup program per command name.
const RUST_PROXIES: &[&str] = &[
    "cargo",
    "rustc",
    "rustdoc",
    "rustfmt",
    "cargo-fmt",
    "cargo-clippy",
    "clippy-driver",
];

fn install_rust(ctx: &Context, staging: &Path, url: &str, sha256: &str) -> Result<(), String> {
    let init = fetch_verified(&ctx.root.join("cache").join("downloads"), url, sha256)?;
    let bin = staging.join("cargo").join("bin");
    std::fs::create_dir_all(&bin).map_err(|err| err.to_string())?;
    let rustup = bin.join("rustup.exe");
    std::fs::copy(&init, &rustup).map_err(|err| err.to_string())?;
    let homes = vec![
        (
            "RUSTUP_HOME".into(),
            staging.join("rustup").display().to_string(),
        ),
        (
            "CARGO_HOME".into(),
            staging.join("cargo").display().to_string(),
        ),
    ];
    let toolchain = "stable-x86_64-pc-windows-gnu";
    let install = ctx.spec(
        rustup.clone(),
        [
            "toolchain",
            "install",
            toolchain,
            "--profile",
            "minimal",
            "-c",
            "rustfmt",
            "-c",
            "clippy",
            "--no-self-update",
        ]
        .map(String::from)
        .to_vec(),
        staging,
        homes.clone(),
    );
    run(&install, "rustup")?;
    run(
        &ctx.spec(
            rustup.clone(),
            vec!["default".into(), toolchain.into()],
            staging,
            homes,
        ),
        "rustup",
    )?;
    for proxy in RUST_PROXIES {
        std::fs::copy(&rustup, bin.join(format!("{proxy}.exe"))).map_err(|err| err.to_string())?;
    }
    Ok(())
}

fn install_into(ctx: &Context, recipe: &Recipe, staging: &Path) -> Result<(), String> {
    match recipe.kind {
        RecipeKind::Npm {
            package_json,
            package_lock,
            ..
        } => install_npm(ctx, staging, package_json, package_lock),
        RecipeKind::Pip { requirement, .. } => install_pip(ctx, staging, requirement),
        RecipeKind::Phar { url, sha256, file } => {
            let archive = fetch_verified(&ctx.root.join("cache").join("downloads"), url, sha256)?;
            std::fs::copy(archive, staging.join(file))
                .map(|_| ())
                .map_err(|err| err.to_string())
        }
        RecipeKind::GoInstall { module } => install_go(ctx, staging, module, recipe.version),
        RecipeKind::Rustup { url, sha256 } => install_rust(ctx, staging, url, sha256),
    }
}

/// Reads `tools/installed.json` (a damaged one is replaced only by what OpenMind itself installed).
fn read_installed(root: &Path) -> Manifest {
    manifest::read(&openmind_toolchains::packs::installed_path(root))
        .ok()
        .flatten()
        .unwrap_or_default()
}

fn write_installed(root: &Path, installed: &Manifest) -> Result<(), String> {
    let path = openmind_toolchains::packs::installed_path(root);
    let text = serde_json::to_string_pretty(installed).map_err(|err| err.to_string())?;
    // A name of its own: a fixed temporary name could be written by two writers at once.
    let unique = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or_default();
    let temp = path.with_extension(format!("json.{}-{unique}.tmp", std::process::id()));
    std::fs::write(&temp, text).map_err(|err| err.to_string())?;
    std::fs::rename(&temp, &path).map_err(|err| err.to_string())
}

/// Records `recipe` as installed (replacing an older record of the same tool).
fn record(root: &Path, recipe: &Recipe, command: &str) -> Result<(), String> {
    let mut installed = read_installed(root);
    installed.tools.retain(|tool| tool.id != recipe.tool);
    installed.tools.push(ManifestTool {
        id: recipe.tool.to_string(),
        name: None,
        versions: vec![ManifestVersion {
            version: recipe.version.to_string(),
            platform: current_platform().to_string(),
            path: program_path(recipe, command),
            bundled: false,
            license: Some(recipe.license.to_string()),
            license_url: None,
            size_bytes: None,
            verify_args: recipe
                .verify_args
                .map(|args| args.iter().map(|a| (*a).to_string()).collect()),
            env: program_env(recipe)
                .into_iter()
                .map(|(k, v)| (k.to_string(), v))
                .collect(),
            installed: true,
        }],
        max_bundled_versions: None,
        active_version: Some(recipe.version.to_string()),
    });
    write_installed(root, &installed)
}

/// Whether `recipe` is installed and its program is there (e.g. another computer installed it while this one waited).
fn already_installed(root: &Path, recipe: &Recipe, command: &str) -> bool {
    read_installed(root).tools.iter().any(|tool| {
        tool.id == recipe.tool
            && tool
                .versions
                .iter()
                .any(|version| version.version == recipe.version)
    }) && root.join(program_path(recipe, command)).is_file()
}

fn install_blocking(ctx: &Context, recipe: &Recipe, command: &str) -> Result<(), String> {
    std::fs::create_dir_all(ctx.root.join("tools")).map_err(|err| err.to_string())?;
    let _shared = shared_lock(&ctx.root)?;
    if already_installed(&ctx.root, recipe, command) {
        tracing::info!(
            tool = recipe.tool,
            version = recipe.version,
            "the tool is already installed in the shared folder; using it"
        );
        return Ok(());
    }
    let tool_root = ctx.root.join("tools").join(recipe.tool);
    let staging = tool_root.join(".installing");
    if staging.exists() {
        std::fs::remove_dir_all(&staging).map_err(|err| err.to_string())?;
    }
    std::fs::create_dir_all(&staging).map_err(|err| err.to_string())?;
    let outcome = (|| {
        install_into(ctx, recipe, &staging)?;
        if let Some(text) = launcher(recipe) {
            std::fs::write(staging.join(format!("{command}.cmd")), text)
                .map_err(|err| err.to_string())?;
        }
        let program = program_path(recipe, command);
        let inside = program
            .strip_prefix(&format!("{}/", tool_dir(recipe)))
            .ok_or("unexpected program path")?;
        if !staging.join(inside).is_file() {
            return Err(format!("the install finished but {inside} is missing"));
        }
        let final_dir = ctx.root.join(tool_dir(recipe));
        if final_dir.exists() {
            std::fs::remove_dir_all(&final_dir).map_err(|err| err.to_string())?;
        }
        std::fs::rename(&staging, &final_dir).map_err(|err| err.to_string())?;
        record(&ctx.root, recipe, command)
    })();
    if outcome.is_err() {
        let _ = std::fs::remove_dir_all(&staging);
    }
    outcome
}

/// Installs a downloadable tool of Language Tools, on the user's click.
#[tauri::command]
pub async fn toolchains_install(
    id: String,
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<Packs, String> {
    let recipe = recipe(&id).ok_or_else(|| format!("{id} can't be downloaded."))?;
    let command = known(&id).map(|k| k.command).ok_or("Unknown tool.")?;
    let _guard = lock().lock().await;
    let environment = environment(&state).await;
    let (node, python) = crate::commands::lsp::installers(&state).await;
    let ctx = Context {
        root: state.app_root.clone(),
        cache_root: state.runtime.paths().cache_dir().to_path_buf(),
        path_prepend: environment.path_prepend,
        vars: environment.vars,
        node,
        python,
    };
    tracing::info!(tool = %id, version = recipe.version, "installing a tool");
    tokio::task::spawn_blocking(move || install_blocking(&ctx, recipe, command))
        .await
        .map_err(|err| format!("The installer stopped unexpectedly: {err}"))??;
    crate::sync::announce_now(&app, crate::sync::Topic::Tools).await;
    Ok(crate::commands::toolchains::packs(&state).await)
}

/// Removes a tool installed from Language Tools: its folder and its record. A shipped (bundled) tool isn't touched.
#[tauri::command]
pub async fn toolchains_remove(
    id: String,
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<Packs, String> {
    let recipe =
        recipe(&id).ok_or_else(|| format!("{id} wasn't installed from Language Tools."))?;
    let _guard = lock().lock().await;
    let root = state.app_root.clone();
    tokio::task::spawn_blocking(move || remove_blocking(&root, recipe, &id))
        .await
        .map_err(|err| err.to_string())??;
    crate::sync::announce_now(&app, crate::sync::Topic::Tools).await;
    Ok(crate::commands::toolchains::packs(&state).await)
}

/// Removes a tool under the shared lock: its folder (all at once: renamed away first, so a program another computer is
/// running from it refuses the removal instead of half-deleting it) and then its record.
fn remove_blocking(root: &Path, recipe: &Recipe, id: &str) -> Result<(), String> {
    let _shared = shared_lock(root)?;
    let mut installed = read_installed(root);
    if !installed.tools.iter().any(|tool| tool.id == recipe.tool) {
        return Err(format!("{id} wasn't installed from Language Tools."));
    }
    let dir = root.join("tools").join(recipe.tool);
    match std::fs::symlink_metadata(&dir) {
        Ok(meta) if meta.is_dir() && !meta.file_type().is_symlink() => {
            let aside =
                dir.with_file_name(format!("{}.removing-{}", recipe.tool, std::process::id()));
            std::fs::rename(&dir, &aside).map_err(|err| {
                format!(
                    "Couldn't remove {} — it is in use (perhaps on another computer): {err}",
                    dir.display()
                )
            })?;
            if let Err(err) = std::fs::remove_dir_all(&aside) {
                tracing::warn!(error = %err, "a removed tool's folder couldn't be deleted completely yet");
            }
        }
        Ok(_) => {
            return Err(format!(
                "{} is not a folder OpenMind created; it was left alone.",
                dir.display()
            ))
        }
        Err(_) => {}
    }
    installed.tools.retain(|tool| tool.id != recipe.tool);
    write_installed(root, &installed)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn installs_are_recorded_and_replace_an_older_record() {
        let tmp = tempfile::tempdir().expect("tmp");
        std::fs::create_dir_all(tmp.path().join("tools")).expect("tools");
        let ruff = recipe("ruff").expect("ruff");
        record(tmp.path(), ruff, "ruff").expect("record");
        record(tmp.path(), ruff, "ruff").expect("again");
        let rust = recipe("rust-toolchain").expect("rust");
        record(tmp.path(), rust, "cargo").expect("rust");
        let installed = read_installed(tmp.path());
        assert_eq!(installed.tools.iter().filter(|t| t.id == "ruff").count(), 1);
        let version = &installed
            .tools
            .iter()
            .find(|t| t.id == "rust-toolchain")
            .expect("rust")
            .versions[0];
        assert_eq!(
            version.path,
            "tools/rust-toolchain/stable/cargo/bin/cargo.exe"
        );
        assert_eq!(
            version.env.get("CARGO_HOME").map(String::as_str),
            Some("tools/rust-toolchain/stable/cargo")
        );
        // The tool list reads it: the version is there, and Active once its program exists.
        let program = tmp.path().join("tools/ruff/0.16.10/ruff.cmd");
        std::fs::create_dir_all(program.parent().expect("dir")).expect("dir");
        std::fs::write(&program, "@echo off").expect("program");
        let packs = openmind_toolchains::load(tmp.path(), current_platform(), &Default::default());
        let tool = packs.tool("ruff").expect("ruff");
        assert_eq!(tool.active_version.as_deref(), Some("0.16.10"));
        assert!(tool.versions[0].installed);
        assert!(packs
            .injection()
            .path_prepend
            .iter()
            .any(|dir| dir.ends_with("0.16.10")));
    }

    #[test]
    fn a_failed_install_leaves_nothing_behind() {
        let tmp = tempfile::tempdir().expect("tmp");
        let ctx = Context {
            root: tmp.path().to_path_buf(),
            cache_root: tmp.path().join("pc-cache"),
            path_prepend: vec![],
            vars: vec![],
            node: Err("Node.js runtime is not installed yet.".into()),
            python: Err("Python was not found.".into()),
        };
        let error = install_blocking(&ctx, recipe("prettier").expect("prettier"), "prettier")
            .expect_err("no node");
        assert!(error.contains("Node.js"), "{error}");
        assert!(!tmp.path().join("tools/prettier/.installing").exists());
        assert!(!tmp.path().join("tools/prettier/3.9.9").exists());
        assert!(read_installed(tmp.path()).tools.is_empty());
    }

    fn no_tools_ctx(root: &Path) -> Context {
        Context {
            root: root.to_path_buf(),
            cache_root: root.join("pc-cache"),
            path_prepend: vec![],
            vars: vec![],
            node: Err("Node.js runtime is not installed yet.".into()),
            python: Err("Python was not found.".into()),
        }
    }

    #[test]
    fn a_tool_another_computer_installs_meanwhile_is_reused_not_installed_again() {
        let tmp = tempfile::tempdir().expect("tmp");
        let root = tmp.path().to_path_buf();
        std::fs::create_dir_all(root.join("tools")).expect("tools");
        let ruff = recipe("ruff").expect("ruff");
        // "PC-A" holds the shared lock and finishes its install while "PC-B" waits.
        let held = shared_lock(&root).expect("lock");
        let pc_b = std::thread::spawn({
            let root = root.clone();
            move || {
                let started = std::time::Instant::now();
                // PC-B has no Python: had it installed anything itself, this would fail.
                let outcome = install_blocking(&no_tools_ctx(&root), ruff, "ruff");
                (outcome, started.elapsed())
            }
        });
        std::thread::sleep(Duration::from_millis(400));
        let program = root.join(program_path(ruff, "ruff"));
        std::fs::create_dir_all(program.parent().expect("parent")).expect("dir");
        std::fs::write(&program, b"@echo ruff").expect("program");
        record(&root, ruff, "ruff").expect("record");
        drop(held);
        let (outcome, waited) = pc_b.join().expect("thread");
        outcome.expect("reused");
        assert!(waited >= Duration::from_millis(400), "{waited:?}");
        assert_eq!(read_installed(&root).tools.len(), 1);
        assert!(!root.join("tools/ruff/.installing").exists());
    }

    #[test]
    fn writers_under_the_shared_lock_leave_no_temporary_files() {
        let tmp = tempfile::tempdir().expect("tmp");
        std::fs::create_dir_all(tmp.path().join("tools")).expect("tools");
        let writers: Vec<_> = (0..8)
            .map(|_| {
                let root = tmp.path().to_path_buf();
                std::thread::spawn(move || {
                    for _ in 0..20 {
                        // Real writers always hold the shared lock (several computers, one folder).
                        let _shared = shared_lock(&root).expect("lock");
                        write_installed(&root, &Manifest::default()).expect("write");
                    }
                })
            })
            .collect();
        for writer in writers {
            writer.join().expect("writer");
        }
        let leftovers = std::fs::read_dir(tmp.path().join("tools"))
            .expect("dir")
            .filter_map(Result::ok)
            .filter(|e| e.file_name().to_string_lossy().ends_with(".tmp"))
            .count();
        assert_eq!(leftovers, 0);
    }
}
