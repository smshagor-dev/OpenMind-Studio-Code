//! **Deployment on a local network**: how one computer finds OpenMind Studio deployments on its LAN and gets a working
//! copy from one — the *deployment layer*. It is separate from collaboration (rooms, peers, documents — the
//! `openmind-collab*` crates, which have their own port and packets) and from execution (terminals, processes and their
//! output, which never leave the computer that started them).
//!
//! **What is a deployment** ([`advert::DeploymentKind`]):
//! - a **shared network installation** ("Recommended for All Users" in a network folder): every computer runs the same
//!   program from `\\server\share`, runtimes and tools are installed there once, and each computer and Windows user keeps
//!   its own database, settings, logs and caches locally. Its identity is the folder's network (UNC) path, so every
//!   computer running it announces the same deployment;
//! - a **package source**: a computer offering OpenMind Studio's own signed setup or portable package to the others (an
//!   administrator's computer, or the share's `deploy/packages` folder).
//!
//! **Discovery** ([`discover`], [`responder`]): a computer sends a small query ([`packet`]) to UDP port
//! [`DISCOVERY_PORT`] — the limited broadcast, each of its IPv4 networks' broadcast address and any address it was given
//! — three times over a short window, and collects the answers that carry its own random nonce. A computer that offers
//! a deployment answers only such queries, only to the sender, rate-limited. Nothing scans addresses. Answers are
//! grouped by deployment id ([`registry`]): one shared installation announced by twenty computers is one deployment; a
//! source that restarts or changes address keeps its identity; an announcement not seen again expires.
//!
//! **The LAN is untrusted.** An announcement only says where to look. A package is used only after its size, its
//! SHA-256 and — the real check — its **minisign signature** against the update key built into this program, bound to
//! the version it claims ([`package::verify_file`], with the app's verifier), all pass; a forged or tampered one is
//! deleted. An announcement never carries a secret, a credential, a key, a database, a file of the user or a project.
//!
//! **Provisioning** ([`provision`]) decides, from facts only (the offer, this computer's architecture, what is at the
//! destination the user chose — any drive, any folder), whether to install, upgrade, repair, only add a shortcut, or
//! refuse with the reason (another platform or architecture, a downgrade, a folder that isn't an OpenMind Studio copy).
//! The app carries the decision out.

pub mod advert;
pub mod client;
pub mod discover;
pub mod package;
pub mod packet;
pub mod provision;
pub mod registry;
pub mod responder;
pub mod server;
pub mod version;

use sha2::{Digest, Sha256};

/// The deployment protocol's version (packets, manifest). A computer answers only queries of its own version and
/// reports a deployment that speaks another one as incompatible.
pub const PROTOCOL: u32 = 1;
/// The UDP port deployment discovery uses (collaboration uses 47731/47732; this is a different service).
pub const DISCOVERY_PORT: u16 = 47741;

/// The architectures OpenMind Studio is built for, as release files name them.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Arch {
    X64,
    X86,
    Arm64,
}

impl Arch {
    pub fn parse(text: &str) -> Option<Self> {
        Some(match text.trim().to_ascii_lowercase().as_str() {
            "x64" | "x86_64" | "amd64" => Self::X64,
            "x86" | "i686" | "i386" => Self::X86,
            "arm64" | "aarch64" => Self::Arm64,
            _ => return None,
        })
    }

    pub fn label(self) -> &'static str {
        match self {
            Self::X64 => "x64",
            Self::X86 => "x86",
            Self::Arm64 => "arm64",
        }
    }

    /// The architecture this program was built for.
    pub fn of_this_build() -> Self {
        if cfg!(target_arch = "x86") {
            Self::X86
        } else if cfg!(target_arch = "aarch64") {
            Self::Arm64
        } else {
            Self::X64
        }
    }

    /// Whether a program built for `program` runs on a computer whose operating system is `self` (64-bit Windows runs
    /// 32-bit programs; Windows on ARM runs both x64 and x86 programs; 32-bit Windows runs only 32-bit ones).
    pub fn runs(self, program: Arch) -> bool {
        match self {
            Self::X64 => matches!(program, Self::X64 | Self::X86),
            Self::X86 => program == Self::X86,
            Self::Arm64 => true,
        }
    }
}

/// The platform name used in announcements and release files.
pub fn this_platform() -> &'static str {
    if cfg!(windows) {
        "windows"
    } else if cfg!(target_os = "macos") {
        "macos"
    } else {
        "linux"
    }
}

/// `n` random bytes as lowercase hex (nonces, instance ids).
pub fn random_hex(bytes: usize) -> String {
    let mut buf = vec![0u8; bytes];
    if getrandom::fill(&mut buf).is_err() {
        // No system randomness: a time-based value still keeps runs apart (never used as a secret).
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or_default();
        let digest = Sha256::digest(format!("{nanos}-{}", std::process::id()));
        buf.iter_mut().zip(digest.iter()).for_each(|(b, d)| *b = *d);
    }
    to_hex(&buf)
}

pub(crate) fn to_hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

/// Whether `text` is exactly `len` lowercase hex digits.
pub fn is_hex(text: &str, len: usize) -> bool {
    text.len() == len
        && text
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

/// The deployment id of a shared network installation: a hash of its folder's network path, so every computer running
/// it — through `\\server\share` or a mapped drive resolved to it — announces the same id. Never the path itself.
pub fn share_deployment_id(normalized_share_path: &str) -> String {
    let digest = Sha256::digest(format!(
        "openmind-deploy:share:v1\n{}",
        normalized_share_path.trim().to_lowercase()
    ));
    to_hex(&digest[..16])
}

/// The deployment id of a package source: this computer (a token of it, never its name) and the offered folder.
pub fn source_deployment_id(computer_token: &str, normalized_folder: &str) -> String {
    let digest = Sha256::digest(format!(
        "openmind-deploy:source:v1\n{}\n{}",
        computer_token.trim(),
        normalized_folder.trim().to_lowercase()
    ));
    to_hex(&digest[..16])
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn architectures_run_what_windows_runs() {
        assert!(Arch::X64.runs(Arch::X64) && Arch::X64.runs(Arch::X86));
        assert!(Arch::X86.runs(Arch::X86) && !Arch::X86.runs(Arch::X64));
        assert!(Arch::Arm64.runs(Arch::X64) && Arch::Arm64.runs(Arch::X86));
        assert!(!Arch::X64.runs(Arch::Arm64));
        assert_eq!(Arch::parse("x86_64"), Some(Arch::X64));
        assert_eq!(Arch::parse("i686"), Some(Arch::X86));
        assert_eq!(Arch::parse("sparc"), None);
    }

    #[test]
    fn a_share_has_one_id_however_its_path_is_spelled_in_case() {
        let a = share_deployment_id(r"\\server\apps\openmind studio");
        let b = share_deployment_id(r"\\SERVER\Apps\OpenMind Studio");
        assert_eq!(a, b);
        assert!(is_hex(&a, 32));
        assert_ne!(a, share_deployment_id(r"\\server\apps\other"));
    }

    #[test]
    fn sources_on_two_computers_are_two_deployments() {
        let folder = r"c:\deploy\packages";
        assert_ne!(
            source_deployment_id("aaaa", folder),
            source_deployment_id("bbbb", folder)
        );
        assert_ne!(
            source_deployment_id("aaaa", folder),
            share_deployment_id(folder)
        );
    }

    #[test]
    fn random_values_are_hex_and_differ() {
        let (a, b) = (random_hex(8), random_hex(8));
        assert!(is_hex(&a, 16) && is_hex(&b, 16));
        assert_ne!(a, b);
    }
}
