use serde::{Deserialize, Serialize};
use sqlx::SqlitePool;

use crate::error::DbError;

/// One breakpoint: a line of a file. Files are absolute paths, so breakpoints are not scoped to a
/// workspace (`project_id` stays NULL, like the recent files list).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BreakpointRow {
    pub file_path: String,
    /// 1-based.
    pub line: u32,
    pub enabled: bool,
}

/// Repository for the `breakpoints` table.
pub struct BreakpointsRepository<'a> {
    pool: &'a SqlitePool,
}

impl<'a> BreakpointsRepository<'a> {
    pub fn new(pool: &'a SqlitePool) -> Self {
        Self { pool }
    }

    pub async fn list(&self) -> Result<Vec<BreakpointRow>, DbError> {
        let rows = sqlx::query_as::<_, Row>(
            "SELECT file_path, line, enabled FROM breakpoints ORDER BY file_path, line",
        )
        .fetch_all(self.pool)
        .await
        .map_err(DbError::Query)?;
        Ok(rows
            .into_iter()
            .map(|row| BreakpointRow {
                file_path: row.file_path,
                line: u32::try_from(row.line).unwrap_or(1),
                enabled: row.enabled != 0,
            })
            .collect())
    }

    /// Replaces every stored breakpoint with `rows` (in one transaction).
    pub async fn replace_all(&self, rows: &[BreakpointRow]) -> Result<(), DbError> {
        let mut transaction = self.pool.begin().await.map_err(DbError::Query)?;
        sqlx::query("DELETE FROM breakpoints")
            .execute(&mut *transaction)
            .await
            .map_err(DbError::Query)?;
        for row in rows {
            sqlx::query("INSERT INTO breakpoints (file_path, line, enabled) VALUES (?1, ?2, ?3)")
                .bind(&row.file_path)
                .bind(i64::from(row.line))
                .bind(i64::from(row.enabled))
                .execute(&mut *transaction)
                .await
                .map_err(DbError::Query)?;
        }
        transaction.commit().await.map_err(DbError::Query)?;
        Ok(())
    }
}

#[derive(sqlx::FromRow)]
struct Row {
    file_path: String,
    line: i64,
    enabled: i64,
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::Db;

    fn row(path: &str, line: u32, enabled: bool) -> BreakpointRow {
        BreakpointRow {
            file_path: path.into(),
            line,
            enabled,
        }
    }

    #[tokio::test]
    async fn breakpoints_round_trip_ordered_by_file_and_line() {
        let dir = tempfile::tempdir().expect("tempdir");
        let db = Db::connect(&dir.path().join("test.db"))
            .await
            .expect("connect");
        let repo = BreakpointsRepository::new(db.pool());
        assert!(repo.list().await.expect("empty").is_empty());

        let rows = vec![
            row("C:/My Site/b.py", 9, true),
            row("C:/My Site/a.py", 12, false),
            row("C:/My Site/a.py", 3, true),
        ];
        repo.replace_all(&rows).await.expect("save");
        let loaded = repo.list().await.expect("load");
        assert_eq!(
            loaded,
            vec![
                row("C:/My Site/a.py", 3, true),
                row("C:/My Site/a.py", 12, false),
                row("C:/My Site/b.py", 9, true),
            ]
        );
    }

    #[tokio::test]
    async fn replacing_drops_what_is_no_longer_listed() {
        let dir = tempfile::tempdir().expect("tempdir");
        let db = Db::connect(&dir.path().join("test.db"))
            .await
            .expect("connect");
        let repo = BreakpointsRepository::new(db.pool());
        repo.replace_all(&[row("a.py", 1, true), row("b.py", 2, true)])
            .await
            .expect("first");
        repo.replace_all(&[row("b.py", 2, false)])
            .await
            .expect("second");
        assert_eq!(
            repo.list().await.expect("list"),
            vec![row("b.py", 2, false)]
        );
        repo.replace_all(&[]).await.expect("clear");
        assert!(repo.list().await.expect("list").is_empty());
    }
}
