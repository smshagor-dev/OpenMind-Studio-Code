use sqlx::{Row, SqlitePool};

use crate::error::DbError;

/// Repository for the `editor_settings` generic key-value table. Used for
/// small standalone UI preferences (e.g. sidebar visibility) that don't
/// warrant their own table.
pub struct EditorSettingsRepository<'a> {
    pool: &'a SqlitePool,
}

impl<'a> EditorSettingsRepository<'a> {
    pub fn new(pool: &'a SqlitePool) -> Self {
        Self { pool }
    }

    pub async fn get(&self, key: &str) -> Result<Option<String>, DbError> {
        let row = sqlx::query("SELECT value FROM editor_settings WHERE key = ?1")
            .bind(key)
            .fetch_optional(self.pool)
            .await
            .map_err(DbError::Query)?;
        Ok(row.map(|row| row.get(0)))
    }

    pub async fn set(&self, key: &str, value: &str) -> Result<(), DbError> {
        sqlx::query(
            "INSERT INTO editor_settings (key, value, updated_at) VALUES (?1, ?2, datetime('now')) \
             ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')",
        )
        .bind(key)
        .bind(value)
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
    async fn get_returns_none_when_unset() {
        let dir = tempfile::tempdir().expect("tempdir");
        let db = Db::connect(&dir.path().join("test.db"))
            .await
            .expect("connect");
        let repo = EditorSettingsRepository::new(db.pool());

        assert_eq!(repo.get("sidebar.visible").await.expect("get"), None);
    }

    #[tokio::test]
    async fn set_then_get_round_trips() {
        let dir = tempfile::tempdir().expect("tempdir");
        let db = Db::connect(&dir.path().join("test.db"))
            .await
            .expect("connect");
        let repo = EditorSettingsRepository::new(db.pool());

        repo.set("sidebar.visible", "false").await.expect("set");

        assert_eq!(
            repo.get("sidebar.visible").await.expect("get"),
            Some("false".to_string())
        );
    }

    #[tokio::test]
    async fn set_upserts_on_conflict() {
        let dir = tempfile::tempdir().expect("tempdir");
        let db = Db::connect(&dir.path().join("test.db"))
            .await
            .expect("connect");
        let repo = EditorSettingsRepository::new(db.pool());

        repo.set("k", "1").await.expect("set 1");
        repo.set("k", "2").await.expect("set 2");

        assert_eq!(repo.get("k").await.expect("get"), Some("2".to_string()));
    }
}
