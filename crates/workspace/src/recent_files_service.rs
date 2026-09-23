use openmind_db::{Db, RecentFilesRepository};
use serde::Serialize;

use crate::error::WorkspaceError;

/// How many recent files are surfaced to callers. Owning this constant here
/// (rather than letting every caller pick its own limit) is the point of
/// this service existing as a layer over the raw repository.
const RECENT_FILES_LIMIT: i64 = 20;

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RecentFileInfo {
    pub path: String,
    pub opened_at: String,
}

#[derive(Clone)]
pub struct RecentFilesService {
    db: Db,
}

impl RecentFilesService {
    pub fn new(db: Db) -> Self {
        Self { db }
    }

    pub async fn touch(&self, path: &str) -> Result<(), WorkspaceError> {
        RecentFilesRepository::new(self.db.pool())
            .touch(path)
            .await?;
        Ok(())
    }

    pub async fn list(&self) -> Result<Vec<RecentFileInfo>, WorkspaceError> {
        let entries = RecentFilesRepository::new(self.db.pool())
            .list_recent(RECENT_FILES_LIMIT)
            .await?;

        Ok(entries
            .into_iter()
            .map(|entry| RecentFileInfo {
                path: entry.path,
                opened_at: entry.opened_at,
            })
            .collect())
    }

    pub async fn clear(&self) -> Result<(), WorkspaceError> {
        RecentFilesRepository::new(self.db.pool()).clear().await?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn list_is_empty_when_nothing_touched() {
        let dir = tempfile::tempdir().expect("tempdir");
        let db = Db::connect(&dir.path().join("test.db"))
            .await
            .expect("connect");
        let service = RecentFilesService::new(db);

        assert_eq!(service.list().await.expect("list"), vec![]);
    }

    #[tokio::test]
    async fn touch_then_list_round_trips_most_recent_first() {
        let dir = tempfile::tempdir().expect("tempdir");
        let db = Db::connect(&dir.path().join("test.db"))
            .await
            .expect("connect");
        let service = RecentFilesService::new(db);

        service.touch("a.rs").await.expect("touch a");
        service.touch("b.rs").await.expect("touch b");

        let entries = service.list().await.expect("list");

        assert_eq!(entries.len(), 2);
        assert_eq!(entries[0].path, "b.rs");
        assert_eq!(entries[1].path, "a.rs");
    }

    #[tokio::test]
    async fn clear_empties_the_list() {
        let dir = tempfile::tempdir().expect("tempdir");
        let db = Db::connect(&dir.path().join("test.db"))
            .await
            .expect("connect");
        let service = RecentFilesService::new(db);

        service.touch("a.rs").await.expect("touch");
        service.clear().await.expect("clear");

        assert!(service.list().await.expect("list").is_empty());
    }
}
