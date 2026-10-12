//! One installed version is changed by one OpenMind at a time — also across computers that share the `runtimes/`
//! folder (a network installation, a portable drive in a lab).
//!
//! The in-process `busy` set only knows this process. [`VersionLock`] adds an operating-system lock on
//! `runtimes/<kind>/versions/<version>.lock` (`LockFileEx` on Windows, also honoured over SMB; `flock` elsewhere), taken
//! for an install, a repair, a delete or an add-on change and held until it ends. It is a lock on an open handle, not
//! "a lock file exists": the system releases it when the process ends, crashes or loses the network, so a leftover
//! `.lock` file never blocks anyone. Readers — a terminal or a run on another computer using that runtime — take no
//! lock: using a runtime and changing it are separate things, and using it never blocks or is blocked by an install.
//!
//! [`reconcile`](super::reconcile) asks [`VersionLock::is_held`] before it touches a half-installed `.installing`
//! folder or a `.removing` one: those belong to an operation that may be running on another computer right now.

use std::fs::{File, OpenOptions, TryLockError};
use std::path::{Path, PathBuf};

use crate::error::RuntimeError;
use crate::paths::RuntimePaths;

/// Held while one version is being changed (see the module text).
#[derive(Debug)]
pub struct VersionLock {
    _file: File,
}

/// The lock file of one version.
pub fn lock_file(paths: &RuntimePaths, kind: &str, version: &str) -> Result<PathBuf, RuntimeError> {
    let dir = paths.version_dir(kind, version)?;
    Ok(dir.with_file_name(format!("{version}.lock")))
}

impl VersionLock {
    /// Takes the lock, or `Ok(None)` when another process (here or on another computer) holds it.
    pub fn try_acquire(
        paths: &RuntimePaths,
        kind: &str,
        version: &str,
    ) -> Result<Option<Self>, RuntimeError> {
        let file = lock_file(paths, kind, version)?;
        Self::try_acquire_at(&file)
    }

    pub fn try_acquire_at(file: &Path) -> Result<Option<Self>, RuntimeError> {
        if let Some(parent) = file.parent() {
            std::fs::create_dir_all(parent).map_err(|err| RuntimeError::io(parent, err))?;
        }
        let handle = OpenOptions::new()
            .read(true)
            .write(true)
            .create(true)
            .truncate(false)
            .open(file)
            .map_err(|err| RuntimeError::io(file, err))?;
        match handle.try_lock() {
            Ok(()) => Ok(Some(Self { _file: handle })),
            Err(TryLockError::WouldBlock) => Ok(None),
            Err(TryLockError::Error(err)) => Err(RuntimeError::io(file, err)),
        }
    }

    /// Whether an operation holds this version's lock right now. A missing or unreadable lock file means no (a folder
    /// nobody can write also has nobody changing it).
    pub fn is_held(paths: &RuntimePaths, kind: &str, version: &str) -> bool {
        let Ok(file) = lock_file(paths, kind, version) else {
            return false;
        };
        if !file.is_file() {
            return false;
        }
        let Ok(handle) = OpenOptions::new().read(true).open(&file) else {
            return false;
        };
        match handle.try_lock() {
            Ok(()) => {
                let _ = handle.unlock();
                false
            }
            Err(TryLockError::WouldBlock) => true,
            Err(TryLockError::Error(_)) => false,
        }
    }
}
