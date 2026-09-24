use std::time::Duration;

use crate::app_state::AppState;
use openmind_db::WindowState;
use openmind_settings::WindowStateService;
use tauri::{Manager, PhysicalPosition, PhysicalSize, WebviewWindow, WindowEvent};

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
/// shut the app down. `CloseRequested` is deferred (`prevent_close`) so the
/// async save can finish first.
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
            match current_window_state(&window) {
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

            // Kill every terminal's whole process tree first so no shell (or
            // anything it spawned) can outlive the window.
            let state = window.app_handle().state::<AppState>();
            state.terminal.kill_all();
            state.search.cancel_all();
            // Nothing a run started may outlive the window.
            state.runner.stop_all();

            // `.destroy()`, not `.close()`: `.close()` re-emits
            // `CloseRequested` (documented behavior — "like a
            // user-initiated close request so you can intercept it"),
            // which would recurse straight back into this same handler.
            // `.destroy()` force-closes without emitting events, running
            // native teardown directly rather than going through
            // `AppHandle::cleanup_before_exit`'s hide-and-clear-resources
            // path. See CLAUDE.md's shutdown note: the WebView2-orphan
            // report from Milestone 3 turned out to be a misdiagnosis (it
            // was counting Windows Search's and other apps' *own*
            // `msedgewebview2.exe` processes, not this app's), so this call
            // is a defensive improvement, not a fix for a confirmed bug —
            // process-ancestry testing showed the app's own WebView2
            // children already exited cleanly without it.
            if let Err(err) = window.destroy() {
                tracing::error!(?err, "failed to destroy window before exit");
            }

            // Tauri 2 doesn't exit the process just because no windows
            // remain (that's what lets tray-icon apps keep running).
            // OpenMind Studio has no background/tray mode yet, so closing
            // the main window should quit the app, same as any
            // single-window desktop editor. `AppHandle::exit` runs the
            // graceful `RunEvent::ExitRequested`/`RunEvent::Exit` sequence
            // (which includes `cleanup_before_exit`) rather than calling
            // `std::process::exit` directly.
            window.app_handle().exit(0);
        });
    });
}

fn current_window_state(window: &WebviewWindow) -> tauri::Result<WindowState> {
    let size = window.outer_size()?;
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
