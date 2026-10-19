use openmind_workspace::{ExplorerState, RecentFileInfo, SessionSnapshot, WorkspaceInfo};
use tauri::{Manager, State};

use crate::app_state::AppState;
use crate::windows::{is_main, window_workspace};

const RECENT_FOLDERS_LIMIT: i64 = 20;

#[tauri::command]
pub async fn recent_files_list(state: State<'_, AppState>) -> Result<Vec<RecentFileInfo>, String> {
    state
        .recent_files
        .list()
        .await
        .map_err(|err| err.to_string())
}

#[tauri::command]
pub async fn recent_files_clear(state: State<'_, AppState>) -> Result<(), String> {
    state
        .recent_files
        .clear()
        .await
        .map_err(|err| err.to_string())
}

/// The saved session belongs to the main window; an extra window starts empty.
#[tauri::command]
pub async fn session_load(
    window: tauri::Window,
    state: State<'_, AppState>,
) -> Result<SessionSnapshot, String> {
    if !is_main(window.label()) {
        return Ok(SessionSnapshot::default());
    }
    state.session.load().await.map_err(|err| err.to_string())
}

/// Only the main window's session is saved (an extra window's isn't restored).
#[tauri::command]
pub async fn session_save(
    snapshot: SessionSnapshot,
    window: tauri::Window,
    state: State<'_, AppState>,
) -> Result<(), String> {
    if !is_main(window.label()) {
        return Ok(());
    }
    state
        .session
        .save(&snapshot)
        .await
        .map_err(|err| err.to_string())
}

/// Opens `path` in the calling window. The main window's folder is saved (and
/// restored on launch); an extra window's is only remembered while it is open.
/// Either way the folder joins the recent folders.
#[tauri::command]
pub async fn workspace_open_folder(
    path: String,
    window: tauri::Window,
    state: State<'_, AppState>,
) -> Result<WorkspaceInfo, String> {
    checked_folder(&path)?;
    if is_main(window.label()) {
        let folder = state
            .workspace_folder
            .open_folder(&path)
            .await
            .map_err(|err| err.to_string())?;
        state.editor_windows.set_folder(window.label(), None);
        return Ok(folder);
    }
    let info = state
        .workspace_folder
        .remember_folder(&path)
        .await
        .map_err(|err| err.to_string())?;
    state
        .editor_windows
        .set_folder(window.label(), Some(info.clone()));
    Ok(info)
}

#[tauri::command]
pub async fn workspace_close_folder(
    window: tauri::Window,
    state: State<'_, AppState>,
) -> Result<(), String> {
    state.editor_windows.set_folder(window.label(), None);
    if !is_main(window.label()) {
        return Ok(());
    }
    state
        .workspace_folder
        .close_folder()
        .await
        .map_err(|err| err.to_string())
}

#[tauri::command]
pub async fn workspace_recent_folders(
    state: State<'_, AppState>,
) -> Result<Vec<WorkspaceInfo>, String> {
    state
        .workspace_folder
        .recent_folders(RECENT_FOLDERS_LIMIT)
        .await
        .map_err(|err| err.to_string())
}

/// Reading the current folder never creates one. Only an explicit operation requests a fallback.
#[tauri::command]
pub async fn workspace_active_folder(
    fallback: Option<String>,
    window: tauri::Window,
    state: State<'_, AppState>,
) -> Result<Option<WorkspaceInfo>, String> {
    if let Some(folder) = window_workspace(&state, window.label()).await? {
        return Ok(Some(folder));
    }
    let Some(fallback) = fallback else {
        return Ok(None);
    };
    if fallback != "documents" && fallback != "agent" {
        return Err("Unknown workspace fallback.".into());
    }
    let documents = window
        .app_handle()
        .path()
        .document_dir()
        .map_err(|err| format!("Could not locate your Documents folder: {err}"))?;
    let path = if fallback == "agent" {
        documents.join("OpenMind Studio")
    } else {
        documents
    };
    std::fs::create_dir_all(&path)
        .map_err(|err| format!("Could not access the default workspace: {err}"))?;
    let folder = state
        .workspace_folder
        .remember_folder(&path.to_string_lossy())
        .await
        .map_err(|err| err.to_string())?;
    // An explicitly opened project wins if it was selected during folder creation.
    if let Some(current) = window_workspace(&state, window.label()).await? {
        return Ok(Some(current));
    }
    // Automatic roots belong to this window session; they do not become the next startup workspace.
    state
        .editor_windows
        .set_folder(window.label(), Some(folder.clone()));
    Ok(Some(folder))
}

#[tauri::command]
pub async fn explorer_state_load(
    workspace_path: String,
    state: State<'_, AppState>,
) -> Result<ExplorerState, String> {
    state
        .explorer_state
        .load(&workspace_path)
        .await
        .map_err(|err| err.to_string())
}

#[tauri::command]
pub async fn explorer_state_save(
    workspace_path: String,
    explorer_state: ExplorerState,
    state: State<'_, AppState>,
) -> Result<(), String> {
    state
        .explorer_state
        .save(&workspace_path, &explorer_state)
        .await
        .map_err(|err| err.to_string())
}

/// A file or folder was renamed or moved from the Explorer: the recent-files list follows it.
#[tauri::command]
pub async fn recent_files_rename(
    from: String,
    to: String,
    state: State<'_, AppState>,
) -> Result<(), String> {
    state
        .recent_files
        .rename(&from, &to)
        .await
        .map_err(|err| err.to_string())
}

/// A folder to open must be a full path to a folder that exists. `E:project` (relative to E:'s current folder) or a
/// path relative to the app would open a different folder than the one named, or one that isn't there.
fn checked_folder(path: &str) -> Result<(), String> {
    let folder = std::path::Path::new(path);
    if path.trim().is_empty() || path.contains('\0') || !folder.is_absolute() {
        return Err(format!("\"{path}\" is not a full folder path."));
    }
    if !folder.is_dir() {
        return Err(format!("The folder \"{path}\" doesn't exist."));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::checked_folder;

    #[test]
    fn only_an_existing_folder_named_by_a_full_path_opens() {
        let dir = tempfile::tempdir().expect("tmp");
        let folder = dir.path().join("My Project");
        std::fs::create_dir(&folder).expect("mkdir");
        assert!(checked_folder(&folder.to_string_lossy()).is_ok());
        assert!(checked_folder(&folder.to_string_lossy().replace('\\', "/")).is_ok());
        let file = folder.join("a.txt");
        std::fs::write(&file, "x").expect("write");
        assert!(
            checked_folder(&file.to_string_lossy()).is_err(),
            "a file is not a folder"
        );
        assert!(checked_folder(&folder.join("missing").to_string_lossy()).is_err());
        assert!(checked_folder("").is_err());
        assert!(checked_folder("relative/project").is_err());
        assert!(checked_folder("a\0b").is_err());
        #[cfg(windows)]
        {
            // Drive-relative and root-relative: they name a folder only relative to some current directory.
            assert!(checked_folder("E:omagent-e2eMy Project").is_err());
            assert!(checked_folder(r"\Users").is_err());
        }
    }
}
