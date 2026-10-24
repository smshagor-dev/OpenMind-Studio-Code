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

    /// Bounded discovery of independently saved window records. The prefix is literal, not LIKE syntax.
    pub async fn list_prefix(&self, prefix: &str) -> Result<Vec<(String, String)>, DbError> {
        let rows = sqlx::query(
            "SELECT key, value FROM editor_settings WHERE substr(key, 1, length(?1)) = ?1 ORDER BY key LIMIT 257",
        )
        .bind(prefix)
        .fetch_all(self.pool)
        .await
        .map_err(DbError::Query)?;
        Ok(rows
            .into_iter()
            .map(|row| (row.get(0), row.get(1)))
            .collect())
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

    /// Removes the key (nothing happens when it was not set).
    pub async fn delete(&self, key: &str) -> Result<(), DbError> {
        sqlx::query("DELETE FROM editor_settings WHERE key = ?1")
            .bind(key)
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
    async fn prefix_discovery_is_literal_bounded_and_keeps_other_settings_out() {
        let dir = tempfile::tempdir().expect("tempdir");
        let db = Db::connect(&dir.path().join("test.db"))
            .await
            .expect("connect");
        let repo = EditorSettingsRepository::new(db.pool());
        repo.set("window_%/one", "first").await.expect("set");
        repo.set("window_other/two", "unrelated").await.expect("set");
        assert_eq!(
            repo.list_prefix("window_%/").await.expect("list"),
            vec![("window_%/one".into(), "first".into())]
        );
        for n in 0..260 {
            repo.set(&format!("session.{n:03}"), "value")
                .await
                .expect("set");
        }
        assert_eq!(repo.list_prefix("session.").await.expect("list").len(), 257);
    }

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
    async fn delete_removes_a_key_and_ignores_a_missing_one() {
        let dir = tempfile::tempdir().expect("tempdir");
        let db = Db::connect(&dir.path().join("test.db"))
            .await
            .expect("connect");
        let repo = EditorSettingsRepository::new(db.pool());
        repo.set("k", "v").await.expect("set");
        repo.delete("k").await.expect("delete");
        assert_eq!(repo.get("k").await.expect("get"), None);
        repo.delete("k").await.expect("delete again");
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
