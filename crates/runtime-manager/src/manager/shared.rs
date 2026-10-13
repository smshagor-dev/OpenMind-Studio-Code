//! What the Runtime Manager does differently because `runtimes/` can be shared by several computers (a network
//! installation, a portable drive in a lab) while each computer keeps its own install records:
//!
//! - **one change at a time across computers**: [`RuntimeManager::acquire`] takes this process's busy mark *and* the
//!   version's operating-system lock (`version_lock.rs`), so two installs never write one folder. An **install** that
//!   finds another computer installing the same version waits for it ([`RuntimeManager::acquire_waiting`], phase
//!   `waiting`) and then uses what that computer installed — three computers asking for Python at once give one
//!   download and one unpack. When the other computer crashes its lock goes with its process, the wait ends and this
//!   computer installs. Repair, delete and add-on changes don't wait: they report [`RuntimeError::BusyElsewhere`];
//! - **never reinstall what is there**: a version another computer installed in full is adopted
//!   ([`RuntimeManager::adopt_if_healthy`]) — recorded here, launchers checked — instead of being unpacked again over
//!   files that may be running on that computer right now;
//! - **remove all or nothing** ([`retire_dir`]): the folder is renamed away first. If anything in it is open — a terminal,
//!   a run or a server using it on any computer — Windows refuses the rename and nothing is removed
//!   ([`RuntimeError::InUse`]); the old behaviour deleted file by file and could leave a half-removed runtime.

use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use openmind_db::InstalledRuntimesRepository;

use super::{
    addons, feature_statuses, version_lock, InstallPhase, InstallProgress, InstalledVersion,
    ProgressSink, RuntimeManager,
};
use crate::error::RuntimeError;
use crate::manifest::RuntimeManifest;

pub(super) struct BusyGuard {
    busy: Arc<Mutex<HashSet<(String, String)>>>,
    key: (String, String),
    /// The cross-process lock, released with the guard.
    _lock: version_lock::VersionLock,
}

impl Drop for BusyGuard {
    fn drop(&mut self) {
        if let Ok(mut set) = self.busy.lock() {
            set.remove(&self.key);
        }
    }
}

/// How long an install waits for another computer's install of the same version. Long enough for a slow download of a
/// large runtime (a JDK, Flutter) over a busy lab network; the wait also ends the moment that computer's process does.
pub(super) const SHARED_INSTALL_WAIT: std::time::Duration = std::time::Duration::from_secs(60 * 60);
/// How often a waiting install looks at the lock again.
const WAIT_POLL: std::time::Duration = std::time::Duration::from_millis(250);

/// The suffix of a folder being removed (`<version>.removing-<pid>`); reconcile clears leftovers.
pub(super) const REMOVING: &str = ".removing-";

impl RuntimeManager {
    pub(super) fn acquire(&self, kind: &str, version: &str) -> Result<BusyGuard, RuntimeError> {
        let key = (kind.to_string(), version.to_string());
        let mut set = self.busy.lock().map_err(|_| RuntimeError::Busy {
            kind: kind.into(),
            version: version.into(),
        })?;
        if !set.insert(key.clone()) {
            return Err(RuntimeError::Busy {
                kind: kind.into(),
                version: version.into(),
            });
        }
        let lock = match version_lock::VersionLock::try_acquire(&self.paths, kind, version) {
            Ok(Some(lock)) => lock,
            outcome => {
                set.remove(&key);
                return Err(outcome
                    .err()
                    .unwrap_or_else(|| RuntimeError::BusyElsewhere {
                        kind: kind.into(),
                        version: version.into(),
                    }));
            }
        };
        Ok(BusyGuard {
            busy: self.busy.clone(),
            key,
            _lock: lock,
        })
    }

    /// [`Self::acquire`] for an install: while another computer holds the version's lock it waits (up to the manager's
    /// shared wait), telling the progress sink once that it is waiting. In-process conflicts and real errors return at
    /// once.
    pub(super) async fn acquire_waiting(
        &self,
        kind: &str,
        version: &str,
        progress: &ProgressSink,
    ) -> Result<BusyGuard, RuntimeError> {
        let deadline = std::time::Instant::now() + self.shared_wait;
        let mut announced = false;
        loop {
            match self.acquire(kind, version) {
                Err(RuntimeError::BusyElsewhere { .. }) if std::time::Instant::now() < deadline => {
                    if !announced {
                        announced = true;
                        tracing::info!(
                            kind,
                            version,
                            "another computer is installing this runtime; waiting to use its install"
                        );
                        progress(InstallProgress {
                            kind: kind.into(),
                            version: version.into(),
                            phase: InstallPhase::Waiting,
                            current: 0,
                            total: None,
                        });
                    }
                    tokio::time::sleep(WAIT_POLL).await;
                }
                outcome => return outcome,
            }
        }
    }

    /// A version another computer (or a hand copy) already installed in full: recorded here and given its shims
    /// instead of being downloaded and unpacked again over files that may be in use. `None` when it isn't healthy.
    pub(super) async fn adopt_if_healthy(
        &self,
        manifest: &RuntimeManifest,
        kind: &str,
        version: &str,
    ) -> Result<Option<InstalledVersion>, RuntimeError> {
        let dir = self.paths.version_dir(kind, version)?;
        if !self.ensure_shims(manifest, kind, version) {
            return Ok(None);
        }
        let repo = InstalledRuntimesRepository::new(self.db.pool());
        if repo.get(kind, version).await?.is_none() {
            repo.record(kind, version, &dir.to_string_lossy()).await?;
            tracing::info!(
                kind,
                version,
                "adopted a runtime that is already installed in the shared folder"
            );
        }
        let entry = repo
            .get(kind, version)
            .await?
            .ok_or_else(|| RuntimeError::NotInstalled {
                kind: kind.into(),
                version: version.into(),
            })?;
        Ok(Some(InstalledVersion {
            version: entry.version,
            path: dir.to_string_lossy().into_owned(),
            active: entry.is_active,
            healthy: true,
            features: feature_statuses(manifest, &dir),
            addons: addons::addon_statuses(manifest, version, &self.platform, &dir),
        }))
    }
}

/// Removes a version's folder all at once or not at all (see the module text).
pub(super) fn retire_dir(dir: &Path, kind: &str, version: &str) -> Result<(), RuntimeError> {
    if !dir.exists() {
        return Ok(());
    }
    let retired = retired_name(dir);
    if let Err(err) = std::fs::rename(dir, &retired) {
        return Err(match err.kind() {
            std::io::ErrorKind::PermissionDenied | std::io::ErrorKind::ResourceBusy => {
                RuntimeError::InUse {
                    kind: kind.into(),
                    version: version.into(),
                }
            }
            _ if is_sharing_violation(&err) => RuntimeError::InUse {
                kind: kind.into(),
                version: version.into(),
            },
            _ => RuntimeError::io(dir, err),
        });
    }
    if let Err(err) = std::fs::remove_dir_all(&retired) {
        // It is out of the way already (no longer a version); what is left goes at the next reconcile.
        tracing::warn!(kind, version, error = %err, "the removed runtime's folder couldn't be deleted completely yet");
    }
    Ok(())
}

fn retired_name(dir: &Path) -> PathBuf {
    let name = dir
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_default();
    dir.with_file_name(format!("{name}{REMOVING}{}", std::process::id()))
}

/// Windows' "file in use" codes (sharing / lock violation), which Rust reports as an uncategorized kind.
fn is_sharing_violation(err: &std::io::Error) -> bool {
    matches!(err.raw_os_error(), Some(32 | 33))
}

/// Whether a folder name under `versions/` is a removal left behind.
pub(super) fn is_retired(name: &str) -> bool {
    name.contains(REMOVING)
}
