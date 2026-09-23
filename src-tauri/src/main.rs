#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod window_events;

use codeforge_core::AppPaths;
use codeforge_db::Db;
use codeforge_settings::{WindowStateService, MAIN_WINDOW_LABEL};
use tauri::Manager;

fn main() {
    codeforge_core::init_logging();

    let app_paths = AppPaths::resolve().expect("failed to resolve application paths");
    app_paths
        .ensure_data_dir()
        .expect("failed to create application data directory");

    tracing::info!(db_path = %app_paths.db_path.display(), "starting CodeForge");

    tauri::Builder::default()
        .setup(move |app| {
            let db = tauri::async_runtime::block_on(Db::connect(&app_paths.db_path))
                .expect("failed to connect to database");
            let window_state_service = WindowStateService::new(db);

            let window = app
                .get_webview_window(MAIN_WINDOW_LABEL)
                .expect("main window must exist");

            let saved_state =
                tauri::async_runtime::block_on(window_state_service.load(MAIN_WINDOW_LABEL))
                    .expect("failed to load window state");

            window_events::apply_window_state(&window, &saved_state)?;
            window.show()?;
            window_events::register_close_handler(&window, window_state_service);

            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
