//! Temporary staging: every artifact the broker downloads lands in `<app>/temp/<provider>/<key>/` and is removed once it
//! has been handed over. A download that stopped half-way keeps its `.part` file (the next request resumes it) for a
//! while; everything else is cleared at the next start. Nothing outside `<app>/temp` is ever touched, links are never
//! followed, and a folder another running OpenMind holds (its `.lock` is open) is left alone.

use std::fs::{self, File, OpenOptions};
use std::io;
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

/// Which part of the broker an artifact belongs to (its staging folder).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Provider {
    /// `openmind-fetch` and other explicit file downloads.
    Download,
    Pypi,
    Npm,
    Go,
    Git,
    Composer,
    Cargo,
    Yarn,
    Pnpm,
    Rustup,
}

impl Provider {
    pub const ALL: [Provider; 10] = [
        Provider::Download,
        Provider::Pypi,
        Provider::Npm,
        Provider::Go,
        Provider::Git,
        Provider::Composer,
        Provider::Cargo,
        Provider::Yarn,
        Provider::Pnpm,
        Provider::Rustup,
    ];

    pub fn dir(self) -> &'static str {
        match self {
            Provider::Download => "downloads",
            Provider::Pypi => "pypi",
            Provider::Npm => "npm",
            Provider::Go => "go",
            Provider::Git => "git",
            Provider::Composer => "composer",
            Provider::Cargo => "cargo",
            Provider::Yarn => "yarn",
            Provider::Pnpm => "pnpm",
            Provider::Rustup => "rustup",
        }
    }
}

const LOCK: &str = ".lock";
const META: &str = "meta.json";
/// How long a resumable partial download is kept for the next attempt.
pub const PARTIAL_MAX_AGE: Duration = Duration::from_secs(3 * 24 * 60 * 60);

/// What `meta.json` records about a staged artifact (no credentials: artifact addresses never carry any).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SlotMeta {
    pub format: String,
    pub version: u32,
    pub provider: Provider,
    pub url: String,
    pub file: String,
    /// Seconds since 1970.
    pub updated: u64,
    /// `downloading`, `partial` (kept to resume) or `ready`.
    pub state: String,
}

pub struct Staging {
    root: PathBuf,
}

/// One artifact's folder, held (its `.lock` open, not shared) for as long as the slot lives.
pub struct Slot {
    dir: PathBuf,
    file: PathBuf,
    meta: SlotMeta,
    _lock: File,
}

/// What start-up recovery did.
#[derive(Debug, Default, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RecoveryReport {
    /// Stale folders removed.
    pub removed: usize,
    /// Partial downloads kept to be resumed.
    pub kept_partial: usize,
    /// Folders another running OpenMind holds.
    pub in_use: usize,
}

pub fn now_secs() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

/// A file name that is safe on every file system: the last segment of the address, other characters dropped.
pub fn safe_file_name(url: &str) -> String {
    let path = url.split(['?', '#']).next().unwrap_or_default();
    let last = path.rsplit('/').next().unwrap_or_default();
    let name: String = last
        .chars()
        .filter(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-' | '+'))
        .take(120)
        .collect();
    let name = name.trim_start_matches('.').to_string();
    if name.is_empty() {
        "artifact".to_string()
    } else {
        name
    }
}

fn key_dir(key: &str) -> String {
    Sha256::digest(key.as_bytes())
        .iter()
        .take(16)
        .map(|b| format!("{b:02x}"))
        .collect()
}

/// Opens `path` so no other process can open it while the handle lives (Windows); elsewhere simply opens it.
fn exclusive(path: &Path) -> io::Result<File> {
    let mut options = OpenOptions::new();
    options.create(true).truncate(false).write(true).read(true);
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        options.share_mode(0);
    }
    options.open(path)
}

/// A real directory (not a link or junction).
fn real_dir(path: &Path) -> bool {
    fs::symlink_metadata(path)
        .map(|m| m.file_type().is_dir() && !m.file_type().is_symlink())
        .unwrap_or(false)
}

impl Staging {
    pub fn new(root: impl Into<PathBuf>) -> Self {
        Staging { root: root.into() }
    }

    pub fn root(&self) -> &Path {
        &self.root
    }

    pub fn provider_dir(&self, provider: Provider) -> PathBuf {
        self.root.join(provider.dir())
    }

    /// The folder for `key` (usually the artifact's address), held until the slot is dropped. Fails with
    /// `WouldBlock` when another process holds it.
    pub fn slot(&self, provider: Provider, key: &str, file_name: &str) -> io::Result<Slot> {
        let base = self.provider_dir(provider);
        fs::create_dir_all(&base)?;
        if !real_dir(&base) {
            return Err(io::Error::other("the staging folder is not a real folder"));
        }
        let dir = base.join(key_dir(key));
        fs::create_dir_all(&dir)?;
        if !real_dir(&dir) {
            return Err(io::Error::other("the staging folder is not a real folder"));
        }
        let lock = exclusive(&dir.join(LOCK))
            .map_err(|err| io::Error::new(io::ErrorKind::WouldBlock, err))?;
        let file = dir.join(safe_file_name(file_name));
        let meta = SlotMeta {
            format: "openmind-staging".into(),
            version: 1,
            provider,
            url: key.to_string(),
            file: safe_file_name(file_name),
            updated: now_secs(),
            state: "downloading".into(),
        };
        let slot = Slot {
            dir,
            file,
            meta,
            _lock: lock,
        };
        slot.write_meta("downloading");
        Ok(slot)
    }

    /// Start-up recovery: removes what an earlier run left behind, keeps partial downloads younger than `max_partial_age`
    /// (they resume) and skips folders another running OpenMind holds.
    pub fn recover(&self, now: u64, max_partial_age: Duration) -> RecoveryReport {
        let mut report = RecoveryReport::default();
        for provider in Provider::ALL {
            let base = self.provider_dir(provider);
            if !real_dir(&base) {
                continue;
            }
            let Ok(entries) = fs::read_dir(&base) else {
                continue;
            };
            for entry in entries.filter_map(Result::ok) {
                let dir = entry.path();
                if !real_dir(&dir) {
                    continue;
                }
                let Ok(lock) = exclusive(&dir.join(LOCK)) else {
                    report.in_use += 1;
                    continue;
                };
                if keep_partial(&dir, now, max_partial_age) {
                    report.kept_partial += 1;
                    continue;
                }
                drop(lock);
                match fs::remove_dir_all(&dir) {
                    Ok(()) => report.removed += 1,
                    Err(err) => {
                        tracing::warn!(dir = %dir.display(), %err, "stale staging folder not removed")
                    }
                }
            }
        }
        if report != RecoveryReport::default() {
            tracing::info!(?report, "staging recovered");
        }
        report
    }
}

/// A folder worth keeping: a `.part` file and a `partial` record younger than `max_age`.
fn keep_partial(dir: &Path, now: u64, max_age: Duration) -> bool {
    let Some(meta) = fs::read_to_string(dir.join(META))
        .ok()
        .and_then(|text| serde_json::from_str::<SlotMeta>(&text).ok())
    else {
        return false;
    };
    let part = dir.join(format!("{}.part", meta.file));
    meta.state == "partial"
        && part.is_file()
        && now.saturating_sub(meta.updated) <= max_age.as_secs()
}

impl Slot {
    /// Where the finished artifact goes.
    pub fn file(&self) -> &Path {
        &self.file
    }

    pub fn dir(&self) -> &Path {
        &self.dir
    }

    fn write_meta(&self, state: &str) {
        let mut meta = self.meta.clone();
        meta.state = state.to_string();
        meta.updated = now_secs();
        if let Ok(text) = serde_json::to_string_pretty(&meta) {
            let _ = fs::write(self.dir.join(META), text);
        }
    }

    /// The artifact is complete and verified.
    pub fn mark_ready(&self) {
        self.write_meta("ready");
    }

    /// The download stopped: keep the `.part` (if any) so the next request resumes it; otherwise remove the folder.
    pub fn keep_for_resume(self) {
        let part = self.dir.join(format!("{}.part", self.meta.file));
        if part.is_file() {
            self.write_meta("partial");
        } else {
            self.remove();
        }
    }

    /// Removes the folder (after the artifact was handed over, or when nothing in it is useful).
    pub fn remove(self) {
        let dir = self.dir.clone();
        drop(self);
        if let Err(err) = fs::remove_dir_all(&dir) {
            if err.kind() != io::ErrorKind::NotFound {
                tracing::warn!(dir = %dir.display(), %err, "staging folder not removed");
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn part_of(slot: &Slot) -> PathBuf {
        slot.dir().join(format!("{}.part", slot.meta.file))
    }

    #[test]
    fn file_names_are_safe_and_never_empty() {
        assert_eq!(
            safe_file_name("https://files.x/p/requests-2.32.3-py3-none-any.whl#sha256=ab"),
            "requests-2.32.3-py3-none-any.whl"
        );
        assert_eq!(safe_file_name("https://x/a/..%2F..%2Fevil"), "2F..2Fevil");
        assert_eq!(safe_file_name("https://x/"), "artifact");
        assert_eq!(safe_file_name("https://x/..."), "artifact");
        assert_eq!(safe_file_name("https://x/a b<c>.tgz"), "abc.tgz");
    }

    #[test]
    fn a_slot_lives_under_its_provider_and_is_removed_when_done() {
        let tmp = tempfile::tempdir().expect("tmp");
        let staging = Staging::new(tmp.path().join("temp"));
        let slot = staging
            .slot(Provider::Pypi, "https://files.x/a.whl", "a.whl")
            .expect("slot");
        assert!(slot.dir().starts_with(tmp.path().join("temp").join("pypi")));
        fs::write(slot.file(), b"x").expect("write");
        let dir = slot.dir().to_path_buf();
        slot.remove();
        assert!(!dir.exists());
    }

    #[test]
    fn a_held_slot_cant_be_taken_twice_and_recovery_skips_it() {
        let tmp = tempfile::tempdir().expect("tmp");
        let staging = Staging::new(tmp.path());
        let held = staging
            .slot(Provider::Npm, "https://r/x.tgz", "x.tgz")
            .expect("slot");
        #[cfg(windows)]
        {
            let second = staging.slot(Provider::Npm, "https://r/x.tgz", "x.tgz");
            assert_eq!(
                second.err().map(|e| e.kind()),
                Some(io::ErrorKind::WouldBlock)
            );
            let report = staging.recover(now_secs(), PARTIAL_MAX_AGE);
            assert_eq!(report.in_use, 1);
            assert!(held.dir().exists());
        }
        held.remove();
    }

    #[test]
    fn recovery_keeps_young_partials_and_clears_everything_else() {
        let tmp = tempfile::tempdir().expect("tmp");
        let staging = Staging::new(tmp.path());
        // A partial download: kept.
        let partial = staging
            .slot(Provider::Pypi, "https://f/a.whl", "a.whl")
            .expect("slot");
        fs::write(part_of(&partial), b"half").expect("part");
        let partial_dir = partial.dir().to_path_buf();
        partial.keep_for_resume();
        // A finished artifact nobody picked up: removed.
        let done = staging
            .slot(Provider::Go, "https://g/m.zip", "m.zip")
            .expect("slot");
        fs::write(done.file(), b"zip").expect("file");
        done.mark_ready();
        let done_dir = done.dir().to_path_buf();
        drop(done);
        // A stopped download without data: nothing to keep.
        let empty = staging
            .slot(Provider::Npm, "https://r/e.tgz", "e.tgz")
            .expect("slot");
        let empty_dir = empty.dir().to_path_buf();
        empty.keep_for_resume();
        assert!(!empty_dir.exists(), "no .part: removed at once");

        let report = staging.recover(now_secs(), PARTIAL_MAX_AGE);
        assert_eq!(report.kept_partial, 1);
        assert_eq!(report.removed, 1);
        assert!(partial_dir.exists());
        assert!(!done_dir.exists());

        // An old partial is removed too.
        let later = now_secs() + PARTIAL_MAX_AGE.as_secs() + 60;
        let report = staging.recover(later, PARTIAL_MAX_AGE);
        assert_eq!(report.removed, 1);
        assert!(!partial_dir.exists());
    }

    #[test]
    fn recovery_leaves_unknown_folders_and_files_alone() {
        let tmp = tempfile::tempdir().expect("tmp");
        let staging = Staging::new(tmp.path());
        fs::create_dir_all(tmp.path().join("run-builds").join("x")).expect("dir");
        fs::write(tmp.path().join("pypi.txt"), b"keep").expect("file");
        let report = staging.recover(now_secs(), PARTIAL_MAX_AGE);
        assert_eq!(report, RecoveryReport::default());
        assert!(tmp.path().join("run-builds").join("x").exists());
        assert!(tmp.path().join("pypi.txt").exists());
    }

    #[cfg(windows)]
    #[test]
    fn recovery_never_follows_a_junction_out_of_the_staging_folder() {
        let tmp = tempfile::tempdir().expect("tmp");
        let outside = tmp.path().join("user project");
        fs::create_dir_all(&outside).expect("dir");
        fs::write(outside.join("main.py"), b"print(1)").expect("file");
        let staging = Staging::new(tmp.path().join("temp"));
        let base = staging.provider_dir(Provider::Pypi);
        fs::create_dir_all(&base).expect("base");
        let link = base.join("0123456789abcdef0123456789abcdef");
        let made = std::process::Command::new("cmd")
            .args(["/C", "mklink", "/J"])
            .arg(&link)
            .arg(&outside)
            .output()
            .map(|o| o.status.success())
            .unwrap_or(false);
        if !made {
            return; // junctions can't be made here
        }
        staging.recover(now_secs(), PARTIAL_MAX_AGE);
        assert!(outside.join("main.py").exists(), "the target is untouched");
        let _ = fs::remove_dir(&link);
    }
}
