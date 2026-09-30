//! The offline Python package bundle (`<app>/python-bundle`, built by `pnpm python:bundle`): the wheels of the
//! packages OpenMind Studio makes available right after a portable Python is installed (requests, numpy, pandas,
//! Flask ...), for one Python line (3.14), plus python.org's Tcl/Tk package for tkinter.
//!
//! Installing: the zip is checked against `bundle.json`'s SHA-256 (a shipped file is never deleted on a mismatch, unlike a
//! download), only plain `*.whl` names are unpacked into a temporary folder, and that Python's own pip installs them with
//! `--no-index --require-hashes` — no network, every wheel hash-checked, the user's `PIP_*` variables and pip's settings files
//! ignored, user site-packages off. Everything lands in that install; the user's Python, PATH and pip are untouched.
//! Then every module (standard library and packages) is imported once as a check, and a record is written.

use std::collections::BTreeMap;
use std::fs::{self, File};
use std::io::{self, Read};
use std::path::{Path, PathBuf};
use std::time::Duration;

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::error::RuntimeError;
use crate::manifest::PostInstallStep;
use crate::postinstall::run_step_limited;

pub const BUNDLE_FORMAT: &str = "openmind-python-bundle";
/// Written into the Python install once the bundle's packages are in (the Runtime Manager's feature check reads it).
pub const RECORD_FILE: &str = ".openmind-python-packages.json";
const MAX_WHEELS: usize = 1000;
const MAX_UNPACKED: u64 = 2 * 1024 * 1024 * 1024;
const PIP_TIMEOUT: Duration = Duration::from_secs(20 * 60);
const CHECK_TIMEOUT: Duration = Duration::from_secs(5 * 60);

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct BundlePackage {
    pub name: String,
    #[serde(rename = "import")]
    pub import_name: String,
}

#[derive(Debug, Clone, Deserialize)]
struct Wheels {
    file: String,
    sha256: String,
}

#[derive(Debug, Clone, Deserialize)]
pub struct BundleAddon {
    pub id: String,
    pub file: String,
    pub sha256: String,
    pub url: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PythonBundle {
    format: String,
    version: u32,
    /// The Python line the wheels are for (`3.14`).
    pub python: String,
    pub stdlib: Vec<String>,
    pub packages: Vec<BundlePackage>,
    wheels: Wheels,
    requirements: String,
    pub addon: Option<BundleAddon>,
}

/// What a finished install recorded.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PackagesRecord {
    pub python: String,
    pub packages: Vec<String>,
    pub bundle_sha256: String,
}

/// A plain file name: no folders, drive, stream or parent reference.
fn plain_name(name: &str) -> bool {
    !name.is_empty()
        && !name.contains(['/', '\\', ':', '\0'])
        && name != "."
        && name != ".."
        && !name.starts_with('.')
}

fn import_name(name: &str) -> bool {
    !name.is_empty()
        && name
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '.')
}

/// SHA-256 of a file (hex, lower case), without touching the file.
pub fn file_sha256(path: &Path) -> Result<String, RuntimeError> {
    let mut file = File::open(path).map_err(|err| RuntimeError::io(path, err))?;
    let mut hasher = Sha256::new();
    let mut buffer = vec![0u8; 1 << 20];
    loop {
        let read = file
            .read(&mut buffer)
            .map_err(|err| RuntimeError::io(path, err))?;
        if read == 0 {
            break;
        }
        hasher.update(&buffer[..read]);
    }
    Ok(hasher
        .finalize()
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect())
}

impl PythonBundle {
    /// The bundle in `dir`, `Ok(None)` when there is none (a development build), an error when it is damaged.
    pub fn load(dir: &Path) -> Result<Option<PythonBundle>, String> {
        let file = dir.join("bundle.json");
        let text = match fs::read_to_string(&file) {
            Ok(text) => text,
            Err(err) if err.kind() == io::ErrorKind::NotFound => return Ok(None),
            Err(err) => return Err(format!("{}: {err}", file.display())),
        };
        let bundle: PythonBundle =
            serde_json::from_str(&text).map_err(|err| format!("{}: {err}", file.display()))?;
        bundle.validate()?;
        Ok(Some(bundle))
    }

    fn validate(&self) -> Result<(), String> {
        if self.format != BUNDLE_FORMAT || self.version != 1 {
            return Err(
                "python-bundle/bundle.json is not a version 1 OpenMind Python bundle".into(),
            );
        }
        let files = [
            Some(&self.wheels.file),
            Some(&self.requirements),
            self.addon.as_ref().map(|a| &a.file),
        ];
        if !files.iter().flatten().all(|name| plain_name(name)) {
            return Err("python-bundle/bundle.json names a file outside its folder".into());
        }
        let names = self
            .stdlib
            .iter()
            .chain(self.packages.iter().map(|p| &p.import_name));
        if !names.clone().all(|name| import_name(name)) {
            return Err("python-bundle/bundle.json has an invalid module name".into());
        }
        Ok(())
    }

    /// Whether the wheels are for this Python version (`3.14.7` for a `3.14` bundle).
    pub fn fits(&self, version: &str) -> bool {
        version == self.python || version.starts_with(&format!("{}.", self.python))
    }

    /// The bundled add-on archive (Tcl/Tk) when it is present and matches its SHA-256.
    pub fn addon_archive(&self, dir: &Path) -> Option<(PathBuf, &BundleAddon)> {
        let addon = self.addon.as_ref()?;
        let path = dir.join(&addon.file);
        let matches = file_sha256(&path).ok()? == addon.sha256.to_lowercase();
        matches.then_some((path, addon))
    }

    /// Every module to import as the final check (`tkinter` only when Tcl/Tk is in the install).
    pub fn modules(&self, with_tkinter: bool) -> Vec<String> {
        self.stdlib
            .iter()
            .filter(|name| with_tkinter || name.as_str() != "tkinter")
            .chain(self.packages.iter().map(|p| &p.import_name))
            .cloned()
            .collect()
    }
}

/// Unpacks the wheels of a checked zip into `dest`: plain `*.whl` names only, no folders, bounded count and size.
fn unpack_wheels(zip_path: &Path, dest: &Path) -> Result<usize, RuntimeError> {
    let file = File::open(zip_path).map_err(|err| RuntimeError::io(zip_path, err))?;
    let mut archive = zip::ZipArchive::new(file)
        .map_err(|err| RuntimeError::InvalidArchive(format!("{}: {err}", zip_path.display())))?;
    if archive.len() > MAX_WHEELS {
        return Err(RuntimeError::UnsafeArchive(format!(
            "{} entries",
            archive.len()
        )));
    }
    fs::create_dir_all(dest).map_err(|err| RuntimeError::io(dest, err))?;
    let mut total = 0u64;
    for index in 0..archive.len() {
        let mut entry = archive
            .by_index(index)
            .map_err(|err| RuntimeError::InvalidArchive(err.to_string()))?;
        let name = entry.name().to_string();
        if entry.is_dir() || !plain_name(&name) || !name.ends_with(".whl") {
            return Err(RuntimeError::UnsafeArchive(format!(
                "unexpected entry \"{name}\""
            )));
        }
        total = total.saturating_add(entry.size());
        if total > MAX_UNPACKED {
            return Err(RuntimeError::UnsafeArchive(
                "the wheels are too large".into(),
            ));
        }
        let target = dest.join(&name);
        let mut out = File::create(&target).map_err(|err| RuntimeError::io(&target, err))?;
        io::copy(&mut entry, &mut out).map_err(|err| RuntimeError::io(&target, err))?;
    }
    Ok(archive.len())
}

/// The user's pip variables, which must not redirect or reconfigure an offline install.
fn pip_variables() -> Vec<String> {
    std::env::vars_os()
        .filter_map(|(key, _)| key.into_string().ok())
        .filter(|key| {
            key.to_ascii_uppercase().starts_with("PIP_")
                || key.eq_ignore_ascii_case("PYTHONUSERBASE")
        })
        .collect()
}

fn step(description: &str, args: Vec<String>) -> PostInstallStep {
    PostInstallStep {
        description: description.into(),
        executable: "python.exe".into(),
        args,
    }
}

/// Installs the bundle's packages into the Python in `python_dir` (see the module comment), then imports every module.
/// `work` is a temporary folder, removed afterwards. `env` = the runtime's own variables (`PYTHONNOUSERSITE`).
pub fn install_packages(
    bundle: &PythonBundle,
    bundle_dir: &Path,
    python_dir: &Path,
    work: &Path,
    env: &BTreeMap<String, String>,
) -> Result<PackagesRecord, RuntimeError> {
    let zip = bundle_dir.join(&bundle.wheels.file);
    let sha = file_sha256(&zip)?;
    if sha != bundle.wheels.sha256.to_lowercase() {
        return Err(RuntimeError::ChecksumMismatch {
            expected: bundle.wheels.sha256.clone(),
            actual: sha,
        });
    }
    let _ = fs::remove_dir_all(work);
    let result = (|| {
        unpack_wheels(&zip, work)?;
        let requirements = work.join("requirements.txt");
        let source = bundle_dir.join(&bundle.requirements);
        fs::copy(&source, &requirements).map_err(|err| RuntimeError::io(&source, err))?;
        let mut env = env.clone();
        env.insert("PYTHONNOUSERSITE".into(), "1".into());
        env.insert("PIP_CONFIG_FILE".into(), "nul".into());
        env.insert("PIP_NO_INPUT".into(), "1".into());
        let text = |path: &Path| path.to_string_lossy().into_owned();
        let pip = step(
            "install the bundled Python packages (offline)",
            [
                "-s",
                "-m",
                "pip",
                "install",
                "--no-index",
                "--find-links",
                &text(work),
                "--require-hashes",
                "-r",
                &text(&requirements),
                "--no-warn-script-location",
                "--disable-pip-version-check",
                "--no-cache-dir",
            ]
            .iter()
            .map(|s| s.to_string())
            .collect(),
        );
        run_step_limited(&pip, python_dir, &env, PIP_TIMEOUT, &pip_variables())?;
        let with_tkinter = python_dir.join("DLLs").join("_tkinter.pyd").is_file();
        let check = step(
            "import the bundled modules",
            vec![
                "-s".into(),
                "-c".into(),
                format!("import {}", bundle.modules(with_tkinter).join(", ")),
            ],
        );
        run_step_limited(&check, python_dir, &env, CHECK_TIMEOUT, &pip_variables())
    })();
    let _ = fs::remove_dir_all(work);
    result?;
    let record = PackagesRecord {
        python: bundle.python.clone(),
        packages: bundle.packages.iter().map(|p| p.name.clone()).collect(),
        bundle_sha256: sha,
    };
    let path = python_dir.join(RECORD_FILE);
    let json = serde_json::to_string_pretty(&record)
        .map_err(|err| RuntimeError::InvalidArchive(err.to_string()))?;
    fs::write(&path, json).map_err(|err| RuntimeError::io(&path, err))?;
    Ok(record)
}

/// What an earlier install recorded, if anything.
pub fn installed_record(python_dir: &Path) -> Option<PackagesRecord> {
    serde_json::from_str(&fs::read_to_string(python_dir.join(RECORD_FILE)).ok()?).ok()
}

#[cfg(test)]
mod tests;
