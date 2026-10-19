use serde::{Deserialize, Serialize};
use sqlx::SqlitePool;

use crate::error::DbError;

/// One bookmark: a line of a file, optionally with a label. Files are absolute paths, so a folder's bookmarks are the
/// ones inside it (`project_id` stays NULL, like breakpoints and the recent files list).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BookmarkRow {
    pub file_path: String,
    /// 1-based.
    pub line: u32,
    #[serde(default)]
    pub label: Option<String>,
}

/// Repository for the `bookmarks` table (created by the first migration, unused until now).
pub struct BookmarksRepository<'a> {
    pool: &'a SqlitePool,
}

fn label_of(value: Option<String>) -> Option<String> {
    value
        .map(|text| text.trim().to_string())
        .filter(|text| !text.is_empty())
}

impl<'a> BookmarksRepository<'a> {
    pub fn new(pool: &'a SqlitePool) -> Self {
        Self { pool }
    }

    pub async fn list(&self) -> Result<Vec<BookmarkRow>, DbError> {
        let rows = sqlx::query_as::<_, Row>(
            "SELECT file_path, line, label FROM bookmarks ORDER BY file_path, line",
        )
        .fetch_all(self.pool)
        .await
        .map_err(DbError::Query)?;
        Ok(rows
            .into_iter()
            .map(|row| BookmarkRow {
                file_path: row.file_path,
                line: u32::try_from(row.line).unwrap_or(1).max(1),
                label: label_of(row.label),
            })
            .collect())
    }

    /// Replaces every stored bookmark with `rows` (in one transaction).
    pub async fn replace_all(&self, rows: &[BookmarkRow]) -> Result<(), DbError> {
        let mut transaction = self.pool.begin().await.map_err(DbError::Query)?;
        sqlx::query("DELETE FROM bookmarks")
            .execute(&mut *transaction)
            .await
            .map_err(DbError::Query)?;
        for row in rows {
            sqlx::query("INSERT INTO bookmarks (file_path, line, label) VALUES (?1, ?2, ?3)")
                .bind(&row.file_path)
                .bind(i64::from(row.line.max(1)))
                .bind(label_of(row.label.clone()))
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
    label: Option<String>,
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::Db;

    fn row(path: &str, line: u32, label: Option<&str>) -> BookmarkRow {
        BookmarkRow {
            file_path: path.into(),
            line,
            label: label.map(Into::into),
        }
    }

    #[tokio::test]
    async fn bookmarks_round_trip_ordered_with_labels() {
        let dir = tempfile::tempdir().expect("tempdir");
        let db = Db::connect(&dir.path().join("test.db"))
            .await
            .expect("connect");
        let repo = BookmarksRepository::new(db.pool());
        assert!(repo.list().await.expect("empty").is_empty());
        repo.replace_all(&[
            row("C:/My Site/b.ts", 9, None),
            row("C:/My Site/a.ts", 12, Some("  login check ")),
            row("C:/My Site/a.ts", 3, Some("   ")),
        ])
        .await
        .expect("save");
        assert_eq!(
            repo.list().await.expect("load"),
            vec![
                row("C:/My Site/a.ts", 3, None),
                row("C:/My Site/a.ts", 12, Some("login check")),
                row("C:/My Site/b.ts", 9, None),
            ]
        );
    }

    #[tokio::test]
    async fn replacing_drops_what_is_no_longer_listed() {
        let dir = tempfile::tempdir().expect("tempdir");
        let db = Db::connect(&dir.path().join("test.db"))
            .await
            .expect("connect");
        let repo = BookmarksRepository::new(db.pool());
        repo.replace_all(&[row("a.ts", 1, None), row("b.ts", 2, None)])
            .await
            .expect("first");
        repo.replace_all(&[row("b.ts", 2, Some("x"))])
            .await
            .expect("second");
        assert_eq!(
            repo.list().await.expect("list"),
            vec![row("b.ts", 2, Some("x"))]
        );
        repo.replace_all(&[]).await.expect("clear");
        assert!(repo.list().await.expect("list").is_empty());
    }
}
