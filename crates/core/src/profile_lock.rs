//! The lock around everything that creates or changes a profile at start-up: choosing a computer's profile folder
//! (and writing its `machine.json`) and importing a database into it.
//!
//! It is an operating-system lock on an open file handle (`LockFileEx` on Windows, `flock` elsewhere, through
//! [`std::fs::File::try_lock`]), not "a lock file exists": the OS releases it when the process ends, also after a crash,
//! a kill or a pulled drive, so a leftover `data/profile.lock` never blocks a start. The file itself is kept (deleting it
//! while another start waits on it would let two processes lock two different files).

use std::fs::{File, OpenOptions};
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

/// The lock file, relative to the app folder.
pub const LOCK_FILE: &str = "data/profile.lock";

/// How long a start waits for another start (same computer) to finish its profile work.
pub const DEFAULT_WAIT: Duration = Duration::from_secs(120);

/// Held while it lives; dropping it (or the process ending) releases it.
#[derive(Debug)]
pub struct ProfileLock {
    _file: File,
    path: PathBuf,
}

impl ProfileLock {
    /// Waits up to `wait` for the lock on `<app_root>/data/profile.lock`.
    pub fn acquire(app_root: &Path, wait: Duration) -> std::io::Result<Self> {
        Self::acquire_file(&app_root.join(LOCK_FILE), wait)
    }

    pub fn acquire_file(path: &Path, wait: Duration) -> std::io::Result<Self> {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        let file = OpenOptions::new()
            .read(true)
            .write(true)
            .create(true)
            .truncate(false)
            .open(path)?;
        let deadline = Instant::now() + wait;
        loop {
            match file.try_lock() {
                Ok(()) => {
                    return Ok(Self {
                        _file: file,
                        path: path.to_path_buf(),
                    })
                }
                Err(std::fs::TryLockError::WouldBlock) if Instant::now() < deadline => {
                    std::thread::sleep(Duration::from_millis(50));
                }
                Err(std::fs::TryLockError::WouldBlock) => return Err(std::io::Error::new(
                    std::io::ErrorKind::TimedOut,
                    "another OpenMind Studio start on this computer is still preparing its profile",
                )),
                Err(std::fs::TryLockError::Error(err)) => return Err(err),
            }
        }
    }

    pub fn path(&self) -> &Path {
        &self.path
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_second_holder_waits_and_a_leftover_file_blocks_nothing() {
        let root = tempfile::tempdir().expect("tempdir");
        // A file left behind by a crashed start is not a lock.
        std::fs::create_dir_all(root.path().join("data")).expect("dir");
        std::fs::write(root.path().join(LOCK_FILE), b"left over").expect("write");
        let first = ProfileLock::acquire(root.path(), Duration::from_millis(200)).expect("first");
        let second = ProfileLock::acquire(root.path(), Duration::from_millis(200));
        assert_eq!(
            second.expect_err("held").kind(),
            std::io::ErrorKind::TimedOut
        );
        drop(first);
        ProfileLock::acquire(root.path(), Duration::from_millis(200)).expect("released on drop");
    }

    #[test]
    fn a_waiting_start_gets_the_lock_once_the_first_finishes() {
        let root = tempfile::tempdir().expect("tempdir");
        let first = ProfileLock::acquire(root.path(), Duration::from_secs(1)).expect("first");
        let path = root.path().to_path_buf();
        let waiter =
            std::thread::spawn(move || ProfileLock::acquire(&path, Duration::from_secs(5)).is_ok());
        std::thread::sleep(Duration::from_millis(150));
        drop(first);
        assert!(waiter.join().expect("thread"));
    }
}
