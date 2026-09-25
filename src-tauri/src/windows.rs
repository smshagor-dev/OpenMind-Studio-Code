//! Several editor windows in one app (VS Code's File > New Window). The first
//! window (`main`) keeps the saved session and the saved open folder; every
//! other editor window (`window-2`, `window-3`, ...) starts empty and keeps its
//! folder in memory only. Commands that act on "the open folder" ask for the
//! folder of the window that called them, so two windows can work on two
//! projects at once. Closing an extra window ends its terminals and its file
//! watcher; closing `main` closes OpenMind Studio (see `window_events.rs`).

use std::collections::HashMap;
use std::sync::Mutex;

use openmind_settings::MAIN_WINDOW_LABEL;
use openmind_workspace::WorkspaceInfo;
use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindowBuilder, WindowEvent};

use crate::app_state::AppState;

/// Labels of the extra editor windows start with this (the capability file allows `window-*`).
pub const EDITOR_WINDOW_PREFIX: &str = "window-";

/// Per-window state the backend keeps for the extra editor windows.
#[derive(Default)]
pub struct EditorWindows {
    /// The folder open in each extra window (the main window's is in the database).
    folders: Mutex<HashMap<String, WorkspaceInfo>>,
    /// Which window created each terminal, so closing a window ends its terminals.
    terminals: Mutex<HashMap<String, String>>,
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

    /// Forgets `label` and returns the terminals it owned.
    fn remove_window(&self, label: &str) -> Vec<String> {
        self.set_folder(label, None);
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

/// The folder open in the window `label`: the saved one for `main`, the
/// in-memory one for an extra window.
pub async fn window_workspace(
    state: &AppState,
    label: &str,
) -> Result<Option<WorkspaceInfo>, String> {
    if is_main(label) {
        return state
            .workspace_folder
            .active_workspace()
            .await
            .map_err(|err| err.to_string());
    }
    Ok(state.editor_windows.folder(label))
}

/// The first free `window-N` label (N from 2, as the main window is the first).
fn next_label(app: &AppHandle) -> String {
    (2..)
        .map(|n| format!("{EDITOR_WINDOW_PREFIX}{n}"))
        .find(|label| app.get_webview_window(label).is_none())
        .unwrap_or_else(|| format!("{EDITOR_WINDOW_PREFIX}new"))
}

/// Opens a new, empty editor window (File > New Window, Ctrl+Shift+N).
#[tauri::command]
pub async fn window_new(app: AppHandle) -> Result<String, String> {
    let label = next_label(&app);
    let (width, height) = app
        .get_webview_window(MAIN_WINDOW_LABEL)
        .and_then(|main| {
            let scale = main.scale_factor().ok()?;
            let size = main.inner_size().ok()?.to_logical::<f64>(scale);
            Some((size.width, size.height))
        })
        .unwrap_or((1280.0, 800.0));
    let window = WebviewWindowBuilder::new(&app, &label, WebviewUrl::App("index.html".into()))
        .title("OpenMind Studio")
        .inner_size(width.min(1600.0), height.min(1000.0))
        .min_inner_size(640.0, 480.0)
        .decorations(false)
        .disable_drag_drop_handler()
        .build()
        .map_err(|err| err.to_string())?;
    let closed_app = app.clone();
    let closed_label = label.clone();
    window.on_window_event(move |event| {
        if matches!(event, WindowEvent::Destroyed) {
            close_window_resources(&closed_app, &closed_label);
        }
    });
    Ok(label)
}

/// An extra window is gone: end its terminals and its file watcher, forget its folder.
fn close_window_resources(app: &AppHandle, label: &str) {
    let state = app.state::<AppState>();
    for id in state.editor_windows.remove_window(label) {
        if let Err(err) = state.terminal.close(&id) {
            tracing::warn!(?err, %id, "could not end a closed window's terminal");
        }
    }
    crate::commands::watch::stop_watching_window(&state, label);
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
    fn only_main_is_the_main_window() {
        assert!(is_main("main"));
        assert!(!is_main("window-2"));
        assert!(!is_main("php-server"));
        assert!(is_editor_window_extra("window-2"));
        assert!(!is_editor_window_extra("main"));
        assert!(!is_editor_window_extra("php-server"));
    }
}
