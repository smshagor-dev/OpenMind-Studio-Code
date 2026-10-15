//! Updating a portable copy (the ZIP), which has no installer to run.
//!
//! 1. **Download** the portable archive named in `latest.json` (`openmind.portable.<target>`: `url` + `signature`) over
//!    https, through the proxy in force, into `<temp>/update/`.
//! 2. **Verify** it the way the Tauri updater verifies installers: the minisign signature against the public key built
//!    into this program (`plugins.updater.pubkey`), and the version recorded inside the signature must be the version the
//!    feed announced (the feed itself isn't signed). Anything else is deleted and never unpacked.
//! 3. **Stage**: unpack it (safe names, size limits) into `<copy>/.update-staged/<version>/`.
//! 4. **Swap at a controlled restart** ([`apply`]): only the program's own items are replaced — `OpenMindStudio.exe`
//!    and the shipped bundles (`lsp/`, `python-bundle/`, `bin/`, `README.txt`) — never `data/`, `settings/`,
//!    `runtimes/`, `tools/`, `extensions/` or anything else of the user's. Each item is first renamed aside
//!    (`<name>.old-<pid>`; Windows allows renaming a running program) and the staged one renamed in; if any step fails,
//!    everything done so far is renamed back and the copy is left as it was. The next start removes the set-aside items
//!    ([`finish_previous_update`]).
//!
//! A copy that another computer is running from the same drive can't have its program renamed; then nothing is changed
//! and the update waits for the next close.

use std::io::Read;
use std::path::{Path, PathBuf};
use std::time::Duration;

use base64::Engine;
use minisign_verify::{PublicKey, Signature};
use tauri::AppHandle;

/// The program's own items in a portable copy: the only things an update replaces.
pub const REPLACEABLE: &[&str] = &[
    "OpenMindStudio.exe",
    "lsp",
    "python-bundle",
    "bin",
    "README.txt",
    "LICENSE.txt",
    "THIRD-PARTY-LICENSES.txt",
    "legal",
    "Start OpenMind Studio.bat",
    "deploy",
];
const STAGED_DIR: &str = ".update-staged";
const OLD_MARK: &str = ".old-";
/// The folder the portable ZIP holds everything in.
const ZIP_ROOT: &str = "OpenMind Studio";
const MAX_PACKAGE_BYTES: u64 = 512 * 1024 * 1024;

fn read_package(
    reader: &mut dyn Read,
    total: Option<u64>,
    limit: u64,
    report: &mut dyn FnMut(u64, Option<u64>),
) -> Result<Vec<u8>, String> {
    if total.is_some_and(|n| n > limit) {
        return Err("The portable update exceeds the maximum package size.".into());
    }
    let mut data = Vec::with_capacity(total.unwrap_or(0).min(8 * 1024 * 1024) as usize);
    let mut reader = reader.take(limit + 1);
    let mut buffer = vec![0u8; 1 << 16];
    loop {
        let read = reader
            .read(&mut buffer)
            .map_err(|e| format!("The portable update download stopped: {e}"))?;
        if read == 0 {
            break;
        }
        if data.len() as u64 + read as u64 > limit {
            return Err("The portable update exceeds the maximum package size.".into());
        }
        data.extend_from_slice(&buffer[..read]);
        report(data.len() as u64, total);
    }
    if total.is_some_and(|n| n != data.len() as u64) {
        return Err("The portable update size does not match Content-Length.".into());
    }
    Ok(data)
}

/// This build's key in `latest.json`'s `openmind.portable` map.
pub fn target() -> &'static str {
    if cfg!(target_arch = "x86") {
        "windows-i686"
    } else if cfg!(target_arch = "aarch64") {
        "windows-aarch64"
    } else {
        "windows-x86_64"
    }
}

/// The updater's public key from tauri.conf.json (base64 of minisign's public key file).
pub fn public_key(app: &AppHandle) -> Result<String, String> {
    app.config()
        .plugins
        .0
        .get("updater")
        .and_then(|updater| updater.get("pubkey"))
        .and_then(serde_json::Value::as_str)
        .map(str::to_string)
        .ok_or_else(|| "This build has no update key, so it can't verify updates.".into())
}

/// What a portable update needs.
#[derive(Debug, Clone)]
pub struct Request {
    pub version: String,
    pub url: String,
    pub signature: String,
    pub pubkey: String,
    /// The portable copy's folder (the program's folder).
    pub root: PathBuf,
    pub download_dir: PathBuf,
}

impl Request {
    pub fn from_feed(
        raw: &serde_json::Value,
        version: &str,
        root: PathBuf,
        download_dir: PathBuf,
        pubkey: String,
    ) -> Result<Self, String> {
        let entry = raw
            .get("openmind")
            .and_then(|o| o.get("portable"))
            .and_then(|p| p.get(target()))
            .ok_or_else(|| {
                format!(
                    "The release has no signed portable package for {} — download it from the releases page.",
                    target()
                )
            })?;
        let field = |name: &str| {
            entry
                .get(name)
                .and_then(serde_json::Value::as_str)
                .map(str::to_string)
                .ok_or_else(|| format!("The release's portable package has no {name}."))
        };
        let url = field("url")?;
        if !url.starts_with("https://") && !local_test_url(&url) {
            return Err("The portable package address must use https.".into());
        }
        Ok(Self {
            version: version.to_string(),
            url,
            signature: field("signature")?,
            pubkey,
            root,
            download_dir,
        })
    }

    fn staged_dir(&self) -> PathBuf {
        self.root.join(STAGED_DIR).join(&self.version)
    }
}

/// A verified, unpacked portable update waiting for the restart.
#[derive(Debug, Clone)]
pub struct Staged {
    pub version: String,
    /// The new copy's folder (holds `OpenMindStudio.exe`).
    pub files: PathBuf,
    pub root: PathBuf,
}

/// A development build may fetch from a feed on this computer over plain http (the end-to-end update test). Never in a
/// release build: there every address must be https.
fn local_test_url(url: &str) -> bool {
    cfg!(debug_assertions) && url.starts_with("http://127.0.0.1:")
}

fn decode(text: &str) -> Result<String, String> {
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(text.trim())
        .map_err(|err| format!("not base64: {err}"))?;
    String::from_utf8(bytes).map_err(|err| err.to_string())
}

/// Checks `data` against a Tauri updater signature (both base64, as in `latest.json` and `plugins.updater.pubkey`),
/// and that the signature was made for `version`.
pub fn verify(data: &[u8], signature: &str, pubkey: &str, version: &str) -> Result<(), String> {
    let key = PublicKey::decode(&decode(pubkey)?)
        .map_err(|err| format!("the update key is invalid: {err}"))?;
    let signature = Signature::decode(&decode(signature)?)
        .map_err(|err| format!("the update signature is invalid: {err}"))?;
    key.verify(data, &signature, true).map_err(|err| {
        format!("the update's signature doesn't match OpenMind's release key: {err}")
    })?;
    // Trusted only now: the global signature that `verify` checked covers the trusted comment.
    let signed = signature
        .trusted_comment()
        .split('\t')
        .find_map(|field| field.strip_prefix("version:"));
    // Required: the feed isn't signed, so only the signed version proves which release this archive is.
    match signed {
        None => Err("the signature doesn't name the version it was made for".into()),
        Some(signed)
            if signed.trim().trim_start_matches('v') != version.trim_start_matches('v') =>
        {
            Err(format!(
                "the signature was made for version {signed}, but the release says {version}"
            ))
        }
        Some(_) => Ok(()),
    }
}

/// Downloads, verifies and unpacks a portable update (on a blocking thread).
pub fn download_and_stage(
    request: &Request,
    mut report: impl FnMut(u64, Option<u64>),
) -> Result<Staged, String> {
    std::fs::create_dir_all(&request.download_dir).map_err(|err| err.to_string())?;
    let archive = request
        .download_dir
        .join(format!("OpenMind-Studio-Portable-{}.zip", request.version));
    let agent = if local_test_url(&request.url) {
        ureq::Agent::new_with_defaults()
    } else {
        openmind_network::http::agent(
            &request.url,
            openmind_network::http::Timeouts::download(Duration::from_secs(60 * 60)),
            None,
        )
    };
    let mut response = agent
        .get(&request.url)
        .call()
        .map_err(|err| format!("Couldn't download the portable update: {err}"))?;
    if !response.status().is_success() {
        return Err(format!(
            "Couldn't download the portable update: the server answered {}",
            response.status()
        ));
    }
    let total = response
        .headers()
        .get("content-length")
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.parse::<u64>().ok());
    let mut reader = response.body_mut().as_reader();
    let data = read_package(&mut reader, total, MAX_PACKAGE_BYTES, &mut report)?;
    verify(&data, &request.signature, &request.pubkey, &request.version)?;
    std::fs::write(&archive, &data).map_err(|err| err.to_string())?;
    drop(data);
    let staged = request.staged_dir();
    let _ = std::fs::remove_dir_all(&staged);
    std::fs::create_dir_all(&staged).map_err(|err| err.to_string())?;
    // The Runtime Manager's extractor: backslash names (PowerShell's Compress-Archive) are normalised, and every entry is
    // checked (no `..`, absolute or drive paths, no links, size limits) before anything is written.
    let unpacked = openmind_runtime_manager::extract::extract_archive(
        openmind_runtime_manager::manifest::ArchiveKind::Zip,
        &archive,
        &staged,
        openmind_runtime_manager::extract::ExtractSelection {
            strip_components: 0,
            only_under: None,
        },
        &mut |_, _| {},
    )
    .map_err(|err| format!("The portable update couldn't be unpacked safely: {err}"));
    let _ = std::fs::remove_file(&archive);
    unpacked?;
    stage_from(&staged, &request.root, &request.version)
}

/// The unpacked folder must hold the program itself.
fn stage_from(staged: &Path, root: &Path, version: &str) -> Result<Staged, String> {
    let files = if staged.join(ZIP_ROOT).join("OpenMindStudio.exe").is_file() {
        staged.join(ZIP_ROOT)
    } else if staged.join("OpenMindStudio.exe").is_file() {
        staged.to_path_buf()
    } else {
        let _ = std::fs::remove_dir_all(staged);
        return Err("The portable package doesn't contain OpenMindStudio.exe.".into());
    };
    Ok(Staged {
        version: version.to_string(),
        files,
        root: root.to_path_buf(),
    })
}

/// Swaps the program's own items for the staged ones (see the module text). All or nothing.
pub fn apply(staged: &Staged) -> Result<(), String> {
    let mark = format!("{OLD_MARK}{}", std::process::id());
    let mut done: Vec<(PathBuf, Option<PathBuf>)> = Vec::new();
    let result = (|| {
        for name in REPLACEABLE {
            let new = staged.files.join(name);
            if !new.exists() {
                continue;
            }
            let current = staged.root.join(name);
            let aside = staged.root.join(format!("{name}{mark}"));
            let moved_aside = if current.exists() {
                std::fs::rename(&current, &aside).map_err(|err| {
                    format!(
                        "{} is in use (perhaps OpenMind Studio runs from this folder on another computer), so the \
                         update waits: {err}",
                        current.display()
                    )
                })?;
                Some(aside)
            } else {
                None
            };
            done.push((current.clone(), moved_aside));
            std::fs::rename(&new, &current)
                .map_err(|err| format!("{}: {err}", current.display()))?;
        }
        Ok::<(), String>(())
    })();
    if let Err(err) = result {
        // Put back everything, newest first. Once an item was set aside (or didn't exist), whatever is at its place is
        // the new copy: it goes, and the original comes back.
        for (current, aside) in done.into_iter().rev() {
            if current.is_dir() {
                let _ = std::fs::remove_dir_all(&current);
            } else if current.exists() {
                let _ = std::fs::remove_file(&current);
            }
            if let Some(aside) = aside {
                let _ = std::fs::rename(&aside, &current);
            }
        }
        return Err(format!(
            "The portable update was not applied; this copy is unchanged. {err}"
        ));
    }
    let _ = std::fs::remove_dir_all(staged.root.join(STAGED_DIR));
    tracing::info!(version = %staged.version, "portable update applied; the new version starts next");
    Ok(())
}

/// At start-up: removes what an applied update set aside and any stale staging (the old program can be deleted now that
/// it no longer runs). Best effort.
pub fn finish_previous_update(root: &Path) {
    let Ok(entries) = std::fs::read_dir(root) else {
        return;
    };
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().into_owned();
        let ours = REPLACEABLE
            .iter()
            .any(|item| name.starts_with(&format!("{item}{OLD_MARK}")));
        if ours {
            let path = entry.path();
            let _ = if path.is_dir() {
                std::fs::remove_dir_all(&path)
            } else {
                std::fs::remove_file(&path)
            };
        }
    }
    // A staging folder from more than a day ago belongs to an update nobody applied; a fresher one may be another
    // computer's (a portable drive used by several), so it stays.
    let staged = root.join(STAGED_DIR);
    let stale = std::fs::metadata(&staged)
        .and_then(|meta| meta.modified())
        .ok()
        .and_then(|modified| modified.elapsed().ok())
        .is_some_and(|age| age > Duration::from_secs(24 * 60 * 60));
    if stale {
        let _ = std::fs::remove_dir_all(&staged);
    }
}

#[cfg(test)]
#[path = "portable_tests.rs"]
mod tests;

#[cfg(test)]
mod download_limit_tests {
    use super::*;
    #[test]
    fn package_limit_handles_declared_and_chunked_oversize_and_truncation() {
        let bytes = [0u8; 9];
        assert!(read_package(&mut &bytes[..], Some(9), 8, &mut |_, _| {}).is_err());
        assert!(read_package(&mut &bytes[..], None, 8, &mut |_, _| {}).is_err());
        assert!(read_package(&mut &bytes[..4], Some(8), 8, &mut |_, _| {}).is_err());
        assert_eq!(
            read_package(&mut &bytes[..8], Some(8), 8, &mut |_, _| {})
                .expect("at limit")
                .len(),
            8
        );
    }
}
