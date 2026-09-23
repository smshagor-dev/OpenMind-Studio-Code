use sqlx::SqlitePool;

use crate::error::DbError;

/// Saved geometry for a single named window (Tauri window label).
#[derive(Debug, Clone, PartialEq)]
pub struct WindowState {
    pub label: String,
    pub width: f64,
    pub height: f64,
    pub x: Option<f64>,
    pub y: Option<f64>,
    pub maximized: bool,
}

#[derive(sqlx::FromRow)]
struct WindowStateRow {
    window_label: String,
    width: f64,
    height: f64,
    x: Option<f64>,
    y: Option<f64>,
    maximized: bool,
}

impl From<WindowStateRow> for WindowState {
    fn from(row: WindowStateRow) -> Self {
        Self {
            label: row.window_label,
            width: row.width,
            height: row.height,
            x: row.x,
            y: row.y,
            maximized: row.maximized,
        }
    }
}

/// Repository for the `window_state` table.
pub struct WindowStateRepository<'a> {
    pool: &'a SqlitePool,
}

impl<'a> WindowStateRepository<'a> {
    pub fn new(pool: &'a SqlitePool) -> Self {
        Self { pool }
    }

    pub async fn get(&self, label: &str) -> Result<Option<WindowState>, DbError> {
        let row = sqlx::query_as::<_, WindowStateRow>(
            "SELECT window_label, width, height, x, y, maximized \
             FROM window_state WHERE window_label = ?1",
        )
        .bind(label)
        .fetch_optional(self.pool)
        .await
        .map_err(DbError::Query)?;

        Ok(row.map(WindowState::from))
    }

    pub async fn save(&self, state: &WindowState) -> Result<(), DbError> {
        sqlx::query(
            "INSERT INTO window_state (window_label, width, height, x, y, maximized, updated_at) \
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, datetime('now')) \
             ON CONFLICT(window_label) DO UPDATE SET \
                width = excluded.width, \
                height = excluded.height, \
                x = excluded.x, \
                y = excluded.y, \
                maximized = excluded.maximized, \
                updated_at = datetime('now')",
        )
        .bind(&state.label)
        .bind(state.width)
        .bind(state.height)
        .bind(state.x)
        .bind(state.y)
        .bind(state.maximized)
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
    async fn get_returns_none_when_no_row_saved() {
        let dir = tempfile::tempdir().expect("tempdir");
        let db = Db::connect(&dir.path().join("test.db"))
            .await
            .expect("connect");

        let repo = WindowStateRepository::new(db.pool());
        let result = repo.get("main").await.expect("query should succeed");

        assert_eq!(result, None);
    }

    #[tokio::test]
    async fn save_then_get_round_trips() {
        let dir = tempfile::tempdir().expect("tempdir");
        let db = Db::connect(&dir.path().join("test.db"))
            .await
            .expect("connect");
        let repo = WindowStateRepository::new(db.pool());

        let state = WindowState {
            label: "main".to_string(),
            width: 1280.0,
            height: 800.0,
            x: Some(100.0),
            y: Some(50.0),
            maximized: false,
        };
        repo.save(&state).await.expect("save should succeed");

        let loaded = repo
            .get("main")
            .await
            .expect("query should succeed")
            .expect("row should exist");

        assert_eq!(loaded, state);
    }

    #[tokio::test]
    async fn save_upserts_on_conflict() {
        let dir = tempfile::tempdir().expect("tempdir");
        let db = Db::connect(&dir.path().join("test.db"))
            .await
            .expect("connect");
        let repo = WindowStateRepository::new(db.pool());

        repo.save(&WindowState {
            label: "main".to_string(),
            width: 1280.0,
            height: 800.0,
            x: Some(0.0),
            y: Some(0.0),
            maximized: false,
        })
        .await
        .expect("first save");

        repo.save(&WindowState {
            label: "main".to_string(),
            width: 1600.0,
            height: 900.0,
            x: Some(20.0),
            y: Some(30.0),
            maximized: true,
        })
        .await
        .expect("second save");

        let loaded = repo.get("main").await.expect("query").expect("row exists");

        assert_eq!(loaded.width, 1600.0);
        assert_eq!(loaded.height, 900.0);
        assert!(loaded.maximized);
    }
}
