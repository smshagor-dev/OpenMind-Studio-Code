use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Instant;

use serde::Serialize;

use crate::error::SearchError;
use crate::matcher::{find_matches, LineMatch};
use crate::query::{CompiledQuery, SearchQuery, ALWAYS_EXCLUDED_DIRS};

/// Files bigger than this are skipped (and counted): they're almost always
/// generated or data files, and reading them would stall the search.
pub const MAX_FILE_BYTES: u64 = 2 * 1024 * 1024;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileMatches {
    /// Absolute path, under the searched root by construction.
    pub path: String,
    /// Path relative to the root, with forward slashes.
    pub relative_path: String,
    pub matches: Vec<LineMatch>,
}

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchOutcome {
    pub files: Vec<FileMatches>,
    pub total_matches: usize,
    pub files_searched: usize,
    pub skipped_binary: usize,
    pub skipped_large: usize,
    /// Stopped early because `max_results` matches were found.
    pub truncated: bool,
    /// Stopped early because the search was cancelled (results so far are kept).
    pub cancelled: bool,
    pub duration_ms: u64,
}

/// Searches `query.root` for `query.text`. Never follows symbolic links (so
/// it can't leave the root or loop), skips the always-excluded folders,
/// binary files and huge files, and checks `cancel` between files and every
/// so many lines, so a cancelled search stops promptly.
pub fn search(query: &SearchQuery, cancel: &AtomicBool) -> Result<SearchOutcome, SearchError> {
    let root = query.root.as_path();
    if !root.is_dir() {
        return Err(SearchError::InvalidRoot(root.to_path_buf()));
    }
    let compiled = query.compile()?;
    let started = Instant::now();
    let mut outcome = SearchOutcome::default();
    let mut stack: Vec<PathBuf> = vec![root.to_path_buf()];

    'walk: while let Some(dir) = stack.pop() {
        let mut entries: Vec<_> = match fs::read_dir(&dir) {
            Ok(entries) => entries.filter_map(Result::ok).collect(),
            Err(err) => {
                tracing::debug!(dir = %dir.display(), %err, "skipping an unreadable folder");
                continue;
            }
        };
        entries.sort_by_key(fs::DirEntry::file_name);
        let mut subdirs = Vec::new();
        for entry in entries {
            if cancel.load(Ordering::Relaxed) {
                outcome.cancelled = true;
                break 'walk;
            }
            let Ok(kind) = entry.file_type() else {
                continue;
            };
            if kind.is_symlink() {
                continue;
            }
            let path = entry.path();
            let Some(relative) = relative_slash_path(root, &path) else {
                continue;
            };
            if kind.is_dir() {
                if !is_excluded_dir(&entry.file_name().to_string_lossy())
                    && !compiled.exclude.is_match(&relative)
                {
                    subdirs.push(path);
                }
            } else if kind.is_file() && wanted_file(&compiled, &relative) {
                search_file(&path, &relative, query, &compiled, cancel, &mut outcome);
                if outcome.truncated || outcome.cancelled {
                    break 'walk;
                }
            }
        }
        // Depth-first in name order: the stack pops the last pushed first.
        stack.extend(subdirs.into_iter().rev());
    }
    outcome.duration_ms = u64::try_from(started.elapsed().as_millis()).unwrap_or(u64::MAX);
    Ok(outcome)
}

fn is_excluded_dir(name: &str) -> bool {
    ALWAYS_EXCLUDED_DIRS
        .iter()
        .any(|excluded| name.eq_ignore_ascii_case(excluded))
}

fn wanted_file(compiled: &CompiledQuery, relative: &str) -> bool {
    !compiled.exclude.is_match(relative)
        && compiled
            .include
            .as_ref()
            .is_none_or(|include| include.is_match(relative))
}

fn relative_slash_path(root: &Path, path: &Path) -> Option<String> {
    let relative = path.strip_prefix(root).ok()?;
    Some(relative.to_string_lossy().replace('\\', "/"))
}

fn search_file(
    path: &Path,
    relative: &str,
    query: &SearchQuery,
    compiled: &CompiledQuery,
    cancel: &AtomicBool,
    outcome: &mut SearchOutcome,
) {
    let Ok(metadata) = fs::metadata(path) else {
        return;
    };
    if metadata.len() > MAX_FILE_BYTES {
        outcome.skipped_large += 1;
        return;
    }
    let Ok(bytes) = fs::read(path) else {
        return;
    };
    if openmind_fs::looks_binary(&bytes) && !is_utf16_text(&bytes) {
        outcome.skipped_binary += 1;
        return;
    }
    outcome.files_searched += 1;
    let decoded = openmind_fs::encoding::decode(&bytes);
    let budget = query.max_results.saturating_sub(outcome.total_matches);
    let mut matches = Vec::new();
    let hit_budget = find_matches(
        &decoded.text,
        &compiled.regex,
        budget,
        &|| cancel.load(Ordering::Relaxed),
        &mut matches,
    );
    outcome.total_matches += matches.len();
    if cancel.load(Ordering::Relaxed) {
        outcome.cancelled = true;
    }
    if hit_budget {
        outcome.truncated = true;
    }
    if !matches.is_empty() {
        outcome.files.push(FileMatches {
            path: path.to_string_lossy().into_owned(),
            relative_path: relative.to_string(),
            matches,
        });
    }
}

/// UTF-16 text is full of NUL bytes but isn't binary; its BOM says so.
fn is_utf16_text(bytes: &[u8]) -> bool {
    bytes.starts_with(&[0xFF, 0xFE]) || bytes.starts_with(&[0xFE, 0xFF])
}
