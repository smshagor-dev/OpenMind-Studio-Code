use std::collections::HashSet;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use openmind_db::{Db, InstalledRuntimeEntry, InstalledRuntimesRepository};
use serde::Serialize;

use crate::detect::system_versions;
use crate::download::{verify_sha256, HttpClient};
use crate::error::RuntimeError;
use crate::extract::{extract_tar_gz, extract_zip, ExtractSelection};
use crate::manifest::{ArchiveKind, License, RuntimeManifest, RuntimeRegistry};
use crate::paths::RuntimePaths;
use crate::postinstall;
use crate::shims::{shims_present, write_shims};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum InstallPhase {
    Download,
    Verify,
    Extract,
    Finalize,
    Done,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InstallProgress {
    pub kind: String,
    pub version: String,
    pub phase: InstallPhase,
    pub current: u64,
    pub total: Option<u64>,
}

pub type ProgressSink = Arc<dyn Fn(InstallProgress) + Send + Sync>;

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InstalledVersion {
    pub version: String,
    pub path: String,
    pub active: bool,
    /// Every file the manifest requires is present. `false` means "repair me".
    pub healthy: bool,
    /// What this particular install can do (pip for Python, ...), from what's actually on disk.
    pub features: Vec<FeatureStatus>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FeatureStatus {
    pub id: String,
    pub label: String,
    pub available: bool,
    /// Why the feature is missing; empty when it's available.
    pub note: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeStatus {
    pub id: String,
    pub display_name: String,
    pub description: String,
    pub notes: String,
    pub default_version: String,
    /// Versions that have a download for this platform.
    pub available_versions: Vec<String>,
    pub installed: Vec<InstalledVersion>,
    pub active_version: Option<String>,
    /// A copy of this tool already on the system PATH, if any (informational).
    pub global_version: Option<String>,
    /// Some operation on this runtime is running right now.
    pub busy: bool,
    pub requires: Vec<String>,
    pub license: Option<License>,
    /// Download and installed size of the default version for this platform (`None`: unknown or no download).
    pub download_bytes: Option<u64>,
    pub install_bytes: Option<u64>,
}

/// What a launched process needs to see the active runtimes: folders to put
/// in front of PATH and extra variables. Handed to whatever starts the
/// process (the terminal) — the real system PATH is never edited.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeEnvironment {
    pub path_prepend: Vec<PathBuf>,
    pub vars: Vec<(String, String)>,
}

struct BusyGuard {
    busy: Arc<Mutex<HashSet<(String, String)>>>,
    key: (String, String),
}

impl Drop for BusyGuard {
    fn drop(&mut self) {
        if let Ok(mut set) = self.busy.lock() {
            set.remove(&self.key);
        }
    }
}

/// Installs, verifies, repairs, switches and removes portable runtimes.
/// Cheap to clone (everything inside is shared).
#[derive(Clone)]
pub struct RuntimeManager {
    db: Db,
    paths: RuntimePaths,
    registry: Arc<RuntimeRegistry>,
    client: Arc<dyn HttpClient>,
    platform: String,
    busy: Arc<Mutex<HashSet<(String, String)>>>,
}

impl RuntimeManager {
    pub fn new(
        db: Db,
        paths: RuntimePaths,
        registry: RuntimeRegistry,
        client: Arc<dyn HttpClient>,
        platform: &str,
    ) -> Self {
        Self {
            db,
            paths,
            registry: Arc::new(registry),
            client,
            platform: platform.to_string(),
            busy: Arc::default(),
        }
    }

    pub fn registry(&self) -> &RuntimeRegistry {
        &self.registry
    }

    pub fn paths(&self) -> &RuntimePaths {
        &self.paths
    }

    pub fn platform(&self) -> &str {
        &self.platform
    }

    /// Every known runtime with what's installed. Also reconciles the
    /// database with disk first, so a `runtimes/` folder copied in from
    /// another portable install just shows up, and leftover half-installs
    /// from a crash are cleaned away.
    pub async fn list(&self) -> Result<Vec<RuntimeStatus>, RuntimeError> {
        self.reconcile().await?;
        let entries = InstalledRuntimesRepository::new(self.db.pool())
            .list()
            .await?;
        let busy: HashSet<String> = self
            .busy
            .lock()
            .map(|set| set.iter().map(|(kind, _)| kind.clone()).collect())
            .unwrap_or_default();

        let manifests: Vec<RuntimeManifest> = self.registry.all().cloned().collect();
        let probe = manifests.clone();
        let globals = tokio::task::spawn_blocking(move || system_versions(&probe))
            .await
            .unwrap_or_default();

        let mut statuses = Vec::new();
        for manifest in manifests {
            let mine: Vec<&InstalledRuntimeEntry> = entries
                .iter()
                .filter(|entry| entry.kind == manifest.id)
                .collect();
            let mut installed = Vec::new();
            for entry in &mine {
                let dir = self.paths.version_dir(&manifest.id, &entry.version)?;
                installed.push(InstalledVersion {
                    version: entry.version.clone(),
                    path: dir.to_string_lossy().into_owned(),
                    active: entry.is_active,
                    healthy: self.ensure_shims(&manifest, &manifest.id, &entry.version),
                    features: feature_statuses(&manifest, &dir),
                });
            }
            statuses.push(RuntimeStatus {
                available_versions: manifest
                    .versions_for(&self.platform)
                    .into_iter()
                    .map(str::to_string)
                    .collect(),
                active_version: mine.iter().find(|e| e.is_active).map(|e| e.version.clone()),
                global_version: globals
                    .iter()
                    .find(|(id, _)| *id == manifest.id)
                    .and_then(|(_, version)| version.clone()),
                busy: busy.contains(&manifest.id),
                download_bytes: manifest.sizes(&manifest.default_version, &self.platform).0,
                install_bytes: manifest.sizes(&manifest.default_version, &self.platform).1,
                requires: manifest.requires,
                license: manifest.license,
                id: manifest.id,
                display_name: manifest.display_name,
                description: manifest.description,
                notes: manifest.notes,
                default_version: manifest.default_version,
                installed,
            });
        }
        Ok(statuses)
    }

    pub async fn install(
        &self,
        kind: &str,
        version: Option<&str>,
        progress: ProgressSink,
    ) -> Result<InstalledVersion, RuntimeError> {
        let manifest = self.registry.get(kind)?;
        let version = version.unwrap_or(&manifest.default_version).to_string();
        let _guard = self.acquire(kind, &version)?;
        self.install_inner(kind, &version, progress).await
    }

    /// Makes sure an installed version is intact: healthy installs are left
    /// alone; damaged or partial ones are wiped and installed again (reusing
    /// the verified cached download when there is one). Returns whether
    /// anything had to be repaired.
    pub async fn repair(
        &self,
        kind: &str,
        version: &str,
        progress: ProgressSink,
    ) -> Result<bool, RuntimeError> {
        let manifest = self.registry.get(kind)?.clone();
        let _guard = self.acquire(kind, version)?;
        let dir = self.paths.version_dir(kind, version)?;
        let recorded = InstalledRuntimesRepository::new(self.db.pool())
            .get(kind, version)
            .await?
            .is_some();
        if !recorded && !dir.exists() {
            return Err(RuntimeError::NotInstalled {
                kind: kind.into(),
                version: version.into(),
            });
        }
        if recorded && is_healthy(&manifest, &dir) {
            // Files are fine; the only thing that can be missing is a shim.
            let shim_dir = self.paths.shim_dir(kind, version)?;
            if shims_present(&manifest, &shim_dir) {
                return Ok(false);
            }
            write_shims(&manifest, version, &shim_dir)?;
            return Ok(true);
        }
        remove_dir_if_exists(&dir)?;
        remove_dir_if_exists(&self.paths.shim_dir(kind, version)?)?;
        self.install_inner(kind, version, progress).await?;
        Ok(true)
    }

    pub async fn set_active(&self, kind: &str, version: &str) -> Result<(), RuntimeError> {
        self.registry.get(kind)?;
        let switched = InstalledRuntimesRepository::new(self.db.pool())
            .set_active(kind, version)
            .await?;
        if switched {
            Ok(())
        } else {
            Err(RuntimeError::NotInstalled {
                kind: kind.into(),
                version: version.into(),
            })
        }
    }

    /// Deletes one installed version's files, then its record. The folder to
    /// delete is always recomputed from the (validated) kind and version —
    /// never taken from the database — so a tampered record can't point the
    /// delete somewhere else.
    pub async fn delete(&self, kind: &str, version: &str) -> Result<(), RuntimeError> {
        self.registry.get(kind)?;
        let _guard = self.acquire(kind, version)?;
        let dir = self.paths.version_dir(kind, version)?;
        let recorded = InstalledRuntimesRepository::new(self.db.pool())
            .get(kind, version)
            .await?
            .is_some();
        if !recorded && !dir.exists() {
            return Err(RuntimeError::NotInstalled {
                kind: kind.into(),
                version: version.into(),
            });
        }
        remove_dir_if_exists(&dir)?;
        remove_dir_if_exists(&self.paths.shim_dir(kind, version)?)?;
        InstalledRuntimesRepository::new(self.db.pool())
            .remove(kind, version)
            .await?;
        Ok(())
    }

    /// The folder of the active, healthy install of `kind`, if there is one (for tools that are not
    /// commands on a PATH: a debug adapter's files).
    pub async fn installed_dir(&self, kind: &str) -> Option<PathBuf> {
        let entries = InstalledRuntimesRepository::new(self.db.pool())
            .list()
            .await
            .ok()?;
        let entry = entries
            .iter()
            .find(|entry| entry.kind == kind && entry.is_active)?;
        let manifest = self.registry.get(kind).ok()?;
        let dir = self.paths.version_dir(kind, &entry.version).ok()?;
        self.ensure_shims(manifest, kind, &entry.version)
            .then_some(dir)
    }

    /// The environment for a process launched by OpenMind Studio: the active
    /// version of each installed, healthy runtime.
    pub async fn environment(&self) -> Result<RuntimeEnvironment, RuntimeError> {
        let entries = InstalledRuntimesRepository::new(self.db.pool())
            .list()
            .await?;
        let mut environment = RuntimeEnvironment::default();
        for entry in entries.iter().filter(|entry| entry.is_active) {
            let Ok(manifest) = self.registry.get(&entry.kind) else {
                continue;
            };
            let Ok(dir) = self.paths.version_dir(&entry.kind, &entry.version) else {
                continue;
            };
            if !self.ensure_shims(manifest, &entry.kind, &entry.version) {
                continue;
            }
            // Shims first: their commands must win over launchers a tool
            // generated with absolute paths (which break when the app moves).
            if !manifest.shims.is_empty() {
                if let Ok(shim_dir) = self.paths.shim_dir(&entry.kind, &entry.version) {
                    environment.path_prepend.push(shim_dir);
                }
            }
            for bin in &manifest.bin_dirs {
                environment.path_prepend.push(if bin == "." {
                    dir.clone()
                } else {
                    dir.join(bin)
                });
            }
            for (key, value) in &manifest.env {
                let value = value.replace("{dir}", &dir.to_string_lossy());
                let value = value.replace("{cache}", &self.paths.cache_dir().to_string_lossy());
                environment.vars.push((key.clone(), value));
            }
        }
        Ok(environment)
    }

    /// Whether this install is fully usable: its files are all there and so
    /// are its shims. Missing shims of an otherwise intact install are simply
    /// written again (they're derived from the manifest and the install's own
    /// location, so this is also what makes a moved app folder work); if that
    /// fails the install is reported unhealthy, never quietly half-working.
    fn ensure_shims(&self, manifest: &RuntimeManifest, kind: &str, version: &str) -> bool {
        let (Ok(dir), Ok(shim_dir)) = (
            self.paths.version_dir(kind, version),
            self.paths.shim_dir(kind, version),
        ) else {
            return false;
        };
        if !is_healthy(manifest, &dir) {
            return false;
        }
        if shims_present(manifest, &shim_dir) {
            return true;
        }
        match write_shims(manifest, version, &shim_dir) {
            Ok(()) => {
                tracing::info!(kind, version, "recreated missing runtime shims");
                true
            }
            Err(err) => {
                tracing::warn!(kind, version, error = %err, "couldn't recreate runtime shims");
                false
            }
        }
    }

    fn acquire(&self, kind: &str, version: &str) -> Result<BusyGuard, RuntimeError> {
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
        Ok(BusyGuard {
            busy: self.busy.clone(),
            key,
        })
    }

    async fn install_inner(
        &self,
        kind: &str,
        version: &str,
        progress: ProgressSink,
    ) -> Result<InstalledVersion, RuntimeError> {
        let mut manifest = self.registry.get(kind)?.clone();
        // A version may carry its own seed files (they replace the manifest's).
        if let Some(own) = manifest
            .versions
            .iter()
            .find(|candidate| candidate.version == version)
            .map(|found| found.seed_files.clone())
            .filter(|files| !files.is_empty())
        {
            manifest.seed_files = own;
        }
        let artifact = match manifest.artifact(version, &self.platform) {
            Some(artifact) => artifact.clone(),
            None if manifest.versions.iter().any(|v| v.version == version) => {
                return Err(RuntimeError::UnsupportedPlatform {
                    kind: kind.into(),
                    version: version.into(),
                    platform: self.platform.clone(),
                });
            }
            None => {
                return Err(RuntimeError::UnknownVersion {
                    kind: kind.into(),
                    version: version.into(),
                });
            }
        };
        let final_dir = self.paths.version_dir(kind, version)?;
        let staging = self.paths.staging_dir(kind, version)?;
        let archive = self.paths.download_path(&artifact.sha256, &artifact.url);

        let client = self.client.clone();
        let (kind_owned, version_owned) = (kind.to_string(), version.to_string());
        let job = {
            let (staging, final_dir) = (staging.clone(), final_dir.clone());
            let manifest = manifest.clone();
            move || -> Result<(), RuntimeError> {
                let report = |phase, current, total| {
                    progress(InstallProgress {
                        kind: kind_owned.clone(),
                        version: version_owned.clone(),
                        phase,
                        current,
                        total,
                    });
                };
                install_files(
                    client.as_ref(),
                    &manifest,
                    &artifact,
                    &archive,
                    &staging,
                    &final_dir,
                    &report,
                )
            }
        };
        let outcome = tokio::task::spawn_blocking(job)
            .await
            .map_err(|err| RuntimeError::Download(format!("install task failed: {err}")))?;
        if let Err(err) = outcome {
            let _ = fs::remove_dir_all(&staging);
            return Err(err);
        }
        // Commands are generated only now: the archive is verified, extracted
        // and set up. A failure here fails the install instead of leaving a
        // runtime whose commands don't exist.
        let shim_dir = self.paths.shim_dir(kind, version)?;
        if let Err(err) = write_shims(&manifest, version, &shim_dir) {
            let _ = fs::remove_dir_all(&final_dir);
            let _ = fs::remove_dir_all(&shim_dir);
            return Err(err);
        }

        let repo = InstalledRuntimesRepository::new(self.db.pool());
        repo.record(kind, version, &final_dir.to_string_lossy())
            .await?;
        let entry = repo
            .get(kind, version)
            .await?
            .ok_or_else(|| RuntimeError::NotInstalled {
                kind: kind.into(),
                version: version.into(),
            })?;
        Ok(InstalledVersion {
            version: entry.version,
            path: final_dir.to_string_lossy().into_owned(),
            active: entry.is_active,
            healthy: true,
            features: feature_statuses(&manifest, &final_dir),
        })
    }

    async fn reconcile(&self) -> Result<(), RuntimeError> {
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
            let Ok(entries) = fs::read_dir(&versions_dir) else {
                continue;
            };
            for entry in entries.filter_map(Result::ok) {
                let name = entry.file_name().to_string_lossy().into_owned();
                if let Some(version) = name.strip_suffix(".installing") {
                    if !in_flight.contains(&(manifest.id.clone(), version.to_string())) {
                        let _ = fs::remove_dir_all(entry.path());
                    }
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
        Ok(())
    }
}

/// Download → verify → extract → swap into place. Runs on a blocking thread.
/// Nothing is executed and nothing outside `staging`/`final_dir` is written.
fn install_files(
    client: &dyn HttpClient,
    manifest: &RuntimeManifest,
    artifact: &crate::manifest::Artifact,
    archive: &Path,
    staging: &Path,
    final_dir: &Path,
    report: &dyn Fn(InstallPhase, u64, Option<u64>),
) -> Result<(), RuntimeError> {
    use InstallPhase::*;

    // A previously downloaded (or offline-imported) copy is reused only if it still matches.
    let cached = archive.exists()
        && verify_sha256(archive, &artifact.sha256, &mut |c, t| report(Verify, c, t)).is_ok();
    if !cached {
        crate::fetch::fetch_verified(
            client,
            artifact,
            archive,
            &|c, t| report(Download, c, t),
            &|c, t| report(Verify, c, t),
            &mut std::thread::sleep,
        )?;
    }

    remove_dir_if_exists(staging)?;
    let selection = ExtractSelection {
        strip_components: artifact.strip_components,
        only_under: artifact.extract_root.as_deref(),
    };
    match artifact.archive {
        ArchiveKind::Zip => extract_zip(archive, staging, selection, &mut |c, t| {
            report(Extract, c, t);
        })?,
        ArchiveKind::TarGz => extract_tar_gz(archive, staging, selection, &mut |c, t| {
            report(Extract, c, t);
        })?,
        ArchiveKind::File => place_file(archive, staging, artifact.install_as.as_deref())?,
    }
    write_seed_files(manifest, staging)?;
    // Files a setup step is going to create can't be checked yet; those installs
    // are checked after the steps ran, below.
    if manifest.post_install.is_empty() {
        check_verify_files(manifest, staging)?;
    }

    report(Finalize, 0, None);
    remove_dir_if_exists(final_dir)?;
    fs::rename(staging, final_dir).map_err(|err| RuntimeError::io(final_dir, err))?;
    if !manifest.post_install.is_empty() {
        // Set up where it will live: tools like pip write launchers that
        // record the interpreter's absolute path.
        let finished = postinstall::run_steps(&manifest.post_install, final_dir, &manifest.env)
            .and_then(|()| check_verify_files(manifest, final_dir));
        if let Err(err) = finished {
            let _ = fs::remove_dir_all(final_dir);
            return Err(err);
        }
    }
    report(Done, 1, Some(1));
    Ok(())
}

/// A single downloaded file (already checksum-verified) becomes the whole
/// install: copied into the staging folder under the manifest's fixed name.
fn place_file(archive: &Path, staging: &Path, name: Option<&str>) -> Result<(), RuntimeError> {
    let name = name.ok_or_else(|| {
        RuntimeError::InvalidManifest("a file artifact has no installAs name".into())
    })?;
    fs::create_dir_all(staging).map_err(|err| RuntimeError::io(staging, err))?;
    let target = staging.join(name);
    fs::copy(archive, &target).map_err(|err| RuntimeError::io(&target, err))?;
    Ok(())
}

/// Writes the manifest's `seedFiles` (a `php.ini`, say) into a fresh install.
fn write_seed_files(manifest: &RuntimeManifest, dir: &Path) -> Result<(), RuntimeError> {
    for seed in &manifest.seed_files {
        let target = dir.join(&seed.path);
        if let Some(parent) = target.parent() {
            fs::create_dir_all(parent).map_err(|err| RuntimeError::io(parent, err))?;
        }
        fs::write(&target, &seed.content).map_err(|err| RuntimeError::io(&target, err))?;
    }
    Ok(())
}

fn check_verify_files(manifest: &RuntimeManifest, dir: &Path) -> Result<(), RuntimeError> {
    for file in &manifest.verify_files {
        if !dir.join(file).is_file() {
            return Err(RuntimeError::InvalidArchive(format!(
                "\"{file}\" is missing from the installed runtime"
            )));
        }
    }
    Ok(())
}

fn feature_statuses(manifest: &RuntimeManifest, dir: &Path) -> Vec<FeatureStatus> {
    manifest
        .features
        .iter()
        .map(|feature| {
            let available = dir.join(&feature.verify_file).is_file();
            FeatureStatus {
                id: feature.id.clone(),
                label: feature.label.clone(),
                available,
                note: if available {
                    String::new()
                } else {
                    feature.missing_note.clone()
                },
            }
        })
        .collect()
}

fn is_healthy(manifest: &RuntimeManifest, dir: &Path) -> bool {
    dir.is_dir()
        && manifest
            .verify_files
            .iter()
            .all(|file| dir.join(file).is_file())
}

fn remove_dir_if_exists(dir: &Path) -> Result<(), RuntimeError> {
    match fs::remove_dir_all(dir) {
        Ok(()) => Ok(()),
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(err) => Err(RuntimeError::io(dir, err)),
    }
}

#[cfg(test)]
mod tests;
