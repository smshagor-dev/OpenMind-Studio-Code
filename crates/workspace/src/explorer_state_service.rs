use openmind_db::{Db, ExplorerStateRepository, OpenedProjectsRepository};
use serde::{Deserialize, Serialize};

use crate::error::WorkspaceError;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "camelCase")]
pub struct ExplorerState {
    pub expanded_paths: Vec<String>,
    pub selected_path: Option<String>,
}

/// Persists explorer tree UI state (expanded folders, selection) per
/// workspace folder, keyed by path rather than the internal numeric
/// `opened_projects.id` — callers never need to know that id exists.
///
/// Deliberately does *not* call `OpenedProjectsRepository::touch` on save:
/// expanding/collapsing a tree node isn't "opening" the workspace again,
/// and touching here would corrupt the recent-folders ordering every time
/// the user interacts with the tree.
#[derive(Clone)]
pub struct ExplorerStateService {
    db: Db,
}

impl ExplorerStateService {
    pub fn new(db: Db) -> Self {
        Self { db }
    }

    pub async fn load(&self, workspace_path: &str) -> Result<ExplorerState, WorkspaceError> {
        let Some(project) = OpenedProjectsRepository::new(self.db.pool())
            .get_by_path(workspace_path)
            .await?
        else {
            return Ok(ExplorerState::default());
        };

        match ExplorerStateRepository::new(self.db.pool())
            .load(project.id)
            .await?
        {
            Some(row) => Ok(ExplorerState {
                expanded_paths: serde_json::from_str(&row.expanded_paths_json)?,
                selected_path: row.selected_path,
            }),
            None => Ok(ExplorerState::default()),
        }
    }

    pub async fn save(
        &self,
        workspace_path: &str,
        state: &ExplorerState,
    ) -> Result<(), WorkspaceError> {
        let Some(project) = OpenedProjectsRepository::new(self.db.pool())
            .get_by_path(workspace_path)
            .await?
        else {
            return Ok(());
        };

        let expanded_json = serde_json::to_string(&state.expanded_paths)?;
        ExplorerStateRepository::new(self.db.pool())
            .save(project.id, &expanded_json, state.selected_path.as_deref())
            .await?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use openmind_db::OpenedProjectsRepository as ProjectsRepo;

    #[tokio::test]
    async fn load_returns_default_when_workspace_unknown() {
        let dir = tempfile::tempdir().expect("tempdir");
        let db = Db::connect(&dir.path().join("test.db"))
            .await
            .expect("connect");
        let service = ExplorerStateService::new(db);

        assert_eq!(
            service.load("C:/unknown").await.expect("load"),
            ExplorerState::default()
        );
    }

    #[tokio::test]
    async fn save_then_load_round_trips() {
        let dir = tempfile::tempdir().expect("tempdir");
        let db = Db::connect(&dir.path().join("test.db"))
            .await
            .expect("connect");
        ProjectsRepo::new(db.pool())
            .touch("C:/proj", None, false)
            .await
            .expect("touch project");
        let service = ExplorerStateService::new(db);

        let state = ExplorerState {
            expanded_paths: vec!["src".to_string(), "src/services".to_string()],
            selected_path: Some("src/App.tsx".to_string()),
        };
        service.save("C:/proj", &state).await.expect("save");

        assert_eq!(service.load("C:/proj").await.expect("load"), state);
    }

    #[tokio::test]
    async fn save_for_unknown_workspace_is_a_no_op_not_an_error() {
        let dir = tempfile::tempdir().expect("tempdir");
        let db = Db::connect(&dir.path().join("test.db"))
            .await
            .expect("connect");
        let service = ExplorerStateService::new(db);

        let result = service
            .save(
                "C:/unknown",
                &ExplorerState {
                    expanded_paths: vec!["src".to_string()],
                    selected_path: None,
                },
            )
            .await;

        assert!(result.is_ok());
    }

    #[tokio::test]
    async fn save_does_not_bump_the_workspaces_recency() {
        let dir = tempfile::tempdir().expect("tempdir");
        let db = Db::connect(&dir.path().join("test.db"))
            .await
            .expect("connect");
        let projects = ProjectsRepo::new(db.pool());
        projects.touch("C:/a", None, false).await.expect("touch a");
        projects.touch("C:/b", None, false).await.expect("touch b");
        let service = ExplorerStateService::new(db.clone());

        // "a" is the older folder; saving its explorer state must not make
        // it look more recently opened than "b".
        service
            .save(
                "C:/a",
                &ExplorerState {
                    expanded_paths: vec!["src".to_string()],
                    selected_path: None,
                },
            )
            .await
            .expect("save");

        let recent = projects.list_recent(10).await.expect("list");
        assert_eq!(recent[0].path, "C:/b");
        assert_eq!(recent[1].path, "C:/a");
    }
}
