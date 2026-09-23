use sqlx::{Row, SqlitePool};

use crate::error::DbError;

/// Repository for the single-row `session_restore` table. The shape of
/// `open_tabs` (which documents were open, which was active, ...) is opaque
/// JSON here by design — that's `openmind-workspace`'s concern, not the
/// storage layer's.
pub struct SessionRepository<'a> {
    pool: &'a SqlitePool,
}

impl<'a> SessionRepository<'a> {
    pub fn new(pool: &'a SqlitePool) -> Self {
        Self { pool }
    }

    pub async fn load(&self) -> Result<Option<String>, DbError> {
        let row = sqlx::query("SELECT open_tabs FROM session_restore WHERE id = 1")
            .fetch_optional(self.pool)
            .await
            .map_err(DbError::Query)?;

        Ok(row.map(|row| row.get::<String, _>(0)))
    }

    pub async fn save(&self, open_tabs_json: &str) -> Result<(), DbError> {
        sqlx::query(
            "INSERT INTO session_restore (id, open_tabs, updated_at) VALUES (1, ?1, datetime('now')) \
             ON CONFLICT(id) DO UPDATE SET \
                open_tabs = excluded.open_tabs, \
                updated_at = datetime('now')",
        )
        .bind(open_tabs_json)
        .execute(self.pool)
        .await
        .map_err(DbError::Query)?;

        Ok(())
    }

    pub async fn clear(&self) -> Result<(), DbError> {
        sqlx::query("DELETE FROM session_restore WHERE id = 1")
            .execute(self.pool)
            .await
            .map_err(DbError::Query)?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::Db;

    #[tokio::test]
    async fn load_returns_none_when_nothing_saved() {
        let dir = tempfile::tempdir().expect("tempdir");
        let db = Db::connect(&dir.path().join("test.db"))
            .await
            .expect("connect");
        let repo = SessionRepository::new(db.pool());

        assert_eq!(repo.load().await.expect("load"), None);
    }

    #[tokio::test]
    async fn save_then_load_round_trips() {
        let dir = tempfile::tempdir().expect("tempdir");
        let db = Db::connect(&dir.path().join("test.db"))
            .await
            .expect("connect");
        let repo = SessionRepository::new(db.pool());

        let json = r#"{"tabs":["a.rs","b.rs"],"active":"a.rs"}"#;
        repo.save(json).await.expect("save");

        assert_eq!(repo.load().await.expect("load"), Some(json.to_string()));
    }

    #[tokio::test]
    async fn save_upserts_on_conflict() {
        let dir = tempfile::tempdir().expect("tempdir");
        let db = Db::connect(&dir.path().join("test.db"))
            .await
            .expect("connect");
        let repo = SessionRepository::new(db.pool());

        repo.save("{}").await.expect("first save");
        repo.save(r#"{"tabs":["only.rs"]}"#)
            .await
            .expect("second save");

        assert_eq!(
            repo.load().await.expect("load"),
            Some(r#"{"tabs":["only.rs"]}"#.to_string())
        );
    }

    #[tokio::test]
    async fn clear_removes_the_row() {
        let dir = tempfile::tempdir().expect("tempdir");
        let db = Db::connect(&dir.path().join("test.db"))
            .await
            .expect("connect");
        let repo = SessionRepository::new(db.pool());

        repo.save("{}").await.expect("save");
        repo.clear().await.expect("clear");

        assert_eq!(repo.load().await.expect("load"), None);
    }
}
