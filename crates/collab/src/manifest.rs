//! The shared workspace manifest: what a participant's remote Explorer shows, and nothing more. Each entry names a
//! file or folder by its stable [`FileId`], its parent's id, its name and its workspace-relative path; sizes and
//! modification times are informational. The Owner's absolute folder is never part of it (only its display name).
//!
//! A manifest can be large, so it travels as pages that each fit one data channel message ([`paginate`]); later
//! changes travel as deltas against a version. [`RemoteTree`] is the participant's side: it assembles pages, applies
//! deltas in order and asks for a fresh manifest when a delta doesn't follow the version it has.

use std::collections::{BTreeMap, HashMap};

use serde::{Deserialize, Serialize};

use crate::error::{invalid, CollabError};
use crate::files::{FileKind, FileTable, RelPath};
use crate::ids::FileId;

/// Encoded size one manifest page or delta may reach (a data channel message must stay below 120 KB).
pub const PAGE_BYTES: usize = 96 * 1024;
/// Entries one page may list (a bound for receivers whatever the encoding).
pub const MAX_PAGE_ENTRIES: usize = 4096;
/// Pages one manifest may have (with [`crate::files::MAX_ENTRIES`] entries at least ~50 per page).
pub const MAX_PAGES: u32 = 8192;

const BINARY_EXTENSIONS: &[&str] = &[
    "png", "jpg", "jpeg", "gif", "bmp", "ico", "webp", "tif", "tiff", "psd", "pdf", "zip", "gz",
    "tgz", "7z", "rar", "xz", "bz2", "jar", "war", "exe", "dll", "so", "dylib", "lib", "a", "o",
    "obj", "pdb", "class", "pyc", "wasm", "mp3", "mp4", "wav", "ogg", "flac", "mov", "avi", "mkv",
    "webm", "ttf", "otf", "woff", "woff2", "eot", "sqlite", "db", "docx", "xlsx", "pptx", "bin",
];

/// One shared file or folder.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ManifestEntry {
    pub id: FileId,
    pub parent: Option<FileId>,
    pub name: String,
    pub path: RelPath,
    pub kind: FileKind,
    pub size: u64,
    pub modified_ms: i64,
    /// Guessed from the extension only (cheap); the transfer classifies the actual bytes.
    pub binary_hint: bool,
}

impl ManifestEntry {
    pub fn validate(&self) -> Result<(), CollabError> {
        if self.name != self.path.file_name() {
            return Err(invalid("manifest entry", "its name doesn't match its path"));
        }
        Ok(())
    }
}

/// One version of the Owner's manifest, shared between the network and the app without copying.
#[derive(Debug, Clone)]
pub struct ManifestSnapshot {
    pub version: u64,
    /// The shared folder's display name (never its path).
    pub root: String,
    pub entries: std::sync::Arc<BTreeMap<FileId, ManifestEntry>>,
}

/// Size and modification time of a file (folders have none).
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct FileStat {
    pub size: u64,
    pub modified_ms: i64,
}

pub fn binary_hint(name: &str) -> bool {
    let lower = name.to_ascii_lowercase();
    lower
        .rsplit_once('.')
        .is_some_and(|(_, ext)| BINARY_EXTENSIONS.contains(&ext))
}

fn parent_path(path: &RelPath) -> Option<RelPath> {
    path.as_str()
        .rsplit_once('/')
        .and_then(|(parent, _)| RelPath::parse(parent).ok())
}

/// The manifest entries of a table, keyed by id (files take their stats from `stats`, keyed by path key).
pub fn entries_of(
    table: &FileTable,
    stats: &HashMap<String, FileStat>,
) -> BTreeMap<FileId, ManifestEntry> {
    table
        .iter()
        .map(|(id, entry)| {
            let stat = stats.get(&entry.path.key()).copied().unwrap_or_default();
            let parent = parent_path(&entry.path).and_then(|p| table.id_of(&p).cloned());
            let name = entry.path.file_name().to_string();
            let manifest = ManifestEntry {
                id: id.clone(),
                parent,
                binary_hint: entry.kind == FileKind::File && binary_hint(&name),
                name,
                path: entry.path.clone(),
                kind: entry.kind,
                size: if entry.kind == FileKind::File {
                    stat.size
                } else {
                    0
                },
                modified_ms: stat.modified_ms,
            };
            (id.clone(), manifest)
        })
        .collect()
}

/// What changed between two manifests: entries added or different, and ids gone.
pub fn diff(
    old: &BTreeMap<FileId, ManifestEntry>,
    new: &BTreeMap<FileId, ManifestEntry>,
) -> (Vec<ManifestEntry>, Vec<FileId>) {
    let upserts = new
        .values()
        .filter(|entry| old.get(&entry.id) != Some(entry))
        .cloned()
        .collect();
    let removed = old
        .keys()
        .filter(|id| !new.contains_key(*id))
        .cloned()
        .collect();
    (upserts, removed)
}

fn encoded_len(entry: &ManifestEntry) -> usize {
    serde_json::to_vec(entry)
        .map(|v| v.len() + 1)
        .unwrap_or(PAGE_BYTES)
}

/// Splits entries into pages that each encode within [`PAGE_BYTES`] (parents before children). Always at least one
/// page, so an empty workspace still produces a manifest.
pub fn paginate(entries: &BTreeMap<FileId, ManifestEntry>) -> Vec<Vec<ManifestEntry>> {
    let mut ordered: Vec<&ManifestEntry> = entries.values().collect();
    ordered.sort_by(|a, b| {
        a.path
            .segments()
            .count()
            .cmp(&b.path.segments().count())
            .then(a.path.cmp(&b.path))
    });
    let mut pages = vec![Vec::new()];
    let mut size = 0;
    for entry in ordered {
        let len = encoded_len(entry);
        let current = pages.len() - 1;
        if !pages[current].is_empty()
            && (size + len > PAGE_BYTES || pages[current].len() >= MAX_PAGE_ENTRIES)
        {
            pages.push(Vec::new());
            size = 0;
        }
        size += len;
        if let Some(page) = pages.last_mut() {
            page.push(entry.clone());
        }
    }
    pages
}

/// Whether a delta fits one message; a larger one is sent as a reset (the participant fetches the manifest again).
pub fn delta_fits(upserts: &[ManifestEntry], removed: &[FileId]) -> bool {
    let size: usize = upserts.iter().map(encoded_len).sum::<usize>() + removed.len() * 36;
    size <= PAGE_BYTES && upserts.len() <= MAX_PAGE_ENTRIES && removed.len() <= MAX_PAGE_ENTRIES
}

struct Assembly {
    version: u64,
    pages: u32,
    received: BTreeMap<u32, Vec<ManifestEntry>>,
}

/// What a participant needs to do after a delta.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DeltaResult {
    Applied,
    /// The delta doesn't follow this tree's version: fetch the manifest again.
    Resync,
}

/// The participant's copy of the Owner's tree.
#[derive(Default)]
pub struct RemoteTree {
    version: u64,
    root: String,
    entries: BTreeMap<FileId, ManifestEntry>,
    ready: bool,
    assembly: Option<Assembly>,
}

impl RemoteTree {
    pub fn is_ready(&self) -> bool {
        self.ready
    }

    pub fn version(&self) -> u64 {
        self.version
    }

    pub fn root(&self) -> &str {
        &self.root
    }

    pub fn entries(&self) -> &BTreeMap<FileId, ManifestEntry> {
        &self.entries
    }

    pub fn get(&self, id: &FileId) -> Option<&ManifestEntry> {
        self.entries.get(id)
    }

    /// Adds one page; returns `true` once every page of that version arrived (the tree then switches to it).
    pub fn apply_page(
        &mut self,
        version: u64,
        page: u32,
        pages: u32,
        root: &str,
        entries: Vec<ManifestEntry>,
    ) -> Result<bool, CollabError> {
        if pages == 0 || pages > MAX_PAGES || page >= pages || entries.len() > MAX_PAGE_ENTRIES {
            return Err(invalid(
                "manifest page",
                "its page numbers or size are out of range",
            ));
        }
        for entry in &entries {
            entry.validate()?;
        }
        let assembly = match &mut self.assembly {
            Some(a) if a.version == version && a.pages == pages => a,
            _ => self.assembly.insert(Assembly {
                version,
                pages,
                received: BTreeMap::new(),
            }),
        };
        if assembly.received.insert(page, entries).is_some() {
            return Err(invalid("manifest page", "this page arrived twice"));
        }
        if assembly.received.len() as u32 != pages {
            return Ok(false);
        }
        let Some(done) = self.assembly.take() else {
            return Ok(false);
        };
        let all: BTreeMap<FileId, ManifestEntry> = done
            .received
            .into_values()
            .flatten()
            .map(|e| (e.id.clone(), e))
            .collect();
        if all.len() > crate::files::MAX_ENTRIES {
            return Err(invalid("manifest", "too many entries"));
        }
        self.entries = all;
        self.version = version;
        self.root = root.chars().take(255).collect();
        self.ready = true;
        Ok(true)
    }

    /// Applies a delta that follows `base`; anything else asks for a resync.
    pub fn apply_delta(
        &mut self,
        base: u64,
        version: u64,
        upserts: Vec<ManifestEntry>,
        removed: Vec<FileId>,
    ) -> Result<DeltaResult, CollabError> {
        if !self.ready || base != self.version || version <= base {
            self.ready = false;
            return Ok(DeltaResult::Resync);
        }
        for entry in &upserts {
            entry.validate()?;
        }
        for id in removed {
            self.entries.remove(&id);
        }
        for entry in upserts {
            self.entries.insert(entry.id.clone(), entry);
        }
        self.version = version;
        Ok(DeltaResult::Applied)
    }

    /// The Owner announced a new manifest (a burst too large for a delta): the copy is stale until refetched.
    pub fn invalidate(&mut self) {
        self.ready = false;
        self.assembly = None;
    }
}

#[cfg(test)]
#[path = "manifest_tests.rs"]
mod tests;
