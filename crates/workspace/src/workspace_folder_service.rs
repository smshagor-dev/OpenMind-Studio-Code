use std::path::Path;

use openmind_db::{Db, OpenedProjectsRepository, SessionRepository};
use serde::Serialize;

use crate::error::WorkspaceError;

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceInfo {
    pub id: i64,
    pub path: String,
    pub name: String,
}

/// Business logic for "which folder is open": opening/closing a workspace
/// folder, recent folders, and which one (if any) is active — all layered
/// over `openmind-db`'s `opened_projects`/`session_restore` tables. The
/// data model (a single `active_project_id`) is multi-root-ready in the
/// sense that `opened_projects` already supports many rows; this milestone
/// intentionally doesn't build multi-root UI on top of it.
#[derive(Clone)]
pub struct WorkspaceFolderService {
    db: Db,
}

impl WorkspaceFolderService {
    pub fn new(db: Db) -> Self {
        Self { db }
    }

    pub async fn open_folder(&self, path: &str) -> Result<WorkspaceInfo, WorkspaceError> {
        let name = folder_name(path);
        let id = OpenedProjectsRepository::new(self.db.pool())
            .touch(path, Some(&name), false)
            .await?;
        SessionRepository::new(self.db.pool())
            .set_active_project(Some(id))
            .await?;
        Ok(WorkspaceInfo {
            id,
            path: path.to_string(),
            name,
        })
    }

    /// Adds `path` to the recent folders without making it the saved open
    /// folder (an extra window's folder: it isn't restored on launch).
    pub async fn remember_folder(&self, path: &str) -> Result<WorkspaceInfo, WorkspaceError> {
        let name = folder_name(path);
        let id = OpenedProjectsRepository::new(self.db.pool())
            .touch(path, Some(&name), false)
            .await?;
        Ok(WorkspaceInfo {
            id,
            path: path.to_string(),
            name,
        })
    }

    pub async fn close_folder(&self) -> Result<(), WorkspaceError> {
        SessionRepository::new(self.db.pool())
            .set_active_project(None)
            .await?;
        Ok(())
    }

    pub async fn recent_folders(&self, limit: i64) -> Result<Vec<WorkspaceInfo>, WorkspaceError> {
        let entries = OpenedProjectsRepository::new(self.db.pool())
            .list_recent(limit)
            .await?;
        Ok(entries
            .into_iter()
            .map(|entry| WorkspaceInfo {
                id: entry.id,
                name: entry.name.unwrap_or_else(|| folder_name(&entry.path)),
                path: entry.path,
            })
            .collect())
    }

    /// The workspace to restore on launch, or `None` if no folder was open
    /// last session (or that folder's row has since gone away).
    pub async fn active_workspace(&self) -> Result<Option<WorkspaceInfo>, WorkspaceError> {
        let Some(project_id) = SessionRepository::new(self.db.pool())
            .get_active_project()
            .await?
        else {
            return Ok(None);
        };

        let Some(entry) = OpenedProjectsRepository::new(self.db.pool())
            .get_by_id(project_id)
            .await?
        else {
            return Ok(None);
        };

        Ok(Some(WorkspaceInfo {
            id: entry.id,
            name: entry.name.unwrap_or_else(|| folder_name(&entry.path)),
            path: entry.path,
        }))
    }
}

fn folder_name(path: &str) -> String {
    Path::new(path)
        .file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .unwrap_or_else(|| path.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn open_folder_records_it_as_active() {
        let dir = tempfile::tempdir().expect("tempdir");
        let db = Db::connect(&dir.path().join("test.db"))
            .await
            .expect("connect");
        let service = WorkspaceFolderService::new(db);

        let info = service.open_folder("C:/proj/my-app").await.expect("open");

        assert_eq!(info.name, "my-app");
        let active = service.active_workspace().await.expect("active");
        assert_eq!(active, Some(info));
    }

    #[tokio::test]
    async fn remember_folder_adds_a_recent_folder_but_keeps_the_saved_one() {
        let dir = tempfile::tempdir().expect("tempdir");
        let db = Db::connect(&dir.path().join("test.db"))
            .await
            .expect("connect");
        let service = WorkspaceFolderService::new(db);
        let main = service.open_folder("C:/proj/main-app").await.expect("open");

        let other = service
            .remember_folder("C:/proj/second app")
            .await
            .expect("remember");

        assert_eq!(other.name, "second app");
        assert_eq!(
            service.active_workspace().await.expect("active"),
            Some(main)
        );
        let recent = service.recent_folders(10).await.expect("recent");
        assert!(recent
            .iter()
            .any(|folder| folder.path == "C:/proj/second app"));
    }

    #[tokio::test]
    async fn active_workspace_is_none_before_opening_anything() {
        let dir = tempfile::tempdir().expect("tempdir");
        let db = Db::connect(&dir.path().join("test.db"))
            .await
            .expect("connect");
        let service = WorkspaceFolderService::new(db);

        assert_eq!(service.active_workspace().await.expect("active"), None);
    }

    #[tokio::test]
    async fn close_folder_clears_the_active_workspace() {
        let dir = tempfile::tempdir().expect("tempdir");
        let db = Db::connect(&dir.path().join("test.db"))
            .await
            .expect("connect");
        let service = WorkspaceFolderService::new(db);
        service.open_folder("C:/proj").await.expect("open");

        service.close_folder().await.expect("close");

        assert_eq!(service.active_workspace().await.expect("active"), None);
    }

    #[tokio::test]
    async fn opening_a_second_folder_switches_the_active_one() {
        let dir = tempfile::tempdir().expect("tempdir");
        let db = Db::connect(&dir.path().join("test.db"))
            .await
            .expect("connect");
        let service = WorkspaceFolderService::new(db);
        service.open_folder("C:/proj/a").await.expect("open a");

        service.open_folder("C:/proj/b").await.expect("open b");

        let active = service.active_workspace().await.expect("active");
        assert_eq!(active.map(|w| w.name), Some("b".to_string()));
    }

    #[tokio::test]
    async fn recent_folders_orders_most_recently_opened_first() {
        let dir = tempfile::tempdir().expect("tempdir");
        let db = Db::connect(&dir.path().join("test.db"))
            .await
            .expect("connect");
        let service = WorkspaceFolderService::new(db);
        service.open_folder("C:/proj/a").await.expect("open a");
        service.open_folder("C:/proj/b").await.expect("open b");
        service.open_folder("C:/proj/a").await.expect("re-open a");

        let recent = service.recent_folders(10).await.expect("recent");

        assert_eq!(recent[0].name, "a");
        assert_eq!(recent[1].name, "b");
    }
}
