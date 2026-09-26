//! Questions the index answers without touching the workspace on disk: file names, text, symbols.

use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Instant;

use globset::GlobBuilder;
use serde::Serialize;

use crate::error::SearchError;
use crate::index::store::IndexStore;
use crate::matcher::find_matches;
use crate::query::SearchQuery;
use crate::walk::{FileMatches, SearchOutcome};

/// Most file-name hits returned.
pub const MAX_FILE_HITS: usize = 200;
/// Most symbol hits returned.
pub const MAX_SYMBOL_HITS: usize = 300;

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct FileHit {
    /// Absolute path under the workspace.
    pub path: String,
    pub relative_path: String,
    pub name: String,
    pub score: i32,
    /// Character ranges `[start, end)` of `relative_path` that matched, for highlighting.
    pub highlights: Vec<[u32; 2]>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SymbolHit {
    pub name: String,
    pub kind: String,
    pub line: u32,
    pub column: u32,
    pub container: Option<String>,
    pub path: String,
    pub relative_path: String,
    pub language: Option<String>,
    pub score: i32,
}

fn absolute(root: &Path, relative: &str) -> String {
    root.join(relative).to_string_lossy().into_owned()
}

fn utf16_index(text: &str, char_index: usize) -> u32 {
    u32::try_from(char_index.min(text.chars().count())).unwrap_or(u32::MAX)
}

/// A case-insensitive subsequence match: every query character in order. Returns a score (consecutive characters and
/// word starts score higher) and the matched character positions.
pub fn fuzzy(query: &[char], text: &str) -> Option<(i32, Vec<u32>)> {
    if query.is_empty() {
        return None;
    }
    let chars: Vec<char> = text.chars().collect();
    let mut positions = Vec::with_capacity(query.len());
    let mut score = 0;
    let mut from = 0;
    let mut previous: Option<usize> = None;
    for wanted in query {
        let index =
            (from..chars.len()).find(|i| chars[*i].to_lowercase().eq(wanted.to_lowercase()))?;
        score += 10;
        if previous.is_some_and(|p| p + 1 == index) {
            score += 15;
        }
        let boundary = index == 0
            || matches!(chars[index - 1], '/' | '_' | '-' | '.' | ' ')
            || (chars[index].is_uppercase() && chars[index - 1].is_lowercase());
        if boundary {
            score += 12;
        }
        positions.push(u32::try_from(index).unwrap_or(u32::MAX));
        previous = Some(index);
        from = index + 1;
    }
    // A tighter match beats a scattered one.
    let span = positions
        .last()
        .zip(positions.first())
        .map_or(0, |(last, first)| i32::try_from(last - first).unwrap_or(0));
    Some((score - span, positions))
}

fn ranges(positions: &[u32]) -> Vec<[u32; 2]> {
    let mut out: Vec<[u32; 2]> = Vec::new();
    for &position in positions {
        match out.last_mut() {
            Some(last) if last[1] == position => last[1] = position + 1,
            _ => out.push([position, position + 1]),
        }
    }
    out
}

fn score_file(
    query_lc: &str,
    query_chars: &[char],
    relative: &str,
    name: &str,
) -> Option<(i32, Vec<[u32; 2]>)> {
    let path_lc = relative.to_lowercase();
    let name_lc = name.to_lowercase();
    let name_offset = relative.chars().count() - name.chars().count();
    let offset = u32::try_from(name_offset).unwrap_or(0);
    if name_lc == query_lc {
        let end = offset + u32::try_from(name.chars().count()).unwrap_or(0);
        return Some((1000, vec![[offset, end]]));
    }
    if let Some(at) = name_lc.find(query_lc) {
        let start = offset + utf16_index(&name_lc, name_lc[..at].chars().count());
        let end = start + u32::try_from(query_lc.chars().count()).unwrap_or(0);
        let bonus = if at == 0 { 100 } else { 0 };
        return Some((
            800 + bonus - i32::try_from(at).unwrap_or(0),
            vec![[start, end]],
        ));
    }
    if let Some(at) = path_lc.find(query_lc) {
        let start = utf16_index(&path_lc, path_lc[..at].chars().count());
        let end = start + u32::try_from(query_lc.chars().count()).unwrap_or(0);
        return Some((600 - i32::try_from(at / 4).unwrap_or(0), vec![[start, end]]));
    }
    if let Some((score, positions)) = fuzzy(query_chars, name) {
        let shifted: Vec<u32> = positions.iter().map(|p| p + offset).collect();
        return Some((300 + score, ranges(&shifted)));
    }
    fuzzy(query_chars, relative).map(|(score, positions)| (100 + score, ranges(&positions)))
}

/// File-name / path search. `*` and `?` make the text a glob (`*.php`, `routes/*.ts`); otherwise it matches the
/// name or path by exact name, prefix, substring, then fuzzy (letters in order), best first.
pub fn search_files(
    store: &IndexStore,
    root: &Path,
    text: &str,
    extension: Option<&str>,
    limit: usize,
) -> Result<Vec<FileHit>, SearchError> {
    let query = text.trim().replace('\\', "/");
    let limit = limit.clamp(1, MAX_FILE_HITS);
    let mut statement = store
        .conn()
        .prepare("SELECT path, name, ext FROM files ORDER BY path")?;
    let rows = statement.query_map([], |row| {
        Ok((
            row.get::<_, String>(0)?,
            row.get::<_, String>(1)?,
            row.get::<_, String>(2)?,
        ))
    })?;
    let wanted_ext = extension.map(|e| e.trim_start_matches('.').to_lowercase());
    let glob = if query.contains('*') || query.contains('?') {
        let pattern = if query.contains('/') {
            query.clone()
        } else {
            format!("**/{query}")
        };
        Some(
            GlobBuilder::new(&pattern)
                .case_insensitive(true)
                .build()
                .map_err(|err| SearchError::InvalidGlob {
                    pattern: query.clone(),
                    reason: err.kind().to_string(),
                })?
                .compile_matcher(),
        )
    } else {
        None
    };
    let query_lc = query.to_lowercase();
    let query_chars: Vec<char> = query_lc.chars().collect();
    let mut hits: Vec<FileHit> = Vec::new();
    for row in rows {
        let (path, name, ext) = row?;
        if let Some(wanted) = &wanted_ext {
            if ext.to_lowercase() != *wanted {
                continue;
            }
        }
        let scored = if let Some(matcher) = &glob {
            matcher.is_match(&path).then(|| {
                (
                    500 - i32::try_from(path.len()).unwrap_or(0).min(400),
                    Vec::new(),
                )
            })
        } else if query.is_empty() {
            Some((0, Vec::new()))
        } else {
            score_file(&query_lc, &query_chars, &path, &name)
        };
        if let Some((score, highlights)) = scored {
            hits.push(FileHit {
                path: absolute(root, &path),
                relative_path: path,
                name,
                score,
                highlights,
            });
        }
    }
    hits.sort_by(|a, b| {
        b.score
            .cmp(&a.score)
            .then(a.relative_path.len().cmp(&b.relative_path.len()))
            .then(a.relative_path.cmp(&b.relative_path))
    });
    hits.truncate(limit);
    Ok(hits)
}

/// The FTS5 phrase for a literal: quotes doubled, so it can't be read as query syntax.
fn phrase(literal: &str) -> String {
    format!("\"{}\"", literal.replace('"', "\"\""))
}

/// Full-text search over the indexed text. A plain query of at least three characters is answered from the trigram
/// index first (only files that contain it are read); a regex or a shorter query looks at every indexed file. The
/// same query type, matching and result shape as the disk search, so the results panel doesn't care which ran.
pub fn search_text(
    store: &IndexStore,
    root: &Path,
    query: &SearchQuery,
    cancel: &AtomicBool,
) -> Result<SearchOutcome, SearchError> {
    let compiled = query.compile()?;
    let started = Instant::now();
    let mut outcome = SearchOutcome::default();
    let use_fts = !query.use_regex && query.text.chars().count() >= 3 && !query.text.contains('\n');
    let sql = if use_fts {
        "SELECT f.path, f.content FROM fts JOIN files f ON f.id = fts.rowid WHERE fts MATCH ?1 ORDER BY f.path"
    } else {
        "SELECT path, content FROM files WHERE status = 'ok' ORDER BY path"
    };
    let mut statement = store.conn().prepare(sql)?;
    let mut rows = if use_fts {
        statement.query([phrase(&query.text)])?
    } else {
        statement.query([])?
    };
    while let Some(row) = rows.next()? {
        if cancel.load(Ordering::Relaxed) {
            outcome.cancelled = true;
            break;
        }
        let relative: String = row.get(0)?;
        let Some(content): Option<String> = row.get(1)? else {
            continue;
        };
        let wanted = !compiled.exclude.is_match(&relative)
            && compiled
                .include
                .as_ref()
                .is_none_or(|include| include.is_match(&relative));
        if !wanted {
            continue;
        }
        outcome.files_searched += 1;
        let budget = query.max_results.saturating_sub(outcome.total_matches);
        let mut matches = Vec::new();
        let hit_budget = find_matches(
            &content,
            &compiled.regex,
            budget,
            &|| cancel.load(Ordering::Relaxed),
            &mut matches,
        );
        outcome.total_matches += matches.len();
        if !matches.is_empty() {
            outcome.files.push(FileMatches {
                path: absolute(root, &relative),
                relative_path: relative,
                matches,
            });
        }
        if hit_budget {
            outcome.truncated = true;
            break;
        }
    }
    drop(rows);
    let (binary, large): (i64, i64) = store.conn().query_row(
        "SELECT COALESCE(SUM(status='binary'),0), COALESCE(SUM(status IN ('large','limit')),0) FROM files",
        [],
        |r| Ok((r.get(0)?, r.get(1)?)),
    )?;
    outcome.skipped_binary = usize::try_from(binary).unwrap_or(0);
    outcome.skipped_large = usize::try_from(large).unwrap_or(0);
    outcome.duration_ms = u64::try_from(started.elapsed().as_millis()).unwrap_or(u64::MAX);
    Ok(outcome)
}

fn symbol_score(query_lc: &str, name: &str) -> Option<i32> {
    let name_lc = name.to_lowercase();
    if query_lc.is_empty() {
        return Some(0);
    }
    if name_lc == query_lc {
        return Some(1000);
    }
    if name_lc.starts_with(query_lc) {
        return Some(800 - i32::try_from(name.len()).unwrap_or(0).min(100));
    }
    if let Some(at) = name_lc.find(query_lc) {
        return Some(500 - i32::try_from(at).unwrap_or(0));
    }
    let chars: Vec<char> = query_lc.chars().collect();
    fuzzy(&chars, name).map(|(score, _)| 100 + score)
}

/// Symbols of the whole workspace matching `text` (empty text lists the first ones), best first; `kind` narrows.
pub fn search_symbols(
    store: &IndexStore,
    root: &Path,
    text: &str,
    kind: Option<&str>,
    limit: usize,
) -> Result<Vec<SymbolHit>, SearchError> {
    let limit = limit.clamp(1, MAX_SYMBOL_HITS);
    let query_lc = text.trim().to_lowercase();
    let mut statement = store.conn().prepare(
        "SELECT s.name, s.kind, s.line, s.col, s.container, f.path, f.language
         FROM symbols s JOIN files f ON f.id = s.file_id
         WHERE (?1 IS NULL OR s.kind = ?1) ORDER BY f.path, s.line",
    )?;
    let rows = statement.query_map([kind], |row| {
        Ok(SymbolHit {
            name: row.get(0)?,
            kind: row.get(1)?,
            line: row.get(2)?,
            column: row.get(3)?,
            container: row.get(4)?,
            relative_path: row.get(5)?,
            language: row.get(6)?,
            path: String::new(),
            score: 0,
        })
    })?;
    let mut hits = Vec::new();
    for row in rows {
        let mut hit = row?;
        if let Some(score) = symbol_score(&query_lc, &hit.name) {
            hit.score = score;
            hit.path = absolute(root, &hit.relative_path);
            hits.push(hit);
        }
    }
    hits.sort_by(|a, b| {
        b.score
            .cmp(&a.score)
            .then(a.name.len().cmp(&b.name.len()))
            .then(a.relative_path.cmp(&b.relative_path))
            .then(a.line.cmp(&b.line))
    });
    hits.truncate(limit);
    Ok(hits)
}

/// Every symbol of one file (by relative path), in source order.
pub fn file_symbols(
    store: &IndexStore,
    root: &Path,
    relative: &str,
) -> Result<Vec<SymbolHit>, SearchError> {
    let mut statement = store.conn().prepare(
        "SELECT s.name, s.kind, s.line, s.col, s.container, f.path, f.language
         FROM symbols s JOIN files f ON f.id = s.file_id WHERE f.path = ?1 ORDER BY s.line, s.col",
    )?;
    let rows = statement.query_map([relative], |row| {
        Ok(SymbolHit {
            name: row.get(0)?,
            kind: row.get(1)?,
            line: row.get(2)?,
            column: row.get(3)?,
            container: row.get(4)?,
            relative_path: row.get(5)?,
            language: row.get(6)?,
            path: absolute(root, relative),
            score: 0,
        })
    })?;
    Ok(rows.collect::<Result<_, _>>()?)
}
