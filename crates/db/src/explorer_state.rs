use sqlx::{Row, SqlitePool};

use crate::error::DbError;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ExplorerStateRow {
    pub expanded_paths_json: String,
    pub selected_path: Option<String>,
}

/// Repository for the `explorer_state` table — one row per workspace
/// (`opened_projects.id`), cascade-deleted if that project's row goes away.
pub struct ExplorerStateRepository<'a> {
    pool: &'a SqlitePool,
}

impl<'a> ExplorerStateRepository<'a> {
    pub fn new(pool: &'a SqlitePool) -> Self {
        Self { pool }
    }

    pub async fn load(&self, project_id: i64) -> Result<Option<ExplorerStateRow>, DbError> {
        let row = sqlx::query(
            "SELECT expanded_paths, selected_path FROM explorer_state WHERE project_id = ?1",
        )
        .bind(project_id)
        .fetch_optional(self.pool)
        .await
        .map_err(DbError::Query)?;

        Ok(row.map(|row| ExplorerStateRow {
            expanded_paths_json: row.get(0),
            selected_path: row.get(1),
        }))
    }

    pub async fn save(
        &self,
        project_id: i64,
        expanded_paths_json: &str,
        selected_path: Option<&str>,
    ) -> Result<(), DbError> {
        sqlx::query(
            "INSERT INTO explorer_state (project_id, expanded_paths, selected_path, updated_at) \
             VALUES (?1, ?2, ?3, datetime('now')) \
             ON CONFLICT(project_id) DO UPDATE SET \
                expanded_paths = excluded.expanded_paths, \
                selected_path = excluded.selected_path, \
                updated_at = datetime('now')",
        )
        .bind(project_id)
        .bind(expanded_paths_json)
        .bind(selected_path)
        .execute(self.pool)
        .await
        .map_err(DbError::Query)?;

        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{Db, OpenedProjectsRepository};

    async fn project_id(db: &Db) -> i64 {
        OpenedProjectsRepository::new(db.pool())
            .touch("C:/proj", None, false)
            .await
            .expect("touch project")
    }

    #[tokio::test]
    async fn load_returns_none_when_nothing_saved() {
        let dir = tempfile::tempdir().expect("tempdir");
        let db = Db::connect(&dir.path().join("test.db"))
            .await
            .expect("connect");
        let id = project_id(&db).await;
        let repo = ExplorerStateRepository::new(db.pool());

        assert_eq!(repo.load(id).await.expect("load"), None);
    }

    #[tokio::test]
    async fn save_then_load_round_trips() {
        let dir = tempfile::tempdir().expect("tempdir");
        let db = Db::connect(&dir.path().join("test.db"))
            .await
            .expect("connect");
        let id = project_id(&db).await;
        let repo = ExplorerStateRepository::new(db.pool());

        repo.save(id, r#"["src","src/services"]"#, Some("src/App.tsx"))
            .await
            .expect("save");

        let loaded = repo.load(id).await.expect("load").expect("row exists");
        assert_eq!(loaded.expanded_paths_json, r#"["src","src/services"]"#);
        assert_eq!(loaded.selected_path.as_deref(), Some("src/App.tsx"));
    }

    #[tokio::test]
    async fn save_upserts_on_conflict() {
        let dir = tempfile::tempdir().expect("tempdir");
        let db = Db::connect(&dir.path().join("test.db"))
            .await
            .expect("connect");
        let id = project_id(&db).await;
        let repo = ExplorerStateRepository::new(db.pool());

        repo.save(id, "[]", None).await.expect("first save");
        repo.save(id, r#"["src"]"#, Some("src/a.rs"))
            .await
            .expect("second save");

        let loaded = repo.load(id).await.expect("load").expect("row exists");
        assert_eq!(loaded.expanded_paths_json, r#"["src"]"#);
    }

    #[tokio::test]
    async fn deleting_project_cascades_to_explorer_state() {
        let dir = tempfile::tempdir().expect("tempdir");
        let db = Db::connect(&dir.path().join("test.db"))
            .await
            .expect("connect");
        let id = project_id(&db).await;
        let repo = ExplorerStateRepository::new(db.pool());
        repo.save(id, "[]", None).await.expect("save");

        sqlx::query("DELETE FROM opened_projects WHERE id = ?1")
            .bind(id)
            .execute(db.pool())
            .await
            .expect("delete project");

        assert_eq!(repo.load(id).await.expect("load"), None);
    }
}
