//! Add-ons: optional parts installed *into* an installed runtime version from their own pinned download (Tcl/Tk for
//! Python's tkinter). The download is checksum-verified and extracted into a staging folder first; then only files
//! the install doesn't already have are moved in — nothing of the runtime is ever overwritten — and their list is
//! recorded in `<install>/.openmind-addons/<id>.json`. Removing the add-on deletes exactly the recorded files (and
//! the folders it created, when empty). Nothing is registered with Windows and PATH is not touched.

use std::fs;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use super::{remove_dir_if_exists, InstallPhase, InstallProgress, ProgressSink, RuntimeManager};
use crate::download::verify_sha256;
use crate::error::RuntimeError;
use crate::extract::{extract_archive, safe_entry_path, ExtractSelection};
use crate::manifest::{Addon, ArchiveKind, Artifact, License, RuntimeManifest};

/// The folder inside an install that holds the add-on records.
pub const RECORD_DIR: &str = ".openmind-addons";

/// An add-on of one installed version, as the Runtime Manager shows it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AddonStatus {
    pub id: String,
    pub label: String,
    pub description: String,
    pub installed: bool,
    /// There is a download for this platform.
    pub available: bool,
    pub download_bytes: Option<u64>,
    pub install_bytes: Option<u64>,
    pub license: Option<License>,
}

/// What an add-on added to an install: removing it deletes exactly these.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct AddonRecord {
    id: String,
    sha256: String,
    /// Relative to the install, `/`-separated.
    files: Vec<String>,
    /// Folders the add-on created, deepest first.
    folders: Vec<String>,
}

/// The manifest add-ons of `version` that have a record in the install `dir` (so Repair can add them back after it
/// rebuilt the version). Only ids the manifest knows are returned; a stray file in the record folder is ignored.
pub(crate) fn recorded_addons(
    manifest: &RuntimeManifest,
    version: &str,
    dir: &Path,
) -> Vec<String> {
    addons_of(manifest, version)
        .iter()
        .filter(|addon| {
            dir.join(RECORD_DIR)
                .join(format!("{}.json", addon.id))
                .is_file()
        })
        .map(|addon| addon.id.clone())
        .collect()
}

fn addons_of<'a>(manifest: &'a RuntimeManifest, version: &str) -> &'a [Addon] {
    manifest
        .versions
        .iter()
        .find(|candidate| candidate.version == version)
        .map_or(&[], |found| found.addons.as_slice())
}

fn artifact_for<'a>(addon: &'a Addon, platform: &str) -> Option<&'a Artifact> {
    addon
        .artifacts
        .iter()
        .find(|artifact| artifact.platform == platform)
}

fn record_path(dir: &Path, id: &str) -> PathBuf {
    dir.join(RECORD_DIR).join(format!("{id}.json"))
}

/// The add-ons of an installed version and whether each is there (its record and its file both exist).
pub(super) fn addon_statuses(
    manifest: &RuntimeManifest,
    version: &str,
    platform: &str,
    dir: &Path,
) -> Vec<AddonStatus> {
    addons_of(manifest, version)
        .iter()
        .map(|addon| {
            let artifact = artifact_for(addon, platform);
            AddonStatus {
                id: addon.id.clone(),
                label: addon.label.clone(),
                description: addon.description.clone(),
                installed: dir.join(&addon.verify_file).is_file(),
                available: artifact.is_some(),
                download_bytes: artifact.and_then(|a| a.size_bytes),
                install_bytes: artifact.and_then(|a| a.install_bytes),
                license: addon.license.clone(),
            }
        })
        .collect()
}

impl RuntimeManager {
    /// Downloads, verifies and adds an add-on to an installed, healthy version.
    pub async fn install_addon(
        &self,
        kind: &str,
        version: &str,
        addon_id: &str,
        progress: ProgressSink,
    ) -> Result<(), RuntimeError> {
        let manifest = self.registry.get(kind)?.clone();
        let addon = addons_of(&manifest, version)
            .iter()
            .find(|addon| addon.id == addon_id)
            .cloned()
            .ok_or_else(|| {
                RuntimeError::Addon(format!("{kind} {version} has no add-on \"{addon_id}\"."))
            })?;
        let artifact = artifact_for(&addon, &self.platform)
            .cloned()
            .ok_or_else(|| {
                RuntimeError::Addon(format!(
                    "{} has no download for this platform.",
                    addon.label
                ))
            })?;
        let _guard = self.acquire(kind, version)?;
        let dir = self.paths.version_dir(kind, version)?;
        if !super::is_healthy(&manifest, &dir) {
            return Err(RuntimeError::NotInstalled {
                kind: kind.into(),
                version: version.into(),
            });
        }
        if dir.join(&addon.verify_file).is_file() {
            return Ok(());
        }
        let staging = self
            .paths
            .staging_dir(kind, &format!("{version}-{}-addon", addon.id))?;
        let archive = self.paths.download_path(&artifact.sha256, &artifact.url);
        let client = self.client.clone();
        let (kind_owned, version_owned) = (kind.to_string(), version.to_string());
        let job = move || -> Result<(), RuntimeError> {
            let report = |phase, current, total| {
                progress(InstallProgress {
                    kind: kind_owned.clone(),
                    version: version_owned.clone(),
                    phase,
                    current,
                    total,
                });
            };
            let cached = archive.exists()
                && verify_sha256(&archive, &artifact.sha256, &mut |c, t| {
                    report(InstallPhase::Verify, c, t);
                })
                .is_ok();
            if !cached {
                crate::fetch::fetch_verified(
                    client.as_ref(),
                    &artifact,
                    &archive,
                    &|c, t| report(InstallPhase::Download, c, t),
                    &|c, t| report(InstallPhase::Verify, c, t),
                    &mut std::thread::sleep,
                )?;
            }
            let outcome = unpack_and_merge(&addon, &artifact, &archive, &staging, &dir, &report);
            let _ = remove_dir_if_exists(&staging);
            outcome?;
            report(InstallPhase::Done, 1, Some(1));
            Ok(())
        };
        tokio::task::spawn_blocking(job)
            .await
            .map_err(|err| RuntimeError::Download(format!("add-on task failed: {err}")))?
    }

    /// Removes exactly what an add-on added (its record says what).
    pub async fn remove_addon(
        &self,
        kind: &str,
        version: &str,
        addon_id: &str,
    ) -> Result<(), RuntimeError> {
        let manifest = self.registry.get(kind)?;
        if !addons_of(manifest, version)
            .iter()
            .any(|addon| addon.id == addon_id)
        {
            return Err(RuntimeError::Addon(format!(
                "{kind} {version} has no add-on \"{addon_id}\"."
            )));
        }
        let _guard = self.acquire(kind, version)?;
        let dir = self.paths.version_dir(kind, version)?;
        let path = record_path(&dir, addon_id);
        let text = fs::read_to_string(&path).map_err(|_| {
            RuntimeError::Addon(format!("The add-on \"{addon_id}\" isn't installed."))
        })?;
        let record: AddonRecord = serde_json::from_str(&text)
            .map_err(|err| RuntimeError::Addon(format!("The add-on's record is damaged: {err}")))?;
        remove_recorded(&dir, &record)?;
        fs::remove_file(&path).map_err(|err| RuntimeError::io(&path, err))?;
        let _ = fs::remove_dir(dir.join(RECORD_DIR));
        Ok(())
    }
}

fn unpack_and_merge(
    addon: &Addon,
    artifact: &Artifact,
    archive: &Path,
    staging: &Path,
    dir: &Path,
    report: &dyn Fn(InstallPhase, u64, Option<u64>),
) -> Result<(), RuntimeError> {
    remove_dir_if_exists(staging)?;
    let selection = ExtractSelection {
        strip_components: artifact.strip_components,
        only_under: artifact.extract_root.as_deref(),
        name_encoding: artifact.name_encoding,
    };
    let mut extracted = |c, t| report(InstallPhase::Extract, c, t);
    if artifact.archive == ArchiveKind::File {
        return Err(RuntimeError::Addon("an add-on must be an archive".into()));
    }
    extract_archive(
        artifact.archive,
        archive,
        staging,
        selection,
        &mut extracted,
    )?;
    if !staging.join(&addon.verify_file).is_file() {
        return Err(RuntimeError::InvalidArchive(format!(
            "\"{}\" is missing from the add-on",
            addon.verify_file
        )));
    }
    report(InstallPhase::Finalize, 0, None);
    let (files, folders) = merge_into(staging, dir)?;
    let record = AddonRecord {
        id: addon.id.clone(),
        sha256: artifact.sha256.clone(),
        files,
        folders,
    };
    let written = write_record(dir, &record);
    if written.is_err() {
        let _ = remove_recorded(dir, &record);
    }
    written
}

fn write_record(dir: &Path, record: &AddonRecord) -> Result<(), RuntimeError> {
    let path = record_path(dir, &record.id);
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|err| RuntimeError::io(parent, err))?;
    }
    let text = serde_json::to_string_pretty(record)
        .map_err(|err| RuntimeError::Addon(format!("couldn't record the add-on: {err}")))?;
    fs::write(&path, text).map_err(|err| RuntimeError::io(&path, err))
}

/// Every regular file under `root`, as `/`-separated relative paths. Links are refused.
fn files_under(root: &Path) -> Result<Vec<String>, RuntimeError> {
    let mut found = Vec::new();
    let mut pending = vec![PathBuf::new()];
    while let Some(relative) = pending.pop() {
        let folder = root.join(&relative);
        for entry in fs::read_dir(&folder).map_err(|err| RuntimeError::io(&folder, err))? {
            let entry = entry.map_err(|err| RuntimeError::io(&folder, err))?;
            let kind = entry
                .file_type()
                .map_err(|err| RuntimeError::io(entry.path(), err))?;
            let name = relative.join(entry.file_name());
            if kind.is_symlink() {
                return Err(RuntimeError::UnsafeArchive(
                    "the add-on contains a link".into(),
                ));
            } else if kind.is_dir() {
                pending.push(name);
            } else {
                found.push(name.to_string_lossy().replace('\\', "/"));
            }
        }
    }
    found.sort();
    Ok(found)
}

/// Moves the staged files the install doesn't have yet into it. Returns the files added and the folders created
/// (deepest first). On a failure everything added so far is taken out again.
fn merge_into(staging: &Path, dir: &Path) -> Result<(Vec<String>, Vec<String>), RuntimeError> {
    let mut added = Vec::new();
    let mut created: Vec<String> = Vec::new();
    let result = (|| -> Result<(), RuntimeError> {
        for relative in files_under(staging)? {
            let target = dir.join(&relative);
            if target.exists() {
                // The runtime's own copy stays (e.g. a DLL the install already ships).
                continue;
            }
            let mut missing = Vec::new();
            let mut parent = target.parent();
            while let Some(folder) = parent {
                if folder == dir || folder.exists() {
                    break;
                }
                missing.push(folder.to_path_buf());
                parent = folder.parent();
            }
            for folder in missing.iter().rev() {
                fs::create_dir(folder).map_err(|err| RuntimeError::io(folder, err))?;
                if let Ok(inside) = folder.strip_prefix(dir) {
                    created.push(inside.to_string_lossy().replace('\\', "/"));
                }
            }
            let source = staging.join(&relative);
            fs::rename(&source, &target)
                .or_else(|_| fs::copy(&source, &target).map(|_| ()))
                .map_err(|err| RuntimeError::io(&target, err))?;
            added.push(relative);
        }
        Ok(())
    })();
    created.reverse();
    if let Err(err) = result {
        let _ = remove_recorded(
            dir,
            &AddonRecord {
                id: String::new(),
                sha256: String::new(),
                files: added,
                folders: created,
            },
        );
        return Err(err);
    }
    Ok((added, created))
}

/// Deletes the recorded files and then the recorded folders that are empty. Every recorded path is checked to stay
/// inside the install, so a tampered record can't point anywhere else.
fn remove_recorded(dir: &Path, record: &AddonRecord) -> Result<(), RuntimeError> {
    for file in &record.files {
        let Some(relative) = safe_entry_path(file, 0)? else {
            continue;
        };
        match fs::remove_file(dir.join(relative)) {
            Ok(()) => {}
            Err(err) if err.kind() == std::io::ErrorKind::NotFound => {}
            Err(err) => return Err(RuntimeError::io(dir.join(file), err)),
        }
    }
    for folder in &record.folders {
        if let Some(relative) = safe_entry_path(folder, 0)? {
            // Only when empty: something the user put there stays.
            let _ = fs::remove_dir(dir.join(relative));
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn write(root: &Path, relative: &str, text: &str) {
        let path = root.join(relative);
        fs::create_dir_all(path.parent().expect("parent")).expect("dir");
        fs::write(path, text).expect("write");
    }

    #[test]
    fn merging_adds_only_missing_files_and_removing_takes_exactly_those_out() {
        let temp = tempfile::tempdir().expect("tempdir");
        let (staging, install) = (temp.path().join("staging"), temp.path().join("my python"));
        write(&install, "python.exe", "py");
        write(&install, "DLLs/libtommath.dll", "the runtime's own");
        write(&staging, "DLLs/libtommath.dll", "the add-on's");
        write(&staging, "DLLs/_tkinter.pyd", "tk");
        write(&staging, "Lib/tkinter/__init__.py", "init");
        write(&staging, "tcl/tk9.0/demos/README", "demo");

        let (files, folders) = merge_into(&staging, &install).expect("merge");

        assert_eq!(
            files,
            [
                "DLLs/_tkinter.pyd",
                "Lib/tkinter/__init__.py",
                "tcl/tk9.0/demos/README"
            ]
        );
        assert_eq!(
            fs::read_to_string(install.join("DLLs/libtommath.dll")).expect("read"),
            "the runtime's own"
        );
        assert_eq!(
            folders,
            ["tcl/tk9.0/demos", "tcl/tk9.0", "tcl", "Lib/tkinter", "Lib"]
        );

        // Something the user added inside a folder the add-on created is kept, with its folder.
        write(&install, "tcl/mine.txt", "mine");
        remove_recorded(
            &install,
            &AddonRecord {
                id: "tcltk".into(),
                sha256: String::new(),
                files,
                folders,
            },
        )
        .expect("remove");
        assert!(!install.join("DLLs/_tkinter.pyd").exists());
        assert!(!install.join("Lib").exists());
        assert!(install.join("tcl/mine.txt").exists());
        assert!(
            install.join("DLLs/libtommath.dll").exists() && install.join("python.exe").exists()
        );
    }

    #[test]
    fn a_tampered_record_cannot_delete_outside_the_install() {
        let temp = tempfile::tempdir().expect("tempdir");
        let install = temp.path().join("install");
        write(temp.path(), "outside.txt", "keep");
        fs::create_dir_all(&install).expect("dir");
        let record = AddonRecord {
            id: "x".into(),
            sha256: String::new(),
            files: vec!["../outside.txt".into()],
            folders: Vec::new(),
        };
        assert!(remove_recorded(&install, &record).is_err());
        assert!(temp.path().join("outside.txt").exists());
    }
}
