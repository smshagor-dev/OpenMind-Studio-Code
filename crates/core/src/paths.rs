use std::path::{Path, PathBuf};

use crate::error::CoreError;

const DB_FILENAME: &str = "openmind-studio.db";
const SETTINGS_FILENAME: &str = "settings.json";
const KEYBINDINGS_FILENAME: &str = "keybindings.json";

/// Portable filesystem layout for the application: every path is resolved
/// relative to the directory containing the running executable, never a
/// per-user OS directory (`%APPDATA%`, `~/.config`, ...). This is what lets
/// OpenMind Studio run entirely from its own folder without admin rights.
/// On Linux/macOS a copy that can't write next to itself (a `.deb` in
/// `/usr/bin`, an AppImage's read-only mount) uses `$XDG_DATA_HOME/openmind-studio`
/// (default `~/.local/share/openmind-studio`) instead — see [`choose_root`].
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
    /// Resolve paths from the real running executable's location (see [`choose_root`]).
    pub fn resolve() -> Result<Self, CoreError> {
        let exe_path = std::env::current_exe().map_err(CoreError::ResolveExePath)?;
        let exe_dir = exe_dir_of(&exe_path);
        let windows = cfg!(windows);
        let appimage = std::env::var_os("APPIMAGE").is_some_and(|value| !value.is_empty());
        // Only probed where it can matter: Windows always uses the exe's folder.
        let writable = windows || (!appimage && dir_is_writable(&exe_dir));
        let root = choose_root(
            &exe_dir,
            RootFacts {
                windows,
                appimage,
                writable,
                xdg_data_home: std::env::var_os("XDG_DATA_HOME").map(PathBuf::from),
                home: std::env::var_os("HOME").map(PathBuf::from),
            },
        );
        Ok(Self::from_root(root))
    }

    /// Pure, unit-testable variant of [`Self::resolve`] taking the exe path
    /// as input instead of reading it from the environment (always the exe's folder).
    pub fn from_exe_path(exe_path: &Path) -> Self {
        Self::from_root(exe_dir_of(exe_path))
    }

    /// The layout under one root folder.
    pub fn from_root(root_dir: PathBuf) -> Self {
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

/// The folder holding the executable (`.` when it has none).
fn exe_dir_of(exe_path: &Path) -> PathBuf {
    match exe_path.parent() {
        Some(parent) if !parent.as_os_str().is_empty() => parent.to_path_buf(),
        _ => PathBuf::from("."),
    }
}

/// What [`choose_root`] decides from (read from the system by [`AppPaths::resolve`]).
#[derive(Debug, Clone, Default)]
pub struct RootFacts {
    pub windows: bool,
    /// Running from an AppImage (`$APPIMAGE` is set): its folder is a read-only mount.
    pub appimage: bool,
    /// A file can be created in the exe's folder.
    pub writable: bool,
    pub xdg_data_home: Option<PathBuf>,
    pub home: Option<PathBuf>,
}

/// The per-user data folder's name under `$XDG_DATA_HOME`.
const USER_DATA_FOLDER: &str = "openmind-studio";

/// The folder the app keeps its data in: the exe's folder on Windows, and elsewhere whenever the app can write there
/// (a portable copy); otherwise `$XDG_DATA_HOME/openmind-studio` (an absolute value only), else
/// `$HOME/.local/share/openmind-studio`. With neither variable it stays with the exe's folder (and start-up then reports
/// that the folder can't be created).
pub fn choose_root(exe_dir: &Path, facts: RootFacts) -> PathBuf {
    if facts.windows || (facts.writable && !facts.appimage) {
        return exe_dir.to_path_buf();
    }
    let base = facts
        .xdg_data_home
        .filter(|dir| dir.is_absolute())
        .or_else(|| {
            facts
                .home
                .filter(|dir| dir.is_absolute())
                .map(|home| home.join(".local").join("share"))
        });
    match base {
        Some(base) => base.join(USER_DATA_FOLDER),
        None => exe_dir.to_path_buf(),
    }
}

/// Whether a file can be created (and removed) in `dir`.
fn dir_is_writable(dir: &Path) -> bool {
    let probe = dir.join(format!(".openmind-write-test-{}", std::process::id()));
    match std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&probe)
    {
        Ok(file) => {
            drop(file);
            let _ = std::fs::remove_file(&probe);
            true
        }
        Err(_) => false,
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

    /// An absolute path on the host running the tests (`/x` or `C:/x`).
    fn abs(path: &str) -> PathBuf {
        PathBuf::from(if cfg!(windows) { "C:/" } else { "/" }).join(path)
    }

    fn facts(windows: bool, appimage: bool, writable: bool) -> RootFacts {
        RootFacts {
            windows,
            appimage,
            writable,
            xdg_data_home: None,
            home: Some(abs("home/ann")),
        }
    }

    #[test]
    fn windows_always_keeps_data_next_to_the_exe() {
        let exe_dir = Path::new("C:/Apps/OpenMind Studio");
        for (appimage, writable) in [(false, false), (true, true), (false, true)] {
            assert_eq!(
                choose_root(exe_dir, facts(true, appimage, writable)),
                exe_dir
            );
        }
    }

    #[test]
    fn a_writable_portable_copy_elsewhere_keeps_data_next_to_the_exe() {
        let exe_dir = Path::new("/home/ann/apps/OpenMind Studio");
        assert_eq!(choose_root(exe_dir, facts(false, false, true)), exe_dir);
    }

    #[test]
    fn a_deb_or_an_appimage_uses_the_users_data_folder() {
        let user = abs("home/ann/.local/share/openmind-studio");
        assert_eq!(
            choose_root(Path::new("/usr/bin"), facts(false, false, false)),
            user
        );
        assert_eq!(
            choose_root(Path::new("/tmp/.mount_OpenMiX"), facts(false, true, true)),
            user,
            "an AppImage mount is never the data folder"
        );
        let with_xdg = RootFacts {
            xdg_data_home: Some(abs("data/ann")),
            ..facts(false, false, false)
        };
        assert_eq!(
            choose_root(Path::new("/usr/bin"), with_xdg),
            abs("data/ann/openmind-studio")
        );
        let relative_xdg = RootFacts {
            xdg_data_home: Some(PathBuf::from("relative")),
            ..facts(false, false, false)
        };
        assert_eq!(choose_root(Path::new("/usr/bin"), relative_xdg), user);
        let nothing = RootFacts {
            home: None,
            ..facts(false, false, false)
        };
        assert_eq!(
            choose_root(Path::new("/usr/bin"), nothing),
            Path::new("/usr/bin")
        );
    }

    #[test]
    fn the_write_probe_leaves_nothing_behind() {
        let root = tempfile::tempdir().expect("tempdir");
        assert!(dir_is_writable(root.path()));
        assert_eq!(std::fs::read_dir(root.path()).expect("read").count(), 0);
        assert!(!dir_is_writable(&root.path().join("missing")));
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
