//! Which deployments this computer's user has trusted. Finding a deployment on the LAN proves nothing about who answered
//! — anyone on the network can announce anything — so **nothing is provisioned from a deployment until the user trusted
//! it here**, explicitly (the dialog's confirmation, `--deploy provision ... --trust`). A signed package still has to pass
//! the release-key check on top: trust says "I mean this source", the signature says "this is OpenMind's file".
//!
//! What trust protects against: a shared installation is used *as it is* (only a shortcut to its program is made, and
//! that program can't be signature-checked here), so a forged announcement of `\\attacker\share` must never become a
//! Desktop shortcut without the user having seen and approved that exact path. A share's deployment id is the hash of
//! its path ([`openmind_deploy::share_id_for`], checked on every announcement), so trusting the id pins the path.
//!
//! Kept in `deploy-trust.json` next to this computer's own database (per computer and Windows user, never in a shared
//! folder), written atomically; a damaged file trusts nothing and is replaced only by the user's next approval.

use std::path::{Path, PathBuf};

use openmind_deploy::advert::{DeploymentKind, Manifest};
use serde::{Deserialize, Serialize};

pub const TRUST_FILE: &str = "deploy-trust.json";
const FORMAT: &str = "openmind-deploy-trust";
/// At most this many trusted deployments are kept (the oldest go first).
const MAX_ENTRIES: usize = 64;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TrustEntry {
    pub deployment_id: String,
    pub kind: DeploymentKind,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub share_path: Option<String>,
    pub trusted_at: String,
}

#[derive(Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct TrustFile {
    format: String,
    entries: Vec<TrustEntry>,
}

pub struct TrustStore {
    file: PathBuf,
}

impl TrustStore {
    /// The store in `dir` (this computer's data folder: the database's).
    pub fn in_dir(dir: &Path) -> Self {
        Self {
            file: dir.join(TRUST_FILE),
        }
    }

    fn read(&self) -> TrustFile {
        std::fs::read_to_string(&self.file)
            .ok()
            .and_then(|text| serde_json::from_str::<TrustFile>(&text).ok())
            .filter(|file| file.format == FORMAT)
            .unwrap_or_default()
    }

    /// Whether `manifest`'s deployment is trusted — the same id, kind and (for a share) the same path.
    pub fn is_trusted(&self, manifest: &Manifest) -> bool {
        self.read().entries.iter().any(|entry| {
            entry.deployment_id == manifest.deployment_id
                && entry.kind == manifest.kind
                && entry.share_path.as_deref().map(str::to_lowercase)
                    == manifest.share_path.as_deref().map(str::to_lowercase)
        })
    }

    /// Records the user's approval of `manifest`'s deployment.
    pub fn trust(&self, manifest: &Manifest) -> std::io::Result<()> {
        let mut file = self.read();
        file.format = FORMAT.into();
        file.entries
            .retain(|entry| entry.deployment_id != manifest.deployment_id);
        file.entries.push(TrustEntry {
            deployment_id: manifest.deployment_id.clone(),
            kind: manifest.kind,
            share_path: manifest.share_path.clone(),
            trusted_at: openmind_core::data_scope::rfc3339_now(),
        });
        if file.entries.len() > MAX_ENTRIES {
            let extra = file.entries.len() - MAX_ENTRIES;
            file.entries.drain(..extra);
        }
        let text = serde_json::to_string_pretty(&file).map_err(std::io::Error::other)?;
        openmind_core::data_scope::write_atomic(&self.file, text.as_bytes())
    }

    /// Withdraws trust from a deployment (nothing else changes).
    pub fn forget(&self, deployment_id: &str) -> std::io::Result<()> {
        let mut file = self.read();
        let before = file.entries.len();
        file.entries
            .retain(|entry| entry.deployment_id != deployment_id);
        if file.entries.len() == before {
            return Ok(());
        }
        file.format = FORMAT.into();
        let text = serde_json::to_string_pretty(&file).map_err(std::io::Error::other)?;
        openmind_core::data_scope::write_atomic(&self.file, text.as_bytes())
    }
}

/// The message for an untrusted deployment.
pub fn untrusted_message(manifest: &Manifest) -> String {
    match (manifest.kind, &manifest.share_path) {
        (DeploymentKind::NetworkShare, Some(path)) => format!(
            "This shared installation ({path}) isn't trusted on this computer yet. Anyone on the network can announce a \
             deployment: trust it only if your IT administrator set up this exact path."
        ),
        _ => "This package source isn't trusted on this computer yet. Its packages are still checked against OpenMind's \
              release signature; trust it only if you know which computer offers it."
            .into(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use openmind_deploy::advert::MANIFEST_FORMAT;
    use openmind_deploy::{share_id_for, Arch, PROTOCOL};

    fn share(path: &str) -> Manifest {
        Manifest {
            format: MANIFEST_FORMAT.into(),
            protocol: PROTOCOL,
            deployment_id: share_id_for(path),
            app_version: "1.0.3".into(),
            platform: "windows".into(),
            arch: Arch::X64,
            kind: DeploymentKind::NetworkShare,
            share_path: Some(path.into()),
            packages: vec![],
            runtimes: vec![],
        }
    }

    #[test]
    fn nothing_is_trusted_until_the_user_says_so_and_trust_pins_the_path() {
        let dir = tempfile::tempdir().expect("dir");
        let store = TrustStore::in_dir(dir.path());
        let lab = share(r"\\lab-server\apps\OpenMind Studio");
        assert!(!store.is_trusted(&lab));
        store.trust(&lab).expect("trust");
        assert!(store.is_trusted(&lab));
        // Another path is another deployment (its id differs), and a forged claim of the trusted id with another path
        // doesn't match the pinned path either.
        let evil = share(r"\\attacker\evil\OpenMind Studio");
        assert!(!store.is_trusted(&evil));
        let mut forged = lab.clone();
        forged.share_path = Some(r"\\attacker\evil\OpenMind Studio".into());
        assert!(!store.is_trusted(&forged));
        let mut other_kind = lab.clone();
        other_kind.kind = DeploymentKind::PackageSource;
        other_kind.share_path = None;
        assert!(!store.is_trusted(&other_kind));
        store.forget(&lab.deployment_id).expect("forget");
        assert!(!store.is_trusted(&lab));
    }

    #[test]
    fn a_damaged_trust_file_trusts_nothing() {
        let dir = tempfile::tempdir().expect("dir");
        std::fs::write(dir.path().join(TRUST_FILE), b"{ not json").expect("damaged");
        let store = TrustStore::in_dir(dir.path());
        let lab = share(r"\\lab-server\apps\OpenMind Studio");
        assert!(!store.is_trusted(&lab));
        store.trust(&lab).expect("replaced by the next approval");
        assert!(store.is_trusted(&lab));
    }
}
