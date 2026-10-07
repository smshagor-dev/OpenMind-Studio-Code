//! The **portable data scope**: whether one copy of OpenMind Studio keeps one profile (database, logs, WebView
//! profile, MariaDB data ...) for everybody who runs it, or one per computer.
//!
//! - [`DataScope::Personal`] ("Only for me"): the layout every earlier version used — `data/openmind-studio.db`,
//!   `logs/`, `data/webview/`, `data/mariadb/` ... next to the program.
//! - [`DataScope::PerMachine`] ("Everyone / multi-computer"): each computer gets `data/machines/<profile id>/`
//!   ([`crate::machine_paths::MachineDataPaths`]), so two computers never open the same SQLite file. Runtimes, tools,
//!   language servers, extensions, settings and downloads stay shared.
//!
//! The choice is kept in `data/data-scope.json` on the drive itself, because it is read before any database is
//! opened. A missing file means "not chosen yet": the app asks (see `src-tauri/src/data_scope.rs`).

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

/// The file the choice is kept in, relative to the app folder.
pub const SCOPE_FILE: &str = "data/data-scope.json";

const SCHEMA_VERSION: u32 = 1;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum DataScope {
    /// One profile for this copy ("Only for me").
    Personal,
    /// One profile per computer ("Everyone / multi-computer").
    PerMachine,
}

impl DataScope {
    pub fn label(self) -> &'static str {
        match self {
            Self::Personal => "personal",
            Self::PerMachine => "perMachine",
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ScopeFile {
    schema_version: u32,
    mode: DataScope,
    chosen_at: String,
    /// An import the user asked for, done at the next start of that computer (see [`PendingImport`]).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    import: Option<PendingImport>,
}

/// "Copy the profile in use into the new scope", saved with the choice and carried out at the next start of the computer
/// it names, before any database is opened (`src-tauri/src/data_scope/migrate.rs`). It is cleared once the target
/// database exists and is valid. The hash here only *matches* a computer whose identity was already resolved from the
/// computer itself; it never decides which computer the app runs on.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PendingImport {
    /// The full identity hash of the computer that asked for it (derived; see `machine_identity`).
    pub identity_hash: String,
    /// The scope whose database is copied (the one in use when the choice was made).
    pub from: DataScope,
    pub requested_at: String,
}

/// What `data/data-scope.json` says.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ScopeChoice {
    Chosen(DataScope),
    /// No file: nobody has chosen yet.
    NotChosen,
    /// A file that can't be used (damaged, from a newer version): treated as not chosen, and never overwritten
    /// except by a new choice.
    Unreadable(String),
}

pub fn scope_file(app_root: &Path) -> PathBuf {
    app_root.join(SCOPE_FILE)
}

fn read_file(app_root: &Path) -> Result<Option<ScopeFile>, String> {
    let text = match std::fs::read_to_string(scope_file(app_root)) {
        Ok(text) => text,
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(err) => return Err(err.to_string()),
    };
    match serde_json::from_str::<ScopeFile>(&text) {
        Ok(parsed) if parsed.schema_version == SCHEMA_VERSION => Ok(Some(parsed)),
        Ok(parsed) => Err(format!(
            "schema version {} is not supported",
            parsed.schema_version
        )),
        Err(err) => Err(err.to_string()),
    }
}

pub fn read_choice(app_root: &Path) -> ScopeChoice {
    match read_file(app_root) {
        Ok(Some(file)) => ScopeChoice::Chosen(file.mode),
        Ok(None) => ScopeChoice::NotChosen,
        Err(reason) => ScopeChoice::Unreadable(reason),
    }
}

/// The import waiting for the next start, if any (and if the file is readable).
pub fn read_pending_import(app_root: &Path) -> Option<PendingImport> {
    read_file(app_root)
        .ok()
        .flatten()
        .and_then(|file| file.import)
}

/// Saves the choice, with an optional import for the next start (written to a temporary file, flushed and renamed, so a
/// half-written file can't be left behind).
pub fn write_choice(
    app_root: &Path,
    mode: DataScope,
    import: Option<PendingImport>,
) -> std::io::Result<()> {
    let body = ScopeFile {
        schema_version: SCHEMA_VERSION,
        mode,
        chosen_at: rfc3339_now(),
        import,
    };
    let text = serde_json::to_string_pretty(&body).map_err(std::io::Error::other)?;
    write_atomic(&scope_file(app_root), text.as_bytes())
}

/// Removes a finished import from the file, keeping the choice (and its date) as it is.
pub fn clear_pending_import(app_root: &Path) -> std::io::Result<()> {
    let Ok(Some(mut file)) = read_file(app_root) else {
        return Ok(());
    };
    if file.import.take().is_none() {
        return Ok(());
    }
    let text = serde_json::to_string_pretty(&file).map_err(std::io::Error::other)?;
    write_atomic(&scope_file(app_root), text.as_bytes())
}

/// Writes `bytes` to `<file>.<pid>.tmp`, flushes it to the disk and renames it over `file`: a crash (or a pulled drive)
/// leaves either the old or the new content, never a truncated file.
pub(crate) fn write_atomic(file: &Path, bytes: &[u8]) -> std::io::Result<()> {
    use std::io::Write;
    if let Some(parent) = file.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let name = file
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_default();
    let partial = file.with_file_name(format!("{name}.{}.tmp", std::process::id()));
    let written = (|| {
        let mut handle = std::fs::File::create(&partial)?;
        handle.write_all(bytes)?;
        handle.sync_all()
    })();
    if let Err(err) = written.and_then(|()| std::fs::rename(&partial, file)) {
        let _ = std::fs::remove_file(&partial);
        return Err(err);
    }
    Ok(())
}

/// `YYYY-MM-DDTHH:MM:SSZ` for now (UTC).
pub fn rfc3339_now() -> String {
    let secs = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or_default();
    rfc3339(secs)
}

/// `YYYY-MM-DDTHH:MM:SSZ` for Unix seconds (UTC; Howard Hinnant's civil-from-days).
pub fn rfc3339(secs: u64) -> String {
    let days = (secs / 86_400) as i64;
    let rem = secs % 86_400;
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = yoe + era * 400 + i64::from(month <= 2);
    format!(
        "{year:04}-{month:02}-{day:02}T{:02}:{:02}:{:02}Z",
        rem / 3600,
        (rem % 3600) / 60,
        rem % 60
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_missing_file_is_not_chosen_and_a_written_choice_reads_back() {
        let root = tempfile::tempdir().expect("tempdir");
        assert_eq!(read_choice(root.path()), ScopeChoice::NotChosen);
        write_choice(root.path(), DataScope::PerMachine, None).expect("write");
        assert_eq!(
            read_choice(root.path()),
            ScopeChoice::Chosen(DataScope::PerMachine)
        );
        write_choice(root.path(), DataScope::Personal, None).expect("write");
        assert_eq!(
            read_choice(root.path()),
            ScopeChoice::Chosen(DataScope::Personal)
        );
        let text = std::fs::read_to_string(scope_file(root.path())).expect("read");
        assert!(text.contains("\"mode\": \"personal\""), "{text}");
        let leftovers = std::fs::read_dir(root.path().join("data"))
            .expect("dir")
            .filter(|e| {
                e.as_ref()
                    .is_ok_and(|e| e.file_name().to_string_lossy().ends_with(".tmp"))
            })
            .count();
        assert_eq!(leftovers, 0);
    }

    #[test]
    fn a_damaged_or_newer_file_is_unreadable_not_a_choice() {
        let root = tempfile::tempdir().expect("tempdir");
        std::fs::create_dir_all(root.path().join("data")).expect("dir");
        std::fs::write(scope_file(root.path()), "{ broken").expect("write");
        assert!(matches!(
            read_choice(root.path()),
            ScopeChoice::Unreadable(_)
        ));
        std::fs::write(
            scope_file(root.path()),
            r#"{"schemaVersion":9,"mode":"personal","chosenAt":"x"}"#,
        )
        .expect("write");
        assert!(matches!(
            read_choice(root.path()),
            ScopeChoice::Unreadable(_)
        ));
    }

    #[test]
    fn a_pending_import_is_kept_until_cleared_and_the_choice_stays() {
        let root = tempfile::tempdir().expect("tempdir");
        assert_eq!(read_pending_import(root.path()), None);
        let import = PendingImport {
            identity_hash: "42f693bd91a7".repeat(5) + "abcd",
            from: DataScope::Personal,
            requested_at: "2026-10-07T00:00:00Z".into(),
        };
        write_choice(root.path(), DataScope::PerMachine, Some(import.clone())).expect("write");
        assert_eq!(read_pending_import(root.path()), Some(import));
        clear_pending_import(root.path()).expect("clear");
        assert_eq!(read_pending_import(root.path()), None);
        assert_eq!(
            read_choice(root.path()),
            ScopeChoice::Chosen(DataScope::PerMachine)
        );
        clear_pending_import(root.path()).expect("clearing twice is fine");
    }

    #[test]
    fn an_interrupted_write_leaves_the_old_file() {
        let root = tempfile::tempdir().expect("tempdir");
        write_choice(root.path(), DataScope::Personal, None).expect("write");
        // A crash between writing the temporary file and renaming it: the real file is untouched.
        std::fs::write(root.path().join("data/data-scope.json.999.tmp"), "{ trunc").expect("write");
        assert_eq!(
            read_choice(root.path()),
            ScopeChoice::Chosen(DataScope::Personal)
        );
    }

    #[test]
    fn timestamps_are_rfc3339_utc() {
        assert_eq!(rfc3339(0), "1970-01-01T00:00:00Z");
        assert_eq!(rfc3339(951_782_400), "2000-02-29T00:00:00Z");
        assert_eq!(rfc3339(1_791_331_199), "2026-10-06T23:59:59Z");
    }
}
