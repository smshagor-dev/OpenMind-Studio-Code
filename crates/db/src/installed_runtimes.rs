use serde::Serialize;
use sqlx::SqlitePool;

use crate::error::DbError;

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InstalledRuntimeEntry {
    pub kind: String,
    pub version: String,
    pub install_path: String,
    pub is_active: bool,
}

/// Repository for the `installed_runtimes` table: which portable runtime
/// versions are installed where, and which version of each kind is active.
/// The "active" choice lives here rather than in a `current` symlink, which
/// keeps switching versions free of filesystem-privilege problems on Windows.
pub struct InstalledRuntimesRepository<'a> {
    pool: &'a SqlitePool,
}

impl<'a> InstalledRuntimesRepository<'a> {
    pub fn new(pool: &'a SqlitePool) -> Self {
        Self { pool }
    }

    /// Records an installed version. The first version of a kind becomes
    /// active automatically; re-recording an existing version just updates
    /// its path and never changes which one is active.
    pub async fn record(
        &self,
        kind: &str,
        version: &str,
        install_path: &str,
    ) -> Result<(), DbError> {
        let mut tx = self.pool.begin().await.map_err(DbError::Query)?;
        let has_active: bool = sqlx::query_scalar(
            "SELECT EXISTS(SELECT 1 FROM installed_runtimes WHERE kind = ?1 AND is_active = 1)",
        )
        .bind(kind)
        .fetch_one(&mut *tx)
        .await
        .map_err(DbError::Query)?;
        sqlx::query(
            "INSERT INTO installed_runtimes (kind, version, install_path, is_active) \
             VALUES (?1, ?2, ?3, ?4) \
             ON CONFLICT(kind, version) DO UPDATE SET install_path = excluded.install_path",
        )
        .bind(kind)
        .bind(version)
        .bind(install_path)
        .bind(!has_active)
        .execute(&mut *tx)
        .await
        .map_err(DbError::Query)?;
        tx.commit().await.map_err(DbError::Query)?;
        Ok(())
    }

    pub async fn list(&self) -> Result<Vec<InstalledRuntimeEntry>, DbError> {
        let rows = sqlx::query_as::<_, Row>(
            "SELECT kind, version, install_path, is_active FROM installed_runtimes ORDER BY kind, id",
        )
        .fetch_all(self.pool)
        .await
        .map_err(DbError::Query)?;
        Ok(rows.into_iter().map(Into::into).collect())
    }

    pub async fn get(
        &self,
        kind: &str,
        version: &str,
    ) -> Result<Option<InstalledRuntimeEntry>, DbError> {
        let row = sqlx::query_as::<_, Row>(
            "SELECT kind, version, install_path, is_active FROM installed_runtimes \
             WHERE kind = ?1 AND version = ?2",
        )
        .bind(kind)
        .bind(version)
        .fetch_optional(self.pool)
        .await
        .map_err(DbError::Query)?;
        Ok(row.map(Into::into))
    }

    /// Makes `version` the only active version of `kind`. Returns `false`
    /// (changing nothing) if that version isn't recorded.
    pub async fn set_active(&self, kind: &str, version: &str) -> Result<bool, DbError> {
        let mut tx = self.pool.begin().await.map_err(DbError::Query)?;
        let exists: bool = sqlx::query_scalar(
            "SELECT EXISTS(SELECT 1 FROM installed_runtimes WHERE kind = ?1 AND version = ?2)",
        )
        .bind(kind)
        .bind(version)
        .fetch_one(&mut *tx)
        .await
        .map_err(DbError::Query)?;
        if !exists {
            return Ok(false);
        }
        sqlx::query("UPDATE installed_runtimes SET is_active = 0 WHERE kind = ?1")
            .bind(kind)
            .execute(&mut *tx)
            .await
            .map_err(DbError::Query)?;
        sqlx::query("UPDATE installed_runtimes SET is_active = 1 WHERE kind = ?1 AND version = ?2")
            .bind(kind)
            .bind(version)
            .execute(&mut *tx)
            .await
            .map_err(DbError::Query)?;
        tx.commit().await.map_err(DbError::Query)?;
        Ok(true)
    }

    /// Removes a version's record. If it was the active one, the most
    /// recently recorded remaining version of that kind (if any) is promoted
    /// so a kind with something installed always has an active version.
    pub async fn remove(&self, kind: &str, version: &str) -> Result<(), DbError> {
        let mut tx = self.pool.begin().await.map_err(DbError::Query)?;
        let was_active: bool = sqlx::query_scalar(
            "SELECT COALESCE((SELECT is_active FROM installed_runtimes WHERE kind = ?1 AND version = ?2), 0)",
        )
        .bind(kind)
        .bind(version)
        .fetch_one(&mut *tx)
        .await
        .map_err(DbError::Query)?;
        sqlx::query("DELETE FROM installed_runtimes WHERE kind = ?1 AND version = ?2")
            .bind(kind)
            .bind(version)
            .execute(&mut *tx)
            .await
            .map_err(DbError::Query)?;
        if was_active {
            sqlx::query(
                "UPDATE installed_runtimes SET is_active = 1 WHERE id = \
                 (SELECT id FROM installed_runtimes WHERE kind = ?1 ORDER BY id DESC LIMIT 1)",
            )
            .bind(kind)
            .execute(&mut *tx)
            .await
            .map_err(DbError::Query)?;
        }
        tx.commit().await.map_err(DbError::Query)?;
        Ok(())
    }
}

#[derive(sqlx::FromRow)]
struct Row {
    kind: String,
    version: String,
    install_path: String,
    is_active: bool,
}

impl From<Row> for InstalledRuntimeEntry {
    fn from(row: Row) -> Self {
        Self {
            kind: row.kind,
            version: row.version,
            install_path: row.install_path,
            is_active: row.is_active,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::Db;

    async fn repo_db() -> (tempfile::TempDir, Db) {
        let dir = tempfile::tempdir().expect("tempdir");
        let db = Db::connect(&dir.path().join("test.db"))
            .await
            .expect("connect");
        (dir, db)
    }

    #[tokio::test]
    async fn first_recorded_version_becomes_active_and_later_ones_do_not() {
        let (_dir, db) = repo_db().await;
        let repo = InstalledRuntimesRepository::new(db.pool());

        repo.record("node", "24.20.0", "C:/rt/node/24.20.0")
            .await
            .expect("record 1");
        repo.record("node", "24.21.0", "C:/rt/node/24.21.0")
            .await
            .expect("record 2");

        let list = repo.list().await.expect("list");
        assert_eq!(list.len(), 2);
        assert!(list[0].is_active);
        assert!(!list[1].is_active);
    }

    #[tokio::test]
    async fn re_recording_a_version_keeps_the_active_choice() {
        let (_dir, db) = repo_db().await;
        let repo = InstalledRuntimesRepository::new(db.pool());
        repo.record("node", "1", "a").await.expect("record");
        repo.record("node", "2", "b").await.expect("record");
        repo.set_active("node", "2").await.expect("switch");

        repo.record("node", "1", "moved").await.expect("re-record");

        let one = repo.get("node", "1").await.expect("get").expect("exists");
        let two = repo.get("node", "2").await.expect("get").expect("exists");
        assert_eq!(one.install_path, "moved");
        assert!(!one.is_active);
        assert!(two.is_active);
    }

    #[tokio::test]
    async fn set_active_switches_within_a_kind_only() {
        let (_dir, db) = repo_db().await;
        let repo = InstalledRuntimesRepository::new(db.pool());
        repo.record("node", "1", "n1").await.expect("record");
        repo.record("node", "2", "n2").await.expect("record");
        repo.record("python", "3", "p3").await.expect("record");

        assert!(repo.set_active("node", "2").await.expect("set active"));

        let get = |k: &'static str, v: &'static str| {
            let repo = InstalledRuntimesRepository::new(db.pool());
            async move {
                repo.get(k, v)
                    .await
                    .expect("get")
                    .expect("exists")
                    .is_active
            }
        };
        assert!(!get("node", "1").await);
        assert!(get("node", "2").await);
        assert!(get("python", "3").await);
    }

    #[tokio::test]
    async fn set_active_for_an_unknown_version_changes_nothing() {
        let (_dir, db) = repo_db().await;
        let repo = InstalledRuntimesRepository::new(db.pool());
        repo.record("node", "1", "n1").await.expect("record");

        assert!(!repo.set_active("node", "999").await.expect("set active"));

        assert!(
            repo.get("node", "1")
                .await
                .expect("get")
                .expect("exists")
                .is_active
        );
    }

    #[tokio::test]
    async fn removing_the_active_version_promotes_another() {
        let (_dir, db) = repo_db().await;
        let repo = InstalledRuntimesRepository::new(db.pool());
        repo.record("node", "1", "n1").await.expect("record");
        repo.record("node", "2", "n2").await.expect("record");

        repo.remove("node", "1").await.expect("remove");

        let list = repo.list().await.expect("list");
        assert_eq!(list.len(), 1);
        assert_eq!(list[0].version, "2");
        assert!(list[0].is_active);
    }

    #[tokio::test]
    async fn removing_the_last_version_leaves_nothing_and_removing_a_missing_one_is_fine() {
        let (_dir, db) = repo_db().await;
        let repo = InstalledRuntimesRepository::new(db.pool());
        repo.record("node", "1", "n1").await.expect("record");

        repo.remove("node", "1").await.expect("remove");
        repo.remove("node", "1").await.expect("remove again");

        assert!(repo.list().await.expect("list").is_empty());
    }
}
