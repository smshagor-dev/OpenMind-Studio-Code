use std::path::{Path, PathBuf};

use crate::data_scope::DataScope;
use crate::error::CoreError;
use crate::install::InstallLayout;
use crate::machine_paths::MachineDataPaths;

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
///
/// That is the [`DataScope::Personal`] layout. In the [`DataScope::PerMachine`] scope ([`Self::per_machine`]) the
/// machine-specific parts — the database, logs, WebView profile, search index, AI history, temporary files, MariaDB's
/// data/logs/config, phpMyAdmin's cache, asm-lsp's generated configuration and the extension host log — live in
/// `data/machines/<profile id>/` ([`MachineDataPaths`]) instead, while runtimes, tools, language servers, extensions,
/// settings and downloads stay shared. Nothing else in the app builds those paths: it takes them from here.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AppPaths {
    pub root_dir: PathBuf,
    /// Which layout the machine-specific paths below follow.
    pub scope: DataScope,
    /// This computer's folder in the per-computer scope.
    pub machine: Option<MachineDataPaths>,
    /// The shared `data/` folder (also the parent of `machines/` and `backups/`).
    pub data_dir: PathBuf,
    /// The SQLite database this run opens.
    pub db_path: PathBuf,
    /// `data/openmind-studio.db`: the one-profile database, whichever scope is in force (for migrations).
    pub shared_db_path: PathBuf,
    /// The workspace search index (one SQLite file per folder).
    pub search_index_dir: PathBuf,
    /// AI provider list and conversation history.
    pub ai_dir: PathBuf,
    /// Short-lived files: download staging, update downloads, the per-run npm config.
    pub temp_dir: PathBuf,
    /// Small caches that belong to one computer (phpMyAdmin's generated configuration); big downloads stay in the
    /// shared `cache_dir`.
    pub machine_cache_dir: PathBuf,
    /// MariaDB's data directory, log folder and generated `my.ini` folder.
    pub mariadb_data_dir: PathBuf,
    pub mariadb_logs_dir: PathBuf,
    pub mariadb_config_dir: PathBuf,
    /// asm-lsp's generated `.asm-lsp.toml` (it holds this computer's absolute NASM path).
    pub asm_lsp_config_dir: PathBuf,
    /// The extension host's log (`extension-host.log`).
    pub extension_logs_dir: PathBuf,
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
    /// How this copy was installed (see [`crate::install`]); decides where the writable state lives.
    pub layout: InstallLayout,
    /// The program's own folder: the read-only files shipped with it (`lsp/`, `python-bundle/`, `bin/`). The same as
    /// `root_dir` except where the program's folder is not where its data goes (the per-machine install).
    pub install_dir: PathBuf,
    /// `settings/` of the installation itself: shared definitions an administrator can add for every computer
    /// (`runtime-manifests/`). The same as `settings_dir` except in a network installation.
    pub shared_settings_dir: PathBuf,
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

    /// The one-profile ([`DataScope::Personal`]) layout under one root folder — the layout of every earlier version.
    pub fn from_root(root_dir: PathBuf) -> Self {
        let data_dir = root_dir.join("data");
        let db_path = data_dir.join(DB_FILENAME);
        let webview_dir = data_dir.join("webview");
        let settings_dir = root_dir.join("settings");
        let logs_dir = root_dir.join("logs");

        Self {
            scope: DataScope::Personal,
            machine: None,
            layout: InstallLayout::Portable,
            install_dir: root_dir.clone(),
            shared_settings_dir: settings_dir.clone(),
            shared_db_path: db_path.clone(),
            search_index_dir: data_dir.join("search-index"),
            ai_dir: data_dir.join("ai"),
            temp_dir: root_dir.join("temp"),
            machine_cache_dir: root_dir.join("cache"),
            mariadb_data_dir: data_dir.join("mariadb"),
            mariadb_logs_dir: logs_dir.join("mariadb"),
            mariadb_config_dir: settings_dir.join("mariadb"),
            asm_lsp_config_dir: settings_dir.join("asm-lsp"),
            extension_logs_dir: root_dir.join("extensions").join("logs"),
            logs_dir,
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

    /// The per-computer layout: the machine-specific paths in `machine`'s folder (found by
    /// [`crate::machine_paths::select_profile`]), everything else shared with [`Self::from_root`].
    pub fn per_machine(root_dir: PathBuf, machine: MachineDataPaths) -> Self {
        let shared = Self::from_root(root_dir);
        Self {
            scope: DataScope::PerMachine,
            db_path: machine.database.clone(),
            logs_dir: machine.logs.clone(),
            webview_dir: machine.state.join("webview"),
            search_index_dir: machine.state.join("search-index"),
            ai_dir: machine.state.join("ai"),
            temp_dir: machine.temp.clone(),
            machine_cache_dir: machine.cache.clone(),
            mariadb_data_dir: machine.state.join("mariadb"),
            mariadb_logs_dir: machine.logs.join("mariadb"),
            mariadb_config_dir: machine.state.join("mariadb-config"),
            asm_lsp_config_dir: machine.state.join("asm-lsp"),
            extension_logs_dir: machine.logs.join("extensions"),
            machine: Some(machine),
            ..shared
        }
    }

    /// The same paths, recorded as installed with `layout` (the per-user setup keeps the one-profile layout next to the
    /// program).
    pub fn with_layout(mut self, layout: InstallLayout) -> Self {
        self.layout = layout;
        self
    }

    /// The per-machine install (Program Files, read-only for users): every Windows user's whole layout — database,
    /// settings, runtimes, tools, language servers, extensions — in their own `local_dir`
    /// ([`crate::install::local_install_dir`]); only the files shipped with the program are read from `install_dir`.
    pub fn per_machine_install(install_dir: PathBuf, local_dir: PathBuf) -> Self {
        Self {
            layout: InstallLayout::PerMachine,
            install_dir,
            ..Self::from_root(local_dir)
        }
    }

    /// A network installation: the program, runtimes, tools, language servers, extensions and downloads are shared in
    /// `install_dir` (installed once for every computer); the database, logs, WebView profile, search index, AI history,
    /// temporary files, MariaDB's folders **and the settings** are this computer's and this Windows user's, in `local`
    /// (on the computer's own disk — SQLite never runs over the network).
    pub fn network(install_dir: PathBuf, local: MachineDataPaths) -> Self {
        let settings_dir = local.root.join("settings");
        let shared = Self::per_machine(install_dir.clone(), local);
        Self {
            layout: InstallLayout::Network,
            install_dir,
            settings_file: settings_dir.join(SETTINGS_FILENAME),
            keybindings_file: settings_dir.join(KEYBINDINGS_FILENAME),
            settings_dir,
            ..shared
        }
    }

    /// A file or folder shipped with the program (`lsp`, `python-bundle` ...).
    pub fn shipped(&self, name: &str) -> PathBuf {
        self.install_dir.join(name)
    }

    /// Create every directory in the layout if it doesn't exist yet (and, per computer, its `machine.json`). In a
    /// network installation the shared folders are only created when possible: users often may only read the share,
    /// and an administrator creates them when installing.
    pub fn ensure_dirs(&self) -> Result<(), CoreError> {
        if self.layout == InstallLayout::Network {
            return self.ensure_network_dirs();
        }
        if let Some(machine) = &self.machine {
            machine
                .ensure_dirs()
                .map_err(|source| CoreError::CreateDir {
                    path: machine.root.clone(),
                    source,
                })?;
        }
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

    fn ensure_network_dirs(&self) -> Result<(), CoreError> {
        let machine = self.machine.as_ref().ok_or_else(|| CoreError::CreateDir {
            path: self.db_path.clone(),
            source: std::io::Error::other(
                "a network installation needs this computer's local folder",
            ),
        })?;
        for dir in [
            &machine.root,
            &machine.logs,
            &machine.cache,
            &machine.state,
            &machine.temp,
            &self.settings_dir,
        ] {
            std::fs::create_dir_all(dir).map_err(|source| CoreError::CreateDir {
                path: dir.clone(),
                source,
            })?;
        }
        for dir in [
            &self.cache_dir,
            &self.runtimes_dir,
            &self.extensions_dir,
            &self.themes_dir,
        ] {
            if let Err(err) = std::fs::create_dir_all(dir) {
                tracing::warn!(path = %dir.display(), error = %err, "a shared folder of the network installation can't be created here; it is used read-only");
            }
        }
        Ok(())
    }
}

/// A folder shipped with the program (`lsp`, `python-bundle`): `<app_root>/<name>` when it is there, else next to the
/// running program — where the per-machine install keeps it while each user's data folder is elsewhere.
pub fn shipped_dir(app_root: &Path, name: &str) -> PathBuf {
    let in_root = app_root.join(name);
    if in_root.exists() {
        return in_root;
    }
    std::env::current_exe()
        .ok()
        .map(|exe| exe_dir_of(&exe).join(name))
        .filter(|beside| beside.exists())
        .unwrap_or(in_root)
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

/// Whether `exe_dir` is a macOS app bundle's `<name>.app/Contents/MacOS` folder.
pub fn is_macos_bundle_dir(exe_dir: &Path) -> bool {
    let mut parts = exe_dir.components().rev().map(|part| part.as_os_str());
    parts.next() == Some("MacOS".as_ref())
        && parts.next() == Some("Contents".as_ref())
        && parts
            .next()
            .and_then(|name| name.to_str())
            .is_some_and(|name| name.to_ascii_lowercase().ends_with(".app"))
}

/// The folder the app keeps its data in: the exe's folder on Windows, and elsewhere whenever the app can write there
/// (a portable copy); otherwise `$XDG_DATA_HOME/openmind-studio` (an absolute value only), else
/// `$HOME/.local/share/openmind-studio`. With neither variable it stays with the exe's folder (and start-up then reports
/// that the folder can't be created).
///
/// A macOS app bundle is never the data folder, even when it is writable: writing into `*.app` invalidates its code
/// signature and macOS may run it from a read-only, randomized location (App Translocation). Its data goes to
/// `~/Library/Application Support/OpenMind Studio/Data` (beside the `Installations` folder kept there).
pub fn choose_root(exe_dir: &Path, facts: RootFacts) -> PathBuf {
    if !facts.windows && is_macos_bundle_dir(exe_dir) {
        if let Some(home) = facts.home.as_ref().filter(|dir| dir.is_absolute()) {
            return home
                .join("Library")
                .join("Application Support")
                .join("OpenMind Studio")
                .join("Data");
        }
    }
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
    fn a_macos_app_bundle_keeps_its_data_in_application_support_never_inside_the_bundle() {
        let bundle = Path::new("/Applications/OpenMind Studio.app/Contents/MacOS");
        assert!(is_macos_bundle_dir(bundle));
        let expected = abs("home/ann")
            .join("Library")
            .join("Application Support")
            .join("OpenMind Studio")
            .join("Data");
        for writable in [true, false] {
            assert_eq!(choose_root(bundle, facts(false, false, writable)), expected);
        }
        // Not a bundle: a bare binary or a folder merely named MacOS keeps the usual rules.
        assert!(!is_macos_bundle_dir(Path::new("/Users/ann/OpenMind/MacOS")));
        assert!(!is_macos_bundle_dir(Path::new(
            "/Users/ann/OpenMind Studio"
        )));
        assert_eq!(
            choose_root(
                Path::new("/Users/ann/OpenMind Studio"),
                facts(false, false, true)
            ),
            Path::new("/Users/ann/OpenMind Studio")
        );
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

    fn machine(root: &Path, id: &str) -> MachineDataPaths {
        MachineDataPaths::new(root, id)
    }

    #[test]
    fn the_per_computer_scope_isolates_machine_data_and_shares_the_heavy_folders() {
        let root = PathBuf::from("G:/OpenMind-Studio");
        let a = AppPaths::per_machine(root.clone(), machine(&root, "42f693bd91a7"));
        let b = AppPaths::per_machine(root.clone(), machine(&root, "a591cc273781"));
        let machine_a = root.join("data/machines/42f693bd91a7");
        assert_eq!(a.db_path, machine_a.join("openmind-studio.db"));
        assert_eq!(a.logs_dir, machine_a.join("logs"));
        assert_eq!(a.webview_dir, machine_a.join("state/webview"));
        assert_eq!(a.search_index_dir, machine_a.join("state/search-index"));
        assert_eq!(a.ai_dir, machine_a.join("state/ai"));
        assert_eq!(a.temp_dir, machine_a.join("temp"));
        assert_eq!(a.machine_cache_dir, machine_a.join("cache"));
        assert_eq!(a.mariadb_data_dir, machine_a.join("state/mariadb"));
        assert_eq!(a.mariadb_logs_dir, machine_a.join("logs/mariadb"));
        assert_eq!(a.mariadb_config_dir, machine_a.join("state/mariadb-config"));
        assert_eq!(a.asm_lsp_config_dir, machine_a.join("state/asm-lsp"));
        assert_eq!(a.extension_logs_dir, machine_a.join("logs/extensions"));
        for (left, right) in [
            (&a.db_path, &b.db_path),
            (&a.logs_dir, &b.logs_dir),
            (&a.webview_dir, &b.webview_dir),
            (&a.search_index_dir, &b.search_index_dir),
            (&a.ai_dir, &b.ai_dir),
            (&a.temp_dir, &b.temp_dir),
            (&a.machine_cache_dir, &b.machine_cache_dir),
            (&a.mariadb_data_dir, &b.mariadb_data_dir),
            (&a.mariadb_logs_dir, &b.mariadb_logs_dir),
            (&a.mariadb_config_dir, &b.mariadb_config_dir),
            (&a.asm_lsp_config_dir, &b.asm_lsp_config_dir),
            (&a.extension_logs_dir, &b.extension_logs_dir),
        ] {
            assert_ne!(left, right, "two computers never share {left:?}");
            assert!(
                left.starts_with(&machine_a),
                "{left:?} is inside A's profile"
            );
        }
        for (left, right) in [
            (&a.runtimes_dir, &b.runtimes_dir),
            (&a.cache_dir, &b.cache_dir),
            (&a.extensions_dir, &b.extensions_dir),
            (&a.settings_dir, &b.settings_dir),
            (&a.themes_dir, &b.themes_dir),
            (&a.shared_db_path, &b.shared_db_path),
        ] {
            assert_eq!(left, right, "shared on the drive");
            assert!(
                !left.starts_with(root.join("data/machines")),
                "{left:?} is not per computer"
            );
        }
        assert_eq!(a.runtimes_dir, root.join("runtimes"));
        assert_eq!(a.cache_dir, root.join("cache"));
        assert_eq!(a.shared_db_path, root.join("data/openmind-studio.db"));
    }

    #[test]
    fn the_personal_scope_is_the_earlier_layout() {
        let root = PathBuf::from("C:/Apps/OpenMind Studio");
        let personal = AppPaths::from_root(root.clone());
        assert_eq!(personal.scope, DataScope::Personal);
        assert_eq!(personal.db_path, root.join("data/openmind-studio.db"));
        assert_eq!(personal.temp_dir, root.join("temp"));
        assert_eq!(personal.mariadb_data_dir, root.join("data/mariadb"));
        assert_eq!(personal.mariadb_logs_dir, root.join("logs/mariadb"));
        assert_eq!(personal.mariadb_config_dir, root.join("settings/mariadb"));
        assert_eq!(personal.asm_lsp_config_dir, root.join("settings/asm-lsp"));
        assert_eq!(personal.extension_logs_dir, root.join("extensions/logs"));
        assert!(personal.machine.is_none());
    }

    #[test]
    fn a_new_drive_letter_keeps_the_same_profile_folder() {
        let on_g = AppPaths::per_machine(
            PathBuf::from("G:/OpenMind-Studio"),
            machine(Path::new("G:/OpenMind-Studio"), "42f693bd91a7"),
        );
        let on_h = AppPaths::per_machine(
            PathBuf::from("H:/OpenMind-Studio"),
            machine(Path::new("H:/OpenMind-Studio"), "42f693bd91a7"),
        );
        assert_eq!(
            on_g.db_path
                .strip_prefix("G:/OpenMind-Studio")
                .expect("inside"),
            on_h.db_path
                .strip_prefix("H:/OpenMind-Studio")
                .expect("inside")
        );
        assert_eq!(
            on_g.runtimes_dir
                .strip_prefix("G:/OpenMind-Studio")
                .expect("inside"),
            on_h.runtimes_dir
                .strip_prefix("H:/OpenMind-Studio")
                .expect("inside")
        );
    }

    #[test]
    fn ensure_dirs_creates_the_machine_folder_and_the_shared_ones() {
        let root = tempfile::tempdir().expect("tempdir");
        let paths = AppPaths::per_machine(
            root.path().to_path_buf(),
            machine(root.path(), "d33ac401128a"),
        );
        paths.ensure_dirs().expect("ensure");
        let machine = paths.machine.as_ref().expect("machine");
        assert!(machine.temp.is_dir());
        assert!(paths.logs_dir.is_dir());
        assert!(paths.runtimes_dir.is_dir());
        assert!(
            !root.path().join("logs").exists(),
            "no shared logs folder per computer"
        );
    }
}

#[cfg(test)]
#[path = "paths_layout_tests.rs"]
mod layout_tests;
