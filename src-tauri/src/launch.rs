//! Opening what the command line names: `OpenMindStudio.exe <folder>` opens the folder as the workspace,
//! `OpenMindStudio.exe <file> ...` opens the files as tabs (File Explorer's "Open with OpenMind Studio", the `openmind`
//! launcher). The arguments are read once at start-up; the main window takes them after restoring its session.
//!
//! Rules: relative paths are resolved against the working folder; the first folder becomes the workspace (a window has
//! one), later folders are reported and ignored; every file opens; a path that doesn't exist is reported and skipped;
//! options (`-x`, `--x`) are ignored.

use std::ffi::OsString;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use serde::Serialize;

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LaunchRequest {
    pub folder: Option<String>,
    pub files: Vec<String>,
    /// Folders after the first (one workspace per window).
    pub ignored_folders: Vec<String>,
    /// Paths that don't exist or are neither a file nor a folder.
    pub missing: Vec<String>,
}

impl LaunchRequest {
    pub fn is_empty(&self) -> bool {
        self.folder.is_none()
            && self.files.is_empty()
            && self.ignored_folders.is_empty()
            && self.missing.is_empty()
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Kind {
    Folder,
    File,
    Missing,
}

fn kind_on_disk(path: &Path) -> Kind {
    match std::fs::metadata(path) {
        Ok(meta) if meta.is_dir() => Kind::Folder,
        Ok(meta) if meta.is_file() => Kind::File,
        _ => Kind::Missing,
    }
}

/// `args` without the program name.
pub fn parse(args: &[OsString], cwd: &Path, kind: &dyn Fn(&Path) -> Kind) -> LaunchRequest {
    let mut request = LaunchRequest::default();
    for arg in args {
        let text = arg.to_string_lossy();
        // Explorer's "%V" of a drive root can end in a stray quote (`C:\"`); options are not paths.
        let text = text.trim().trim_end_matches('"');
        if text.is_empty() || text.starts_with('-') {
            continue;
        }
        // `My Folder\` and `My Folder` are the same folder; a drive root (`C:\`) keeps its slash.
        let trimmed = text.trim_end_matches(['\\', '/']);
        let text = if trimmed.ends_with(':') || trimmed.is_empty() {
            text
        } else {
            trimmed
        };
        let path = PathBuf::from(text);
        let path = if path.is_absolute() {
            path
        } else {
            cwd.join(path)
        };
        let path = std::path::absolute(&path).unwrap_or(path);
        let shown = path.display().to_string();
        match kind(&path) {
            Kind::Folder if request.folder.is_none() => request.folder = Some(shown),
            Kind::Folder => request.ignored_folders.push(shown),
            Kind::File => request.files.push(shown),
            Kind::Missing => request.missing.push(shown),
        }
    }
    request
}

/// The request of this process's command line.
pub fn from_process() -> LaunchRequest {
    let args: Vec<OsString> = std::env::args_os().skip(1).collect();
    let cwd = std::env::current_dir().unwrap_or_default();
    parse(&args, &cwd, &kind_on_disk)
}

/// Held until the main window takes it (once).
pub struct LaunchState(Mutex<Option<LaunchRequest>>);

impl LaunchState {
    pub fn new(request: LaunchRequest) -> Self {
        LaunchState(Mutex::new((!request.is_empty()).then_some(request)))
    }

    pub fn take(&self) -> Option<LaunchRequest> {
        self.0.lock().ok()?.take()
    }
}

/// What the command line asked to open; only the main window gets it, and only once.
#[tauri::command]
pub fn launch_take(
    window: tauri::Window,
    state: tauri::State<'_, LaunchState>,
) -> Option<LaunchRequest> {
    (window.label() == openmind_settings::MAIN_WINDOW_LABEL)
        .then(|| state.take())
        .flatten()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fake(path: &Path) -> Kind {
        let name = path
            .file_name()
            .map(|n| n.to_string_lossy().to_string())
            .unwrap_or_default();
        if name.contains("missing") {
            Kind::Missing
        } else if name.contains('.') {
            Kind::File
        } else {
            Kind::Folder
        }
    }

    fn args(list: &[&str]) -> Vec<OsString> {
        list.iter().map(OsString::from).collect()
    }

    #[test]
    fn a_folder_becomes_the_workspace_and_files_open_as_tabs() {
        let cwd = Path::new(r"C:\Users\Ivan\My Work");
        let request = parse(
            &args(&[
                r"C:\Projects\My Site",
                "notes one.md",
                r"src\main.rs",
                "--verbose",
                "-n",
            ]),
            cwd,
            &fake,
        );
        assert_eq!(request.folder.as_deref(), Some(r"C:\Projects\My Site"));
        assert_eq!(
            request.files,
            vec![
                r"C:\Users\Ivan\My Work\notes one.md".to_string(),
                r"C:\Users\Ivan\My Work\src\main.rs".to_string()
            ]
        );
        assert!(request.ignored_folders.is_empty() && request.missing.is_empty());
    }

    #[test]
    fn later_folders_and_missing_paths_are_reported_not_opened() {
        let cwd = Path::new(r"C:\w");
        let request = parse(
            &args(&[r"C:\a", r"C:\b", r"C:\missing thing", ""]),
            cwd,
            &fake,
        );
        assert_eq!(request.folder.as_deref(), Some(r"C:\a"));
        assert_eq!(request.ignored_folders, vec![r"C:\b".to_string()]);
        assert_eq!(request.missing, vec![r"C:\missing thing".to_string()]);
        assert!(parse(&args(&["--flag"]), cwd, &fake).is_empty());
    }

    #[test]
    fn explorer_arguments_with_spaces_and_a_stray_quote_work_on_the_real_disk() {
        let tmp = tempfile::tempdir().expect("tmp");
        let folder = tmp.path().join("My Folder");
        std::fs::create_dir_all(&folder).expect("dir");
        let file = folder.join("read me.txt");
        std::fs::write(&file, "x").expect("file");
        let with_quote = format!("{}\\\"", folder.display());
        let request = parse(
            &args(&[&with_quote, &file.display().to_string()]),
            tmp.path(),
            &kind_on_disk,
        );
        assert_eq!(
            request.folder.as_deref(),
            Some(folder.display().to_string().as_str())
        );
        assert_eq!(request.files, vec![file.display().to_string()]);
    }

    #[test]
    fn the_request_is_taken_once() {
        let state = LaunchState::new(LaunchRequest {
            folder: Some("C:\\a".into()),
            ..LaunchRequest::default()
        });
        assert!(state.take().is_some());
        assert!(state.take().is_none());
        assert!(LaunchState::new(LaunchRequest::default()).take().is_none());
    }
}
