//! Language and project support (Milestone 14): the language registry, the status of the open folder's projects
//! (what was detected, which commands they have, which tools exist) and of one file, and a command rendered as a
//! line for a terminal. Everything is a lookup of files: nothing is run, installed or downloaded here, and the
//! machine's PATH is only read. The folder is always the asking window's, found server-side.

use std::path::{Path, PathBuf};

use openmind_language::{
    file_status, typed_line, workspace_status, FileStatus, LanguageDef, ShellStyle, ToolEnv,
    WorkspaceStatus, LANGUAGES,
};
use tauri::State;

use crate::app_state::AppState;

async fn workspace_root(state: &AppState, window: &tauri::Window) -> Result<PathBuf, String> {
    crate::windows::window_workspace(state, window.label())
        .await?
        .map(|workspace| PathBuf::from(workspace.path))
        .ok_or_else(|| "Open a folder first.".to_string())
}

/// The lookup environment: bundled app-local tools, OpenMind's portable runtimes, then the machine's PATH (read, never written).
pub(crate) async fn tool_env(state: &AppState) -> ToolEnv {
    let bundled = crate::commands::toolchains::bundled_dirs(state).await;
    let portable = match state.runtime.environment().await {
        Ok(environment) => environment.path_prepend,
        Err(err) => {
            tracing::warn!(
                ?err,
                "could not read the runtime environment for tool lookup"
            );
            Vec::new()
        }
    };
    let mut env = ToolEnv::with_bundled(bundled, portable);
    add_offline_bundle_tools(&mut env, &state.app_root);
    env
}

/// The offline bundle's formatters that are already unpacked (Milestone 18): native programs join the bundled
/// folders (after the user's own `tools/` packs), Prettier becomes a launcher on the bundle's Node.js (or, without
/// one, OpenMind's portable Node — never a system one). Unpacking itself happens only when formatting is asked for
/// (`unpack_offline_formatters`).
fn add_offline_bundle_tools(env: &mut ToolEnv, app_root: &Path) {
    let bundle = openmind_lsp::bundle::load(app_root).ok().flatten();
    let node = openmind_lsp::resolve_lsp_node(
        bundle.as_ref().and_then(|b| b.node_path()),
        &env.portable_dirs,
        None,
    )
    .ok()
    .map(|node| node.path);
    for tool in openmind_lsp::tools::ready_tools(app_root, node.as_deref()) {
        if let Some(dir) = tool.dir {
            env.bundled_dirs.push(dir);
        }
        if let Some(launcher) = tool.launcher {
            env.launchers.insert(tool.tool.to_string(), launcher);
        }
    }
}

/// Unpacks the offline bundle's formatter packs that aren't unpacked yet (offline, once; a few seconds the first
/// time). A pack that fails is logged and left out; formatting then says the tool is missing.
pub(crate) async fn unpack_offline_formatters(state: &AppState) {
    let root = state.app_root.clone();
    let outcome = tokio::task::spawn_blocking(move || match openmind_lsp::bundle::load(&root) {
        Ok(Some(bundle)) => openmind_lsp::tools::ensure_unpacked(&root, &bundle),
        Ok(None) => Vec::new(),
        Err(problem) => vec![problem],
    })
    .await;
    match outcome {
        Ok(problems) => {
            for problem in problems {
                tracing::warn!(%problem, "a bundled formatter could not be unpacked");
            }
        }
        Err(err) => tracing::warn!(?err, "unpacking the bundled formatters stopped"),
    }
}

/// Every language OpenMind knows (static data).
#[tauri::command]
pub fn language_registry() -> Vec<&'static LanguageDef> {
    LANGUAGES.iter().collect()
}

#[tauri::command]
pub async fn language_workspace_status(
    window: tauri::Window,
    state: State<'_, AppState>,
) -> Result<WorkspaceStatus, String> {
    let root = workspace_root(&state, &window).await?;
    let env = tool_env(&state).await;
    tokio::task::spawn_blocking(move || workspace_status(&root, &env))
        .await
        .map_err(|err| format!("the scan stopped unexpectedly: {err}"))
}

/// The language, language servers, formatters and linters of one file inside the open folder.
#[tauri::command]
pub async fn language_file_status(
    path: String,
    window: tauri::Window,
    state: State<'_, AppState>,
) -> Result<FileStatus, String> {
    let root = workspace_root(&state, &window).await?;
    let env = tool_env(&state).await;
    tokio::task::spawn_blocking(move || file_status_of(&root, Path::new(&path), &path, &env))
        .await
        .map_err(|err| format!("the lookup stopped unexpectedly: {err}"))?
}

fn file_status_of(
    root: &Path,
    file: &Path,
    shown: &str,
    env: &ToolEnv,
) -> Result<FileStatus, String> {
    let canonical =
        openmind_fs::path_safety::ensure_within_root(root, file).map_err(|err| err.to_string())?;
    // The same normalisation as `canonical` (no `\?\` prefix on Windows), or the two paths can't be compared.
    let root_canonical =
        openmind_fs::path_safety::normalize_path(root).map_err(|err| err.to_string())?;
    let workspace = workspace_status(&root_canonical, env);
    let mut status = file_status(&root_canonical, &canonical, env, &workspace);
    status.path = shown.replace('\\', "/");
    Ok(status)
}

/// The line to type into a terminal for a command (plain words stay plain; a line that can't be quoted safely is refused).
#[tauri::command]
pub fn language_terminal_line(argv: Vec<String>, style: ShellStyle) -> Result<String, String> {
    typed_line(&argv, style).map_err(|err| err.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_file_in_a_sub_folder_is_matched_to_its_project() {
        let dir = tempfile::tempdir().expect("tmp");
        let root = dir.path().join("multi language workspace");
        let project = root.join("rust-json-sql");
        std::fs::create_dir_all(project.join("src")).expect("dirs");
        std::fs::write(
            project.join("Cargo.toml"),
            "[package]
name = \"r\"
",
        )
        .expect("cargo");
        std::fs::write(project.join("src/main.rs"), "fn main() {}").expect("main");
        let env = ToolEnv::from_process(vec![]);
        let file = project.join("src/main.rs");
        let status = file_status_of(&root, &file, &file.to_string_lossy(), &env).expect("status");
        assert_eq!(status.project_root.as_deref(), Some("rust-json-sql"));
    }
}
