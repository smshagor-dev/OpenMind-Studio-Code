//! A consistent copy of a SQLite database through SQLite itself, for moving a profile between data scopes
//! (see [`crate::migration`]).
//!
//! The source is opened with `SQLITE_OPEN_READONLY` (not `immutable=1`: it may be live) and copied with the Backup API
//! in one step, i.e. inside one read transaction: the copy holds every transaction committed before it started,
//! including those still only in the source's `-wal` file, and nothing half-written. A read-only connection never
//! writes the source, never checkpoints or truncates its WAL and never changes its journal mode; SQLite may update its
//! `-shm` bookkeeping, which holds no data.

use std::path::Path;
use std::time::Duration;

use rusqlite::{Connection, OpenFlags};

use crate::DbError;

/// Copies `source` into `dest` (which must not exist) and flushes `dest` to the disk. `dest` is left in place on
/// failure for the caller to discard.
pub fn snapshot_to(source: &Path, dest: &Path) -> Result<(), DbError> {
    if dest.exists() {
        return Err(DbError::Copy(format!(
            "{} already exists; nothing was overwritten",
            dest.display()
        )));
    }
    let from = Connection::open_with_flags(
        source,
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )
    .map_err(|err| copy_error("couldn't open the source database", &err))?;
    from.busy_timeout(Duration::from_secs(10))
        .map_err(|err| copy_error("couldn't open the source database", &err))?;
    let mut to = Connection::open_with_flags(
        dest,
        OpenFlags::SQLITE_OPEN_READ_WRITE
            | OpenFlags::SQLITE_OPEN_CREATE
            | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )
    .map_err(|err| copy_error("couldn't create the copy", &err))?;
    {
        let backup = rusqlite::backup::Backup::new(&from, &mut to)
            .map_err(|err| copy_error("couldn't start the copy", &err))?;
        // -1: every page in one step, so the whole copy reads one consistent state of the source. Busy/Locked (a
        // writer holds the lock for a moment) is retried for up to ten seconds.
        let deadline = std::time::Instant::now() + Duration::from_secs(10);
        loop {
            use rusqlite::backup::StepResult::{Busy, Done, Locked, More};
            match backup
                .step(-1)
                .map_err(|err| copy_error("the copy failed", &err))?
            {
                Done => break,
                More | Busy | Locked if std::time::Instant::now() < deadline => {
                    std::thread::sleep(Duration::from_millis(25));
                }
                _ => {
                    return Err(DbError::Copy(
                        "the source database stayed locked; the copy will be tried again".into(),
                    ))
                }
            }
        }
    }
    drop(from);
    to.close()
        .map_err(|(_, err)| copy_error("couldn't finish the copy", &err))?;
    flush(dest)
}

/// `PRAGMA quick_check` answered `ok`. A file that can't be opened or read as a database is not valid. For a copy this
/// app made (read-write, so closing removes its `-wal`/`-shm`); a source is checked with [`quick_check_source`].
pub fn quick_check(path: &Path) -> bool {
    check_with(path, OpenFlags::SQLITE_OPEN_READ_WRITE)
}

/// [`quick_check`] for a database that must not be written (a source being copied): closing a read-write connection
/// would checkpoint its WAL into the main file.
pub fn quick_check_source(path: &Path) -> bool {
    check_with(path, OpenFlags::SQLITE_OPEN_READ_ONLY)
}

fn check_with(path: &Path, mode: OpenFlags) -> bool {
    let Ok(connection) = Connection::open_with_flags(path, mode | OpenFlags::SQLITE_OPEN_NO_MUTEX)
    else {
        return false;
    };
    let answer: Result<Vec<String>, rusqlite::Error> = connection
        .prepare("PRAGMA quick_check")
        .and_then(|mut statement| {
            statement
                .query_map([], |row| row.get::<_, String>(0))?
                .collect()
        });
    drop(connection);
    matches!(answer.as_deref(), Ok([only]) if only == "ok")
}

/// Writes a file's data to the disk (a later rename must never point at data still in a cache).
pub fn flush(path: &Path) -> Result<(), DbError> {
    std::fs::OpenOptions::new()
        .read(true)
        .write(true)
        .open(path)
        .and_then(|file| file.sync_all())
        .map_err(|err| DbError::Copy(format!("couldn't flush {}: {err}", path.display())))
}

fn copy_error(what: &str, err: &rusqlite::Error) -> DbError {
    DbError::Copy(format!("{what}: {err}"))
}

#[cfg(test)]
#[path = "snapshot_tests.rs"]
pub(crate) mod tests;
