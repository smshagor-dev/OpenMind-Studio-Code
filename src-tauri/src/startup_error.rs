//! What the app shows when its local database can't be opened. It used to panic (exit code 101, no window); now it
//! opens one small window with the reason, where the database is and safe actions. Nothing here changes, resets or
//! deletes the database by itself: the only change is moving its files aside, and only when the user confirms it.

use std::path::{Path, PathBuf};

use openmind_core::AppPaths;
use openmind_db::{DbError, FailureKind};
use serde::Serialize;
use tauri::{Manager, State};

/// The error window's label; `main.tsx` shows the error page instead of the workbench for it.
pub const STARTUP_ERROR_WINDOW_LABEL: &str = "startup-error";

/// The database's own files (SQLite keeps recent writes in `-wal` until they are checkpointed).
const DB_FILE_SUFFIXES: [&str; 4] = ["", "-wal", "-shm", "-journal"];

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StartupFailure {
    pub failure: FailureKind,
    /// A short name of the category, as shown and copied ("Migration checksum mismatch").
    pub category: String,
    pub title: String,
    pub explanation: String,
    pub next_steps: Vec<String>,
    pub db_path: String,
    pub data_dir: String,
    /// The error and its causes, outermost first.
    pub error_chain: Vec<String>,
    /// Everything above as plain text for Copy Error Details.
    pub details: String,
    /// Whether there is a database file to move aside ("Back Up and Start Fresh").
    pub can_back_up: bool,
}

pub struct StartupFailureState {
    failure: StartupFailure,
    db_path: PathBuf,
    data_dir: PathBuf,
}

/// Builds what the window shows. Only the error, the two paths and the app version go into it — nothing is read
/// from the database or the settings, so no key, password or project content can end up in the copied text.
pub fn describe(err: &DbError, db_path: &Path, data_dir: &Path) -> StartupFailure {
    let failure = err.kind();
    let (category, title, explanation, next_steps) = explain(failure);
    let error_chain = chain(err);
    let db_path_text = db_path.display().to_string();
    let data_dir_text = data_dir.display().to_string();
    let details = [
        "OpenMind Studio could not open its local database.".to_string(),
        format!(
            "Version: {} ({} {})",
            env!("CARGO_PKG_VERSION"),
            std::env::consts::OS,
            std::env::consts::ARCH
        ),
        format!("Category: {category}"),
        format!("Database: {db_path_text}"),
        format!("Error: {}", error_chain.join(": ")),
        "Your data was not deleted.".to_string(),
    ]
    .join("\n");
    StartupFailure {
        failure,
        category: category.to_string(),
        title,
        explanation,
        next_steps,
        db_path: db_path_text,
        data_dir: data_dir_text,
        error_chain,
        details,
        can_back_up: db_path.is_file(),
    }
}

fn chain(err: &dyn std::error::Error) -> Vec<String> {
    let mut lines = vec![err.to_string()];
    let mut source = err.source();
    while let Some(cause) = source {
        let text = cause.to_string();
        if lines.last() != Some(&text) {
            lines.push(text);
        }
        source = cause.source();
    }
    lines
}

const KEPT: &str = "Your data was not deleted.";

fn explain(failure: FailureKind) -> (&'static str, String, String, Vec<String>) {
    let exit_and_use =
        "Exit, and start the OpenMind Studio build that last used this folder.".to_string();
    let back_up = "Back Up and Start Fresh moves the database into a backup folder and starts with a new one \
                   (recent files, sessions and saved keys stay in the backup)."
        .to_string();
    match failure {
        FailureKind::ChecksumMismatch { version } => (
            "Migration checksum mismatch",
            "The local database doesn't match this build".into(),
            format!(
                "OpenMind Studio could not open the local database because migration {version}'s checksum does not \
                 match this build. This can happen if a previous development build used different SQL file line \
                 endings or a different version of that migration. {KEPT}"
            ),
            vec![exit_and_use, back_up],
        ),
        FailureKind::UnknownMigration { version } => (
            "Database from a newer version",
            "The local database was made by a newer OpenMind Studio".into(),
            format!(
                "The database has an update (migration {version}) that this version doesn't know, so it was probably \
                 created or updated by a newer OpenMind Studio. This version won't change it. {KEPT}"
            ),
            vec!["Exit, and use the newer version of OpenMind Studio.".into(), back_up],
        ),
        FailureKind::PartialMigration { version } => (
            "Unfinished database update",
            "An earlier database update didn't finish".into(),
            format!(
                "Migration {version} was started earlier and never finished (the app may have been stopped while it \
                 ran). OpenMind Studio won't guess how to complete it. {KEPT}"
            ),
            vec![back_up, "Copy Error Details and report it with the database kept.".into()],
        ),
        FailureKind::MigrationFailed { version } => (
            "Database update failed",
            "The local database couldn't be updated".into(),
            format!(
                "Updating the database to this version{} failed. {KEPT}",
                version.map(|v| format!(" (migration {v})")).unwrap_or_default()
            ),
            vec![exit_and_use, back_up],
        ),
        FailureKind::Locked => (
            "Database in use",
            "The local database is in use".into(),
            format!(
                "Another program holds the database — often another OpenMind Studio started from this same folder. \
                 {KEPT}"
            ),
            vec!["Close the other copy of OpenMind Studio, then start it again.".into()],
        ),
        FailureKind::Corrupt => (
            "Damaged database",
            "The local database file is damaged".into(),
            format!("The database file is damaged or isn't a SQLite database. {KEPT}"),
            vec![back_up, "Restore the file from a backup of this folder if you have one.".into()],
        ),
        FailureKind::ReadOnly | FailureKind::CannotOpen | FailureKind::CreateFolder => (
            "Database can't be opened",
            "The local database can't be opened or written".into(),
            format!(
                "OpenMind Studio needs to read and write its data folder, which is next to the program. The folder \
                 may be read-only, on a disconnected drive, or blocked by permissions. {KEPT}"
            ),
            vec![
                "Check that the folder is writable (not a read-only drive or a protected location such as Program \
                 Files), then start again."
                    .into(),
            ],
        ),
        FailureKind::DiskFull => (
            "Disk full",
            "The disk is full".into(),
            format!("The database couldn't be written because the disk is full. {KEPT}"),
            vec!["Free some space on this drive, then start again.".into()],
        ),
        FailureKind::Other => (
            "Database error",
            "The local database couldn't be opened".into(),
            format!("OpenMind Studio couldn't open its local database. {KEPT}"),
            vec!["Copy Error Details and report it.".into(), back_up],
        ),
    }
}

/// Moves the database's files into a new `db-backup-<stamp>` folder in the data folder. Refuses when that folder
/// exists; nothing is deleted or overwritten, and the move stops at the first file that can't be moved.
pub fn move_database_aside(db_path: &Path, data_dir: &Path, stamp: u64) -> Result<PathBuf, String> {
    let backup = data_dir.join(format!("db-backup-{stamp}"));
    if backup.exists() {
        return Err(format!(
            "{} already exists; nothing was moved.",
            backup.display()
        ));
    }
    let file_name = db_path
        .file_name()
        .ok_or_else(|| "The database path has no file name.".to_string())?
        .to_string_lossy()
        .into_owned();
    std::fs::create_dir_all(&backup)
        .map_err(|err| format!("couldn't create {}: {err}", backup.display()))?;
    for suffix in DB_FILE_SUFFIXES {
        let source = db_path.with_file_name(format!("{file_name}{suffix}"));
        if source.is_file() {
            let target = backup.join(format!("{file_name}{suffix}"));
            std::fs::rename(&source, &target)
                .map_err(|err| format!("couldn't move {}: {err}", source.display()))?;
        }
    }
    Ok(backup)
}

/// Opens the error window in place of the main window.
pub fn show(app: &tauri::App, paths: &AppPaths, err: &DbError) -> tauri::Result<()> {
    let failure = describe(err, &paths.db_path, &paths.data_dir);
    tracing::error!(
        category = %failure.category,
        error = %failure.error_chain.join(": "),
        "the local database could not be opened; showing the start-up error window"
    );
    app.manage(StartupFailureState {
        failure,
        db_path: paths.db_path.clone(),
        data_dir: paths.data_dir.clone(),
    });
    tauri::WebviewWindowBuilder::new(
        app,
        STARTUP_ERROR_WINDOW_LABEL,
        tauri::WebviewUrl::App("index.html".into()),
    )
    .title("OpenMind Studio")
    .inner_size(640.0, 560.0)
    .min_inner_size(420.0, 360.0)
    .center()
    .data_directory(paths.webview_dir.clone())
    .build()?;
    Ok(())
}

#[tauri::command]
pub fn startup_error_info(state: State<'_, StartupFailureState>) -> StartupFailure {
    state.failure.clone()
}

#[tauri::command]
pub fn startup_error_open_data_folder(state: State<'_, StartupFailureState>) -> Result<(), String> {
    crate::commands::panel::panel_open_folder(state.data_dir.to_string_lossy().into_owned())
}

/// "Back Up and Start Fresh": moves the files aside (the page asks first). The app is restarted by a second call.
#[tauri::command]
pub fn startup_error_back_up(state: State<'_, StartupFailureState>) -> Result<String, String> {
    let stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or_default();
    let backup = move_database_aside(&state.db_path, &state.data_dir, stamp)?;
    tracing::warn!(backup = %backup.display(), "the user moved the database aside from the start-up error window");
    Ok(backup.display().to_string())
}

#[tauri::command]
pub fn startup_error_restart(app: tauri::AppHandle) {
    app.restart();
}

#[tauri::command]
pub fn startup_error_exit(app: tauri::AppHandle) {
    app.exit(0);
}

#[cfg(test)]
#[path = "startup_error_tests.rs"]
mod tests;
