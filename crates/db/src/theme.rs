use sqlx::{Row, SqlitePool};

use crate::error::DbError;

/// Repository for the single-row `theme` table.
pub struct ThemeRepository<'a> {
    pool: &'a SqlitePool,
}

impl<'a> ThemeRepository<'a> {
    pub fn new(pool: &'a SqlitePool) -> Self {
        Self { pool }
    }

    pub async fn get_theme_name(&self) -> Result<Option<String>, DbError> {
        let row = sqlx::query("SELECT theme_name FROM theme WHERE id = 1")
            .fetch_optional(self.pool)
            .await
            .map_err(DbError::Query)?;

        Ok(row.map(|row| row.get::<String, _>(0)))
    }

    pub async fn set_theme_name(&self, theme_name: &str) -> Result<(), DbError> {
        sqlx::query(
            "INSERT INTO theme (id, theme_name, updated_at) VALUES (1, ?1, datetime('now')) \
             ON CONFLICT(id) DO UPDATE SET \
                theme_name = excluded.theme_name, \
                updated_at = datetime('now')",
        )
        .bind(theme_name)
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
    async fn get_theme_name_returns_none_when_nothing_saved() {
        let dir = tempfile::tempdir().expect("tempdir");
        let db = Db::connect(&dir.path().join("test.db"))
            .await
            .expect("connect");
        let repo = ThemeRepository::new(db.pool());

        assert_eq!(repo.get_theme_name().await.expect("get"), None);
    }

    #[tokio::test]
    async fn set_then_get_round_trips() {
        let dir = tempfile::tempdir().expect("tempdir");
        let db = Db::connect(&dir.path().join("test.db"))
            .await
            .expect("connect");
        let repo = ThemeRepository::new(db.pool());

        repo.set_theme_name("light").await.expect("set");

        assert_eq!(
            repo.get_theme_name().await.expect("get"),
            Some("light".to_string())
        );
    }

    #[tokio::test]
    async fn set_upserts_on_conflict() {
        let dir = tempfile::tempdir().expect("tempdir");
        let db = Db::connect(&dir.path().join("test.db"))
            .await
            .expect("connect");
        let repo = ThemeRepository::new(db.pool());

        repo.set_theme_name("dark").await.expect("first set");
        repo.set_theme_name("light").await.expect("second set");

        assert_eq!(
            repo.get_theme_name().await.expect("get"),
            Some("light".to_string())
        );
    }
}
