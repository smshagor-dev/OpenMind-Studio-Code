//! The offline package cache: archives the user brings on a USB stick or from another computer, recognized, verified
//! and kept in the app's own folder (`cache/offline`). Nothing here downloads, runs a package or writes a package
//! manager's global cache.

use std::fs::{self, File};
use std::io::{Read, Write};
use std::path::{Component, Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum PackageKind {
    /// An archive a Runtime Manager manifest lists (matched by its SHA-256).
    Runtime,
    Vsix,
    Wheel,
    NpmPackage,
    ComposerPackage,
    /// A source ZIP (for example GitHub's "Download ZIP"), extracted to a folder instead of cloning.
    SourceArchive,
}

impl PackageKind {
    fn folder(self) -> &'static str {
        match self {
            PackageKind::Runtime => "runtimes",
            PackageKind::Vsix => "vsix",
            PackageKind::Wheel => "wheels",
            PackageKind::NpmPackage => "npm",
            PackageKind::ComposerPackage => "composer",
            PackageKind::SourceArchive => "source",
        }
    }
}

/// A runtime archive a manifest knows (supplied by the app from the Runtime Manager).
#[derive(Debug, Clone)]
pub struct KnownArtifact {
    pub runtime: String,
    pub display_name: String,
    pub version: String,
    pub platform: String,
    pub sha256: String,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Inspection {
    pub path: String,
    pub file_name: String,
    pub kind: Option<PackageKind>,
    pub name: String,
    pub version: Option<String>,
    pub architecture: Option<String>,
    pub compatible: bool,
    pub sha256: String,
    pub size: u64,
    /// Why it can't be imported (unknown type, other architecture ...).
    pub reason: Option<String>,
    /// For a runtime archive: the Runtime Manager kind and version it installs.
    pub runtime: Option<(String, String)>,
}

#[derive(Debug, thiserror::Error)]
pub enum OfflineError {
    #[error("{0}: {1}")]
    Io(String, std::io::Error),
    #[error("{0}")]
    Refused(String),
}

fn io(path: &Path, err: std::io::Error) -> OfflineError {
    OfflineError::Io(path.display().to_string(), err)
}

/// The largest file accepted (a runtime archive or an offline pack can be large).
pub const MAX_IMPORT_BYTES: u64 = 2 * 1024 * 1024 * 1024;

pub fn sha256_file(path: &Path) -> Result<(String, u64), OfflineError> {
    let mut file = File::open(path).map_err(|err| io(path, err))?;
    let mut hasher = Sha256::new();
    let mut buffer = vec![0u8; 64 * 1024];
    let mut size = 0u64;
    loop {
        let read = file.read(&mut buffer).map_err(|err| io(path, err))?;
        if read == 0 {
            break;
        }
        hasher.update(&buffer[..read]);
        size += read as u64;
    }
    let hex: String = hasher
        .finalize()
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect();
    Ok((hex, size))
}

/// Recognizes a file: its kind, name, version and architecture, and whether this computer can use it.
/// `platform` is the Runtime Manager's platform name (`windows-x64`).
pub fn inspect(
    path: &Path,
    known: &[KnownArtifact],
    platform: &str,
) -> Result<Inspection, OfflineError> {
    let meta = fs::metadata(path).map_err(|err| io(path, err))?;
    if !meta.is_file() {
        return Err(OfflineError::Refused("Only files can be imported.".into()));
    }
    if meta.len() > MAX_IMPORT_BYTES {
        return Err(OfflineError::Refused(
            "The file is larger than 2 GB.".into(),
        ));
    }
    let file_name = path
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_default();
    let (sha256, size) = sha256_file(path)?;
    let mut found = Inspection {
        path: path.display().to_string(),
        file_name: file_name.clone(),
        kind: None,
        name: file_name.clone(),
        version: None,
        architecture: None,
        compatible: false,
        sha256: sha256.clone(),
        size,
        reason: None,
        runtime: None,
    };
    if let Some(artifact) = known
        .iter()
        .find(|a| a.sha256.eq_ignore_ascii_case(&sha256))
    {
        found.kind = Some(PackageKind::Runtime);
        found.name = artifact.display_name.clone();
        found.version = Some(artifact.version.clone());
        found.architecture = Some(artifact.platform.clone());
        found.compatible = artifact.platform == platform;
        if !found.compatible {
            found.reason = Some(format!(
                "This archive is for {}, not {platform}.",
                artifact.platform
            ));
        }
        found.runtime = Some((artifact.runtime.clone(), artifact.version.clone()));
        return Ok(found);
    }
    let lower = file_name.to_ascii_lowercase();
    if lower.ends_with(".vsix") {
        inspect_vsix(path, &mut found, platform);
    } else if lower.ends_with(".whl") {
        inspect_wheel(&file_name, &mut found);
    } else if lower.ends_with(".tgz") {
        inspect_npm(&file_name, &mut found);
    } else if lower.ends_with(".zip") {
        inspect_zip(path, &mut found);
    } else {
        found.reason = Some(
            "Unknown package type. Supported: runtime archives listed by the Runtime Manager, .vsix, .whl, npm .tgz, Composer or source .zip."
                .into(),
        );
    }
    Ok(found)
}

fn read_zip_text(path: &Path, wanted: &dyn Fn(&str) -> bool, cap: u64) -> Option<(String, String)> {
    let file = File::open(path).ok()?;
    let mut archive = zip::ZipArchive::new(file).ok()?;
    for index in 0..archive.len().min(20_000) {
        let mut entry = archive.by_index(index).ok()?;
        let name = entry.name().to_string();
        if wanted(&name) && entry.size() <= cap {
            let mut text = String::new();
            entry.by_ref().take(cap).read_to_string(&mut text).ok()?;
            return Some((name, text));
        }
    }
    None
}

fn inspect_vsix(path: &Path, found: &mut Inspection, platform: &str) {
    let Some((_, manifest)) = read_zip_text(path, &|n| n == "extension/package.json", 1024 * 1024)
    else {
        found.reason = Some("This .vsix has no extension/package.json.".into());
        return;
    };
    let json: serde_json::Value = serde_json::from_str(&manifest).unwrap_or_default();
    let publisher = json["publisher"].as_str().unwrap_or("local");
    let name = json["name"].as_str().unwrap_or("unknown");
    found.kind = Some(PackageKind::Vsix);
    found.name = format!("{publisher}.{name}");
    found.version = json["version"].as_str().map(str::to_string);
    let target = read_zip_text(path, &|n| n == "extension.vsixmanifest", 1024 * 1024)
        .and_then(|(_, xml)| {
            let at = xml.find("TargetPlatform=\"")? + "TargetPlatform=\"".len();
            xml[at..].split('"').next().map(str::to_string)
        })
        .filter(|t| !t.is_empty());
    let wanted = if platform == "windows-x64" {
        "win32-x64"
    } else {
        "win32-ia32"
    };
    found.compatible = target
        .as_deref()
        .is_none_or(|t| t == wanted || t == "universal" || t == "web");
    if !found.compatible {
        found.reason = Some(format!(
            "This extension is built for {}.",
            target.as_deref().unwrap_or("?")
        ));
    }
    found.architecture = target.or_else(|| Some("universal".into()));
}

/// `name-version(-build)?-python-abi-platform.whl`
fn inspect_wheel(file_name: &str, found: &mut Inspection) {
    let stem = file_name.trim_end_matches(".whl");
    let parts: Vec<&str> = stem.split('-').collect();
    if parts.len() < 5 {
        found.reason = Some("This isn't a valid wheel file name.".into());
        return;
    }
    let platform = parts[parts.len() - 1].to_ascii_lowercase();
    found.kind = Some(PackageKind::Wheel);
    found.name = parts[0].to_string();
    found.version = Some(parts[1].to_string());
    found.architecture = Some(platform.clone());
    found.compatible = platform == "any" || platform.split('.').any(|p| p == "win_amd64");
    if !found.compatible {
        found.reason = Some(format!(
            "This wheel is for {platform}; Windows x64 needs win_amd64 or any."
        ));
    }
}

/// `name-1.2.3.tgz` (what `npm pack` writes).
fn inspect_npm(file_name: &str, found: &mut Inspection) {
    let stem = file_name.trim_end_matches(".tgz");
    let split = stem
        .char_indices()
        .rev()
        .find(|(i, c)| *c == '-' && stem[i + 1..].starts_with(|d: char| d.is_ascii_digit()))
        .map(|(i, _)| i);
    found.kind = Some(PackageKind::NpmPackage);
    found.compatible = true;
    found.architecture = Some("any".into());
    match split {
        Some(i) => {
            found.name = stem[..i].to_string();
            found.version = Some(stem[i + 1..].to_string());
        }
        None => found.name = stem.to_string(),
    }
}

fn inspect_zip(path: &Path, found: &mut Inspection) {
    let Ok(file) = File::open(path) else {
        found.reason = Some("The file can't be read.".into());
        return;
    };
    if zip::ZipArchive::new(file).is_err() {
        found.reason = Some("This isn't a valid ZIP archive.".into());
        return;
    }
    let composer = read_zip_text(
        path,
        &|n| n == "composer.json" || (n.ends_with("/composer.json") && n.matches('/').count() == 1),
        1024 * 1024,
    );
    found.compatible = true;
    found.architecture = Some("any".into());
    if let Some((_, text)) = composer {
        let json: serde_json::Value = serde_json::from_str(&text).unwrap_or_default();
        found.kind = Some(PackageKind::ComposerPackage);
        found.name = json["name"].as_str().unwrap_or(&found.name).to_string();
        found.version = json["version"].as_str().map(str::to_string);
    } else {
        found.kind = Some(PackageKind::SourceArchive);
        found.name = found.file_name.trim_end_matches(".zip").to_string();
    }
}

/// One imported package.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CacheEntry {
    pub id: String,
    pub kind: PackageKind,
    pub name: String,
    pub version: Option<String>,
    pub architecture: Option<String>,
    pub sha256: String,
    pub size: u64,
    /// Where the file is, relative to the app's `cache` folder.
    pub file: String,
    pub imported_at: u64,
    /// Always `localImport` for now (the UI shows "Local Import").
    pub source: String,
    pub runtime: Option<(String, String)>,
}

/// `cache/offline` and its `index.json`.
pub struct OfflineCache {
    cache_root: PathBuf,
}

impl OfflineCache {
    /// `cache_root` is the app's `cache` folder.
    pub fn new(cache_root: impl Into<PathBuf>) -> Self {
        OfflineCache {
            cache_root: cache_root.into(),
        }
    }

    pub fn folder(&self) -> PathBuf {
        self.cache_root.join("offline")
    }

    pub fn wheelhouse(&self) -> PathBuf {
        self.folder().join(PackageKind::Wheel.folder())
    }

    fn index_path(&self) -> PathBuf {
        self.folder().join("index.json")
    }

    /// The imported packages. A damaged index reads as empty (and is rewritten by the next import).
    pub fn list(&self) -> Vec<CacheEntry> {
        fs::read_to_string(self.index_path())
            .ok()
            .and_then(|text| serde_json::from_str(&text).ok())
            .unwrap_or_default()
    }

    fn save(&self, entries: &[CacheEntry]) -> Result<(), OfflineError> {
        let path = self.index_path();
        fs::create_dir_all(self.folder()).map_err(|err| io(&path, err))?;
        let temp = path.with_extension("json.tmp");
        let text = serde_json::to_string_pretty(entries)
            .map_err(|err| OfflineError::Refused(err.to_string()))?;
        fs::write(&temp, text).map_err(|err| io(&temp, err))?;
        fs::rename(&temp, &path).map_err(|err| io(&path, err))
    }

    /// Copies an inspected file into the cache (a runtime archive to `runtime_target`, where the Runtime Manager
    /// looks for it) and verifies the copy against the inspection's SHA-256. The source file is never changed.
    pub fn import(
        &self,
        inspection: &Inspection,
        runtime_target: Option<&Path>,
    ) -> Result<CacheEntry, OfflineError> {
        let kind = inspection.kind.ok_or_else(|| {
            OfflineError::Refused(
                inspection
                    .reason
                    .clone()
                    .unwrap_or_else(|| "Unknown package type.".into()),
            )
        })?;
        if !inspection.compatible {
            return Err(OfflineError::Refused(
                inspection
                    .reason
                    .clone()
                    .unwrap_or_else(|| "Not for this computer.".into()),
            ));
        }
        let safe_name: String = inspection
            .file_name
            .chars()
            .map(|c| {
                if c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | '_' | '+' | '@') {
                    c
                } else {
                    '_'
                }
            })
            .collect();
        let target = match (kind, runtime_target) {
            (PackageKind::Runtime, Some(target)) => target.to_path_buf(),
            (PackageKind::Runtime, None) => {
                return Err(OfflineError::Refused("No runtime target.".into()))
            }
            _ => self.folder().join(kind.folder()).join(&safe_name),
        };
        if !target.starts_with(&self.cache_root) {
            return Err(OfflineError::Refused(
                "The target is outside the app's cache folder.".into(),
            ));
        }
        if let Some(parent) = target.parent() {
            fs::create_dir_all(parent).map_err(|err| io(parent, err))?;
        }
        let partial = target.with_extension("importing");
        fs::copy(&inspection.path, &partial).map_err(|err| io(&partial, err))?;
        let (copied, _) = sha256_file(&partial)?;
        if copied != inspection.sha256 {
            let _ = fs::remove_file(&partial);
            return Err(OfflineError::Refused(
                "The file changed while it was copied; nothing was imported.".into(),
            ));
        }
        fs::rename(&partial, &target).map_err(|err| io(&target, err))?;
        let relative = target
            .strip_prefix(&self.cache_root)
            .map(|p| p.to_string_lossy().replace('\\', "/"))
            .unwrap_or_default();
        let entry = CacheEntry {
            id: inspection.sha256[..16].to_string(),
            kind,
            name: inspection.name.clone(),
            version: inspection.version.clone(),
            architecture: inspection.architecture.clone(),
            sha256: inspection.sha256.clone(),
            size: inspection.size,
            file: relative,
            imported_at: SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .map(|d| d.as_secs())
                .unwrap_or_default(),
            source: "localImport".into(),
            runtime: inspection.runtime.clone(),
        };
        let mut entries: Vec<CacheEntry> = self
            .list()
            .into_iter()
            .filter(|e| e.id != entry.id)
            .collect();
        entries.push(entry.clone());
        self.save(&entries)?;
        Ok(entry)
    }

    /// The absolute path of an entry's file (only inside the cache folder).
    pub fn path_of(&self, entry: &CacheEntry) -> Option<PathBuf> {
        let relative = Path::new(&entry.file);
        let safe = relative
            .components()
            .all(|c| matches!(c, Component::Normal(_)));
        safe.then(|| self.cache_root.join(relative))
    }

    /// Removes one package (its file and its index entry).
    pub fn remove(&self, id: &str) -> Result<(), OfflineError> {
        let entries = self.list();
        if let Some(entry) = entries.iter().find(|e| e.id == id) {
            if let Some(path) = self.path_of(entry) {
                let _ = fs::remove_file(path);
            }
        }
        self.save(
            &entries
                .into_iter()
                .filter(|e| e.id != id)
                .collect::<Vec<_>>(),
        )
    }

    /// Removes every imported package.
    pub fn clear(&self) -> Result<(), OfflineError> {
        for entry in self.list() {
            if let Some(path) = self.path_of(&entry) {
                let _ = fs::remove_file(path);
            }
        }
        self.save(&[])
    }
}

/// Extracts a source ZIP into `dest`, which must be missing or empty. Entry names are checked (no `..`, absolute or
/// drive paths), links are refused, at most 50 000 entries and 2 GB.
pub fn extract_source(archive: &Path, dest: &Path) -> Result<usize, OfflineError> {
    if dest.exists()
        && fs::read_dir(dest)
            .map_err(|err| io(dest, err))?
            .next()
            .is_some()
    {
        return Err(OfflineError::Refused(
            "The folder isn't empty; nothing was extracted.".into(),
        ));
    }
    let file = File::open(archive).map_err(|err| io(archive, err))?;
    let mut zip =
        zip::ZipArchive::new(file).map_err(|err| OfflineError::Refused(err.to_string()))?;
    if zip.len() > 50_000 {
        return Err(OfflineError::Refused(
            "The archive has too many entries.".into(),
        ));
    }
    let mut total = 0u64;
    let mut written = 0usize;
    for index in 0..zip.len() {
        let mut entry = zip
            .by_index(index)
            .map_err(|err| OfflineError::Refused(err.to_string()))?;
        if entry.is_symlink() {
            return Err(OfflineError::Refused(format!(
                "{} is a link; links are refused.",
                entry.name()
            )));
        }
        let Some(relative) = entry.enclosed_name() else {
            return Err(OfflineError::Refused(format!(
                "{} has an unsafe name.",
                entry.name()
            )));
        };
        if entry.name().contains(':') || entry.name().contains('\0') {
            return Err(OfflineError::Refused(format!(
                "{} has an unsafe name.",
                entry.name()
            )));
        }
        let out = dest.join(relative);
        if entry.is_dir() {
            fs::create_dir_all(&out).map_err(|err| io(&out, err))?;
            continue;
        }
        total += entry.size();
        if total > MAX_IMPORT_BYTES {
            return Err(OfflineError::Refused(
                "The archive expands to more than 2 GB.".into(),
            ));
        }
        if let Some(parent) = out.parent() {
            fs::create_dir_all(parent).map_err(|err| io(parent, err))?;
        }
        let mut target = File::create(&out).map_err(|err| io(&out, err))?;
        std::io::copy(&mut entry, &mut target).map_err(|err| io(&out, err))?;
        target.flush().map_err(|err| io(&out, err))?;
        written += 1;
    }
    Ok(written)
}

#[cfg(test)]
#[path = "offline_tests.rs"]
mod tests;
