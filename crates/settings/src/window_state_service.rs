use codeforge_db::{Db, WindowState, WindowStateRepository};

use crate::error::SettingsError;

pub const MAIN_WINDOW_LABEL: &str = "main";
const DEFAULT_WIDTH: f64 = 1280.0;
const DEFAULT_HEIGHT: f64 = 800.0;

/// Business logic over the `window_state` table: default-fallback plus
/// persistence, so callers never have to think about the "no row yet" case.
#[derive(Clone)]
pub struct WindowStateService {
    db: Db,
}

impl WindowStateService {
    pub fn new(db: Db) -> Self {
        Self { db }
    }

    /// Load the saved geometry for `label`, or a sensible default
    /// (1280x800, unpositioned, not maximized) if none was saved yet.
    pub async fn load(&self, label: &str) -> Result<WindowState, SettingsError> {
        let repo = WindowStateRepository::new(self.db.pool());
        match repo.get(label).await? {
            Some(state) => Ok(state),
            None => Ok(Self::default_state(label)),
        }
    }

    pub async fn save(&self, state: &WindowState) -> Result<(), SettingsError> {
        let repo = WindowStateRepository::new(self.db.pool());
        repo.save(state).await?;
        Ok(())
    }

    fn default_state(label: &str) -> WindowState {
        WindowState {
            label: label.to_string(),
            width: DEFAULT_WIDTH,
            height: DEFAULT_HEIGHT,
            x: None,
            y: None,
            maximized: false,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn load_returns_default_when_nothing_saved() {
        let dir = tempfile::tempdir().expect("tempdir");
        let db = Db::connect(&dir.path().join("test.db"))
            .await
            .expect("connect");
        let service = WindowStateService::new(db);

        let state = service.load(MAIN_WINDOW_LABEL).await.expect("load");

        assert_eq!(state.label, MAIN_WINDOW_LABEL);
        assert_eq!(state.width, DEFAULT_WIDTH);
        assert_eq!(state.height, DEFAULT_HEIGHT);
        assert_eq!(state.x, None);
        assert_eq!(state.y, None);
        assert!(!state.maximized);
    }

    #[tokio::test]
    async fn save_then_load_round_trips() {
        let dir = tempfile::tempdir().expect("tempdir");
        let db = Db::connect(&dir.path().join("test.db"))
            .await
            .expect("connect");
        let service = WindowStateService::new(db);

        let saved = WindowState {
            label: MAIN_WINDOW_LABEL.to_string(),
            width: 1600.0,
            height: 900.0,
            x: Some(40.0),
            y: Some(60.0),
            maximized: true,
        };
        service.save(&saved).await.expect("save");

        let loaded = service.load(MAIN_WINDOW_LABEL).await.expect("load");

        assert_eq!(loaded, saved);
    }
}
