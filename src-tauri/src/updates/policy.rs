//! The update rules, free of Tauri and the network so they are tested exactly:
//!
//! - **what may be installed**: a stable version newer than this one — never a pre-release on the stable channel, never
//!   an older version (no downgrade, even if the feed says so);
//! - **mandatory**: a release names the oldest version still supported (`openmind.minimumVersion` in `latest.json`);
//!   this version below it must update — enforced only once the update is downloaded, verified and installable;
//! - **who may update itself** ([`SelfUpdate`]): an installed copy runs its signed installer; a portable copy replaces
//!   its own program files from a signed archive; a shared network installation is updated only by whoever installed
//!   it, so its computers are told about the new version and nothing else;
//! - **when to try again** ([`backoff`]) and **what went wrong** ([`Failure`]).

use std::time::Duration;

use semver::Version;
use serde::Serialize;

use openmind_core::InstallLayout;

use super::InstallKind;

/// The release channel. Only stable exists: GitHub's "latest release" never points at a pre-release.
pub const CHANNEL: &str = "stable";

/// Whether `remote` may replace `current` on the stable channel.
pub fn is_installable_upgrade(current: &Version, remote: &Version) -> bool {
    remote.pre.is_empty() && remote > current
}

/// The OpenMind section of `latest.json` (next to Tauri's own fields; the updater ignores it).
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct FeedExtras {
    /// The oldest version still supported; an older one must update.
    pub minimum_version: Option<Version>,
    pub channel: Option<String>,
}

pub fn feed_extras(raw: &serde_json::Value) -> FeedExtras {
    let section = raw.get("openmind");
    FeedExtras {
        minimum_version: section
            .and_then(|s| s.get("minimumVersion"))
            .and_then(serde_json::Value::as_str)
            .and_then(|v| Version::parse(v.trim()).ok()),
        channel: section
            .and_then(|s| s.get("channel"))
            .and_then(serde_json::Value::as_str)
            .map(str::to_string),
    }
}

/// This version is no longer supported by the release it found.
pub fn is_mandatory(current: &Version, extras: &FeedExtras) -> bool {
    extras
        .minimum_version
        .as_ref()
        .is_some_and(|minimum| current < minimum)
}

/// How this copy can take an update.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase", tag = "kind", content = "reason")]
pub enum SelfUpdate {
    /// The per-user setup or the MSI: the signed installer replaces the program (the MSI asks Windows for permission).
    Installer,
    /// A portable copy: its program files are replaced from the signed portable archive, at a restart.
    Portable,
    /// Updated by someone else (the reason says who and how); this copy only shows that a new version exists.
    Managed(String),
}

pub fn self_update(kind: InstallKind, layout: InstallLayout) -> SelfUpdate {
    if layout == InstallLayout::Network {
        return SelfUpdate::Managed(
            "This is a shared network installation. Other computers run it, so it is updated by whoever installed it: \
             run the new setup on that computer with the shared folder as the install folder while nobody uses it."
                .into(),
        );
    }
    match kind {
        InstallKind::Nsis | InstallKind::Msi => SelfUpdate::Installer,
        InstallKind::Portable => SelfUpdate::Portable,
    }
}

/// The pause before the next attempt after `failures` failed checks in a row: 1, 2, 4 … minutes, at most an hour.
pub fn backoff(failures: u32) -> Duration {
    let minutes = 1u64 << failures.saturating_sub(1).min(6);
    Duration::from_secs(60 * minutes.min(60))
}

/// The regular pause between two checks while nothing goes wrong.
pub const CHECK_INTERVAL: Duration = Duration::from_secs(6 * 60 * 60);
/// The first check after start-up waits this long, so it never competes with opening the window.
pub const FIRST_CHECK_DELAY: Duration = Duration::from_secs(45);

/// What kind of problem stopped a check or a download (shown with its own advice; the details are logged).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Failure {
    /// No connection, a name that can't be resolved, a timeout: tried again later, quietly.
    Network,
    /// The release server answered, but without an update feed for this version (404) or with a broken one.
    Feed,
    /// The downloaded file isn't signed with OpenMind's release key: it is thrown away and never run.
    Signature,
    /// Windows refused to run or finish the installer (permissions, policy, cancelled UAC prompt).
    Install,
    Other,
}

pub fn classify(message: &str) -> Failure {
    let text = message.to_ascii_lowercase();
    if text.contains("signature") || text.contains("minisign") || text.contains("public key") {
        Failure::Signature
    } else if [
        "404",
        "not found",
        "deserialize",
        "release not found",
        "target",
        "invalid json",
        "expected",
    ]
    .iter()
    .any(|needle| text.contains(needle))
    {
        Failure::Feed
    } else if [
        "dns",
        "connect",
        "timed out",
        "timeout",
        "network",
        "unreachable",
        "resolve",
        "tls",
        "proxy",
        "reset",
    ]
    .iter()
    .any(|needle| text.contains(needle))
    {
        Failure::Network
    } else if [
        "access is denied",
        "elevation",
        "cancelled by the user",
        "installer",
    ]
    .iter()
    .any(|needle| text.contains(needle))
    {
        Failure::Install
    } else {
        Failure::Other
    }
}

#[cfg(test)]
#[path = "policy_tests.rs"]
mod tests;
