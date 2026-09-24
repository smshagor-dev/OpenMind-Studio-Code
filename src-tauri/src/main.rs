#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod app_state;
mod commands;
mod window_events;

use openmind_core::AppPaths;
use openmind_db::Db;
use openmind_runner::RunRegistry;
use openmind_runtime_manager::{RuntimeManager, RuntimePaths, RuntimeRegistry, UreqClient};
use openmind_search::SearchRegistry;
use openmind_settings::{ThemeSettingService, WindowStateService, MAIN_WINDOW_LABEL};
use openmind_terminal::TerminalRegistry;
use openmind_workspace::{
    ExplorerStateService, RecentFilesService, SessionService, WorkspaceFolderService,
};
use tauri::Manager;

use app_state::AppState;

fn main() {
    openmind_core::init_logging();

    let app_paths = AppPaths::resolve().expect("failed to resolve application paths");
    app_paths
        .ensure_dirs()
        .expect("failed to create application directory layout");

    tracing::info!(db_path = %app_paths.db_path.display(), "starting OpenMind Studio");

    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .invoke_handler(tauri::generate_handler![
            commands::document::document_open,
            commands::document::document_save,
            commands::workspace::recent_files_list,
            commands::workspace::recent_files_clear,
            commands::workspace::session_load,
            commands::workspace::session_save,
            commands::workspace::workspace_open_folder,
            commands::workspace::workspace_close_folder,
            commands::workspace::workspace_recent_folders,
            commands::workspace::workspace_active_folder,
            commands::workspace::explorer_state_load,
            commands::workspace::explorer_state_save,
            commands::theme::theme_get,
            commands::theme::theme_set,
            commands::filesystem::fs_read_dir,
            commands::filesystem::fs_metadata,
            commands::filesystem::fs_is_binary,
            commands::filesystem::fs_create_file,
            commands::filesystem::fs_create_folder,
            commands::filesystem::fs_rename,
            commands::filesystem::fs_delete,
            commands::filesystem::fs_move,
            commands::filesystem::fs_copy,
            commands::filesystem::fs_duplicate,
            commands::settings::settings_get,
            commands::settings::settings_set,
            commands::settings::workspace_pin_folder,
            commands::settings::workspace_unpin_folder,
            commands::settings::workspace_list_pinned_folders,
            commands::terminal::terminal_list_shells,
            commands::terminal::terminal_create,
            commands::terminal::terminal_write,
            commands::terminal::terminal_resize,
            commands::terminal::terminal_close,
            commands::runtime::runtime_list,
            commands::runtime::runtime_install,
            commands::runtime::runtime_repair,
            commands::runtime::runtime_set_active,
            commands::runtime::runtime_delete,
            commands::php::php_server_start,
            commands::php::php_server_stop,
            commands::php::php_server_status,
            commands::php::php_window_open,
            commands::database::mariadb_status,
            commands::database::mariadb_credentials,
            commands::database::mariadb_initialize,
            commands::database::mariadb_start,
            commands::database::mariadb_stop,
            commands::database::pma_start,
            commands::database::pma_stop,
            commands::database::pma_status,
            commands::database::php_project_info,
            commands::database::composer_run,
            commands::database::composer_stop,
            commands::database::composer_status,
            commands::php::php_port_free,
            commands::run::run_resolve,
            commands::run::run_start,
            commands::run::run_stop,
            commands::run::run_active,
            commands::run::run_terminal_command,
            commands::search::search_run,
            commands::search::search_cancel,
            commands::system::open_external_url,
        ])
        .setup(move |app| {
            let db = tauri::async_runtime::block_on(Db::connect(&app_paths.db_path))
                .expect("failed to connect to database");
            let window_state_service = WindowStateService::new(db.clone());

            let window = app
                .get_webview_window(MAIN_WINDOW_LABEL)
                .expect("main window must exist");

            let saved_state =
                tauri::async_runtime::block_on(window_state_service.load(MAIN_WINDOW_LABEL))
                    .expect("failed to load window state");

            window_events::apply_window_state(&window, &saved_state)?;
            window.show()?;
            window_events::register_close_handler(&window, window_state_service.clone());

            let (registry, manifest_warnings) = RuntimeRegistry::builtin()
                .with_overrides(&app_paths.settings_dir.join("runtime-manifests"));
            for warning in manifest_warnings {
                tracing::warn!(%warning, "ignoring an invalid runtime definition");
            }
            let runtime = RuntimeManager::new(
                db.clone(),
                RuntimePaths::new(&app_paths.runtimes_dir, &app_paths.cache_dir),
                registry,
                std::sync::Arc::new(UreqClient::new()),
                openmind_runtime_manager::current_platform(),
            );

            app.manage(AppState {
                runtime,
                search: SearchRegistry::new(),
                runner: RunRegistry::new(),
                php_server: RunRegistry::new(),
                php_server_info: std::sync::Mutex::new(None),
                db_server: RunRegistry::new(),
                db_info: std::sync::Mutex::new(None),
                pma: RunRegistry::new(),
                pma_info: std::sync::Mutex::new(None),
                composer: RunRegistry::new(),
                window_states: window_state_service.clone(),
                app_root: app_paths.root_dir.clone(),
                terminal: TerminalRegistry::new(),
                recent_files: RecentFilesService::new(db.clone()),
                session: SessionService::new(db.clone()),
                theme: ThemeSettingService::new(db.clone()),
                workspace_folder: WorkspaceFolderService::new(db.clone()),
                explorer_state: ExplorerStateService::new(db.clone()),
                db,
            });

            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
