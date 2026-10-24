//! Several editor windows in one app (VS Code's File > New Window). The first
//! window (`main`) keeps the saved session and the saved open folder; every
//! other editor window (`window-2`, `window-3`, ...) has its own recovery record
//! and restores its folder before its editor page starts. Commands that act on
//! "the open folder" ask for the
//! folder of the window that called them, so two windows can work on two
//! projects at once. Like VS Code, closing a window closes only that window
//! (its terminals and file watcher end with it); OpenMind Studio quits when the
//! last editor window closes. `main` is hidden rather than destroyed while other
//! windows remain, because it owns the saved session (see `window_events.rs`).
//! A tab dragged out of the tab bar opens its file in a new window
//! (`window_new` with a path, picked up by `window_take_pending_open`).

use std::collections::{HashMap, HashSet};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Mutex;

use openmind_db::EditorSettingsRepository;
use serde::{Deserialize, Serialize};

use openmind_settings::MAIN_WINDOW_LABEL;
use openmind_workspace::WorkspaceInfo;
use tauri::{AppHandle, Emitter, Manager, WebviewUrl, WebviewWindowBuilder, WindowEvent};

use crate::app_state::AppState;

/// Labels of the extra editor windows start with this (the capability file allows `window-*`).
pub const EDITOR_WINDOW_PREFIX: &str = "window-";

/// Per-window state, including session-only automatic workspace roots.
#[derive(Default)]
pub struct EditorWindows {
    /// Serialize creation, folder changes and close acknowledgements across native invocations.
    operations: tokio::sync::Mutex<()>,
    restored: AtomicBool,
    close_ready: Mutex<HashMap<String, String>>,
    /// Extra-window folders and automatic roots; explicitly selected main projects are in the database.
    folders: Mutex<HashMap<String, WorkspaceInfo>>,
    /// Which window created each terminal, so closing a window ends its terminals.
    terminals: Mutex<HashMap<String, String>>,
    /// A file a new window opens once it has started (a tab dragged out of another window).
    pending_open: Mutex<HashMap<String, String>>,
}

impl EditorWindows {
    pub fn folder(&self, label: &str) -> Option<WorkspaceInfo> {
        self.folders.lock().ok()?.get(label).cloned()
    }

    pub fn set_folder(&self, label: &str, folder: Option<WorkspaceInfo>) {
        if let Ok(mut folders) = self.folders.lock() {
            match folder {
                Some(folder) => folders.insert(label.to_string(), folder),
                None => folders.remove(label),
            };
        }
    }

    pub fn track_terminal(&self, id: &str, label: &str) {
        if let Ok(mut terminals) = self.terminals.lock() {
            terminals.insert(id.to_string(), label.to_string());
        }
    }

    pub fn forget_terminal(&self, id: &str) {
        if let Ok(mut terminals) = self.terminals.lock() {
            terminals.remove(id);
        }
    }

    fn set_pending_open(&self, label: &str, path: String) {
        if let Ok(mut pending) = self.pending_open.lock() {
            pending.insert(label.to_string(), path);
        }
    }

    /// The file the window `label` was opened for, handed out once.
    pub fn take_pending_open(&self, label: &str) -> Option<String> {
        self.pending_open.lock().ok()?.remove(label)
    }

    /// Forgets `label` and returns the terminals it owned.
    fn remove_window(&self, label: &str) -> Vec<String> {
        if let Ok(mut ready) = self.close_ready.lock() {
            ready.remove(label);
        }
        self.set_folder(label, None);
        let _ = self.take_pending_open(label);
        let Ok(mut terminals) = self.terminals.lock() else {
            return Vec::new();
        };
        let owned: Vec<String> = terminals
            .iter()
            .filter(|(_, owner)| owner.as_str() == label)
            .map(|(id, _)| id.clone())
            .collect();
        for id in &owned {
            terminals.remove(id);
        }
        owned
    }
}

pub fn is_main(label: &str) -> bool {
    label == MAIN_WINDOW_LABEL
}

/// An editor window opened with New Window (not `main`, not the PHP Server window).
pub fn is_editor_window_extra(label: &str) -> bool {
    label.starts_with(EDITOR_WINDOW_PREFIX)
}

/// Whether closing `closing` leaves no editor window on screen, i.e. the app
/// should quit (or hide to the tray). `visible` = the editor windows now shown.
pub fn is_last_editor_window(visible: &[String], closing: &str) -> bool {
    !visible.iter().any(|label| label != closing)
}

/// Labels of the editor windows (main and `window-*`) currently shown.
pub fn visible_editor_windows(app: &AppHandle) -> Vec<String> {
    app.webview_windows()
        .into_iter()
        .filter(|(label, window)| {
            (is_main(label) || is_editor_window_extra(label))
                && window.is_visible().unwrap_or(false)
        })
        .map(|(label, _)| label)
        .collect()
}

/// Ends what belongs to one window (its terminals and file watcher), as its close does.
pub fn release_window(app: &AppHandle, label: &str) {
    let state = app.state::<AppState>();
    for id in state.editor_windows.remove_window(label) {
        if let Err(err) = state.terminal.close(&id) {
            tracing::warn!(?err, %id, "could not end a closed window's terminal");
        }
    }
    crate::commands::watch::stop_watching_window(&state, label);
    app.state::<crate::commands::agent::AgentRuntime>()
        .forget_window(label);
    crate::commands::collab::net_presence::window_closed(app, label);
    crate::commands::collab::net_voice::window_closed(app, label);
    // Its folder's canonical state goes too when no other window has that folder open.
    crate::state::detach(app, label);
}

/// A window's page started loading (its first load, or a reload): what its previous page held in collaboration — a
/// voice call (left, so the Owner drops the member from the call and from a classroom media server) and what it showed
/// in presence — is released. A reload keeps the window's label, so the close cleanup above never runs for it; the
/// room connection itself belongs to the computer, not the page, and stays.
pub fn page_started(app: &AppHandle, label: &str) {
    let state = app.state::<AppState>();
    if let Ok(mut ready) = state.editor_windows.close_ready.lock() {
        ready.remove(label);
    }
    crate::commands::collab::net_presence::window_closed(app, label);
    crate::commands::collab::net_voice::window_closed(app, label);
}

/// A window's current folder: a session-only automatic root, a saved main-window
/// project, or an extra window's in-memory project.
pub async fn window_workspace(
    state: &AppState,
    label: &str,
) -> Result<Option<WorkspaceInfo>, String> {
    if let Some(folder) = state.editor_windows.folder(label) {
        return Ok(Some(folder));
    }
    if is_main(label) {
        return state
            .workspace_folder
            .active_workspace()
            .await
            .map_err(|err| err.to_string());
    }
    Ok(state.editor_windows.folder(label))
}

/// A rectangle in logical screen pixels: x, y, width, height.
type Rect = (f64, f64, f64, f64);

/// Moves a window of `size` placed at `at` so it lies inside `area` (a window
/// dropped near a screen edge stays fully on that screen, title bar included).
fn keep_inside(at: (f64, f64), size: (f64, f64), area: Rect) -> (f64, f64) {
    let (ax, ay, aw, ah) = area;
    let x = at.0.min(ax + aw - size.0).max(ax);
    let y = at.1.min(ay + ah - size.1).max(ay);
    (x, y)
}

/// The work area (screen minus taskbar), in logical pixels, of the monitor
/// that contains the logical point (its taskbar included), else the primary one.
fn work_area_at(app: &AppHandle, x: f64, y: f64) -> Option<Rect> {
    let logical = |position: (i32, i32), size: (u32, u32), scale: f64| -> Rect {
        (
            f64::from(position.0) / scale,
            f64::from(position.1) / scale,
            f64::from(size.0) / scale,
            f64::from(size.1) / scale,
        )
    };
    let contains = |(ax, ay, aw, ah): Rect| x >= ax && y >= ay && x < ax + aw && y < ay + ah;
    let monitors = app.available_monitors().ok()?;
    let monitor = monitors
        .iter()
        .find(|m| {
            let (p, s) = (m.position(), m.size());
            contains(logical((p.x, p.y), (s.width, s.height), m.scale_factor()))
        })
        .cloned()
        .or_else(|| app.primary_monitor().ok().flatten())?;
    let area = monitor.work_area();
    Some(logical(
        (area.position.x, area.position.y),
        (area.size.width, area.size.height),
        monitor.scale_factor(),
    ))
}

const SESSION_PREFIX: &str = "editor.window.session.";
pub const CLOSE_REQUEST_EVENT: &str = "editor-close-requested";
static CLOSE_SEQUENCE: AtomicU64 = AtomicU64::new(1);

#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct WindowSession {
    label: String,
    workspace: Option<String>,
}

fn valid_session(key: &str, value: &str) -> Result<WindowSession, String> {
    if value.len() > 32768 {
        return Err("Window recovery record is too large.".into());
    }
    let session: WindowSession = serde_json::from_str(value).map_err(|err| err.to_string())?;
    let number = session
        .label
        .strip_prefix(EDITOR_WINDOW_PREFIX)
        .and_then(|suffix| suffix.parse::<u32>().ok());
    if !number.is_some_and(|n| n >= 2 && session.label == format!("window-{n}"))
        || key != format!("{SESSION_PREFIX}{}", session.label)
        || session.workspace.as_ref().is_some_and(|path| {
            path.is_empty() || path.len() > 16384 || path.contains('\0')
        })
    {
        return Err("Invalid editor window recovery record.".into());
    }
    Ok(session)
}

async fn write_session(state: &AppState, session: &WindowSession) -> Result<(), String> {
    let value = serde_json::to_string(session).map_err(|err| err.to_string())?;
    EditorSettingsRepository::new(state.db.pool())
        .set(&format!("{SESSION_PREFIX}{}", session.label), &value)
        .await
        .map_err(|err| err.to_string())
}

/// Called while the window-operation lock is held, before committing its in-memory folder.
pub async fn save_extra_workspace(
    state: &AppState,
    label: &str,
    path: Option<String>,
) -> Result<(), String> {
    if is_editor_window_extra(label) {
        write_session(
            state,
            &WindowSession {
                label: label.into(),
                workspace: path,
            },
        )
        .await?;
    }
    Ok(())
}

pub async fn lock_operations(state: &AppState) -> tokio::sync::MutexGuard<'_, ()> {
    state.editor_windows.operations.lock().await
}

/// The first free `window-N` label (N from 2, as the main window is the first).
fn next_label(app: &AppHandle, reserved: &HashSet<String>) -> String {
    (2..)
        .map(|n| format!("{EDITOR_WINDOW_PREFIX}{n}"))
        .find(|label| app.get_webview_window(label).is_none() && !reserved.contains(label))
        .unwrap_or_else(|| format!("{EDITOR_WINDOW_PREFIX}new"))
}

/// Opens a new editor window (File > New Window, Ctrl+Shift+N): empty, or, for
/// a tab dragged out of the tab bar, opening `path`, placed at the drop point
/// (`x`/`y`, logical screen pixels) when one is given.
#[tauri::command]
pub async fn window_new(
    app: AppHandle,
    path: Option<String>,
    x: Option<f64>,
    y: Option<f64>,
) -> Result<String, String> {
    let state = app.state::<AppState>();
    let _operation = lock_operations(&state).await;
    let records = EditorSettingsRepository::new(state.db.pool())
        .list_prefix(SESSION_PREFIX)
        .await
        .map_err(|err| err.to_string())?;
    if records.len() >= 256 {
        return Err("Too many saved editor windows; close an existing window first.".into());
    }
    let reserved = records
        .iter()
        .filter_map(|(key, _)| key.strip_prefix(SESSION_PREFIX).map(str::to_string))
        .collect();
    let label = next_label(&app, &reserved);
    let session = WindowSession {
        label: label.clone(),
        workspace: None,
    };
    write_session(&state, &session).await?;
    if let Err(error) = create_editor_window(&app, &label, path, x, y) {
        let _ = EditorSettingsRepository::new(state.db.pool())
            .delete(&format!("{SESSION_PREFIX}{label}"))
            .await;
        return Err(error);
    }
    Ok(label)
}

fn create_editor_window(
    app: &AppHandle,
    label: &str,
    path: Option<String>,
    x: Option<f64>,
    y: Option<f64>,
) -> Result<(), String> {
    if let Some(path) = path {
        app.state::<AppState>()
            .editor_windows
            .set_pending_open(label, path);
    }
    let (width, height) = app
        .get_webview_window(MAIN_WINDOW_LABEL)
        .and_then(|main| {
            let scale = main.scale_factor().ok()?;
            let size = main.inner_size().ok()?.to_logical::<f64>(scale);
            Some((size.width, size.height))
        })
        .unwrap_or((1280.0, 800.0));
    let webview_dir = app.state::<AppState>().webview_dir.clone();
    let mut builder = WebviewWindowBuilder::new(app, label, WebviewUrl::App("index.html".into()))
        .data_directory(webview_dir)
        .title("OpenMind Studio")
        .inner_size(width.min(1600.0), height.min(1000.0))
        .min_inner_size(640.0, 480.0)
        .decorations(false)
        .disable_drag_drop_handler();
    if let (Some(x), Some(y)) = (x, y) {
        let (width, height) = (width.min(1600.0), height.min(1000.0));
        let (x, y) = match work_area_at(app, x, y) {
            Some(area) => keep_inside((x, y), (width, height), area),
            None => (x, y),
        };
        builder = builder.position(x, y);
    }
    let window = builder.build().map_err(|err| {
        let _ = app
            .state::<AppState>()
            .editor_windows
            .take_pending_open(label);
        err.to_string()
    })?;
    let event_app = AppHandle::clone(app);
    let event_label = label.to_string();
    let closing = window.clone();
    window.on_window_event(move |event| match event {
        WindowEvent::CloseRequested { api, .. } => {
            // Native close waits for the renderer's confirmed recovery write.
            api.prevent_close();
            request_editor_close(closing.app_handle(), closing.label());
        }
        WindowEvent::Destroyed => release_window(&event_app, &event_label),
        _ => {}
    });
    Ok(())
}

/// Recreate extra windows once, before their pages restore their scoped buffers.
#[tauri::command]
pub async fn window_restore(app: AppHandle, window: tauri::Window) -> Result<Vec<String>, String> {
    if !is_main(window.label()) {
        return Err("Only the main window restores editor windows.".into());
    }
    let state = app.state::<AppState>();
    let _operation = lock_operations(&state).await;
    if state.editor_windows.restored.load(Ordering::SeqCst) {
        return Ok(Vec::new());
    }
    let records = EditorSettingsRepository::new(state.db.pool())
        .list_prefix(SESSION_PREFIX)
        .await
        .map_err(|err| err.to_string())?;
    if records.len() > 256 {
        return Err("Too many saved editor windows; recovery data was preserved.".into());
    }
    let mut warnings = Vec::new();
    for (key, value) in records {
        let session = match valid_session(&key, &value) {
            Ok(session) => session,
            Err(error) => {
                warnings.push(format!("Could not restore {key}: {error}"));
                continue;
            }
        };
        if app.get_webview_window(&session.label).is_some() {
            continue;
        }
        if let Some(path) = &session.workspace {
            if std::path::Path::new(path).is_absolute() && std::path::Path::new(path).is_dir() {
                match state.workspace_folder.remember_folder(path).await {
                    Ok(folder) => state.editor_windows.set_folder(&session.label, Some(folder)),
                    Err(error) => {
                        warnings.push(format!("Could not restore folder {path}: {error}"))
                    }
                }
            } else {
                warnings.push(format!("Saved workspace folder is unavailable: {path}"));
            }
        }
        if let Err(error) = create_editor_window(&app, &session.label, None, None, None) {
            state.editor_windows.set_folder(&session.label, None);
            warnings.push(format!("Could not restore {}: {error}", session.label));
        }
    }
    state.editor_windows.restored.store(true, Ordering::SeqCst);
    Ok(warnings)
}

/// The renderer calls this only after its recovery flush completed successfully.
#[tauri::command]
pub async fn window_close_confirmed(
    app: AppHandle,
    window: tauri::Window,
    token: String,
) -> Result<(), String> {
    close_editor_confirmed(app, window.label().to_string(), Some(token)).await
}

/// Listener readiness distinguishes a loading page from a page that can have unsaved edits.
#[tauri::command]
pub fn window_close_ready(
    window: tauri::Window,
    state: tauri::State<'_, AppState>,
) -> Result<String, String> {
    if !is_main(window.label()) && !is_editor_window_extra(window.label()) {
        return Err("Not an editor window.".into());
    }
    let token = CLOSE_SEQUENCE.fetch_add(1, Ordering::SeqCst).to_string();
    state
        .editor_windows
        .close_ready
        .lock()
        .map_err(|err| err.to_string())?
        .insert(window.label().to_string(), token.clone());
    Ok(token)
}

/// Retiring an old listener must not revoke a replacement page's close capability.
#[tauri::command]
pub fn window_close_unready(
    window: tauri::Window,
    state: tauri::State<'_, AppState>,
    token: String,
) -> Result<(), String> {
    let mut ready = state
        .editor_windows
        .close_ready
        .lock()
        .map_err(|err| err.to_string())?;
    if ready.get(window.label()) == Some(&token) {
        ready.remove(window.label());
    }
    Ok(())
}

pub fn request_editor_close(app: &AppHandle, label: &str) {
    let state = app.state::<AppState>();
    let ready = state
        .editor_windows
        .close_ready
        .lock()
        .map(|ready| ready.contains_key(label))
        .unwrap_or(true);
    if ready {
        if app.get_webview_window(label).is_some() {
            if let Err(error) = app.emit_to(label, CLOSE_REQUEST_EVENT, ()) {
                tracing::error!(?error, "could not request editor recovery before close");
            }
        }
    } else {
        // Before the page's close listener is ready no editable workbench has been shown.
        // Closing a loading or failed page must still work without replacing its recovery data.
        let app = AppHandle::clone(app);
        let label = label.to_string();
        tauri::async_runtime::spawn(async move {
            if let Err(error) = close_editor_confirmed(app, label, None).await {
                tracing::error!(?error, "could not close a loading editor window");
            }
        });
    }
}

async fn close_editor_confirmed(
    app: AppHandle,
    label: String,
    token: Option<String>,
) -> Result<(), String> {
    if !is_main(&label) && !is_editor_window_extra(&label) {
        return Err("Not an editor window.".into());
    }
    let state = app.state::<AppState>();
    let _operation = lock_operations(&state).await;
    let Some(editor) = app.get_webview_window(&label) else {
        return Ok(());
    };
    // Check after acquiring the operation lock: a queued acknowledgement can outlive a page reload.
    let ready = state
        .editor_windows
        .close_ready
        .lock()
        .map_err(|err| err.to_string())?
        .get(&label)
        .cloned();
    if let Some(token) = token {
        if ready.as_ref() != Some(&token) {
            return Err("The editor page changed before close was confirmed. Try again.".into());
        }
    } else if ready.is_some() {
        editor
            .emit_to(label.as_str(), CLOSE_REQUEST_EVENT, ())
            .map_err(|err| err.to_string())?;
        return Ok(());
    }
    let visible = visible_editor_windows(&app);
    if is_main(&label) {
        crate::window_events::close_main_confirmed(editor, state.window_states.clone()).await;
    } else if is_last_editor_window(&visible, &label) {
        // Keep the last window's descriptor so app restart restores its session.
        crate::window_events::close_last_editor_window(app.clone(), editor).await;
    } else {
        // Only a confirmed individual close retires the window from startup recovery.
        let key = format!("{SESSION_PREFIX}{label}");
        let repository = EditorSettingsRepository::new(state.db.pool());
        let previous = repository.get(&key).await.map_err(|err| err.to_string())?;
        repository.delete(&key).await.map_err(|err| err.to_string())?;
        if let Err(error) = editor.destroy() {
            if let Some(value) = previous {
                let _ = repository.set(&key, &value).await;
            }
            return Err(error.to_string());
        }
    }
    Ok(())
}

/// The file this window was opened for (a tab dragged out of another window), once.
#[tauri::command]
pub fn window_take_pending_open(
    window: tauri::Window,
    state: tauri::State<'_, AppState>,
) -> Option<String> {
    state.editor_windows.take_pending_open(window.label())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn info(path: &str) -> WorkspaceInfo {
        WorkspaceInfo {
            id: 1,
            path: path.into(),
            name: "site".into(),
        }
    }

    #[test]
    fn recovery_records_cannot_select_other_windows_or_mismatch_their_key() {
        let valid = r#"{"label":"window-2","workspace":null}"#;
        assert!(valid_session("editor.window.session.window-2", valid).is_ok());
        assert!(valid_session("editor.window.session.window-3", valid).is_err());
        for label in [
            "main",
            "php-server",
            "window-1",
            "window-02",
            "window-2/other",
        ] {
            let value = serde_json::json!({"label": label, "workspace": null}).to_string();
            assert!(valid_session(&format!("{SESSION_PREFIX}{label}"), &value).is_err());
        }
        assert!(valid_session("editor.window.session.window-2", "invalid JSON").is_err());
        let value = serde_json::json!({"label": "window-2", "workspace": "a\0b"}).to_string();
        assert!(valid_session("editor.window.session.window-2", &value).is_err());
    }

    #[test]
    fn keeps_one_folder_per_window() {
        let windows = EditorWindows::default();
        windows.set_folder("window-2", Some(info("C:/a")));
        windows.set_folder("window-3", Some(info("C:/b")));
        assert_eq!(
            windows.folder("window-2").map(|f| f.path),
            Some("C:/a".into())
        );
        assert_eq!(
            windows.folder("window-3").map(|f| f.path),
            Some("C:/b".into())
        );
        windows.set_folder("window-2", None);
        assert!(windows.folder("window-2").is_none());
    }

    #[test]
    fn a_closed_window_hands_back_only_its_own_terminals() {
        let windows = EditorWindows::default();
        windows.set_folder("window-2", Some(info("C:/a")));
        windows.track_terminal("t1", "window-2");
        windows.track_terminal("t2", "main");
        windows.track_terminal("t3", "window-2");
        windows.forget_terminal("t3");

        assert_eq!(windows.remove_window("window-2"), vec!["t1".to_string()]);
        assert!(windows.folder("window-2").is_none());
        assert!(windows.remove_window("main").contains(&"t2".to_string()));
    }

    #[test]
    fn a_pending_file_is_handed_out_once_and_dropped_with_its_window() {
        let windows = EditorWindows::default();
        windows.set_pending_open("window-2", "C:/site/index.php".into());
        assert_eq!(
            windows.take_pending_open("window-2"),
            Some("C:/site/index.php".into())
        );
        assert_eq!(windows.take_pending_open("window-2"), None);
        windows.set_pending_open("window-3", "C:/a.py".into());
        let _ = windows.remove_window("window-3");
        assert_eq!(windows.take_pending_open("window-3"), None);
    }

    #[test]
    fn a_window_dropped_near_an_edge_stays_on_the_screen() {
        let area = (0.0, 0.0, 1920.0, 1032.0);
        // Dropped on the taskbar: pulled up so the whole window shows.
        assert_eq!(
            keep_inside((188.0, 1049.0), (1100.0, 700.0), area),
            (188.0, 332.0)
        );
        // Dropped past the right edge / above the top.
        assert_eq!(
            keep_inside((1800.0, -40.0), (1100.0, 700.0), area),
            (820.0, 0.0)
        );
        // Already inside: unchanged.
        assert_eq!(
            keep_inside((300.0, 200.0), (1100.0, 700.0), area),
            (300.0, 200.0)
        );
        // A second monitor to the left.
        let left = (-1600.0, 0.0, 1600.0, 900.0);
        assert_eq!(
            keep_inside((-100.0, 100.0), (1100.0, 700.0), left),
            (-1100.0, 100.0)
        );
    }

    #[test]
    fn only_the_last_editor_window_on_screen_closes_the_app() {
        let both = vec!["main".to_string(), "window-2".to_string()];
        assert!(!is_last_editor_window(&both, "main"));
        assert!(!is_last_editor_window(&both, "window-2"));
        assert!(is_last_editor_window(&["window-2".to_string()], "window-2"));
        assert!(is_last_editor_window(&["main".to_string()], "main"));
        assert!(is_last_editor_window(&[], "window-3"));
    }

    #[test]
    fn only_main_is_the_main_window() {
        assert!(is_main("main"));
        assert!(!is_main("window-2"));
        assert!(!is_main("php-server"));
        assert!(is_editor_window_extra("window-2"));
        assert!(!is_editor_window_extra("main"));
        assert!(!is_editor_window_extra("php-server"));
    }
}
