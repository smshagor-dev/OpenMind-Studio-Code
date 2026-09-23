use sqlx::{Row, SqlitePool};

use crate::error::DbError;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OpenedProjectEntry {
    pub id: i64,
    pub path: String,
    pub name: Option<String>,
    pub is_workspace_file: bool,
    pub last_opened_at: String,
}

/// Repository for the `opened_projects` table: recently opened
/// folders/workspaces. `path` is `UNIQUE`, so `touch` upserts in place
/// (keeping the same `id`) rather than delete-and-reinsert — unlike
/// `recent_files`, other rows (`session_restore.active_project_id`,
/// `explorer_state.project_id`) reference this id by foreign key, and a
/// changing id would cascade-null/cascade-delete them.
pub struct OpenedProjectsRepository<'a> {
    pool: &'a SqlitePool,
}

impl<'a> OpenedProjectsRepository<'a> {
    pub fn new(pool: &'a SqlitePool) -> Self {
        Self { pool }
    }

    /// Records `path` as just opened, returning its (stable) row id.
    ///
    /// Bumps `touch_seq` to one past the current max — an exact,
    /// clock-resolution-independent ordering for `list_recent` (see the
    /// migration comment for why `last_opened_at`/`id` alone aren't enough).
    pub async fn touch(
        &self,
        path: &str,
        name: Option<&str>,
        is_workspace_file: bool,
    ) -> Result<i64, DbError> {
        sqlx::query(
            "INSERT INTO opened_projects (path, name, is_workspace_file, last_opened_at, touch_seq) \
             VALUES ( \
                ?1, ?2, ?3, datetime('now'), \
                (SELECT COALESCE(MAX(touch_seq), 0) + 1 FROM opened_projects) \
             ) \
             ON CONFLICT(path) DO UPDATE SET \
                name = excluded.name, \
                is_workspace_file = excluded.is_workspace_file, \
                last_opened_at = datetime('now'), \
                touch_seq = (SELECT COALESCE(MAX(touch_seq), 0) + 1 FROM opened_projects)",
        )
        .bind(path)
        .bind(name)
        .bind(is_workspace_file)
        .execute(self.pool)
        .await
        .map_err(DbError::Query)?;

        let row = sqlx::query("SELECT id FROM opened_projects WHERE path = ?1")
            .bind(path)
            .fetch_one(self.pool)
            .await
            .map_err(DbError::Query)?;
        Ok(row.get(0))
    }

    pub async fn list_recent(&self, limit: i64) -> Result<Vec<OpenedProjectEntry>, DbError> {
        let rows = sqlx::query_as::<_, OpenedProjectRow>(
            "SELECT id, path, name, is_workspace_file, last_opened_at FROM opened_projects \
             ORDER BY touch_seq DESC LIMIT ?1",
        )
        .bind(limit)
        .fetch_all(self.pool)
        .await
        .map_err(DbError::Query)?;
        Ok(rows.into_iter().map(Into::into).collect())
    }

    pub async fn get_by_id(&self, id: i64) -> Result<Option<OpenedProjectEntry>, DbError> {
        let row = sqlx::query_as::<_, OpenedProjectRow>(
            "SELECT id, path, name, is_workspace_file, last_opened_at \
             FROM opened_projects WHERE id = ?1",
        )
        .bind(id)
        .fetch_optional(self.pool)
        .await
        .map_err(DbError::Query)?;
        Ok(row.map(Into::into))
    }

    pub async fn get_by_path(&self, path: &str) -> Result<Option<OpenedProjectEntry>, DbError> {
        let row = sqlx::query_as::<_, OpenedProjectRow>(
            "SELECT id, path, name, is_workspace_file, last_opened_at \
             FROM opened_projects WHERE path = ?1",
        )
        .bind(path)
        .fetch_optional(self.pool)
        .await
        .map_err(DbError::Query)?;
        Ok(row.map(Into::into))
    }
}

#[derive(sqlx::FromRow)]
struct OpenedProjectRow {
    id: i64,
    path: String,
    name: Option<String>,
    is_workspace_file: bool,
    last_opened_at: String,
}

impl From<OpenedProjectRow> for OpenedProjectEntry {
    fn from(row: OpenedProjectRow) -> Self {
        Self {
            id: row.id,
            path: row.path,
            name: row.name,
            is_workspace_file: row.is_workspace_file,
            last_opened_at: row.last_opened_at,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::Db;

    #[tokio::test]
    async fn touch_inserts_new_project() {
        let dir = tempfile::tempdir().expect("tempdir");
        let db = Db::connect(&dir.path().join("test.db"))
            .await
            .expect("connect");
        let repo = OpenedProjectsRepository::new(db.pool());

        let id = repo
            .touch("C:/proj", Some("proj"), false)
            .await
            .expect("touch");
        let entries = repo.list_recent(10).await.expect("list");

        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].id, id);
        assert_eq!(entries[0].path, "C:/proj");
        assert_eq!(entries[0].name.as_deref(), Some("proj"));
    }

    #[tokio::test]
    async fn touch_on_existing_path_keeps_the_same_id() {
        let dir = tempfile::tempdir().expect("tempdir");
        let db = Db::connect(&dir.path().join("test.db"))
            .await
            .expect("connect");
        let repo = OpenedProjectsRepository::new(db.pool());

        let first_id = repo
            .touch("C:/proj", Some("proj"), false)
            .await
            .expect("touch 1");
        let second_id = repo
            .touch("C:/proj", Some("proj"), false)
            .await
            .expect("touch 2");

        assert_eq!(first_id, second_id);
        assert_eq!(repo.list_recent(10).await.expect("list").len(), 1);
    }

    #[tokio::test]
    async fn list_recent_orders_most_recently_touched_first() {
        let dir = tempfile::tempdir().expect("tempdir");
        let db = Db::connect(&dir.path().join("test.db"))
            .await
            .expect("connect");
        let repo = OpenedProjectsRepository::new(db.pool());

        repo.touch("a", None, false).await.expect("touch a");
        repo.touch("b", None, false).await.expect("touch b");
        repo.touch("a", None, false).await.expect("re-touch a");

        let entries = repo.list_recent(10).await.expect("list");

        assert_eq!(entries[0].path, "a");
        assert_eq!(entries[1].path, "b");
    }

    #[tokio::test]
    async fn get_by_path_finds_existing_entry() {
        let dir = tempfile::tempdir().expect("tempdir");
        let db = Db::connect(&dir.path().join("test.db"))
            .await
            .expect("connect");
        let repo = OpenedProjectsRepository::new(db.pool());
        repo.touch("C:/proj", None, false).await.expect("touch");

        let found = repo.get_by_path("C:/proj").await.expect("get");

        assert!(found.is_some());
    }

    #[tokio::test]
    async fn get_by_path_returns_none_when_missing() {
        let dir = tempfile::tempdir().expect("tempdir");
        let db = Db::connect(&dir.path().join("test.db"))
            .await
            .expect("connect");
        let repo = OpenedProjectsRepository::new(db.pool());

        assert_eq!(repo.get_by_path("missing").await.expect("get"), None);
    }
}
