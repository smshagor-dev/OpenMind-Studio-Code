//! Runtime Manager > Workloads: the workload / language-pack catalog with each component's honest status on this
//! computer, the install plan for a selection, the first-run flag and Verify. Building the catalog only reads local
//! state (the runtime list, the LSP bundle, files on PATH); nothing is downloaded or installed here — installs go
//! through `runtime_install`, one runtime at a time, when the user presses Install.

use std::collections::HashMap;
use std::io::Read;
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

use openmind_db::EditorSettingsRepository;
use openmind_language::tools::{status_of, Source};
use openmind_runtime_manager::detect::parse_version_output;
use openmind_workloads::{
    framework_missing, plan, resolve, Category, ComponentStatus, Facts, Framework, LspFact, Pack,
    Plan, Provision, RuntimeFact, Selection, Workload, COMPONENTS, FRAMEWORKS, PACKS, WORKLOADS,
};
use serde::Serialize;
use tauri::State;

use crate::app_state::AppState;

const FIRST_RUN_KEY: &str = "workloads.firstRunDone";
const VERIFY_TIMEOUT: Duration = Duration::from_secs(30);

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ComponentView {
    name: &'static str,
    category: Category,
    provision: Provision,
    requires: &'static [&'static str],
    #[serde(flatten)]
    status: ComponentStatus,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FrameworkView {
    #[serde(flatten)]
    framework: Framework,
    /// Components still missing (empty = ready).
    missing: Vec<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkloadCatalog {
    workloads: &'static [Workload],
    packs: &'static [Pack],
    frameworks: Vec<FrameworkView>,
    components: Vec<ComponentView>,
    /// `<app>/runtimes`, where every runtime is installed.
    install_root: String,
    /// `<app>/cache/offline`, where offline packages are kept.
    offline_folder: String,
    platform: String,
}

fn source_label(source: Source) -> &'static str {
    match source {
        Source::Project => "project",
        Source::Bundled => "bundled",
        Source::Portable => "OpenMind runtime",
        Source::System => "system",
        Source::Env => "environment",
    }
}

/// What status resolution needs, from local state only.
async fn facts(state: &AppState) -> Facts {
    let mut facts = Facts::default();
    if let Ok(list) = state.runtime.list().await {
        for runtime in list {
            facts.runtimes.insert(
                runtime.id.clone(),
                RuntimeFact {
                    installed: runtime.active_version.clone(),
                    available: runtime
                        .available_versions
                        .contains(&runtime.default_version),
                    default_version: runtime.default_version.clone(),
                    download_bytes: runtime.download_bytes,
                    install_bytes: runtime.install_bytes,
                    license_acceptance: runtime
                        .license
                        .as_ref()
                        .is_some_and(|l| l.acceptance_required),
                },
            );
        }
    }
    for (server, bundled, installed) in crate::commands::lsp::server_facts(state).await {
        facts
            .lsp
            .insert(server.to_string(), LspFact { bundled, installed });
    }
    let env = crate::commands::language::tool_env(state).await;
    let detects: Vec<&str> = COMPONENTS.iter().filter_map(|c| c.detect).collect();
    let found = tauri::async_runtime::spawn_blocking(move || {
        detects
            .into_iter()
            .filter_map(|tool| {
                let found = status_of(tool, &env).found?;
                Some((
                    tool.to_string(),
                    format!("{} ({})", found.path, source_label(found.source)),
                ))
            })
            .collect::<HashMap<_, _>>()
    })
    .await
    .unwrap_or_default();
    facts.found = found;
    facts
}

#[tauri::command]
pub async fn workloads_catalog(state: State<'_, AppState>) -> Result<WorkloadCatalog, String> {
    let facts = facts(&state).await;
    let statuses: HashMap<String, ComponentStatus> = COMPONENTS
        .iter()
        .map(|c| (c.id.to_string(), resolve(c, &facts)))
        .collect();
    let frameworks = FRAMEWORKS
        .iter()
        .map(|f| FrameworkView {
            framework: *f,
            missing: framework_missing(f.needs, &statuses),
        })
        .collect();
    let components = COMPONENTS
        .iter()
        .filter_map(|c| {
            Some(ComponentView {
                name: c.name,
                category: c.category,
                provision: c.provision,
                requires: c.requires,
                status: statuses.get(c.id)?.clone(),
            })
        })
        .collect();
    let cache = state.runtime.paths().cache_dir().to_path_buf();
    Ok(WorkloadCatalog {
        workloads: WORKLOADS,
        packs: PACKS,
        frameworks,
        components,
        install_root: state.runtime.paths().runtimes_dir().display().to_string(),
        offline_folder: cache.join("offline").display().to_string(),
        platform: state.runtime.platform().to_string(),
    })
}

/// What a selection would install: runtimes in dependency order, sizes and warnings.
#[tauri::command]
pub async fn workloads_plan(
    selection: Selection,
    state: State<'_, AppState>,
) -> Result<Plan, String> {
    Ok(plan(&selection, &facts(&state).await))
}

/// Whether the first-run workload page should open (it opens once; skipping counts as done).
#[tauri::command]
pub async fn workloads_first_run(state: State<'_, AppState>) -> Result<bool, String> {
    let done = EditorSettingsRepository::new(state.db.pool())
        .get(FIRST_RUN_KEY)
        .await
        .map_err(|err| err.to_string())?;
    Ok(done.is_none())
}

#[tauri::command]
pub async fn workloads_first_run_done(state: State<'_, AppState>) -> Result<(), String> {
    EditorSettingsRepository::new(state.db.pool())
        .set(FIRST_RUN_KEY, "1")
        .await
        .map_err(|err| err.to_string())
}

/// Verify: runs the active install's version command (with the runtimes' environment, so Maven finds the JDK) and
/// returns the version it prints. Only on a click; a time limit ends a command that hangs.
#[tauri::command]
pub async fn runtime_verify(kind: String, state: State<'_, AppState>) -> Result<String, String> {
    let manifest = state
        .runtime
        .registry()
        .get(&kind)
        .map_err(|err| err.to_string())?
        .clone();
    let dir = state.runtime.installed_dir(&kind).await.ok_or_else(|| {
        format!(
            "{} is not installed (or needs Repair).",
            manifest.display_name
        )
    })?;
    let environment = crate::commands::run::environment(&state).await;
    let (program, args) = verify_command(
        &dir.join(&manifest.version_command.executable),
        &manifest.version_command.args,
        &environment.vars,
    )?;
    tauri::async_runtime::spawn_blocking(move || {
        let mut command = Command::new(&program);
        command
            .args(&args)
            .current_dir(&dir)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        let path = std::env::var_os("PATH").unwrap_or_default();
        let joined = std::env::join_paths(
            environment
                .path_prepend
                .iter()
                .cloned()
                .chain(std::env::split_paths(&path)),
        )
        .map_err(|err| err.to_string())?;
        command
            .env("PATH", joined)
            .envs(environment.vars.iter().map(|(k, v)| (k, v)));
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            command.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
        }
        let mut child = command
            .spawn()
            .map_err(|err| format!("{} could not start: {err}", program.display()))?;
        let started = Instant::now();
        loop {
            match child.try_wait() {
                Ok(Some(_)) => break,
                Ok(None) if started.elapsed() > VERIFY_TIMEOUT => {
                    let _ = child.kill();
                    return Err(format!(
                        "{} did not answer within 30 seconds.",
                        manifest.display_name
                    ));
                }
                Ok(None) => std::thread::sleep(Duration::from_millis(50)),
                Err(err) => return Err(err.to_string()),
            }
        }
        let mut output = String::new();
        if let Some(mut out) = child.stdout.take() {
            let _ = out.read_to_string(&mut output);
        }
        if let Some(mut err) = child.stderr.take() {
            let mut text = String::new();
            let _ = err.read_to_string(&mut text);
            output.push('\n');
            output.push_str(&text);
        }
        parse_version_output(&output, &manifest.version_command.output_prefix)
            .ok_or_else(|| format!("{} ran but printed no version.", manifest.display_name))
    })
    .await
    .map_err(|err| err.to_string())?
}

/// The program and arguments that print a runtime's version. A PHP archive (`composer.phar`) is not a Windows program:
/// it is run by OpenMind's active PHP (`OPENMIND_PHP`, set by the PHP runtime), as the `composer` launcher does.
fn verify_command(
    program: &std::path::Path,
    args: &[String],
    vars: &[(String, String)],
) -> Result<(std::path::PathBuf, Vec<String>), String> {
    if !program
        .extension()
        .is_some_and(|ext| ext.eq_ignore_ascii_case("phar"))
    {
        return Ok((program.to_path_buf(), args.to_vec()));
    }
    let php = vars
        .iter()
        .find(|(name, _)| name == "OPENMIND_PHP")
        .map(|(_, value)| std::path::PathBuf::from(value))
        .ok_or("Composer runs on OpenMind's PHP: install PHP in the Runtime Manager first.")?;
    let mut all = vec![program.display().to_string()];
    all.extend(args.iter().cloned());
    Ok((php, all))
}

#[cfg(test)]
mod verify_tests {
    use super::*;

    #[test]
    fn a_php_archive_is_verified_with_openmind_php_and_a_program_runs_as_itself() {
        let args = vec!["--version".to_string()];
        let exe = std::path::Path::new(r"C:\app\runtimes\node\versions\24\node.exe");
        assert_eq!(
            verify_command(exe, &args, &[]).expect("program"),
            (exe.to_path_buf(), args.clone())
        );
        let phar = std::path::Path::new(r"C:\app\runtimes\composer\versions\2\composer.phar");
        let vars = vec![(
            "OPENMIND_PHP".to_string(),
            r"C:\app\php\php.exe".to_string(),
        )];
        let (program, all) = verify_command(phar, &args, &vars).expect("php");
        assert_eq!(program, std::path::PathBuf::from(r"C:\app\php\php.exe"));
        assert_eq!(
            all,
            vec![phar.display().to_string(), "--version".to_string()]
        );
        let missing = verify_command(phar, &args, &[]).expect_err("no php");
        assert!(missing.contains("install PHP"), "{missing}");
    }
}
