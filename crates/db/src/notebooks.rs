use serde::Serialize;
use sqlx::SqlitePool;

use crate::error::DbError;

/// A cell the user ran (the history keeps no code or output: the notebook file holds those).
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NotebookRun {
    pub cell_index: u32,
    pub status: String,
    pub duration_ms: u64,
    pub interpreter: String,
    pub ran_at: String,
}

/// Repository for `notebook_trust` and `notebook_runs`.
pub struct NotebooksRepository<'a> {
    pool: &'a SqlitePool,
}

const MAX_RUNS_PER_NOTEBOOK: i64 = 200;

impl<'a> NotebooksRepository<'a> {
    pub fn new(pool: &'a SqlitePool) -> Self {
        Self { pool }
    }

    /// The content fingerprint the user trusted for `path`, if any.
    pub async fn trusted_fingerprint(&self, path: &str) -> Result<Option<String>, DbError> {
        sqlx::query_scalar::<_, String>("SELECT sha256 FROM notebook_trust WHERE path = ?1")
            .bind(path)
            .fetch_optional(self.pool)
            .await
            .map_err(DbError::Query)
    }

    /// Trusts `path` with exactly this content (`None` removes the trust).
    pub async fn set_trust(&self, path: &str, fingerprint: Option<&str>) -> Result<(), DbError> {
        match fingerprint {
            Some(sha) => sqlx::query(
                "INSERT INTO notebook_trust (path, sha256) VALUES (?1, ?2) \
                 ON CONFLICT(path) DO UPDATE SET sha256 = excluded.sha256, trusted_at = datetime('now')",
            )
            .bind(path)
            .bind(sha)
            .execute(self.pool)
            .await,
            None => sqlx::query("DELETE FROM notebook_trust WHERE path = ?1")
                .bind(path)
                .execute(self.pool)
                .await,
        }
        .map_err(DbError::Query)?;
        Ok(())
    }

    /// Records a run and keeps only the newest ones of that notebook.
    pub async fn add_run(
        &self,
        path: &str,
        cell_index: u32,
        status: &str,
        duration_ms: u64,
        interpreter: &str,
    ) -> Result<(), DbError> {
        sqlx::query(
            "INSERT INTO notebook_runs (path, cell_index, status, duration_ms, interpreter) VALUES (?1, ?2, ?3, ?4, ?5)",
        )
        .bind(path)
        .bind(i64::from(cell_index))
        .bind(status)
        .bind(i64::try_from(duration_ms).unwrap_or(i64::MAX))
        .bind(interpreter)
        .execute(self.pool)
        .await
        .map_err(DbError::Query)?;
        sqlx::query(
            "DELETE FROM notebook_runs WHERE path = ?1 AND id NOT IN \
             (SELECT id FROM notebook_runs WHERE path = ?1 ORDER BY id DESC LIMIT ?2)",
        )
        .bind(path)
        .bind(MAX_RUNS_PER_NOTEBOOK)
        .execute(self.pool)
        .await
        .map_err(DbError::Query)?;
        Ok(())
    }

    /// The notebook's runs, newest first.
    pub async fn runs(&self, path: &str) -> Result<Vec<NotebookRun>, DbError> {
        let rows = sqlx::query_as::<_, (i64, String, i64, String, String)>(
            "SELECT cell_index, status, duration_ms, interpreter, ran_at FROM notebook_runs WHERE path = ?1 ORDER BY id DESC",
        )
        .bind(path)
        .fetch_all(self.pool)
        .await
        .map_err(DbError::Query)?;
        Ok(rows
            .into_iter()
            .map(
                |(cell, status, duration, interpreter, ran_at)| NotebookRun {
                    cell_index: u32::try_from(cell).unwrap_or(0),
                    status,
                    duration_ms: u64::try_from(duration).unwrap_or(0),
                    interpreter,
                    ran_at,
                },
            )
            .collect())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::Db;

    #[tokio::test]
    async fn trust_is_per_path_and_content() {
        let dir = tempfile::tempdir().expect("tempdir");
        let db = Db::connect(&dir.path().join("t.db"))
            .await
            .expect("connect");
        let repo = NotebooksRepository::new(db.pool());
        assert_eq!(repo.trusted_fingerprint("C:/n.ipynb").await.unwrap(), None);
        repo.set_trust("C:/n.ipynb", Some("aaa")).await.unwrap();
        repo.set_trust("C:/n.ipynb", Some("bbb")).await.unwrap();
        assert_eq!(
            repo.trusted_fingerprint("C:/n.ipynb")
                .await
                .unwrap()
                .as_deref(),
            Some("bbb")
        );
        assert_eq!(
            repo.trusted_fingerprint("C:/other.ipynb").await.unwrap(),
            None
        );
        repo.set_trust("C:/n.ipynb", None).await.unwrap();
        assert_eq!(repo.trusted_fingerprint("C:/n.ipynb").await.unwrap(), None);
    }

    #[tokio::test]
    async fn runs_are_kept_newest_first_and_capped() {
        let dir = tempfile::tempdir().expect("tempdir");
        let db = Db::connect(&dir.path().join("t.db"))
            .await
            .expect("connect");
        let repo = NotebooksRepository::new(db.pool());
        for cell in 0..205 {
            repo.add_run("C:/n.ipynb", cell, "ok", 12, "C:/py.exe")
                .await
                .unwrap();
        }
        repo.add_run("C:/other.ipynb", 1, "error", 3, "C:/py.exe")
            .await
            .unwrap();
        let runs = repo.runs("C:/n.ipynb").await.unwrap();
        assert_eq!(runs.len(), 200);
        assert_eq!(runs[0].cell_index, 204);
        assert_eq!(
            repo.runs("C:/other.ipynb").await.unwrap()[0].status,
            "error"
        );
    }
}
