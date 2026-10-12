//! Keeping the install records in line with the `runtimes/` folder, which is the truth.
//!
//! The records live in the database, and in the per-computer data scope every computer has its own database while the
//! `runtimes/` folder on the drive is shared. So a runtime installed (or removed) on another computer — or copied in by
//! hand — must show up (or disappear) here without a download: a healthy version folder without a record is adopted
//! (the first version of a kind becomes the active one), a record whose folder is gone is dropped (another installed
//! version then becomes active). Only *which* installed version is active stays a per-computer choice.

use std::collections::HashSet;
use std::fs;
use std::time::{Duration, Instant};

use openmind_db::InstalledRuntimesRepository;

use super::shared;
use super::version_lock::VersionLock;
use super::RuntimeManager;
use crate::error::RuntimeError;

/// How long a reconcile is trusted by [`RuntimeManager::environment`]-style callers (a terminal launch, a run).
const FRESH_FOR: Duration = Duration::from_secs(3);

impl RuntimeManager {
    pub(super) async fn reconcile(&self) -> Result<(), RuntimeError> {
        let repo = InstalledRuntimesRepository::new(self.db.pool());
        let known = repo.list().await?;
        let in_flight: HashSet<(String, String)> =
            self.busy.lock().map(|set| set.clone()).unwrap_or_default();
        for manifest in self.registry.all() {
            let versions_dir = self.paths.versions_dir(&manifest.id)?;
            // Shims of a version that no longer exists are just clutter.
            if let Ok(shim_entries) = fs::read_dir(self.paths.shims_root(&manifest.id)?) {
                for shim_entry in shim_entries.filter_map(Result::ok) {
                    if !versions_dir.join(shim_entry.file_name()).is_dir() {
                        let _ = fs::remove_dir_all(shim_entry.path());
                    }
                }
            }
            // Busy here, or being changed by another OpenMind (possibly on another computer sharing this folder).
            let busy = |version: &str| {
                in_flight.contains(&(manifest.id.clone(), version.to_string()))
                    || VersionLock::is_held(&self.paths, &manifest.id, version)
            };
            // A record whose folder is gone (removed on another computer, or by hand) is dropped.
            for entry in known.iter().filter(|k| k.kind == manifest.id) {
                let present = self
                    .paths
                    .version_dir(&entry.kind, &entry.version)
                    .is_ok_and(|dir| dir.is_dir());
                if !present && !busy(&entry.version) {
                    repo.remove(&entry.kind, &entry.version).await?;
                }
            }
            let Ok(entries) = fs::read_dir(&versions_dir) else {
                continue;
            };
            for entry in entries.filter_map(Result::ok) {
                if !entry.file_type().is_ok_and(|t| t.is_dir()) {
                    continue; // `<version>.lock` files
                }
                let name = entry.file_name().to_string_lossy().into_owned();
                // A half-installed or half-removed folder is cleared only when nobody is working on that version: on
                // another computer the install may be running right now.
                if let Some(version) = name.strip_suffix(".installing") {
                    if !busy(version) {
                        let _ = fs::remove_dir_all(entry.path());
                    }
                    continue;
                }
                if shared::is_retired(&name) {
                    let version = name.split(shared::REMOVING).next().unwrap_or_default();
                    if !busy(version) {
                        let _ = fs::remove_dir_all(entry.path());
                    }
                    continue;
                }
                if busy(&name) {
                    continue;
                }
                let Ok(dir) = self.paths.version_dir(&manifest.id, &name) else {
                    continue;
                };
                let recorded = known
                    .iter()
                    .any(|k| k.kind == manifest.id && k.version == name);
                if !recorded && self.ensure_shims(manifest, &manifest.id, &name) {
                    repo.record(&manifest.id, &name, &dir.to_string_lossy())
                        .await?;
                }
            }
        }
        if let Ok(mut last) = self.reconciled.lock() {
            *last = Some(Instant::now());
        }
        Ok(())
    }

    /// [`Self::reconcile`] unless one ran a moment ago; a failure is logged and the records are used as they are.
    pub(super) async fn reconcile_recent(&self) {
        let fresh = self
            .reconciled
            .lock()
            .ok()
            .and_then(|last| *last)
            .is_some_and(|at| at.elapsed() < FRESH_FOR);
        if !fresh {
            if let Err(err) = self.reconcile().await {
                tracing::warn!(%err, "couldn't compare the runtime records with the runtimes folder");
            }
        }
    }
}
