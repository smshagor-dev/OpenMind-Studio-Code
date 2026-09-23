use openmind_db::{Db, SessionRepository};
use serde::{Deserialize, Serialize};

use crate::error::WorkspaceError;

/// Everything needed to restore the previous session's open tabs. Encoding
/// and line-ending aren't part of this — they're properties of the file's
/// bytes, redetected naturally when each path is reopened on restore.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "camelCase")]
pub struct SessionSnapshot {
    pub open_paths: Vec<String>,
    pub active_path: Option<String>,
}

#[derive(Clone)]
pub struct SessionService {
    db: Db,
}

impl SessionService {
    pub fn new(db: Db) -> Self {
        Self { db }
    }

    /// The previous session, or an empty snapshot if none was saved yet.
    pub async fn load(&self) -> Result<SessionSnapshot, WorkspaceError> {
        let repo = SessionRepository::new(self.db.pool());
        match repo.load().await? {
            Some(json) => Ok(serde_json::from_str(&json)?),
            None => Ok(SessionSnapshot::default()),
        }
    }

    pub async fn save(&self, snapshot: &SessionSnapshot) -> Result<(), WorkspaceError> {
        let json = serde_json::to_string(snapshot)?;
        SessionRepository::new(self.db.pool()).save(&json).await?;
        Ok(())
    }

    pub async fn clear(&self) -> Result<(), WorkspaceError> {
        SessionRepository::new(self.db.pool()).clear().await?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn load_returns_empty_snapshot_when_nothing_saved() {
        let dir = tempfile::tempdir().expect("tempdir");
        let db = Db::connect(&dir.path().join("test.db"))
            .await
            .expect("connect");
        let service = SessionService::new(db);

        assert_eq!(
            service.load().await.expect("load"),
            SessionSnapshot::default()
        );
    }

    #[tokio::test]
    async fn save_then_load_round_trips() {
        let dir = tempfile::tempdir().expect("tempdir");
        let db = Db::connect(&dir.path().join("test.db"))
            .await
            .expect("connect");
        let service = SessionService::new(db);

        let snapshot = SessionSnapshot {
            open_paths: vec!["a.rs".to_string(), "b.rs".to_string()],
            active_path: Some("b.rs".to_string()),
        };
        service.save(&snapshot).await.expect("save");

        assert_eq!(service.load().await.expect("load"), snapshot);
    }

    #[tokio::test]
    async fn clear_resets_to_empty_snapshot() {
        let dir = tempfile::tempdir().expect("tempdir");
        let db = Db::connect(&dir.path().join("test.db"))
            .await
            .expect("connect");
        let service = SessionService::new(db);

        service
            .save(&SessionSnapshot {
                open_paths: vec!["a.rs".to_string()],
                active_path: Some("a.rs".to_string()),
            })
            .await
            .expect("save");
        service.clear().await.expect("clear");

        assert_eq!(
            service.load().await.expect("load"),
            SessionSnapshot::default()
        );
    }
}
