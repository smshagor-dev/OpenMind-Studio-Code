#![cfg_attr(windows, windows_subsystem = "windows")]

mod app_state;
mod commands;
mod data_scope;
mod deploy;
mod integration;
mod launch;
mod locale;
mod secret;
mod startup;
mod startup_error;
mod state;
mod sync;
#[cfg(all(test, windows))]
mod test_paths;
mod updates;
mod window_events;
mod windows;

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
    // `--integration <action>` (the installer, the uninstaller): do it and exit before anything else starts.
    if let Some(code) = commands::integration::run_cli() {
        std::process::exit(code);
    }
    // `--deploy <action>` (deployment on the local network from a console): likewise, before anything starts.
    if let Some(code) = deploy::cli::run_cli() {
        std::process::exit(code);
    }
    let launch_request = launch::from_process();
    startup::mark_process_start();
    // The app folder, this computer's (hashed) profile id and the portable data scope decide every machine-specific
    // path; the machine identity never stops the app from starting (see data_scope.rs).
    let mut scope = data_scope::resolve().expect("failed to resolve application paths");
    let app_paths = scope.paths.clone();
    let needs_scope_setup = scope.needs_setup;
    // A folder that can't be created (a read-only install folder, a full disk) gets the start-up error window below
    // instead of a crash with no window.
    let layout_failure = app_paths.ensure_dirs().err();
    openmind_core::init_logging_to_file(&app_paths.logs_dir);
    data_scope::log_start_notes();
    data_scope::provision_desktop_shortcut(&scope);

    tracing::info!(
        db_path = %app_paths.db_path.display(),
        data_scope = if needs_scope_setup { "not chosen" } else { app_paths.scope.label() },
        layout = app_paths.layout.label(),
        profile = scope.machine.as_ref().map(|m| m.machine_id.as_str()).unwrap_or("-"),
        identity = ?scope.identity.source(),
        "starting OpenMind Studio"
    );
    if scope.identity.source() != openmind_core::machine_identity::IdentitySource::System {
        tracing::warn!(
            "System machine identifier unavailable. Using OpenMind fallback device identity."
        );
    }
    // A profile that couldn't be prepared (locked, damaged, an import that failed) gets the start-up error window
    // below instead of the workbench; no database is opened.
    // The error itself is moved to the window (not its text): its kind decides the page's category and whether "Back Up
    // and Start Fresh" may be offered (never for a database another computer has open).
    let startup_failure = scope
        .failure
        .take()
        .inspect(|err| {
            tracing::error!(error = %err, "this computer's profile could not be prepared");
        })
        .or_else(|| {
            layout_failure.map(|err| {
                tracing::error!(error = %err, "the folders of this installation could not be created");
                openmind_db::DbError::Copy(err.to_string())
            })
        });
    // An update installer downloaded by an earlier run is never reused (it is downloaded and verified again).
    updates::clean_stale_downloads(&app_paths.temp_dir);
    // A portable update applied at the last restart left the old program files aside: they go now.
    updates::finish_previous_update(&app_paths.install_dir);

    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .manage(launch::LaunchState::new(launch_request))
        .manage(updates::UpdateState::default())
        .manage(sync::SyncState::default())
        .manage(deploy::service::DeployService::default())
        .manage(scope)
        .on_page_load(|webview, payload| {
            if matches!(payload.event(), tauri::webview::PageLoadEvent::Started) {
                windows::page_started(webview.app_handle(), webview.label());
            }
        })
        .invoke_handler(tauri::generate_handler![
            launch::launch_take,
            state::state_snapshot,
            state::state_revision,
            state::state_workspace_attach,
            state::state_refresh,
            state::state_reads,
            updates::update_check,
            updates::update_status,
            updates::update_download,
            updates::update_install_now,
            updates::update_install_on_exit,
            updates::update_report_unsaved,
            commands::integration::integration_status,
            commands::integration::integration_apply,
            commands::integration::integration_desktop_shortcut,
            commands::integration::integration_check,
            commands::deploy::deploy_status,
            commands::deploy::deploy_apply_offering,
            commands::deploy::deploy_search,
            commands::deploy::deploy_test,
            commands::deploy::deploy_provision,
            commands::deploy::deploy_launch,
            commands::deploy::deploy_trust,
            commands::python_packages::python_packages_status,
            commands::pascalabc::pascal_status,
            commands::python_packages::python_packages_install,
            commands::document::document_open,
            commands::document::document_save,
            commands::workspace::recent_files_list,
            commands::workspace::recent_files_clear,
            commands::workspace::recent_files_rename,
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
            commands::terminal::terminal_busy,
            commands::terminal::terminal_create,
            commands::terminal::terminal_write,
            commands::terminal::terminal_resize,
            commands::terminal::terminal_close,
            commands::runtime::runtime_install,
            commands::runtime::runtime_addon_install,
            commands::runtime::runtime_addon_remove,
            commands::runtime::runtime_repair,
            commands::runtime::runtime_set_active,
            commands::runtime::runtime_delete,
            commands::php::php_server_start,
            commands::php::php_server_stop,
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
            commands::mysql::mysql_start,
            commands::mysql::mysql_stop,
            commands::mysql::mysql_restart,
            commands::php_project::php_project_info,
            commands::database::composer_run,
            commands::database::composer_stop,
            commands::database::composer_status,
            commands::php::php_port_free,
            commands::document::document_read,
            commands::watch::watch_start,
            commands::watch::watch_stop,
            commands::debug::debug_run,
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
            commands::lsp::lsp_install,
            commands::lsp::lsp_sync_document,
            commands::lsp::lsp_save_document,
            commands::lsp::lsp_close_document,
            commands::lsp::lsp_request,
            commands::lsp::lsp_execute_command,
            commands::dictation::dictation_toggle,
            commands::lsp_manage::lsp_workspace_symbols,
            commands::lsp_manage::lsp_uninstall,
            commands::lsp::lsp_stop,
            commands::lsp::lsp_stop_all,
            commands::lsp::lsp_set_verbose,
            commands::extensions::ext_inspect_vsix,
            commands::extensions::ext_install,
            commands::extensions::ext_detect_vscode,
            commands::extensions::ext_import_vscode,
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
            commands::git_file::git_file_context,
            commands::git_file::git_file_log,
            commands::git_file::git_file_at,
            commands::git_file::git_file_refs,
            commands::git_file::git_file_remotes,
            commands::git_file::git_file_published,
            commands::git_file::git_file_resolve,
            commands::git_file::git_file_commit,
            commands::git_file::git_file_blame,
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
            commands::live_preview::live_preview_open,
            commands::run::run_resolve,
            commands::run::run_start,
            commands::run::run_stop,
            commands::run::run_active,
            commands::run::run_terminal_command,
            commands::search::search_run,
            commands::search::search_cancel,
            commands::collab::collab_identity,
            commands::collab::collab_room_create,
            commands::collab::collab_room_invite,
            commands::collab::collab_room_command,
            commands::collab::collab_room_archive,
            commands::collab::collab_room_history,
            commands::collab::collab_room_verify,
            commands::collab::collab_network_config,
            commands::collab::collab_turn_credential_set,
            commands::collab::collab_turn_credential_clear,
            commands::collab::net_commands::collab_host_start,
            commands::collab::net_commands::collab_host_stop,
            commands::collab::net_commands::collab_join,
            commands::collab::net_commands::collab_rejoin,
            commands::collab::net_commands::collab_leave,
            commands::collab::net_commands::collab_net_status,
            commands::collab::net_commands::collab_net_diagnostics,
            commands::collab::docs_commands::collab_doc_owner_state,
            commands::collab::docs_commands::collab_doc_owner_update,
            commands::collab::docs_commands::collab_doc_owner_bind,
            commands::collab::docs_commands::collab_doc_subscribe,
            commands::collab::docs_commands::collab_doc_send,
            commands::collab::docs_commands::collab_doc_unsubscribe,
            commands::collab::docs_commands::collab_presence_set,
            commands::collab::docs_commands::collab_presence_snapshot,
            commands::collab::net_manage::collab_remote_command,
            commands::collab::net_manage::collab_permission_model,
            commands::collab::net_voice::collab_voice_state,
            commands::collab::net_voice::collab_voice_signal,
            commands::collab::net_voice::collab_voice_snapshot,
            commands::collab::net_voice_ice::collab_voice_media,
            commands::collab::sfu::collab_voice_mode_set,
            commands::collab::sfu::collab_classroom_status,
            commands::collab::sfu::collab_classroom_local_start,
            commands::collab::sfu::collab_classroom_local_stop,
            commands::collab::sfu::collab_classroom_secret_set,
            commands::collab::sfu::collab_classroom_secret_clear,
            commands::collab::sfu::collab_classroom_media_room,
            commands::collab::net_commands::collab_remote_tree,
            commands::collab::net_commands::collab_remote_open,
            commands::collab::net_commands::collab_remote_cancel,
            commands::collab::net_commands::collab_remote_refresh,
            commands::ai::ai_providers_list,
            commands::ai::ai_provider_save,
            commands::ai::ai_provider_delete,
            commands::ai::ai_provider_set_enabled,
            commands::ai::ai_provider_set_key,
            commands::ai::ai_provider_clear_key,
            commands::ai::ai_provider_test,
            commands::ai::ai_chat_send,
            commands::ai::ai_request_cancel,
            commands::agent::cloud::agent_cloud_status,
            commands::agent::cloud::agent_cloud_set_base_url,
            commands::agent::cloud::agent_cloud_set_key,
            commands::agent::cloud::agent_cloud_clear_key,
            commands::agent::cloud::agent_cloud_test,
            commands::agent::models::agent_overview,
            commands::agent::inline::agent_inline_complete,
            commands::agent::inline::agent_inline_cancel,
            commands::agent::models::agent_model_download,
            commands::agent::models::agent_model_cancel,
            commands::agent::models::agent_model_delete,
            commands::agent::history::agent_history_list,
            commands::agent::history::agent_history_load,
            commands::agent::history::agent_history_save,
            commands::agent::history::agent_history_delete,
            commands::agent::capabilities::agent_document_read,
            commands::agent::capabilities::agent_capabilities_check,
            commands::agent::control::agent_control,
            commands::agent::agent_send,
            commands::agent::agent_answer,
            commands::agent::agent_guard_answer,
            commands::agent::agent_stop,
            commands::agent::agent_wait_idle,
            commands::agent::agent_reset,
            commands::agent::agent_background_list,
            commands::agent::agent_background_kill,
            commands::agent::agent_undo,
            commands::agent::agent_engine_start,
            commands::agent::agent_engine_stop,
            commands::ai::ai_conversations_list,
            commands::ai::ai_conversation_load,
            commands::ai::ai_conversation_save,
            commands::ai::ai_conversation_delete,
            commands::ai::ai_conversations_clear,
            commands::language::language_registry,
            commands::language::language_file_status,
            commands::language::language_terminal_line,
            startup::startup_report,
            locale::ui_language,
            startup_error::startup_error_info,
            startup_error::startup_error_open_data_folder,
            startup_error::startup_error_back_up,
            startup_error::startup_error_restart,
            startup_error::startup_error_exit,
            data_scope::data_scope_status,
            data_scope::data_scope_setup_apply,
            data_scope::data_scope_restart,
            data_scope::data_scope_exit,
            commands::profiles::profiles_list,
            commands::profiles::profile_create,
            commands::profiles::profile_switch,
            commands::profiles::profile_rename,
            commands::profiles::profile_duplicate,
            commands::profiles::profile_delete,
            commands::profiles::profile_export,
            commands::profiles::profile_import,
            commands::profiles::profile_import_vscode,
            commands::profiles::profile_detect_vscode,
            commands::profiles::profile_import_detected_vscode,
            commands::format::format_options,
            commands::format::format_run,
            commands::about::about_info,
            commands::workloads::workloads_catalog,
            commands::workloads::workloads_plan,
            commands::workloads::workloads_first_run,
            commands::workloads::workloads_first_run_done,
            commands::workloads::runtime_verify,
            commands::network::network_status,
            commands::network::network_set_credentials,
            commands::network::network_clear_credentials,
            commands::network::network_test,
            commands::network::network_terminal_env,
            commands::broker::broker_status,
            commands::broker::broker_cancel,
            commands::broker::broker_clear_temp,
            commands::network_diag::network_diagnostics_export,
            commands::network_offline::network_offline_inspect,
            commands::network_offline::network_offline_import,
            commands::network_offline::network_offline_list,
            commands::network_offline::network_offline_remove,
            commands::network_offline::network_offline_clear,
            commands::network_offline::network_offline_folder,
            commands::network_offline::network_offline_path,
            commands::network_offline::network_offline_extract,
            commands::network_offline::network_offline_import_wheels,
            commands::network_offline::network_wheelhouse,
            commands::network_offline::network_wheelhouse_command,
            commands::deps::deps_plan,
            commands::deps::deps_run,
            commands::deps::deps_project_info,
            commands::toolchains::toolchains_set_active,
            commands::tool_packages::toolchains_install,
            commands::tool_packages::toolchains_remove,
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
            // A portable copy whose data scope was never chosen asks first: nothing below (no database) starts.
            if let Some(err) = &startup_failure {
                startup_error::show(app, &app_paths, err)?;
                return Ok(());
            }
            if needs_scope_setup {
                data_scope::show_setup(app, &app_paths)?;
                return Ok(());
            }
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
            // The automatic update check: a little after start-up, then every few hours (nothing at launch itself).
            updates::start_scheduler(app.handle().clone());

            let (registry, manifest_warnings) = RuntimeRegistry::builtin()
                .with_overrides(&app_paths.shared_settings_dir.join("runtime-manifests"));
            for warning in manifest_warnings {
                tracing::warn!(%warning, "ignoring an invalid runtime definition");
            }
            let mut runtime_paths = RuntimePaths::new(&app_paths.runtimes_dir, &app_paths.cache_dir);
            if app_paths.layout == openmind_core::InstallLayout::Network {
                // Each computer's own tool caches (GOPATH, NuGet, Gradle, pip, npm ...); downloads stay shared.
                runtime_paths = runtime_paths.with_tool_cache(app_paths.machine_cache_dir.join("tools"));
                // Toolchains whose linker can't open files on a network path go on this computer's own disk.
                if openmind_core::install::is_remote_path(&app_paths.runtimes_dir) {
                    if let Some(local) = app_paths.machine_cache_dir.parent() {
                        runtime_paths = runtime_paths
                            .with_local_kinds(local.join("runtimes"), commands::runtime::GNU_LINKED);
                    }
                }
            }
            let runtime = RuntimeManager::new(
                db.clone(),
                runtime_paths,
                registry,
                std::sync::Arc::new(UreqClient::new()),
                openmind_runtime_manager::current_platform(),
            );

            // The package gateway: a loopback bind and the start-up recovery of <app>/temp; nothing is downloaded.
            let network_config = commands::network::read_config_file(&app_paths.settings_file);
            let broker = commands::broker::BrokerRuntime::start(
                app.handle(),
                &app_paths.root_dir,
                &app_paths.temp_dir,
                &network_config.go_proxy,
            );

            // The OpenMindAI Agent: models live beside the runtimes (shared like them), its engine log with the app's logs.
            app.manage(commands::agent::diagnostics::DiagnosticsCache::default());
            app.manage(commands::agent::AgentRuntime::new(
                app_paths.runtimes_dir.with_file_name("models"),
                app_paths.logs_dir.clone(),
            ));
            // The canonical state (and its publisher thread) exists before anything can change it.
            app.manage(state::CanonicalState::start(app.handle()));
            app.manage(AppState {
                broker,
                runtime,
                search: SearchRegistry::new(),
                index: commands::index::new_manager(
                    app.handle().clone(),
                    app_paths.search_index_dir.clone(),
                ),
                ai: commands::ai::AiRuntime::new(app_paths.ai_dir.clone()),
                notebooks: commands::notebook::NotebookRuntime::default(),
                collab: commands::collab::CollabRuntime::default(),
                runner: RunRegistry::new(),
                php_server: RunRegistry::new(),
                live_previews: commands::live_preview::LivePreviews::default(),
                php_server_info: std::sync::Mutex::new(None),
                db_server: RunRegistry::new(),
                db_info: std::sync::Mutex::new(None),
                pma: RunRegistry::new(),
                pma_info: std::sync::Mutex::new(None),
                mysql: commands::mysql::MySqlStack::default(),
                composer: RunRegistry::new(),
                git: openmind_git::GitRegistry::default(),
                dap: commands::debug::new_manager(app.handle().clone()),
                lsp: commands::lsp::new_manager(app.handle().clone(), &app_paths.logs_dir),
                extensions: commands::extensions::ExtensionsRuntime::new(
                    &app_paths.extensions_dir,
                    &app_paths.extension_logs_dir,
                ),
                file_watch: std::sync::Mutex::new(std::collections::HashMap::new()),
                editor_windows: crate::windows::EditorWindows::default(),
                window_states: window_state_service.clone(),
                app_root: app_paths.root_dir.clone(),
                webview_dir: app_paths.webview_dir.clone(),
                paths: app_paths.clone(),
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
            // Live sync of changes made outside the app to what it installed (runtimes, tools, servers, extensions).
            sync::start_watching(app.handle(), &app_paths.root_dir);
            // The canonical state's first read of every domain, in the background.
            state::fill(app.handle());
            // Deployment on the local network: offer this installation only when the user turned it on.
            commands::deploy::apply_offering_at_start(app.handle());
            // The PascalABC.NET this copy ships, installed once after start-up (files only; nothing runs).
            commands::pascalabc::install_bundled_at_start(app.handle());
            // The proxy for OpenMind's own requests, from the settings (local reads; no request is made).
            let handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                commands::network::refresh(&handle.state::<AppState>()).await;
            });

            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
