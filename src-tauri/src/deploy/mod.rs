//! OpenMind Studio's deployment on a local network, on this computer: what this copy offers (`local`), finding other
//! deployments and keeping what was found (`service`), provisioning this computer from one (`inspect`, `exec`), the
//! Network Deployment Test (`checks`) and the `--deploy` command line (`cli`). The protocol, validation and package
//! transfer are `openmind_deploy`'s; this module adds the app's facts, its release key and its side effects.
//!
//! Layers stay apart: deployment discovery has its own port and packets (collaboration rooms have theirs), and nothing
//! here touches a terminal, a process's output or another computer's database — execution state is always local.

pub mod checks;
pub mod cli;
pub mod cli_text;
pub mod exec;
pub mod inspect;
pub mod live;
pub mod local;
pub mod service;
#[cfg(test)]
pub mod test_signing;
pub mod trust;

/// The release's update key (`plugins.updater.pubkey`), read from the configuration built into this program — the
/// same key the updater trusts, also available to the `--deploy` command line, which runs without the app.
pub fn release_key() -> Result<String, String> {
    let config: serde_json::Value = serde_json::from_str(include_str!("../../tauri.conf.json"))
        .map_err(|err| format!("the built-in configuration can't be read: {err}"))?;
    config
        .pointer("/plugins/updater/pubkey")
        .and_then(serde_json::Value::as_str)
        .filter(|key| !key.is_empty())
        .map(str::to_string)
        .ok_or_else(|| "This build has no release key, so it can't verify packages.".into())
}

/// Checks a package against the release key, bound to its version (see `updates::portable::verify`).
pub fn release_verifier() -> Result<PackageVerifier, String> {
    let key = release_key()?;
    Ok(Box::new(
        move |data: &[u8], signature: &str, version: &str| {
            crate::updates::portable::verify(data, signature, &key, version)
        },
    ))
}

/// `(bytes, signature, version)` checked against a key.
pub type PackageVerifier = Box<dyn Fn(&[u8], &str, &str) -> Result<(), String> + Send + Sync>;

#[cfg(test)]
mod tests {
    #[test]
    fn the_release_key_is_the_updaters_and_decodes() {
        let key = super::release_key().expect("key");
        // A real minisign public key: a signature made by another key is refused by it, not "malformed".
        let other = super::test_signing::TestKey::new(9).sign(b"x", "1.0.3");
        let refused =
            crate::updates::portable::verify(b"x", &other, &key, "1.0.3").expect_err("another key");
        assert!(refused.contains("doesn't match"), "{refused}");
    }
}
