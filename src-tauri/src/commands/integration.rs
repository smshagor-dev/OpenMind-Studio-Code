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
    let exe = this_exe()?;
    let result = integration::run(&mut integration::registry::UserRegistry, &exe, action)?;
    if action == Action::RemoveAll {
        // The uninstaller: the setup programs no longer find this folder (as started, and as its network path).
        if let Some(dir) = exe.parent() {
            let universal = integration::shortcut::universal_path(dir);
            for dir in [dir, universal.as_path()] {
                integration::forget_installation(
                    &mut integration::registry::UserRegistry,
                    &dir.display().to_string(),
                )?;
            }
        }
    }
    Ok(result)
}

/// Notes this installed copy's folder for the setup programs (see `integration::INSTALLATIONS_KEY`); its network path
/// when it runs from a mapped drive, so another computer's setup finds the same folder.
#[cfg(windows)]
pub fn remember_installation(install_dir: &std::path::Path, version: &str) -> Result<(), String> {
    let dir = integration::shortcut::universal_path(install_dir);
    integration::remember_installation(
        &mut integration::registry::UserRegistry,
        &dir.display().to_string(),
        version,
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
    let words: Vec<String> = args.map(|a| a.to_string_lossy().into_owned()).collect();
    attach_console();
    // Installation and deployment: the install layout and Desktop shortcuts (see `integration::deploy`).
    if let Some(parsed) = integration::deploy::parse(&words) {
        let result = parsed.and_then(|action| integration::deploy::run(action, &this_exe()?));
        return Some(report(result));
    }
    let Some(action) = words
        .first()
        .filter(|_| words.len() == 1)
        .and_then(|a| Action::parse(a))
    else {
        eprintln!("usage: OpenMindStudio.exe --integration add-path|remove-path|add-explorer|remove-explorer|remove-all|status");
        eprintln!("{}", integration::deploy::USAGE);
        return Some(2);
    };
    Some(report(apply(action)))
}

/// The program is a window program, so a console it was typed into doesn't show what it prints: attach to that console
/// when standard output goes nowhere (a redirect to a file or a pipe — the installers, the deploy scripts — is kept).
#[cfg(windows)]
pub(crate) fn attach_console() {
    use winapi::um::processenv::GetStdHandle;
    use winapi::um::winbase::STD_OUTPUT_HANDLE;
    use winapi::um::wincon::{AttachConsole, ATTACH_PARENT_PROCESS};
    // SAFETY: plain queries/attachment of the calling process's standard handles.
    unsafe {
        let out = GetStdHandle(STD_OUTPUT_HANDLE);
        if out.is_null() || out == winapi::um::handleapi::INVALID_HANDLE_VALUE {
            AttachConsole(ATTACH_PARENT_PROCESS);
        }
    }
}

#[cfg(not(windows))]
pub(crate) fn attach_console() {}

/// Prints the outcome and gives the exit code (0 done, 1 failed).
fn report(result: Result<String, String>) -> i32 {
    match result {
        Ok(message) => {
            println!("{message}");
            0
        }
        Err(err) => {
            eprintln!("{err}");
            1
        }
    }
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

/// "Create or Repair Desktop Shortcut" (the command palette): this user's `OpenMind Studio.lnk` for this copy, by its
/// network path when it runs from a share. The error explains how to do it by hand.
#[tauri::command]
pub async fn integration_desktop_shortcut() -> Result<String, String> {
    let result = tauri::async_runtime::spawn_blocking(|| {
        integration::deploy::desktop_shortcut(&this_exe()?, false)
    })
    .await
    .map_err(|err| err.to_string())?;
    match &result {
        Ok(message) => tracing::info!(%message, "desktop shortcut"),
        Err(err) => tracing::warn!(%err, "desktop shortcut failed"),
    }
    result
}

/// The deployment check's report (see `integration::check`), for "Check Desktop Shortcut and Installation".
#[tauri::command]
pub async fn integration_check() -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(|| {
        integration::deploy::run(integration::deploy::DeployAction::Check, &this_exe()?)
    })
    .await
    .map_err(|err| err.to_string())?
}
