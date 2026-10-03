use sqlx::SqlitePool;

use crate::error::DbError;

/// A single entry in the global (not yet project-scoped) recent-files list.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RecentFileEntry {
    pub path: String,
    pub opened_at: String,
}

/// Repository for the `recent_files` table. Milestone 2 has no
/// project/workspace concept yet, so every row is inserted with
/// `project_id = NULL` — the global recent-files list. Because SQLite
/// treats `NULL <> NULL` for uniqueness purposes, the table's
/// `UNIQUE(project_id, path)` constraint does not dedupe NULL-project rows,
/// so `touch` does its own find-or-insert instead of relying on it.
pub struct RecentFilesRepository<'a> {
    pool: &'a SqlitePool,
}

impl<'a> RecentFilesRepository<'a> {
    pub fn new(pool: &'a SqlitePool) -> Self {
        Self { pool }
    }

    /// Record `path` as just opened, bumping it to the front of the list if
    /// already present rather than creating a duplicate entry.
    ///
    /// "Most recent" ordering is by row id (delete + reinsert on re-touch),
    /// not by `opened_at` — `datetime('now')` only has second resolution,
    /// so two touches within the same second would otherwise tie and make
    /// the ordering unreliable. `opened_at` is kept for display purposes
    /// only.
    pub async fn touch(&self, path: &str) -> Result<(), DbError> {
        sqlx::query("DELETE FROM recent_files WHERE project_id IS NULL AND path = ?1")
            .bind(path)
            .execute(self.pool)
            .await
            .map_err(DbError::Query)?;

        sqlx::query(
            "INSERT INTO recent_files (project_id, path, opened_at) \
             VALUES (NULL, ?1, datetime('now'))",
        )
        .bind(path)
        .execute(self.pool)
        .await
        .map_err(DbError::Query)?;

        Ok(())
    }

    pub async fn list_recent(&self, limit: i64) -> Result<Vec<RecentFileEntry>, DbError> {
        let rows = sqlx::query_as::<_, RecentFileRow>(
            "SELECT path, opened_at FROM recent_files \
             WHERE project_id IS NULL ORDER BY id DESC LIMIT ?1",
        )
        .bind(limit)
        .fetch_all(self.pool)
        .await
        .map_err(DbError::Query)?;

        Ok(rows.into_iter().map(Into::into).collect())
    }

    /// A file or folder was renamed or moved: entries for `from`, and for files inside it when it is a folder, now
    /// name the new place. Their order is kept; an entry already recorded under the new name gives way.
    pub async fn rename_path(&self, from: &str, to: &str) -> Result<(), DbError> {
        sqlx::query(
            "DELETE FROM recent_files WHERE project_id IS NULL AND path = ?2              AND EXISTS (SELECT 1 FROM recent_files WHERE project_id IS NULL AND path = ?1)",
        )
        .bind(from)
        .bind(to)
        .execute(self.pool)
        .await
        .map_err(DbError::Query)?;
        sqlx::query(
            "UPDATE recent_files SET path = ?2 || substr(path, length(?1) + 1)              WHERE project_id IS NULL AND (path = ?1              OR substr(path, 1, length(?1) + 1) IN (?1 || '/', ?1 || char(92)))",
        )
        .bind(from)
        .bind(to)
        .execute(self.pool)
        .await
        .map_err(DbError::Query)?;
        Ok(())
    }

    pub async fn clear(&self) -> Result<(), DbError> {
        sqlx::query("DELETE FROM recent_files WHERE project_id IS NULL")
            .execute(self.pool)
            .await
            .map_err(DbError::Query)?;
        Ok(())
    }
}

#[derive(sqlx::FromRow)]
struct RecentFileRow {
    path: String,
    opened_at: String,
}

impl From<RecentFileRow> for RecentFileEntry {
    fn from(row: RecentFileRow) -> Self {
        Self {
            path: row.path,
            opened_at: row.opened_at,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::Db;

    #[tokio::test]
    async fn touch_inserts_new_entry() {
        let dir = tempfile::tempdir().expect("tempdir");
        let db = Db::connect(&dir.path().join("test.db"))
            .await
            .expect("connect");
        let repo = RecentFilesRepository::new(db.pool());

        repo.touch("C:/proj/main.rs").await.expect("touch");
        let entries = repo.list_recent(10).await.expect("list");

        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].path, "C:/proj/main.rs");
    }

    #[tokio::test]
    async fn touch_on_existing_path_does_not_duplicate() {
        let dir = tempfile::tempdir().expect("tempdir");
        let db = Db::connect(&dir.path().join("test.db"))
            .await
            .expect("connect");
        let repo = RecentFilesRepository::new(db.pool());

        repo.touch("C:/proj/main.rs").await.expect("touch 1");
        repo.touch("C:/proj/main.rs").await.expect("touch 2");
        let entries = repo.list_recent(10).await.expect("list");

        assert_eq!(entries.len(), 1);
    }

    #[tokio::test]
    async fn list_recent_orders_most_recent_first_and_respects_limit() {
        let dir = tempfile::tempdir().expect("tempdir");
        let db = Db::connect(&dir.path().join("test.db"))
            .await
            .expect("connect");
        let repo = RecentFilesRepository::new(db.pool());

        repo.touch("a.rs").await.expect("touch a");
        repo.touch("b.rs").await.expect("touch b");
        repo.touch("c.rs").await.expect("touch c");
        // Re-touching "a" should move it back to the front.
        repo.touch("a.rs").await.expect("re-touch a");

        let entries = repo.list_recent(2).await.expect("list");

        assert_eq!(entries.len(), 2);
        assert_eq!(entries[0].path, "a.rs");
        assert_eq!(entries[1].path, "c.rs");
    }

    #[tokio::test]
    async fn clear_removes_all_entries() {
        let dir = tempfile::tempdir().expect("tempdir");
        let db = Db::connect(&dir.path().join("test.db"))
            .await
            .expect("connect");
        let repo = RecentFilesRepository::new(db.pool());

        repo.touch("a.rs").await.expect("touch");
        repo.clear().await.expect("clear");
        let entries = repo.list_recent(10).await.expect("list");

        assert!(entries.is_empty());
    }
}
