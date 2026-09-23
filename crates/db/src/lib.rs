pub mod editor_settings;
pub mod error;
pub mod explorer_state;
pub mod opened_projects;
pub mod pinned_folders;
pub mod recent_files;
pub mod session;
pub mod theme;
pub mod window_state;

use std::path::Path;

use sqlx::sqlite::{SqliteConnectOptions, SqliteJournalMode, SqlitePoolOptions};
use sqlx::SqlitePool;

pub use editor_settings::EditorSettingsRepository;
pub use error::DbError;
pub use explorer_state::{ExplorerStateRepository, ExplorerStateRow};
pub use opened_projects::{OpenedProjectEntry, OpenedProjectsRepository};
pub use pinned_folders::{PinnedFolderEntry, PinnedFoldersRepository};
pub use recent_files::{RecentFileEntry, RecentFilesRepository};
pub use session::SessionRepository;
pub use theme::ThemeRepository;
pub use window_state::{WindowState, WindowStateRepository};

/// A connected, migrated, WAL-mode SQLite database.
#[derive(Clone)]
pub struct Db {
    pool: SqlitePool,
}

impl Db {
    /// Open (creating if missing) the SQLite database at `db_path`, enable
    /// WAL journaling, and run all embedded migrations.
    pub async fn connect(db_path: &Path) -> Result<Self, DbError> {
        if let Some(parent) = db_path.parent() {
            std::fs::create_dir_all(parent).map_err(|source| DbError::CreateDataDir {
                path: parent.to_path_buf(),
                source,
            })?;
        }

        let options = SqliteConnectOptions::new()
            .filename(db_path)
            .create_if_missing(true)
            .journal_mode(SqliteJournalMode::Wal);

        let pool = SqlitePoolOptions::new()
            .max_connections(8)
            .connect_with(options)
            .await
            .map_err(DbError::Connect)?;

        sqlx::migrate!("./migrations")
            .run(&pool)
            .await
            .map_err(DbError::Migrate)?;

        Ok(Self { pool })
    }

    pub fn pool(&self) -> &SqlitePool {
        &self.pool
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use sqlx::Row;

    #[tokio::test]
    async fn connect_creates_data_dir_and_all_tables() {
        let dir = tempfile::tempdir().expect("tempdir");
        let nested_path = dir.path().join("nested").join("openmind-studio.db");

        let db = Db::connect(&nested_path).await.expect("connect");

        assert!(nested_path.exists());

        let expected_tables = [
            "editor_settings",
            "workspace_settings",
            "opened_projects",
            "recent_files",
            "pinned_folders",
            "terminal_history",
            "search_history",
            "extensions",
            "installed_runtimes",
            "ai_settings",
            "theme",
            "window_state",
            "keybindings",
            "bookmarks",
            "breakpoints",
            "git_settings",
            "session_restore",
            "plugin_registry",
            "download_cache",
            "explorer_state",
        ];

        for table in expected_tables {
            let row =
                sqlx::query("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?1")
                    .bind(table)
                    .fetch_optional(db.pool())
                    .await
                    .expect("query sqlite_master");
            assert!(row.is_some(), "expected table `{table}` to exist");
        }
    }

    #[tokio::test]
    async fn connect_enables_wal_journal_mode() {
        let dir = tempfile::tempdir().expect("tempdir");
        let db_path = dir.path().join("openmind-studio.db");

        let db = Db::connect(&db_path).await.expect("connect");

        let row = sqlx::query("PRAGMA journal_mode")
            .fetch_one(db.pool())
            .await
            .expect("pragma query");
        let mode: String = row.get(0);

        assert_eq!(mode.to_lowercase(), "wal");
    }
}
