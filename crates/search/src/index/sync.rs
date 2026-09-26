//! Bringing the index in line with the workspace: a full incremental pass (only new or changed files are read) and
//! single-file updates for the file watcher and saves.

use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use ignore::gitignore::{Gitignore, GitignoreBuilder};

use crate::error::SearchError;
use crate::index::crawl::{
    crawl, is_excluded_dir_name, mtime_ms, relative_inside, slash_relative, CrawlEntry,
};
use crate::index::settings::IndexSettings;
use crate::index::store::{FileRecord, IndexStore};
use crate::index::symbols::extract;
use crate::index::text::{classify, language_of, Content};
use crate::query::build_globs;

/// How often progress is reported.
const PROGRESS_EVERY: Duration = Duration::from_millis(200);
/// Files written per transaction (queries can run between batches).
const BATCH: usize = 100;

#[derive(Debug, Clone, Copy, Default)]
pub struct Progress {
    pub discovered: usize,
    pub processed: usize,
    pub changed: usize,
    pub removed: usize,
}

#[derive(Debug, Clone, Copy, Default)]
pub struct SyncSummary {
    pub progress: Progress,
    pub unreadable: usize,
    pub cancelled: bool,
}

fn record_for(entry: &CrawlEntry, settings: &IndexSettings, indexed_bytes: &mut u64) -> FileRecord {
    let name = entry
        .rel
        .rsplit('/')
        .next()
        .unwrap_or(&entry.rel)
        .to_string();
    let ext = name
        .rsplit_once('.')
        .map_or(String::new(), |(_, ext)| ext.to_string());
    let language = language_of(&ext).map(str::to_string);
    let mut record = FileRecord {
        path: entry.rel.clone(),
        name,
        ext,
        size: entry.size,
        mtime_ms: entry.mtime_ms,
        language: language.clone(),
        status: "ok".into(),
        error: None,
        content: None,
        symbols: Vec::new(),
    };
    if entry.size > settings.max_file_bytes {
        record.status = "large".into();
        return record;
    }
    if indexed_bytes.saturating_add(entry.size) > settings.max_total_bytes {
        record.status = "limit".into();
        return record;
    }
    let bytes = match std::fs::read(&entry.abs) {
        Ok(bytes) => bytes,
        Err(err) => {
            record.status = "error".into();
            record.error = Some(err.to_string());
            return record;
        }
    };
    if u64::try_from(bytes.len()).unwrap_or(u64::MAX) > settings.max_file_bytes {
        record.status = "large".into();
        return record;
    }
    match classify(&bytes) {
        Content::Binary => record.status = "binary".into(),
        Content::Text(text) => {
            *indexed_bytes += u64::try_from(text.len()).unwrap_or(0);
            if let Some(language) = &language {
                record.symbols = extract(language, &text);
            }
            record.content = Some(text);
        }
    }
    record
}

/// One full pass: files that vanished are removed, new or changed ones (size or modification time, or every file
/// when the settings changed) are read and indexed, the rest is left alone. Writes happen in short batches under
/// `write_lock`, so searches and single-file updates are never blocked for long. Stops promptly when `cancel` is set.
pub fn sync_workspace(
    root: &Path,
    store: &IndexStore,
    settings: &IndexSettings,
    cancel: &AtomicBool,
    write_lock: &Mutex<()>,
    report: &mut dyn FnMut(Progress),
) -> Result<SyncSummary, SearchError> {
    let mut entries: Vec<CrawlEntry> = Vec::new();
    let mut progress = Progress::default();
    let mut last_report = Instant::now();
    let crawled = crawl(root, settings, cancel, &mut |entry| {
        entries.push(entry);
        progress.discovered += 1;
        if last_report.elapsed() >= PROGRESS_EVERY {
            last_report = Instant::now();
            report(progress);
        }
    })?;
    let mut summary = SyncSummary {
        progress,
        unreadable: crawled.unreadable,
        cancelled: cancel.load(Ordering::Relaxed),
    };
    if summary.cancelled {
        return Ok(summary);
    }
    let signature = settings.signature();
    let same_settings = store.meta("settings")?.as_deref() == Some(signature.as_str());
    let known = store.known_files()?;
    let present: std::collections::HashSet<&str> = entries.iter().map(|e| e.rel.as_str()).collect();
    {
        let _guard = write_lock
            .lock()
            .map_err(|_| SearchError::Index("index lock poisoned".into()))?;
        store.begin()?;
        for path in known.keys().filter(|p| !present.contains(p.as_str())) {
            store.remove(path)?;
            summary.progress.removed += 1;
        }
        store.commit()?;
    }
    let mut indexed_bytes = store.stats()?.content_bytes;
    for batch in entries.chunks(BATCH) {
        if cancel.load(Ordering::Relaxed) {
            summary.cancelled = true;
            break;
        }
        let _guard = write_lock
            .lock()
            .map_err(|_| SearchError::Index("index lock poisoned".into()))?;
        store.begin()?;
        for entry in batch {
            let unchanged = same_settings
                && known.get(&entry.rel).is_some_and(|(size, mtime, _)| {
                    *size == entry.size && *mtime == entry.mtime_ms
                });
            if !unchanged {
                store.upsert(&record_for(entry, settings, &mut indexed_bytes))?;
                summary.progress.changed += 1;
            }
            summary.progress.processed += 1;
        }
        store.commit()?;
        if last_report.elapsed() >= PROGRESS_EVERY {
            last_report = Instant::now();
            report(summary.progress);
        }
    }
    if !summary.cancelled {
        store.set_meta("settings", &signature)?;
        store.set_meta("last_indexed_ms", &now_ms().to_string())?;
    }
    Ok(summary)
}

pub fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |d| i64::try_from(d.as_millis()).unwrap_or(0))
}

fn ignore_matcher(root: &Path, settings: &IndexSettings) -> Gitignore {
    let mut builder = GitignoreBuilder::new(root);
    if settings.use_gitignore {
        let _ = builder.add(root.join(".gitignore"));
    }
    let _ = builder.add(root.join(".openmindignore"));
    builder.build().unwrap_or_else(|_| Gitignore::empty())
}

/// Whether one file belongs in the index under the current settings (the same rules as the crawl, except that only
/// the root's own ignore files are consulted — nested `.gitignore` files are honoured by the full pass only).
pub fn should_index(
    root: &Path,
    relative: &str,
    settings: &IndexSettings,
) -> Result<bool, SearchError> {
    let parts: Vec<&str> = relative.split('/').collect();
    let (dirs, _) = parts.split_at(parts.len().saturating_sub(1));
    if dirs.iter().any(|d| is_excluded_dir_name(d)) {
        return Ok(false);
    }
    if !settings.index_hidden && parts.iter().any(|p| p.starts_with('.')) {
        return Ok(false);
    }
    if build_globs(&settings.exclude)?.is_match(relative) {
        return Ok(false);
    }
    Ok(!ignore_matcher(root, settings)
        .matched_path_or_any_parents(root.join(relative), false)
        .is_ignore())
}

/// What happened to a path, as the file watcher or a save reports it.
#[derive(Debug, Clone)]
pub struct Change {
    pub path: std::path::PathBuf,
}

/// Applies watcher/save changes: a path that no longer exists is removed (a folder takes everything under it with
/// it); an existing file is (re)indexed when it belongs in the index; a changed folder asks for a full pass (returned
/// `true`), because a moved folder brings many files at once. Paths outside the workspace are refused.
pub fn apply_changes(
    root: &Path,
    store: &IndexStore,
    settings: &IndexSettings,
    changes: &[Change],
    write_lock: &Mutex<()>,
) -> Result<bool, SearchError> {
    let mut need_full_pass = false;
    let _guard = write_lock
        .lock()
        .map_err(|_| SearchError::Index("index lock poisoned".into()))?;
    let mut indexed_bytes = store.stats()?.content_bytes;
    store.begin()?;
    for change in changes {
        let relative = match relative_inside(root, &change.path) {
            Ok(relative) => relative,
            Err(err) => {
                store.commit()?;
                return Err(err);
            }
        };
        let Ok(metadata) = std::fs::symlink_metadata(&change.path) else {
            store.remove(&relative)?;
            store.remove_prefix(&relative)?;
            continue;
        };
        if metadata.file_type().is_symlink() {
            continue;
        }
        if metadata.is_dir() {
            need_full_pass = true;
            continue;
        }
        if !metadata.is_file() {
            continue;
        }
        if !should_index(root, &relative, settings)? {
            store.remove(&relative)?;
            continue;
        }
        let entry = CrawlEntry {
            rel: slash_relative(root, &change.path).unwrap_or(relative),
            abs: change.path.clone(),
            size: metadata.len(),
            mtime_ms: mtime_ms(&metadata),
        };
        store.upsert(&record_for(&entry, settings, &mut indexed_bytes))?;
    }
    store.commit()?;
    Ok(need_full_pass)
}
