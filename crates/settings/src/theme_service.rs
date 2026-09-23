use openmind_db::{Db, ThemeRepository};
use serde::{Deserialize, Serialize};

use crate::error::SettingsError;

/// Foundation-level theme selection: the two Monaco ships built in
/// (`vs-dark`/`vs`). Custom/JSON theme loading is a later milestone.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum ThemeKind {
    Dark,
    Light,
}

impl ThemeKind {
    fn as_str(self) -> &'static str {
        match self {
            ThemeKind::Dark => "dark",
            ThemeKind::Light => "light",
        }
    }

    fn parse(value: &str) -> Option<Self> {
        match value {
            "dark" => Some(ThemeKind::Dark),
            "light" => Some(ThemeKind::Light),
            _ => None,
        }
    }
}

#[derive(Clone)]
pub struct ThemeSettingService {
    db: Db,
}

impl ThemeSettingService {
    pub fn new(db: Db) -> Self {
        Self { db }
    }

    /// The saved theme, or `Dark` (this app's default) if nothing was saved
    /// yet or the stored value is unrecognized.
    pub async fn get(&self) -> Result<ThemeKind, SettingsError> {
        let stored = ThemeRepository::new(self.db.pool())
            .get_theme_name()
            .await?;
        Ok(stored
            .as_deref()
            .and_then(ThemeKind::parse)
            .unwrap_or(ThemeKind::Dark))
    }

    pub async fn set(&self, theme: ThemeKind) -> Result<(), SettingsError> {
        ThemeRepository::new(self.db.pool())
            .set_theme_name(theme.as_str())
            .await?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn get_defaults_to_dark_when_nothing_saved() {
        let dir = tempfile::tempdir().expect("tempdir");
        let db = Db::connect(&dir.path().join("test.db"))
            .await
            .expect("connect");
        let service = ThemeSettingService::new(db);

        assert_eq!(service.get().await.expect("get"), ThemeKind::Dark);
    }

    #[tokio::test]
    async fn set_then_get_round_trips() {
        let dir = tempfile::tempdir().expect("tempdir");
        let db = Db::connect(&dir.path().join("test.db"))
            .await
            .expect("connect");
        let service = ThemeSettingService::new(db);

        service.set(ThemeKind::Light).await.expect("set");

        assert_eq!(service.get().await.expect("get"), ThemeKind::Light);
    }
}
