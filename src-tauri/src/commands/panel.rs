//! Commands behind the PHP Server window's control-panel buttons: Config
//! (open a module's config file), Explorer (open the project folder), Shell
//! (a terminal with the portable runtimes first on PATH) and Netstat (which
//! ports are listening). Everything is an argument list to a fixed program —
//! nothing is passed through a shell — and files are only opened from inside
//! the app's own folder.

use std::path::{Path, PathBuf};
use std::process::Command;

use openmind_runner::{name_processes, parse_netstat, parse_tasklist, ListeningPort};
use tauri::State;

use crate::app_state::AppState;
use crate::commands::run::environment;

/// A module's config file, if it exists right now.
#[tauri::command]
pub async fn panel_config_path(
    kind: String,
    state: State<'_, AppState>,
) -> Result<Option<String>, String> {
    let file = match kind.as_str() {
        "mariadb" => Some(openmind_runner::MariaDbPaths::new(&state.app_root).config_file),
        "php" => install_file(&state, "php", "php.ini").await,
        "phpmyadmin" => install_file(&state, "phpmyadmin", "config.inc.php").await,
        _ => return Err(format!("Unknown module: {kind}")),
    };
    Ok(file
        .filter(|path| path.is_file())
        .map(|path| path.to_string_lossy().into_owned()))
}

async fn install_file(state: &AppState, kind: &str, name: &str) -> Option<PathBuf> {
    let list = state.runtime.list().await.ok()?;
    let status = list.into_iter().find(|entry| entry.id == kind)?;
    let entry = status.installed.into_iter().find(|entry| entry.active)?;
    Some(PathBuf::from(entry.path).join(name))
}

/// Opens a file that lives inside the app folder in the system text editor.
#[tauri::command]
pub fn panel_open_file(path: String, state: State<'_, AppState>) -> Result<(), String> {
    let file = std::fs::canonicalize(&path).map_err(|_| "That file doesn't exist.".to_string())?;
    let root = std::fs::canonicalize(&state.app_root).map_err(|err| err.to_string())?;
    if !file.is_file() || !file.starts_with(&root) {
        return Err("Only files inside the OpenMind Studio folder can be opened here.".into());
    }
    spawn_editor(&file).map_err(|err| format!("couldn't open the editor: {err}"))
}

#[cfg(windows)]
fn spawn_editor(file: &Path) -> std::io::Result<()> {
    Command::new("notepad.exe").arg(file).spawn().map(drop)
}

#[cfg(not(windows))]
fn spawn_editor(file: &Path) -> std::io::Result<()> {
    let program = if cfg!(target_os = "macos") {
        "open"
    } else {
        "xdg-open"
    };
    Command::new(program).arg(file).spawn().map(drop)
}

/// Opens an existing folder in the system file manager.
#[tauri::command]
pub fn panel_open_folder(path: String) -> Result<(), String> {
    let dir = PathBuf::from(&path);
    if !dir.is_dir() {
        return Err("Select a valid folder first.".into());
    }
    let program = if cfg!(windows) {
        "explorer.exe"
    } else if cfg!(target_os = "macos") {
        "open"
    } else {
        "xdg-open"
    };
    Command::new(program)
        .arg(&dir)
        .spawn()
        .map(drop)
        .map_err(|err| format!("couldn't open the folder: {err}"))
}

/// Opens a console in `cwd` (or the app folder) whose PATH starts with the
/// active portable runtimes. Only that console's environment is changed.
#[tauri::command]
pub async fn panel_open_shell(
    cwd: Option<String>,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let runtime = environment(&state).await;
    let dir = cwd
        .map(PathBuf::from)
        .filter(|path| path.is_dir())
        .unwrap_or_else(|| state.app_root.clone());
    let mut paths = runtime.path_prepend.clone();
    if let Some(existing) = std::env::var_os("PATH") {
        paths.extend(std::env::split_paths(&existing));
    }
    let joined = std::env::join_paths(paths).map_err(|err| err.to_string())?;
    let mut command = shell_command();
    command.current_dir(&dir).env("PATH", joined);
    for (key, value) in runtime.vars {
        command.env(key, value);
    }
    command
        .spawn()
        .map(drop)
        .map_err(|err| format!("couldn't open a shell: {err}"))
}

#[cfg(windows)]
fn shell_command() -> Command {
    use std::os::windows::process::CommandExt;
    let mut command = Command::new("cmd.exe");
    command.creation_flags(0x0000_0010); // CREATE_NEW_CONSOLE
    command
}

#[cfg(not(windows))]
fn shell_command() -> Command {
    Command::new("sh")
}

/// Every listening TCP port with its owning process (Windows: `netstat` +
/// `tasklist`; elsewhere `netstat` isn't parsed the same way, so it's empty).
#[tauri::command]
pub async fn panel_netstat() -> Result<Vec<ListeningPort>, String> {
    tauri::async_runtime::spawn_blocking(collect_listening)
        .await
        .map_err(|err| err.to_string())?
}

#[cfg(windows)]
fn collect_listening() -> Result<Vec<ListeningPort>, String> {
    let netstat = system_output("netstat.exe", &["-ano", "-p", "TCP"])?;
    let mut rows = parse_netstat(&netstat);
    if let Ok(tasks) = system_output("tasklist.exe", &["/FO", "CSV", "/NH"]) {
        name_processes(&mut rows, &parse_tasklist(&tasks));
    }
    Ok(rows)
}

#[cfg(not(windows))]
fn collect_listening() -> Result<Vec<ListeningPort>, String> {
    Err("Netstat is only available on Windows.".into())
}

#[cfg(windows)]
fn system_output(program: &str, args: &[&str]) -> Result<String, String> {
    use std::os::windows::process::CommandExt;
    let output = Command::new(program)
        .args(args)
        .creation_flags(0x0800_0000) // CREATE_NO_WINDOW
        .output()
        .map_err(|err| format!("couldn't run {program}: {err}"))?;
    Ok(String::from_utf8_lossy(&output.stdout).into_owned())
}
