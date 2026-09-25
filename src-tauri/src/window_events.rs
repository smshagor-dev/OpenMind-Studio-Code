use std::time::Duration;

use crate::app_state::AppState;
use openmind_db::WindowState;
use openmind_settings::{WindowStateService, MAIN_WINDOW_LABEL};
use tauri::{AppHandle, Manager, PhysicalPosition, PhysicalSize, WebviewWindow, WindowEvent};

/// Ceiling on the close-time window-state write. Everything else the app
/// persists (session, explorer state, active workspace) is already saved
/// continuously as it changes — see CLAUDE.md's Persistence section — so
/// window geometry, captured only at the moment of close, is the one save
/// this handler is actually responsible for completing before exit. If
/// SQLite is somehow stuck, this bounds how long "closing" can hang rather
/// than letting the app linger forever.
const SAVE_TIMEOUT: Duration = Duration::from_secs(2);

/// Apply a previously-saved (or default) geometry to `window` before it's
/// shown, so the user never sees a flash of the wrong size/position.
pub fn apply_window_state(window: &WebviewWindow, state: &WindowState) -> tauri::Result<()> {
    window.set_size(PhysicalSize::new(state.width as u32, state.height as u32))?;

    match (state.x, state.y) {
        (Some(x), Some(y)) => window.set_position(PhysicalPosition::new(x as i32, y as i32))?,
        _ => window.center()?,
    }

    if state.maximized {
        window.maximize()?;
    }

    Ok(())
}

/// Persist the window's current geometry before it actually closes, then
/// shut the app down — or, while a PHP stack server runs, hide to the tray so
/// the servers keep running (XAMPP style; see `tray.rs`). `CloseRequested` is
/// deferred (`prevent_close`) so the async save can finish first.
pub fn register_close_handler(window: &WebviewWindow, service: WindowStateService) {
    let handled_window = window.clone();

    window.on_window_event(move |event| {
        let WindowEvent::CloseRequested { api, .. } = event else {
            return;
        };
        api.prevent_close();

        let window = handled_window.clone();
        let service = service.clone();
        tauri::async_runtime::spawn(async move {
            save_main_geometry(&window, &service).await;

            let app = window.app_handle().clone();
            let visible = crate::windows::visible_editor_windows(&app);
            if !crate::windows::is_last_editor_window(&visible, MAIN_WINDOW_LABEL) {
                // Other windows stay open (VS Code): this one goes away with its
                // terminals and watcher. It is hidden, not destroyed, because it
                // owns the saved session; the tray's Show brings it back.
                crate::windows::release_window(&app, MAIN_WINDOW_LABEL);
                if let Err(err) = window.hide() {
                    tracing::error!(?err, "failed to hide the main window");
                }
                return;
            }
            close_last_editor_window(app, window).await;
        });
    });
}

/// The last editor window on screen is closing: hide to the tray while a PHP
/// stack server runs (if the user wants that), otherwise quit.
pub async fn close_last_editor_window(app: AppHandle, window: WebviewWindow) {
    let hide_wanted =
        crate::commands::preferences::user_bool(&app.state::<AppState>(), "php.tray.hideOnClose");
    if hide_wanted && crate::tray::servers_running(&app) {
        match crate::tray::ensure(&app) {
            Ok(()) => {
                tracing::info!("servers are running: hiding to the tray instead of quitting");
                // An extra window goes for good; the tray brings back the main one.
                let result = if window.label() == MAIN_WINDOW_LABEL {
                    window.hide()
                } else {
                    window.destroy()
                };
                if let Err(err) = result {
                    tracing::error!(?err, "failed to close the window for the tray");
                }
                return;
            }
            Err(err) => {
                tracing::error!(?err, "no tray icon; quitting and stopping the servers");
            }
        }
    }
    shutdown(app).await;
}

async fn save_main_geometry(window: &WebviewWindow, service: &WindowStateService) {
    match current_window_state(window) {
        Ok(state) => match tokio::time::timeout(SAVE_TIMEOUT, service.save(&state)).await {
            Ok(Ok(())) => {}
            Ok(Err(err)) => {
                tracing::error!(?err, "failed to persist window state on close");
            }
            Err(_) => {
                tracing::error!(
                    timeout_secs = SAVE_TIMEOUT.as_secs(),
                    "timed out persisting window state on close"
                );
            }
        },
        Err(err) => {
            tracing::error!(?err, "failed to read window geometry before close");
        }
    }
}

/// Quits for real: stops every terminal, run, server and Git process, then
/// destroys the main window and exits. Used by a normal close and by the
/// tray's Quit.
pub async fn shutdown(app: AppHandle) {
    // Kill every terminal's whole process tree first so no shell (or
    // anything it spawned) can outlive the app.
    let state = app.state::<AppState>();
    state.terminal.kill_all();
    state.search.cancel_all();
    // Nothing a run started may outlive the app.
    state.runner.stop_all();
    state.php_server.stop_all();
    // MariaDB gets a clean shutdown (it flushes its files), then phpMyAdmin
    // and Composer go; the PHP window's geometry is remembered first.
    if let Some(php_window) = app.get_webview_window(crate::commands::php::PHP_WINDOW_LABEL) {
        save_secondary_geometry(&php_window).await;
    }
    let stopper = app.clone();
    let _ = tokio::time::timeout(
        Duration::from_secs(25),
        tokio::task::spawn_blocking(move || {
            crate::commands::watch::stop_on_exit(&stopper);
            crate::commands::debug::stop_debug(&stopper);
            crate::commands::lsp::stop_lsp(&stopper);
            crate::commands::extension_host::stop_host(&stopper);
            crate::commands::git::stop_git(&stopper);
            crate::commands::database::stop_all_services(&stopper)
        }),
    )
    .await;

    // `.destroy()`, not `.close()`: `.close()` re-emits `CloseRequested`
    // (documented behavior — "like a user-initiated close request so you can
    // intercept it"), which would recurse straight back into the close
    // handler. See CLAUDE.md's shutdown note: the WebView2-orphan report from
    // Milestone 3 was a misdiagnosis, so this is a defensive improvement, not
    // a fix for a confirmed bug.
    if let Some(window) = app.get_webview_window(MAIN_WINDOW_LABEL) {
        if let Err(err) = window.destroy() {
            tracing::error!(?err, "failed to destroy window before exit");
        }
    }

    // Tauri 2 doesn't exit the process just because no windows remain (that's
    // what lets tray apps keep running), so quit explicitly. `AppHandle::exit`
    // runs the graceful `RunEvent::ExitRequested`/`RunEvent::Exit` sequence
    // (which includes `cleanup_before_exit`), not `std::process::exit`.
    app.exit(0);
}

/// Saves a secondary window's geometry (best effort, bounded).
pub async fn save_secondary_geometry(window: &WebviewWindow) {
    // A minimized window reports a far off-screen position; never save that.
    if window.is_minimized().unwrap_or(false) {
        return;
    }
    let Ok(state) = current_window_state(window) else {
        return;
    };
    let service = window
        .app_handle()
        .state::<AppState>()
        .window_states
        .clone();
    let _ = tokio::time::timeout(SAVE_TIMEOUT, service.save(&state)).await;
}

/// Remembers the window's size, position and maximized state as it changes
/// (throttled) and when it closes.
pub fn track_secondary_geometry(window: &WebviewWindow) {
    let tracked = window.clone();
    let last_save = std::sync::Arc::new(std::sync::atomic::AtomicU64::new(0));
    window.on_window_event(move |event| {
        let always = matches!(
            event,
            WindowEvent::CloseRequested { .. } | WindowEvent::Destroyed
        );
        if !always && !matches!(event, WindowEvent::Resized(_) | WindowEvent::Moved(_)) {
            return;
        }
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis() as u64)
            .unwrap_or(0);
        let previous = last_save.load(std::sync::atomic::Ordering::Relaxed);
        if !always && now.saturating_sub(previous) < 400 {
            return;
        }
        last_save.store(now, std::sync::atomic::Ordering::Relaxed);
        let window = tracked.clone();
        tauri::async_runtime::spawn(async move {
            save_secondary_geometry(&window).await;
        });
    });
}

fn current_window_state(window: &WebviewWindow) -> tauri::Result<WindowState> {
    // Inner size, because `apply_window_state` sets the inner size: saving the outer size made a
    // decorated window grow by its frame on every reopen.
    let size = window.inner_size()?;
    let position = window.outer_position()?;
    let maximized = window.is_maximized()?;

    Ok(WindowState {
        label: window.label().to_string(),
        width: size.width as f64,
        height: size.height as f64,
        x: Some(position.x as f64),
        y: Some(position.y as f64),
        maximized,
    })
}
