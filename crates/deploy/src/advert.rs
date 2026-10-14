//! What a deployment says about itself: the short [`Advert`] in a discovery answer, and the [`Manifest`] its package
//! server hands out. Both arrive from the network, so every field is checked before anything uses it
//! ([`Advert::validate`], [`Manifest::validate`]); a value that fails is never shown or acted on.
//!
//! Neither carries a secret: no credentials, tokens, keys, signing material, database content, user files or project
//! data — only versions, architectures, sizes, checksums, the publisher's own package signatures and, for a shared
//! installation, the network path every computer already runs it from.

use serde::{Deserialize, Serialize};

use crate::{is_hex, version, Arch, PROTOCOL};

/// The most packages one source offers (one per architecture and kind is the normal case).
pub const MAX_PACKAGES: usize = 16;
/// The most runtimes a manifest lists.
pub const MAX_RUNTIMES: usize = 256;
/// A package is at most this large (the largest release file is about 130 MB).
pub const MAX_PACKAGE_BYTES: u64 = 2 * 1024 * 1024 * 1024;
const MAX_SHARE_PATH: usize = 400;
const MAX_SIGNATURE: usize = 2048;
const PLATFORMS: [&str; 3] = ["windows", "linux", "macos"];

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum DeploymentKind {
    /// One installation in a shared folder that every computer runs (see the crate text).
    NetworkShare,
    /// A computer offering signed setup / portable packages.
    PackageSource,
}

/// A discovery answer's description of one deployment (it fits in one UDP datagram).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Advert {
    pub protocol: u32,
    /// The deployment's identity: the same from every computer that announces it, across restarts and new addresses.
    pub deployment_id: String,
    /// Random per announcing process: a new value means that computer's OpenMind Studio restarted.
    pub instance: String,
    pub app_version: String,
    pub platform: String,
    pub arch: Arch,
    pub kind: DeploymentKind,
    /// A shared installation's folder as every computer reaches it (`\\server\share\OpenMind Studio`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub share_path: Option<String>,
    /// The package server's TCP port on the answering computer (0: no packages offered).
    pub http_port: u16,
    /// How many packages the server offers.
    pub packages: u32,
    /// How many runtimes the deployment's shared store holds ready.
    pub runtimes: u32,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum PackageKind {
    /// The setup (`..._setup.exe`): it detects, updates and repairs an existing installation itself.
    Installer,
    /// The portable ZIP (`..._portable.zip`).
    Portable,
}

/// One package a source offers.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PackageEntry {
    /// The release file's own name — always exactly [`release_name`] of its version, architecture and kind.
    pub name: String,
    pub kind: PackageKind,
    pub arch: Arch,
    pub version: String,
    pub size: u64,
    /// Lowercase hex SHA-256 of the file.
    pub sha256: String,
    /// The release's updater signature of the file (base64, as in `latest.json`), bound to `version`.
    pub signature: String,
}

/// A runtime the deployment's shared store has ready (informational: what a computer will reuse instead of
/// downloading).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RuntimeEntry {
    pub kind: String,
    pub version: String,
}

/// `manifest.json` of a package server.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Manifest {
    pub format: String,
    pub protocol: u32,
    pub deployment_id: String,
    pub app_version: String,
    pub platform: String,
    pub arch: Arch,
    pub kind: DeploymentKind,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub share_path: Option<String>,
    pub packages: Vec<PackageEntry>,
    pub runtimes: Vec<RuntimeEntry>,
}

/// `Manifest::format`.
pub const MANIFEST_FORMAT: &str = "openmind-deploy-manifest";

/// The release file name of a package: `OpenMind-Studio_<version>_<platform>_<arch>_setup.exe` / `..._portable.zip`.
pub fn release_name(version: &str, platform: &str, arch: Arch, kind: PackageKind) -> String {
    let suffix = match kind {
        PackageKind::Installer => "_setup.exe",
        PackageKind::Portable => "_portable.zip",
    };
    format!(
        "OpenMind-Studio_{version}_{platform}_{}{suffix}",
        arch.label()
    )
}

/// Reads a release file name back into (version, platform, arch, kind); `None` for anything else.
pub fn parse_release_name(name: &str) -> Option<(String, String, Arch, PackageKind)> {
    let rest = name.strip_prefix("OpenMind-Studio_")?;
    let (stem, kind) = match rest.strip_suffix("_setup.exe") {
        Some(stem) => (stem, PackageKind::Installer),
        None => (rest.strip_suffix("_portable.zip")?, PackageKind::Portable),
    };
    let mut parts = stem.rsplitn(3, '_');
    let arch = Arch::parse(parts.next()?)?;
    let platform = parts.next()?.to_string();
    let version = parts.next()?.to_string();
    (version::is_valid(&version) && PLATFORMS.contains(&platform.as_str())).then(|| {
        let canonical = release_name(&version, &platform, arch, kind);
        (canonical == name).then_some((version, platform, arch, kind))
    })?
}

fn check(condition: bool, what: &str) -> Result<(), String> {
    if condition {
        Ok(())
    } else {
        Err(what.to_string())
    }
}

/// A shared installation's path as announced: a network (UNC) path on Windows, an absolute path elsewhere, no control
/// characters, no `.`/`..` parts, nothing Windows can't name.
pub fn valid_share_path(path: &str, platform: &str) -> bool {
    if path.is_empty() || path.len() > MAX_SHARE_PATH || path.chars().any(char::is_control) {
        return false;
    }
    if platform == "windows" {
        let Some(rest) = path.strip_prefix(r"\\") else {
            return false;
        };
        let parts: Vec<&str> = rest.split('\\').collect();
        parts.len() >= 2
            && !rest.starts_with(['?', '.'])
            && parts.iter().all(|part| {
                !part.is_empty()
                    && *part != "."
                    && *part != ".."
                    && !part.contains(['/', ':', '*', '?', '"', '<', '>', '|'])
            })
    } else {
        path.starts_with('/') && path.split('/').skip(1).all(|p| p != "." && p != "..")
    }
}

fn check_common(
    protocol: u32,
    id: &str,
    app_version: &str,
    platform: &str,
    kind: DeploymentKind,
    share_path: Option<&str>,
) -> Result<(), String> {
    check(protocol == PROTOCOL, "protocol version")?;
    check(is_hex(id, 32), "deployment id")?;
    check(version::is_valid(app_version), "app version")?;
    check(PLATFORMS.contains(&platform), "platform")?;
    match (kind, share_path) {
        (DeploymentKind::NetworkShare, Some(path)) => {
            check(valid_share_path(path, platform), "share path")?;
            check(crate::share_id_for(path) == id, "deployment id")
        }
        (DeploymentKind::NetworkShare, None) => Err("share path".into()),
        (DeploymentKind::PackageSource, None) => Ok(()),
        (DeploymentKind::PackageSource, Some(_)) => Err("share path".into()),
    }
}

impl Advert {
    /// `Err(field)` names the first field that isn't acceptable.
    pub fn validate(&self) -> Result<(), String> {
        check_common(
            self.protocol,
            &self.deployment_id,
            &self.app_version,
            &self.platform,
            self.kind,
            self.share_path.as_deref(),
        )?;
        check(is_hex(&self.instance, 16), "instance")?;
        check(self.packages as usize <= MAX_PACKAGES, "package count")?;
        check(self.runtimes as usize <= MAX_RUNTIMES, "runtime count")?;
        check(
            (self.http_port == 0) == (self.packages == 0),
            "package server port",
        )
    }
}

impl PackageEntry {
    pub fn validate(&self, platform: &str) -> Result<(), String> {
        check(version::is_valid(&self.version), "package version")?;
        check(
            self.name == release_name(&self.version, platform, self.arch, self.kind),
            "package name",
        )?;
        check(
            self.size > 0 && self.size <= MAX_PACKAGE_BYTES,
            "package size",
        )?;
        check(is_hex(&self.sha256, 64), "package checksum")?;
        check(
            !self.signature.is_empty()
                && self.signature.len() <= MAX_SIGNATURE
                && self
                    .signature
                    .bytes()
                    .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'+' | b'/' | b'=')),
            "package signature",
        )
    }
}

impl Manifest {
    pub fn validate(&self) -> Result<(), String> {
        check(self.format == MANIFEST_FORMAT, "manifest format")?;
        check_common(
            self.protocol,
            &self.deployment_id,
            &self.app_version,
            &self.platform,
            self.kind,
            self.share_path.as_deref(),
        )?;
        check(self.packages.len() <= MAX_PACKAGES, "package count")?;
        check(self.runtimes.len() <= MAX_RUNTIMES, "runtime count")?;
        for entry in &self.packages {
            entry.validate(&self.platform)?;
        }
        let mut names: Vec<&str> = self.packages.iter().map(|p| p.name.as_str()).collect();
        names.sort_unstable();
        check(
            names.windows(2).all(|pair| pair[0] != pair[1]),
            "duplicate package",
        )?;
        check(
            self.runtimes.iter().all(|r| {
                !r.kind.is_empty()
                    && r.kind.len() <= 32
                    && r.kind
                        .bytes()
                        .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
                    && !r.version.is_empty()
                    && r.version.len() <= 64
                    && r.version.bytes().all(|b| {
                        b.is_ascii_alphanumeric() || matches!(b, b'.' | b'-' | b'_' | b'+')
                    })
            }),
            "runtime entry",
        )
    }
}

#[cfg(test)]
#[path = "advert_tests.rs"]
pub(crate) mod tests;
