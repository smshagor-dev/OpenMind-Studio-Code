use serde::Serialize;
use sqlx::SqlitePool;

use crate::error::DbError;

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PinnedFolderEntry {
    pub path: String,
    pub label: Option<String>,
}

/// Repository for the `pinned_folders` table.
pub struct PinnedFoldersRepository<'a> {
    pool: &'a SqlitePool,
}

impl<'a> PinnedFoldersRepository<'a> {
    pub fn new(pool: &'a SqlitePool) -> Self {
        Self { pool }
    }

    pub async fn pin(&self, path: &str, label: Option<&str>) -> Result<(), DbError> {
        sqlx::query(
            "INSERT INTO pinned_folders (path, label, pinned_at) VALUES (?1, ?2, datetime('now')) \
             ON CONFLICT(path) DO UPDATE SET label = excluded.label",
        )
        .bind(path)
        .bind(label)
        .execute(self.pool)
        .await
        .map_err(DbError::Query)?;
        Ok(())
    }

    pub async fn unpin(&self, path: &str) -> Result<(), DbError> {
        sqlx::query("DELETE FROM pinned_folders WHERE path = ?1")
            .bind(path)
            .execute(self.pool)
            .await
            .map_err(DbError::Query)?;
        Ok(())
    }

    pub async fn list(&self) -> Result<Vec<PinnedFolderEntry>, DbError> {
        let rows = sqlx::query_as::<_, PinnedFolderRow>(
            "SELECT path, label FROM pinned_folders ORDER BY pinned_at DESC",
        )
        .fetch_all(self.pool)
        .await
        .map_err(DbError::Query)?;
        Ok(rows.into_iter().map(Into::into).collect())
    }

    pub async fn is_pinned(&self, path: &str) -> Result<bool, DbError> {
        let row = sqlx::query("SELECT 1 FROM pinned_folders WHERE path = ?1")
            .bind(path)
            .fetch_optional(self.pool)
            .await
            .map_err(DbError::Query)?;
        Ok(row.is_some())
    }
}

#[derive(sqlx::FromRow)]
struct PinnedFolderRow {
    path: String,
    label: Option<String>,
}

impl From<PinnedFolderRow> for PinnedFolderEntry {
    fn from(row: PinnedFolderRow) -> Self {
        Self {
            path: row.path,
            label: row.label,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::Db;

    #[tokio::test]
    async fn pin_then_list_round_trips() {
        let dir = tempfile::tempdir().expect("tempdir");
        let db = Db::connect(&dir.path().join("test.db"))
            .await
            .expect("connect");
        let repo = PinnedFoldersRepository::new(db.pool());

        repo.pin("C:/proj", Some("My Project")).await.expect("pin");
        let entries = repo.list().await.expect("list");

        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].path, "C:/proj");
        assert_eq!(entries[0].label.as_deref(), Some("My Project"));
        assert!(repo.is_pinned("C:/proj").await.expect("is_pinned"));
    }

    #[tokio::test]
    async fn unpin_removes_entry() {
        let dir = tempfile::tempdir().expect("tempdir");
        let db = Db::connect(&dir.path().join("test.db"))
            .await
            .expect("connect");
        let repo = PinnedFoldersRepository::new(db.pool());
        repo.pin("C:/proj", None).await.expect("pin");

        repo.unpin("C:/proj").await.expect("unpin");

        assert!(repo.list().await.expect("list").is_empty());
        assert!(!repo.is_pinned("C:/proj").await.expect("is_pinned"));
    }

    #[tokio::test]
    async fn pinning_twice_does_not_duplicate() {
        let dir = tempfile::tempdir().expect("tempdir");
        let db = Db::connect(&dir.path().join("test.db"))
            .await
            .expect("connect");
        let repo = PinnedFoldersRepository::new(db.pool());

        repo.pin("C:/proj", None).await.expect("pin 1");
        repo.pin("C:/proj", Some("relabelled"))
            .await
            .expect("pin 2");

        let entries = repo.list().await.expect("list");
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].label.as_deref(), Some("relabelled"));
    }
}
