//! Background (tray) mode, XAMPP style: closing the main window while a PHP
//! stack server runs hides the app instead of quitting, so the servers keep
//! running. The tray icon brings the windows back, stops every server, or
//! quits for real (which stops everything, exactly like a normal close).

use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Manager};

use crate::app_state::AppState;

const TRAY_ID: &str = "openmind-tray";
const SHOW: &str = "tray-show";
const PANEL: &str = "tray-panel";
const STOP_ALL: &str = "tray-stop-all";
const QUIT: &str = "tray-quit";

/// Whether a long-running server (PHP built-in server, MariaDB, phpMyAdmin) is up.
pub fn servers_running(app: &AppHandle) -> bool {
    let state = app.state::<AppState>();
    !state.php_server.active().is_empty()
        || !state.db_server.active().is_empty()
        || !state.pma.active().is_empty()
}

/// Shows the tray icon (once). Failing to create it is reported to the caller,
/// which then quits normally rather than leaving an unreachable hidden app.
pub fn ensure(app: &AppHandle) -> tauri::Result<()> {
    if app.tray_by_id(TRAY_ID).is_some() {
        return Ok(());
    }
    let show = MenuItem::with_id(app, SHOW, "Show OpenMind Studio", true, None::<&str>)?;
    let panel = MenuItem::with_id(app, PANEL, "PHP Control Panel", true, None::<&str>)?;
    let stop = MenuItem::with_id(app, STOP_ALL, "Stop All Servers", true, None::<&str>)?;
    let quit_item = MenuItem::with_id(app, QUIT, "Quit OpenMind Studio", true, None::<&str>)?;
    let separator = PredefinedMenuItem::separator(app)?;
    let separator2 = PredefinedMenuItem::separator(app)?;
    let menu = Menu::with_items(
        app,
        &[&show, &panel, &separator, &stop, &separator2, &quit_item],
    )?;

    let mut builder = TrayIconBuilder::with_id(TRAY_ID)
        .tooltip("OpenMind Studio — servers are running")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id.as_ref() {
            SHOW => show_main(app),
            PANEL => open_panel(app),
            STOP_ALL => stop_all(app),
            QUIT => quit_app(app),
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                show_main(tray.app_handle());
            }
        });
    if let Some(icon) = app.default_window_icon() {
        builder = builder.icon(icon.clone());
    }
    builder.build(app)?;
    Ok(())
}

/// Brings the main window back and removes the tray icon (closing it again
/// with servers running puts the app back in the tray).
pub fn show_main(app: &AppHandle) {
    if let Some(window) = app.get_webview_window(openmind_settings::MAIN_WINDOW_LABEL) {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
    }
    let _ = app.remove_tray_by_id(TRAY_ID);
}

fn open_panel(app: &AppHandle) {
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        if let Err(err) = crate::commands::php::php_window_open(app).await {
            tracing::error!(%err, "failed to open the PHP control panel from the tray");
        }
    });
}

/// Stops the PHP server, phpMyAdmin, Composer and MariaDB (clean shutdown).
/// The app stays in the tray; Quit or Show is still there.
fn stop_all(app: &AppHandle) {
    app.state::<AppState>().php_server.stop_all();
    let app = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
        crate::commands::database::stop_all_services(&app);
    });
}

fn quit_app(app: &AppHandle) {
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        let _ = app.remove_tray_by_id(TRAY_ID);
        crate::window_events::shutdown(app).await;
    });
}
