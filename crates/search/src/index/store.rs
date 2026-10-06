//! The index on disk: one SQLite file per workspace (WAL), holding file metadata, the text of indexed files, a
//! trigram full-text index over that text (substring search without reading the disk) and the symbols. The file
//! lives under the app's own `data/search-index/` folder, never in AppData and never inside the workspace.

use std::collections::HashMap;
use std::path::Path;

use rusqlite::{params, Connection, OptionalExtension};
use serde::Serialize;

use crate::error::SearchError;
use crate::index::symbols::Symbol;

/// Bumped when the tables change, or when what is read from a file changes (2: assembly symbols, `.asm`/`.nasm`/`.s`
/// files gained a language) — an index with another version is thrown away and rebuilt, so unchanged files are read
/// again.
const SCHEMA_VERSION: &str = "2";

/// What is stored about one file.
#[derive(Debug, Clone)]
pub struct FileRecord {
    /// Relative to the workspace, forward slashes.
    pub path: String,
    pub name: String,
    pub ext: String,
    pub size: u64,
    pub mtime_ms: i64,
    pub language: Option<String>,
    /// `ok` (text indexed), `binary`, `large`, `limit` (index size limit reached), `error`.
    pub status: String,
    pub error: Option<String>,
    pub content: Option<String>,
    pub symbols: Vec<Symbol>,
}

#[derive(Debug, Clone, Default, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct StoreStats {
    pub files: u64,
    pub indexed: u64,
    pub skipped: u64,
    pub errors: u64,
    pub symbols: u64,
    pub content_bytes: u64,
}

pub struct IndexStore {
    conn: Connection,
}

fn to_i64(value: u64) -> i64 {
    i64::try_from(value).unwrap_or(i64::MAX)
}

fn to_u64(value: i64) -> u64 {
    u64::try_from(value).unwrap_or(0)
}

const SCHEMA: &str = "
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS files (
    id INTEGER PRIMARY KEY,
    path TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL,
    ext TEXT NOT NULL,
    size INTEGER NOT NULL,
    mtime_ms INTEGER NOT NULL,
    language TEXT,
    status TEXT NOT NULL,
    error TEXT,
    content TEXT
);
CREATE TABLE IF NOT EXISTS symbols (
    id INTEGER PRIMARY KEY,
    file_id INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    kind TEXT NOT NULL,
    line INTEGER NOT NULL,
    col INTEGER NOT NULL,
    container TEXT
);
CREATE INDEX IF NOT EXISTS symbols_name ON symbols(name COLLATE NOCASE);
CREATE INDEX IF NOT EXISTS symbols_file ON symbols(file_id);
CREATE VIRTUAL TABLE IF NOT EXISTS fts USING fts5(content, content='files', content_rowid='id', tokenize='trigram');
";

impl IndexStore {
    /// Opens (creating it, and its folder) the index file. An index from another schema version is emptied.
    pub fn open(path: &Path) -> Result<Self, SearchError> {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).map_err(|err| SearchError::Index(err.to_string()))?;
        }
        let conn = Connection::open(path)?;
        conn.busy_timeout(std::time::Duration::from_secs(10))?;
        conn.pragma_update(None, "journal_mode", "WAL")?;
        conn.pragma_update(None, "synchronous", "NORMAL")?;
        conn.pragma_update(None, "foreign_keys", "ON")?;
        let mut store = Self { conn };
        store.conn.execute_batch(SCHEMA)?;
        if store.meta("schema")?.as_deref() != Some(SCHEMA_VERSION) {
            store.clear()?;
            store.set_meta("schema", SCHEMA_VERSION)?;
        }
        Ok(store)
    }

    pub fn meta(&self, key: &str) -> Result<Option<String>, SearchError> {
        Ok(self
            .conn
            .query_row("SELECT value FROM meta WHERE key = ?1", [key], |row| {
                row.get(0)
            })
            .optional()?)
    }

    pub fn set_meta(&self, key: &str, value: &str) -> Result<(), SearchError> {
        self.conn.execute(
            "INSERT INTO meta(key, value) VALUES (?1, ?2) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            params![key, value],
        )?;
        Ok(())
    }

    pub fn begin(&self) -> Result<(), SearchError> {
        self.conn.execute_batch("BEGIN")?;
        Ok(())
    }

    pub fn commit(&self) -> Result<(), SearchError> {
        self.conn.execute_batch("COMMIT")?;
        Ok(())
    }

    /// path -> (size, mtime_ms, status) of everything stored.
    pub fn known_files(&self) -> Result<HashMap<String, (u64, i64, String)>, SearchError> {
        let mut statement = self
            .conn
            .prepare("SELECT path, size, mtime_ms, status FROM files")?;
        let rows = statement.query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                (
                    to_u64(row.get(1)?),
                    row.get::<_, i64>(2)?,
                    row.get::<_, String>(3)?,
                ),
            ))
        })?;
        let mut map = HashMap::new();
        for row in rows {
            let (path, value) = row?;
            map.insert(path, value);
        }
        Ok(map)
    }

    fn delete_by_id(&self, id: i64, content: Option<&str>) -> Result<(), SearchError> {
        if let Some(text) = content {
            self.conn.execute(
                "INSERT INTO fts(fts, rowid, content) VALUES ('delete', ?1, ?2)",
                params![id, text],
            )?;
        }
        self.conn
            .execute("DELETE FROM symbols WHERE file_id = ?1", [id])?;
        self.conn.execute("DELETE FROM files WHERE id = ?1", [id])?;
        Ok(())
    }

    /// Removes one file (and its text, full-text entries and symbols).
    pub fn remove(&self, path: &str) -> Result<bool, SearchError> {
        let found: Option<(i64, Option<String>)> = self
            .conn
            .query_row(
                "SELECT id, content FROM files WHERE path = ?1",
                [path],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .optional()?;
        match found {
            Some((id, content)) => {
                self.delete_by_id(id, content.as_deref())?;
                Ok(true)
            }
            None => Ok(false),
        }
    }

    /// Removes a folder's files (`dir` itself if it was a file, and everything under `dir/`). Returns how many.
    pub fn remove_prefix(&self, dir: &str) -> Result<usize, SearchError> {
        let escaped = dir
            .replace('\\', "\\\\")
            .replace('%', "\\%")
            .replace('_', "\\_");
        let mut statement = self
            .conn
            .prepare("SELECT id, content FROM files WHERE path = ?1 OR path LIKE ?2 ESCAPE '\\'")?;
        let victims: Vec<(i64, Option<String>)> = statement
            .query_map(params![dir, format!("{escaped}/%")], |row| {
                Ok((row.get(0)?, row.get(1)?))
            })?
            .collect::<Result<_, _>>()?;
        for (id, content) in &victims {
            self.delete_by_id(*id, content.as_deref())?;
        }
        Ok(victims.len())
    }

    /// Inserts or replaces a file's record, text, full-text entry and symbols.
    pub fn upsert(&self, record: &FileRecord) -> Result<(), SearchError> {
        let existing: Option<(i64, Option<String>)> = self
            .conn
            .query_row(
                "SELECT id, content FROM files WHERE path = ?1",
                [&record.path],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .optional()?;
        let id = if let Some((id, old)) = existing {
            if let Some(text) = old {
                self.conn.execute(
                    "INSERT INTO fts(fts, rowid, content) VALUES ('delete', ?1, ?2)",
                    params![id, text],
                )?;
            }
            self.conn
                .execute("DELETE FROM symbols WHERE file_id = ?1", [id])?;
            self.conn.execute(
                "UPDATE files SET name=?2, ext=?3, size=?4, mtime_ms=?5, language=?6, status=?7, error=?8, content=?9 WHERE id=?1",
                params![
                    id,
                    record.name,
                    record.ext,
                    to_i64(record.size),
                    record.mtime_ms,
                    record.language,
                    record.status,
                    record.error,
                    record.content
                ],
            )?;
            id
        } else {
            self.conn.execute(
                "INSERT INTO files(path, name, ext, size, mtime_ms, language, status, error, content) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9)",
                params![
                    record.path,
                    record.name,
                    record.ext,
                    to_i64(record.size),
                    record.mtime_ms,
                    record.language,
                    record.status,
                    record.error,
                    record.content
                ],
            )?;
            self.conn.last_insert_rowid()
        };
        if let Some(text) = &record.content {
            self.conn.execute(
                "INSERT INTO fts(rowid, content) VALUES (?1, ?2)",
                params![id, text],
            )?;
        }
        let mut insert = self.conn.prepare_cached(
            "INSERT INTO symbols(file_id, name, kind, line, col, container) VALUES (?1,?2,?3,?4,?5,?6)",
        )?;
        for symbol in &record.symbols {
            insert.execute(params![
                id,
                symbol.name,
                symbol.kind,
                symbol.line,
                symbol.column,
                symbol.container
            ])?;
        }
        Ok(())
    }

    /// Empties the index (files, text, full-text entries, symbols); the settings signature is forgotten too.
    pub fn clear(&mut self) -> Result<(), SearchError> {
        self.conn.execute_batch(
            "DELETE FROM symbols; DELETE FROM files; INSERT INTO fts(fts) VALUES ('delete-all'); DELETE FROM meta WHERE key NOT IN ('schema','root');",
        )?;
        Ok(())
    }

    /// Gives disk space back after a clear.
    pub fn compact(&self) -> Result<(), SearchError> {
        self.conn
            .execute_batch("PRAGMA wal_checkpoint(TRUNCATE); VACUUM;")?;
        Ok(())
    }

    pub fn stats(&self) -> Result<StoreStats, SearchError> {
        let (files, indexed, skipped, errors, content_bytes): (i64, i64, i64, i64, i64) =
            self.conn.query_row(
                "SELECT COUNT(*), COALESCE(SUM(status='ok'),0), COALESCE(SUM(status IN ('binary','large','limit')),0), COALESCE(SUM(status='error'),0), COALESCE(SUM(LENGTH(content)),0) FROM files",
                [],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?, row.get(4)?)),
            )?;
        let symbols: i64 = self
            .conn
            .query_row("SELECT COUNT(*) FROM symbols", [], |row| row.get(0))?;
        Ok(StoreStats {
            files: to_u64(files),
            indexed: to_u64(indexed),
            skipped: to_u64(skipped),
            errors: to_u64(errors),
            symbols: to_u64(symbols),
            content_bytes: to_u64(content_bytes),
        })
    }

    pub(crate) fn conn(&self) -> &Connection {
        &self.conn
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    pub(crate) fn record(path: &str, content: Option<&str>) -> FileRecord {
        FileRecord {
            path: path.into(),
            name: path.rsplit('/').next().unwrap_or(path).into(),
            ext: path.rsplit('.').next().unwrap_or("").into(),
            size: content.map_or(0, |c| c.len() as u64),
            mtime_ms: 1,
            language: None,
            status: "ok".into(),
            error: None,
            content: content.map(str::to_string),
            symbols: Vec::new(),
        }
    }

    #[test]
    fn add_update_remove_and_the_full_text_index_follows() {
        let dir = tempfile::tempdir().expect("tempdir");
        let store = IndexStore::open(&dir.path().join("i.sqlite")).expect("open");
        store
            .upsert(&record("src/a.ts", Some("hello world")))
            .expect("add");
        store
            .upsert(&record("src/b.ts", Some("other text")))
            .expect("add");
        let hits = |needle: &str| -> Vec<i64> {
            let mut s = store
                .conn()
                .prepare("SELECT rowid FROM fts WHERE fts MATCH ?1 ORDER BY rowid")
                .expect("prepare");
            s.query_map([format!("\"{needle}\"")], |r| r.get(0))
                .expect("query")
                .collect::<Result<_, _>>()
                .expect("rows")
        };
        assert_eq!(hits("hello").len(), 1);
        // A substring, not only a whole word, is found (trigram index), whatever its case.
        assert_eq!(hits("ELL").len(), 1);
        store
            .upsert(&record("src/a.ts", Some("changed body")))
            .expect("update");
        assert!(hits("hello").is_empty());
        assert_eq!(hits("changed").len(), 1);
        assert_eq!(store.stats().expect("stats").files, 2);
        assert!(store.remove("src/a.ts").expect("remove"));
        assert!(!store.remove("src/a.ts").expect("again"));
        assert!(hits("changed").is_empty());
        assert_eq!(store.remove_prefix("src").expect("prefix"), 1);
        assert_eq!(store.stats().expect("stats").files, 0);
    }

    #[test]
    fn a_folder_removal_only_takes_that_folder_and_treats_wildcards_literally() {
        let dir = tempfile::tempdir().expect("tempdir");
        let store = IndexStore::open(&dir.path().join("i.sqlite")).expect("open");
        for path in ["a/x.ts", "a/b/y.ts", "ab/z.ts", "a_b/w.ts", "a%/v.ts"] {
            store.upsert(&record(path, Some("t"))).expect("add");
        }
        assert_eq!(store.remove_prefix("a").expect("prefix"), 2);
        let left = store.known_files().expect("known");
        assert_eq!(left.len(), 3);
        assert!(
            left.contains_key("ab/z.ts")
                && left.contains_key("a_b/w.ts")
                && left.contains_key("a%/v.ts")
        );
        assert_eq!(store.remove_prefix("a_b").expect("underscore"), 1);
        assert_eq!(store.remove_prefix("a%").expect("percent"), 1);
    }

    #[test]
    fn persistence_clear_and_a_schema_change_reset() {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path().join("i.sqlite");
        {
            let mut store = IndexStore::open(&path).expect("open");
            store.upsert(&record("a.md", Some("kept"))).expect("add");
            store.set_meta("last", "1").expect("meta");
            assert_eq!(store.stats().expect("s").files, 1);
            drop(store.stats());
            let _ = &mut store;
        }
        let mut store = IndexStore::open(&path).expect("reopen");
        assert_eq!(store.stats().expect("s").files, 1);
        assert_eq!(store.meta("last").expect("m").as_deref(), Some("1"));
        store.clear().expect("clear");
        store.compact().expect("compact");
        assert_eq!(store.stats().expect("s").files, 0);
        assert_eq!(store.meta("last").expect("m"), None);
        store.set_meta("schema", "0").expect("old version");
        drop(store);
        let store = IndexStore::open(&path).expect("reopen again");
        assert_eq!(
            store.meta("schema").expect("m").as_deref(),
            Some(SCHEMA_VERSION)
        );
    }
}
