use std::path::{Path, PathBuf};

use crate::error::CoreError;

const DB_FILENAME: &str = "openmind-studio.db";
const SETTINGS_FILENAME: &str = "settings.json";
const KEYBINDINGS_FILENAME: &str = "keybindings.json";

/// Portable filesystem layout for the application: every path is resolved
/// relative to the directory containing the running executable, never a
/// per-user OS directory (`%APPDATA%`, `~/.config`, ...). This is what lets
/// OpenMind Studio run entirely from its own folder without admin rights.
///
/// Layout, all rooted at `root_dir` (the portable install directory):
///
/// ```text
/// OpenMind Studio/
///     data/openmind-studio.db   SQLite (WAL) — see openmind_db
///     data/webview/             the WebView2 profile
///     logs/                     structured log output (future milestone)
///     cache/                    download_cache contents (future milestone)
///     runtimes/                 installed portable runtimes (future milestone)
///     extensions/               installed extension packages (future milestone)
///     themes/                   on-disk theme/icon-theme assets (future milestone)
///     settings/                 settings.json and keybindings.json (user-editable)
/// ```
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AppPaths {
    pub root_dir: PathBuf,
    pub data_dir: PathBuf,
    pub db_path: PathBuf,
    /// The WebView2 profile (cache, local storage, cookies): under `data/`, never `%LOCALAPPDATA%`.
    pub webview_dir: PathBuf,
    pub logs_dir: PathBuf,
    pub cache_dir: PathBuf,
    pub runtimes_dir: PathBuf,
    pub extensions_dir: PathBuf,
    pub themes_dir: PathBuf,
    pub settings_dir: PathBuf,
    /// The user settings file (`settings/settings.json`), edited by the Settings page or by hand.
    pub settings_file: PathBuf,
    /// The user keybindings file (`settings/keybindings.json`).
    pub keybindings_file: PathBuf,
}

impl AppPaths {
    /// Resolve paths from the real running executable's location.
    pub fn resolve() -> Result<Self, CoreError> {
        let exe_path = std::env::current_exe().map_err(CoreError::ResolveExePath)?;
        Ok(Self::from_exe_path(&exe_path))
    }

    /// Pure, unit-testable variant of [`Self::resolve`] taking the exe path
    /// as input instead of reading it from the environment.
    pub fn from_exe_path(exe_path: &Path) -> Self {
        let root_dir = match exe_path.parent() {
            Some(parent) if !parent.as_os_str().is_empty() => parent.to_path_buf(),
            _ => PathBuf::from("."),
        };
        let data_dir = root_dir.join("data");
        let db_path = data_dir.join(DB_FILENAME);
        let webview_dir = data_dir.join("webview");
        let settings_dir = root_dir.join("settings");

        Self {
            logs_dir: root_dir.join("logs"),
            cache_dir: root_dir.join("cache"),
            runtimes_dir: root_dir.join("runtimes"),
            extensions_dir: root_dir.join("extensions"),
            themes_dir: root_dir.join("themes"),
            settings_file: settings_dir.join(SETTINGS_FILENAME),
            keybindings_file: settings_dir.join(KEYBINDINGS_FILENAME),
            settings_dir,
            root_dir,
            data_dir,
            db_path,
            webview_dir,
        }
    }

    /// Create every directory in the portable layout if it doesn't exist yet.
    pub fn ensure_dirs(&self) -> Result<(), CoreError> {
        for dir in [
            &self.data_dir,
            &self.logs_dir,
            &self.cache_dir,
            &self.runtimes_dir,
            &self.extensions_dir,
            &self.themes_dir,
            &self.settings_dir,
        ] {
            std::fs::create_dir_all(dir).map_err(|source| CoreError::CreateDir {
                path: dir.clone(),
                source,
            })?;
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn resolves_full_layout_next_to_exe() {
        let exe_path = Path::new("C:/Apps/OpenMind Studio/openmind-studio.exe");

        let paths = AppPaths::from_exe_path(exe_path);

        let root = Path::new("C:/Apps/OpenMind Studio");
        assert_eq!(paths.root_dir, root);
        assert_eq!(paths.data_dir, root.join("data"));
        assert_eq!(paths.db_path, root.join("data/openmind-studio.db"));
        assert_eq!(paths.webview_dir, root.join("data/webview"));
        assert_eq!(paths.logs_dir, root.join("logs"));
        assert_eq!(paths.cache_dir, root.join("cache"));
        assert_eq!(paths.runtimes_dir, root.join("runtimes"));
        assert_eq!(paths.extensions_dir, root.join("extensions"));
        assert_eq!(paths.themes_dir, root.join("themes"));
        assert_eq!(paths.settings_dir, root.join("settings"));
        assert_eq!(paths.settings_file, root.join("settings/settings.json"));
        assert_eq!(
            paths.keybindings_file,
            root.join("settings/keybindings.json")
        );
    }

    #[test]
    fn every_path_stays_under_the_exe_folder_even_with_spaces_and_no_appdata() {
        let exe_path = Path::new("D:/Portable Apps/OpenMind Studio/OpenMindStudio.exe");
        let paths = AppPaths::from_exe_path(exe_path);
        for path in [
            &paths.data_dir,
            &paths.db_path,
            &paths.webview_dir,
            &paths.logs_dir,
            &paths.cache_dir,
            &paths.runtimes_dir,
            &paths.extensions_dir,
            &paths.themes_dir,
            &paths.settings_dir,
            &paths.settings_file,
            &paths.keybindings_file,
        ] {
            assert!(
                path.starts_with("D:/Portable Apps/OpenMind Studio"),
                "{path:?} left the app folder"
            );
            assert!(!path.to_string_lossy().to_lowercase().contains("appdata"));
        }
        assert_eq!(
            paths.db_path.file_name().and_then(|n| n.to_str()),
            Some("openmind-studio.db")
        );
    }

    #[test]
    fn falls_back_to_current_dir_when_exe_has_no_parent() {
        let exe_path = Path::new("openmind-studio.exe");

        let paths = AppPaths::from_exe_path(exe_path);

        assert_eq!(paths.root_dir, Path::new("."));
        assert_eq!(paths.data_dir, Path::new("./data"));
    }

    #[test]
    fn ensure_dirs_creates_the_full_layout() {
        let root = tempfile::tempdir().expect("tempdir");
        let exe_path = root.path().join("openmind-studio.exe");

        let paths = AppPaths::from_exe_path(&exe_path);
        paths.ensure_dirs().expect("ensure_dirs should succeed");

        for dir in [
            &paths.data_dir,
            &paths.logs_dir,
            &paths.cache_dir,
            &paths.runtimes_dir,
            &paths.extensions_dir,
            &paths.themes_dir,
            &paths.settings_dir,
        ] {
            assert!(dir.is_dir(), "expected {dir:?} to exist");
        }
    }
}
