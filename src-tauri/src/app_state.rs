use std::path::PathBuf;

use openmind_db::Db;
use openmind_runner::RunRegistry;
use openmind_runtime_manager::RuntimeManager;
use openmind_search::SearchRegistry;
use openmind_settings::ThemeSettingService;
use openmind_terminal::TerminalRegistry;
use openmind_workspace::{
    ExplorerStateService, RecentFilesService, SessionService, WorkspaceFolderService,
};

/// Shared application state, managed by Tauri and injected into commands via
/// `tauri::State<AppState>`. This is the composition root's DI seam: as
/// later milestones add services, they get wired in here, not through
/// ad-hoc globals. `WindowStateService` isn't here — it's only ever used
/// inside `main.rs`'s `setup` closure (load-on-launch, save-on-close), never
/// from a command, so it stays local rather than adding an unread field.
///
/// `db` is the raw connection, kept alongside the services above for the
/// handful of commands (`commands::settings`) that only need a thin
/// repository passthrough with no service-layer logic to justify a
/// dedicated service wrapper.
pub struct AppState {
    pub db: Db,
    /// The portable app root (`AppPaths::root_dir`) — the always-valid fallback
    /// working directory for terminals whose requested cwd is missing.
    pub app_root: PathBuf,
    pub recent_files: RecentFilesService,
    pub session: SessionService,
    pub theme: ThemeSettingService,
    pub workspace_folder: WorkspaceFolderService,
    pub explorer_state: ExplorerStateService,
    pub terminal: TerminalRegistry,
    pub runtime: RuntimeManager,
    pub search: SearchRegistry,
    pub runner: RunRegistry,
    /// The PHP built-in server (at most one), its own registry so its events never look like a Run Code run.
    pub php_server: RunRegistry,
    /// The running built-in server (URL, port, PHP version) — the one truth both windows read.
    pub php_server_info: std::sync::Mutex<Option<crate::commands::php::PhpServerInfo>>,
    /// MariaDB (a normal child process, never a Windows service).
    pub db_server: RunRegistry,
    pub db_info: std::sync::Mutex<Option<crate::commands::database::ServiceInfo>>,
    /// phpMyAdmin, served by the portable PHP's built-in server.
    pub pma: RunRegistry,
    pub pma_info: std::sync::Mutex<Option<crate::commands::database::ServiceInfo>>,
    /// The Composer command that is running, if any (one at a time).
    pub composer: RunRegistry,
    /// The watcher on the open workspace folder (external file changes).
    pub file_watch: std::sync::Mutex<Option<openmind_file_watch::FileWatcher>>,
    /// Running Git commands, stopped on app close.
    pub git: openmind_git::GitRegistry,
    /// Geometry of secondary windows (the PHP Server window).
    pub window_states: openmind_settings::WindowStateService,
}
