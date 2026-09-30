//! Shell integration requests: `OpenMindStudio.exe --integration <action>` (the NSIS installer's check boxes and its
//! uninstaller) and the app's own commands (portable copies). See `crate::integration` for what is changed and why it
//! is safe to undo.

use std::path::PathBuf;

use crate::integration::{self, Action, Status};

fn this_exe() -> Result<PathBuf, String> {
    std::env::current_exe().map_err(|err| format!("the program's own path is unknown: {err}"))
}

#[cfg(windows)]
fn apply(action: Action) -> Result<String, String> {
    integration::run(
        &mut integration::registry::UserRegistry,
        &this_exe()?,
        action,
    )
}

#[cfg(not(windows))]
fn apply(_action: Action) -> Result<String, String> {
    Err("Shell integration is available on Windows only.".into())
}

/// `--integration <action>` as the first argument: runs it and returns the exit code (0 done, 1 failed, 2 unknown
/// action) before anything else starts — no window, no data folders, no log file. `None` for an ordinary launch.
pub fn run_cli() -> Option<i32> {
    let mut args = std::env::args_os().skip(1);
    if args.next()? != "--integration" {
        return None;
    }
    let Some(action) = args
        .next()
        .and_then(|a| Action::parse(&a.to_string_lossy()))
    else {
        eprintln!("usage: OpenMindStudio.exe --integration add-path|remove-path|add-explorer|remove-explorer|remove-all|status");
        return Some(2);
    };
    Some(match apply(action) {
        Ok(message) => {
            println!("{message}");
            0
        }
        Err(err) => {
            eprintln!("{err}");
            1
        }
    })
}

#[cfg(windows)]
fn read_status() -> Result<Status, String> {
    integration::status(&integration::registry::UserRegistry, &this_exe()?)
}

#[cfg(not(windows))]
fn read_status() -> Result<Status, String> {
    Err("Shell integration is available on Windows only.".into())
}

/// What is in place for this copy (reads the user's Registry; changes nothing).
#[tauri::command]
pub async fn integration_status() -> Result<Status, String> {
    tauri::async_runtime::spawn_blocking(read_status)
        .await
        .map_err(|err| err.to_string())?
}

/// One of the four user commands (`add-path`, `remove-path`, `add-explorer`, `remove-explorer`), after the UI asked.
#[tauri::command]
pub async fn integration_apply(action: String) -> Result<String, String> {
    let action = match Action::parse(&action) {
        Some(
            action @ (Action::AddPath
            | Action::RemovePath
            | Action::AddExplorer
            | Action::RemoveExplorer),
        ) => action,
        _ => return Err(format!("Unknown shell integration action: {action}")),
    };
    let result = tauri::async_runtime::spawn_blocking(move || apply(action))
        .await
        .map_err(|err| err.to_string())?;
    match &result {
        Ok(_) => tracing::info!(?action, "shell integration changed"),
        Err(err) => tracing::warn!(?action, %err, "shell integration change failed"),
    }
    result
}
