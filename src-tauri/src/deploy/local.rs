//! This computer's side of deployment: what this copy is (where the program, its data and its runtimes are) and what it
//! can offer other computers on the LAN.
//!
//! **What is offered** ([`build_offer`]):
//! - a **shared network installation** (layout `network`) is announced as itself: its network path, version and
//!   architecture, and how many runtimes its shared store holds ready — every computer running it announces the same
//!   deployment id;
//! - **packages**: the signed release files in `<program>\deploy\packages` (an administrator copies the release's
//!   `..._setup.exe` / `..._portable.zip` with their `.sig` files there) or a folder given on the command line. A file is
//!   offered only after its signature passes the release-key check *here*.
//!
//! Never offered: the database, settings, logs, projects, credentials, keys, the computer's name or user name — the
//! announcement carries only what [`openmind_deploy::advert`] allows.

use std::collections::HashMap;
use std::path::{Path, PathBuf};

use openmind_core::{AppPaths, DataScope, InstallLayout};
use openmind_deploy::advert::{
    Advert, DeploymentKind, Manifest, RuntimeEntry, MANIFEST_FORMAT, MAX_RUNTIMES,
};
use openmind_deploy::package::{scan_folder, Verifier};
use openmind_deploy::{share_deployment_id, source_deployment_id, this_platform, Arch, PROTOCOL};
use serde::Serialize;

/// Where the runtimes this copy uses are kept.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum RuntimeStore {
    /// This computer's own (one profile, a per-user or per-machine install).
    Local,
    /// Shared with other computers (a network installation, a portable drive used per computer): installed once.
    Shared,
}

/// What this copy is on this computer.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ThisCopy {
    pub exe: PathBuf,
    pub install_dir: PathBuf,
    /// The program folder's network (UNC) path when it is on a network drive, else the same as `install_dir`.
    pub universal_dir: PathBuf,
    pub on_network: bool,
    pub layout: InstallLayout,
    pub data_scope: DataScope,
    pub version: String,
    pub build_arch: Arch,
    pub os_arch: Arch,
    pub hostname: String,
    pub user: String,
    /// This computer's profile id (a hash; never a raw machine identifier).
    pub profile_id: String,
    pub data_root: PathBuf,
    pub db_path: PathBuf,
    pub logs_dir: PathBuf,
    pub temp_dir: PathBuf,
    pub cache_dir: PathBuf,
    pub runtimes_dir: PathBuf,
    pub runtime_store: RuntimeStore,
    pub packages_dir: PathBuf,
}

/// The architecture of this computer's Windows (not of this program: a 32-bit program on 64-bit Windows says x64).
pub fn os_arch() -> Arch {
    if !cfg!(windows) {
        return Arch::parse(std::env::consts::ARCH).unwrap_or_else(Arch::of_this_build);
    }
    let native = std::env::var("PROCESSOR_ARCHITEW6432")
        .ok()
        .or_else(|| std::env::var("PROCESSOR_ARCHITECTURE").ok())
        .unwrap_or_default();
    match native.to_ascii_uppercase().as_str() {
        "AMD64" => Arch::X64,
        "ARM64" => Arch::Arm64,
        "X86" => Arch::X86,
        _ => Arch::of_this_build(),
    }
}

fn env_text(name: &str) -> String {
    std::env::var(name).unwrap_or_default()
}

impl ThisCopy {
    pub fn from_paths(paths: &AppPaths) -> Self {
        let exe = std::env::current_exe()
            .unwrap_or_else(|_| paths.install_dir.join("OpenMindStudio.exe"));
        let universal_dir = openmind_core::install::resolved_install_dir(&paths.install_dir);
        let universal_dir = if universal_dir.to_string_lossy().starts_with(r"\\?\UNC\") {
            PathBuf::from(format!(
                r"\\{}",
                &universal_dir.to_string_lossy()[r"\\?\UNC\".len()..]
            ))
        } else {
            openmind_core::install::universal_path(&paths.install_dir)
        };
        let shared_runtimes = paths.layout == InstallLayout::Network
            || (paths.layout == InstallLayout::Portable && paths.scope == DataScope::PerMachine);
        let identity = openmind_core::machine_identity::resolve(&paths.root_dir);
        Self {
            exe,
            on_network: openmind_core::install::is_remote_path(&paths.install_dir),
            install_dir: paths.install_dir.clone(),
            universal_dir,
            layout: paths.layout,
            data_scope: paths.scope,
            version: env!("CARGO_PKG_VERSION").to_string(),
            build_arch: Arch::of_this_build(),
            os_arch: os_arch(),
            hostname: env_text(if cfg!(windows) {
                "COMPUTERNAME"
            } else {
                "HOSTNAME"
            }),
            user: env_text(if cfg!(windows) { "USERNAME" } else { "USER" }),
            profile_id: identity.profile_id().to_string(),
            data_root: paths
                .db_path
                .parent()
                .map_or_else(|| paths.data_dir.clone(), Path::to_path_buf),
            db_path: paths.db_path.clone(),
            logs_dir: paths.logs_dir.clone(),
            temp_dir: paths.temp_dir.clone(),
            cache_dir: paths.machine_cache_dir.clone(),
            runtimes_dir: paths.runtimes_dir.clone(),
            runtime_store: if shared_runtimes {
                RuntimeStore::Shared
            } else {
                RuntimeStore::Local
            },
            packages_dir: paths.install_dir.join("deploy").join("packages"),
        }
    }

    /// The network path this copy is announced by, when it is a shared installation reachable as one.
    pub fn share_path(&self) -> Option<String> {
        let text = self
            .universal_dir
            .to_string_lossy()
            .trim_end_matches('\\')
            .to_string();
        (self.layout == InstallLayout::Network
            && openmind_deploy::advert::valid_share_path(&text, this_platform()))
        .then_some(text)
    }
}

/// The runtimes ready in a store: `runtimes/<kind>/versions/<version>/` folders (staging, removals and lock files left
/// out). What a computer will reuse instead of downloading.
pub fn scan_runtimes(runtimes_dir: &Path) -> Vec<RuntimeEntry> {
    let mut found = Vec::new();
    let Ok(kinds) = std::fs::read_dir(runtimes_dir) else {
        return found;
    };
    for kind in kinds.filter_map(Result::ok) {
        let kind_name = kind.file_name().to_string_lossy().into_owned();
        let Ok(versions) = std::fs::read_dir(kind.path().join("versions")) else {
            continue;
        };
        for version in versions.filter_map(Result::ok) {
            let name = version.file_name().to_string_lossy().into_owned();
            let finished = version.file_type().is_ok_and(|t| t.is_dir())
                && !name.contains(".installing")
                && !name.contains(".removing")
                && !name.contains(".unpacking");
            if finished && found.len() < MAX_RUNTIMES {
                found.push(RuntimeEntry {
                    kind: kind_name.clone(),
                    version: name,
                });
            }
        }
    }
    found.sort_by(|a, b| (&a.kind, &a.version).cmp(&(&b.kind, &b.version)));
    found
}

/// What this computer offers (see the module text).
pub struct Offer {
    pub manifest: Manifest,
    pub files: HashMap<String, PathBuf>,
    /// Files left out of the offer, and why.
    pub problems: Vec<String>,
}

impl Offer {
    /// The discovery answer for this offer, announcing the package server on `http_port`.
    pub fn advert(&self, instance: &str, http_port: u16) -> Advert {
        let packages = self.manifest.packages.len() as u32;
        Advert {
            protocol: PROTOCOL,
            deployment_id: self.manifest.deployment_id.clone(),
            instance: instance.to_string(),
            app_version: self.manifest.app_version.clone(),
            platform: self.manifest.platform.clone(),
            arch: self.manifest.arch,
            kind: self.manifest.kind,
            share_path: self.manifest.share_path.clone(),
            http_port: if packages == 0 { 0 } else { http_port },
            packages,
            runtimes: self.manifest.runtimes.len() as u32,
        }
    }
}

/// Builds this computer's offer from `copy` and the package folders (see the module text). `Err` when there is nothing
/// to offer.
pub fn build_offer(
    copy: &ThisCopy,
    package_dirs: &[PathBuf],
    verifier: Verifier,
) -> Result<Offer, String> {
    let platform = this_platform();
    let mut problems = Vec::new();
    let mut packages = Vec::new();
    let mut files = HashMap::new();
    for dir in package_dirs.iter().filter(|dir| dir.is_dir()) {
        let (offered, left_out) = scan_folder(dir, platform, verifier);
        problems.extend(left_out);
        for (entry, file) in offered {
            if !files.contains_key(&entry.name) {
                files.insert(entry.name.clone(), file);
                packages.push(entry);
            }
        }
    }
    let share_path = copy.share_path();
    let (kind, deployment_id) = match &share_path {
        Some(path) => (
            DeploymentKind::NetworkShare,
            share_deployment_id(&openmind_core::install::normalized_key_path(Path::new(path))),
        ),
        None if !packages.is_empty() => {
            let folders: Vec<String> = package_dirs
                .iter()
                .map(|d| openmind_core::install::normalized_key_path(d))
                .collect();
            (
                DeploymentKind::PackageSource,
                source_deployment_id(
                    &openmind_core::session_guard::computer_token(),
                    &folders.join("\n"),
                ),
            )
        }
        None => {
            return Err(format!(
                "This copy has nothing to offer: it isn't a shared network installation, and {} holds no signed \
                 OpenMind Studio package.",
                package_dirs
                    .first()
                    .map_or_else(|| copy.packages_dir.display().to_string(), |d| d.display().to_string())
            ))
        }
    };
    let runtimes = if copy.runtime_store == RuntimeStore::Shared {
        scan_runtimes(&copy.runtimes_dir)
    } else {
        Vec::new()
    };
    let manifest = Manifest {
        format: MANIFEST_FORMAT.into(),
        protocol: PROTOCOL,
        deployment_id,
        app_version: copy.version.clone(),
        platform: platform.into(),
        arch: copy.build_arch,
        kind,
        share_path,
        packages,
        runtimes,
    };
    manifest.validate()?;
    Ok(Offer {
        manifest,
        files,
        problems,
    })
}

#[cfg(test)]
#[path = "local_tests.rs"]
mod tests;
