use openmind_db::WindowState;
use openmind_settings::WindowStateService;
use tauri::{Manager, PhysicalPosition, PhysicalSize, WebviewWindow, WindowEvent};

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

/// Persist the window's current geometry before it actually closes.
/// `CloseRequested` is deferred (`prevent_close`) so the async save can
/// finish before the window is torn down.
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
                Ok(state) => {
                    if let Err(err) = service.save(&state).await {
                        tracing::error!(?err, "failed to persist window state on close");
                    }
                }
                Err(err) => {
                    tracing::error!(?err, "failed to read window geometry before close");
                }
            }

            // `window.close()` alone tears down the window but Tauri 2 does
            // not exit the process just because no windows remain (that's
            // what lets tray-icon apps keep running). Openmind Studio has no
            // background/tray mode yet, so closing the main window should
            // quit the app, same as any single-window desktop editor.
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
