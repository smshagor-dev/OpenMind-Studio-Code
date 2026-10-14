//! The real side effects of provisioning on this computer — one place, so the window and the `--deploy` command line can
//! never differ in what they check:
//! - the release key built into this program verifies every package;
//! - only a deployment this computer's user trusted is used (`trust.rs`);
//! - nothing older than this program is installed;
//! - downloads go to this Windows user's own temporary folder (never a shared app folder), a new folder per provisioning;
//! - a destination on this computer is locked in this computer's data folder;
//! - the Desktop shortcut is this user's own, and only when asked for.

use std::path::Path;
use std::sync::atomic::AtomicBool;

use openmind_deploy::advert::Manifest;

use super::exec::{run_setup_silently, Effects};
use super::local::ThisCopy;
use super::trust::TrustStore;

/// Runs `job` with this computer's effects for `copy`.
pub fn with_live_effects<R>(
    copy: &ThisCopy,
    desktop_shortcut: bool,
    job: impl FnOnce(&Effects) -> R,
) -> Result<R, String> {
    let verifier = super::release_verifier()?;
    let cancel = AtomicBool::new(false);
    let trust = TrustStore::in_dir(&copy.data_root);
    let trusted = |manifest: &Manifest| trust.is_trusted(manifest);
    let shortcut = |program: &Path| {
        if desktop_shortcut {
            crate::integration::deploy::desktop_shortcut(program, false)
        } else {
            Ok(format!(
                "not created (as asked); start {}",
                program.display()
            ))
        }
    };
    let effects = Effects {
        verifier: &verifier,
        shortcut: &shortcut,
        run_setup: &run_setup_silently,
        temp_dir: std::env::temp_dir().join("OpenMind Studio"),
        lock_dir: copy.data_root.join("provision-locks"),
        trusted: &trusted,
        minimum_version: env!("CARGO_PKG_VERSION"),
        cancel: &cancel,
    };
    Ok(job(&effects))
}
