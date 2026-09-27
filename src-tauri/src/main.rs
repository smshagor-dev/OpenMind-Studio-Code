#![cfg_attr(windows, windows_subsystem = "windows")]

mod app_state;
mod commands;
mod secret;
mod startup;
mod startup_error;
mod tray;
mod window_events;
mod windows;

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
    startup::mark_process_start();
    let app_paths = AppPaths::resolve().expect("failed to resolve application paths");
    app_paths
        .ensure_dirs()
        .expect("failed to create application directory layout");
    openmind_core::init_logging_to_file(&app_paths.logs_dir);

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
            commands::preferences::preferences_load,
            commands::preferences::preferences_set,
            commands::preferences::preferences_reset,
            commands::preferences::preferences_file,
            commands::preferences::preferences_validate,
            commands::preferences::preferences_scope_of,
            commands::preferences::keybindings_load,
            commands::preferences::keybindings_save,
            commands::preferences::keybindings_file,
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
            commands::php::php_web_root,
            windows::window_new,
            windows::window_take_pending_open,
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
            commands::document::document_read,
            commands::watch::watch_start,
            commands::watch::watch_stop,
            commands::debug::debug_status,
            commands::debug::debug_start,
            commands::debug::debug_stop,
            commands::debug::debug_control,
            commands::debug::debug_request,
            commands::debug::debug_set_breakpoints,
            commands::debug::breakpoints_load,
            commands::debug::breakpoints_save,
            commands::debug::debug_configurations,
            commands::tasks::tasks_list,
            commands::tasks::tasks_plan,
            commands::tasks::task_run_step,
            commands::tasks::tasks_problems,
            commands::notebook::notebook_open,
            commands::notebook::notebook_save,
            commands::notebook::notebook_set_trust,
            commands::notebook::notebook_kernels,
            commands::notebook::notebook_kernel_start,
            commands::notebook::notebook_kernel_stop,
            commands::notebook::notebook_execute,
            commands::lsp::lsp_status,
            commands::lsp::lsp_install,
            commands::lsp::lsp_sync_document,
            commands::lsp::lsp_save_document,
            commands::lsp::lsp_close_document,
            commands::lsp::lsp_request,
            commands::lsp::lsp_stop,
            commands::lsp::lsp_stop_all,
            commands::lsp::lsp_set_verbose,
            commands::extensions::ext_list,
            commands::extensions::ext_inspect_vsix,
            commands::extensions::ext_install,
            commands::extension_manage::ext_read_icon,
            commands::marketplace::ext_market_search,
            commands::marketplace::ext_market_details,
            commands::marketplace::ext_market_text,
            commands::marketplace::ext_market_download,
            commands::extension_manage::ext_set_enabled,
            commands::extension_manage::ext_uninstall,
            commands::extension_manage::ext_secrets_count,
            commands::extension_manage::ext_secrets_clear,
            commands::extension_manage::ext_grant_permission,
            commands::extension_manage::ext_webview_read_resource,
            commands::extension_manage::ext_read_file,
            commands::extension_manage::ext_host_log,
            commands::extension_host::ext_host_start,
            commands::extension_host::ext_host_stop,
            commands::extension_host::ext_host_request,
            commands::extension_host::ext_host_notify,
            commands::extension_host::ext_host_respond,
            commands::extension_host::ext_activate_for,
            commands::git::git_snapshot,
            commands::git::git_init,
            commands::git::git_stage,
            commands::git::git_stage_all,
            commands::git::git_unstage,
            commands::git::git_unstage_all,
            commands::git::git_discard,
            commands::git::git_discard_all,
            commands::git::git_delete_untracked,
            commands::git::git_commit,
            commands::git::git_identity,
            commands::git::git_set_identity,
            commands::git::git_diff,
            commands::git::git_branches,
            commands::git::git_switch_branch,
            commands::git::git_create_branch,
            commands::git::git_delete_branch,
            commands::git::git_fetch,
            commands::git::git_pull,
            commands::git::git_push,
            commands::git::git_clone,
            commands::git::git_history,
            commands::git::git_commit_files,
            commands::git::git_commit_diff,
            commands::git::git_blame,
            commands::git::git_stash_list,
            commands::git::git_stash_push,
            commands::git::git_stash_apply,
            commands::git::git_stash_pop,
            commands::git::git_stash_drop,
            commands::git::git_allow_system,
            commands::git::git_set_allow_system,
            commands::panel::panel_config_path,
            commands::panel::panel_open_file,
            commands::panel::panel_open_folder,
            commands::panel::panel_open_shell,
            commands::panel::panel_netstat,
            commands::run::run_resolve,
            commands::run::run_start,
            commands::run::run_stop,
            commands::run::run_active,
            commands::run::run_terminal_command,
            commands::search::search_run,
            commands::search::search_cancel,
            commands::ai::ai_providers_list,
            commands::ai::ai_provider_save,
            commands::ai::ai_provider_delete,
            commands::ai::ai_provider_set_enabled,
            commands::ai::ai_provider_set_key,
            commands::ai::ai_provider_clear_key,
            commands::ai::ai_provider_test,
            commands::ai::ai_chat_send,
            commands::ai::ai_request_cancel,
            commands::ai::ai_conversations_list,
            commands::ai::ai_conversation_load,
            commands::ai::ai_conversation_save,
            commands::ai::ai_conversation_delete,
            commands::ai::ai_conversations_clear,
            commands::language::language_registry,
            commands::language::language_workspace_status,
            commands::language::language_file_status,
            commands::language::language_terminal_line,
            startup::startup_report,
            startup_error::startup_error_info,
            startup_error::startup_error_open_data_folder,
            startup_error::startup_error_back_up,
            startup_error::startup_error_restart,
            startup_error::startup_error_exit,
            commands::profiles::profiles_list,
            commands::profiles::profile_create,
            commands::profiles::profile_switch,
            commands::profiles::profile_rename,
            commands::profiles::profile_duplicate,
            commands::profiles::profile_delete,
            commands::profiles::profile_export,
            commands::profiles::profile_import,
            commands::format::format_options,
            commands::format::format_run,
            commands::about::about_info,
            commands::toolchains::toolchains_list,
            commands::toolchains::toolchains_set_active,
            commands::toolchains::toolchains_verify,
            commands::index::index_start,
            commands::index::index_status,
            commands::index::index_cancel,
            commands::index::index_rebuild,
            commands::index::index_clear,
            commands::index::index_touch,
            commands::index::search_files_indexed,
            commands::index::search_symbols_indexed,
            commands::index::search_file_symbols,
            commands::index::search_text_indexed,
            commands::index::search_symbols_of_text,
            commands::system::open_external_url,
            commands::preview::preview_inspect,
            commands::preview::preview_read_bytes,
            commands::preview::preview_read_text,
            commands::preview::preview_docx,
            commands::preview::preview_xlsx,
        ])
        .setup(move |app| {
            // A database that can't be opened (a migration mismatch, a damaged or locked file ...) gets a window
            // that explains it instead of a panic; the workbench doesn't start and nothing is reset.
            let db = match tauri::async_runtime::block_on(Db::connect(&app_paths.db_path)) {
                Ok(db) => db,
                Err(err) => {
                    startup_error::show(app, &app_paths, &err)?;
                    return Ok(());
                }
            };
            let window_state_service = WindowStateService::new(db.clone());

            // The main window is described in tauri.conf.json (`create: false`) but built here, so its WebView2
            // profile can live next to the executable instead of in %LOCALAPPDATA%.
            let window_config = app
                .config()
                .app
                .windows
                .iter()
                .find(|window| window.label == MAIN_WINDOW_LABEL)
                .expect("tauri.conf.json must describe the main window");
            let window = tauri::WebviewWindowBuilder::from_config(app.handle(), window_config)?
                .data_directory(app_paths.webview_dir.clone())
                .build()?;

            let saved_state =
                tauri::async_runtime::block_on(window_state_service.load(MAIN_WINDOW_LABEL))
                    .unwrap_or_else(|err| {
                        tracing::warn!(error = %err, "couldn't read the saved window size; using the default");
                        WindowStateService::default_state(MAIN_WINDOW_LABEL)
                    });

            window_events::apply_window_state(&window, &saved_state)?;
            window.show()?;
            tracing::info!(elapsed_ms = startup::since_start_ms(), "main window shown");
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
                index: commands::index::new_manager(
                    app.handle().clone(),
                    app_paths.data_dir.join("search-index"),
                ),
                ai: commands::ai::AiRuntime::new(app_paths.data_dir.join("ai")),
                notebooks: commands::notebook::NotebookRuntime::default(),
                runner: RunRegistry::new(),
                php_server: RunRegistry::new(),
                php_server_info: std::sync::Mutex::new(None),
                db_server: RunRegistry::new(),
                db_info: std::sync::Mutex::new(None),
                pma: RunRegistry::new(),
                pma_info: std::sync::Mutex::new(None),
                composer: RunRegistry::new(),
                git: openmind_git::GitRegistry::default(),
                dap: commands::debug::new_manager(app.handle().clone()),
                lsp: commands::lsp::new_manager(app.handle().clone(), &app_paths.logs_dir),
                extensions: commands::extensions::ExtensionsRuntime::new(&app_paths.extensions_dir),
                file_watch: std::sync::Mutex::new(std::collections::HashMap::new()),
                editor_windows: crate::windows::EditorWindows::default(),
                window_states: window_state_service.clone(),
                app_root: app_paths.root_dir.clone(),
                webview_dir: app_paths.webview_dir.clone(),
                settings_file: app_paths.settings_file.clone(),
                keybindings_file: app_paths.keybindings_file.clone(),
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
