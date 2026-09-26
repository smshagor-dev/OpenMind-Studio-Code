//! The folder a formatter runs in: the nearest ancestor of the file that looks like a project root.

use std::path::{Path, PathBuf};

const MARKERS: &[&str] = &[
    "package.json",
    "pyproject.toml",
    "setup.py",
    "setup.cfg",
    "requirements.txt",
    "Cargo.toml",
    "go.mod",
    "composer.json",
    "pom.xml",
    "build.gradle",
    "pubspec.yaml",
    "biome.json",
    ".prettierrc",
    ".editorconfig",
    ".git",
];

/// The nearest folder at or above `file` that holds a project marker, never going above `stop` (the open workspace).
/// With no marker it is `stop` when given, else the file's own folder.
pub fn nearest_project_root(file: &Path, stop: Option<&Path>) -> PathBuf {
    let start = file.parent().unwrap_or(file).to_path_buf();
    let mut dir = start.clone();
    // Without a workspace to stop at, look only a few folders up (never wander to the drive root).
    let mut budget = if stop.is_some() { usize::MAX } else { 6 };
    loop {
        if MARKERS.iter().any(|marker| dir.join(marker).exists()) {
            return dir;
        }
        if stop.is_some_and(|stop| dir == stop) || budget == 0 {
            break;
        }
        budget -= 1;
        match dir.parent() {
            Some(parent) => dir = parent.to_path_buf(),
            None => break,
        }
    }
    stop.map(Path::to_path_buf).unwrap_or(start)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_nearest_marker_wins_and_the_walk_stops_at_the_workspace() {
        let dir = tempfile::tempdir().expect("tmp");
        let root = dir.path().join("my work space");
        let app = root.join("apps").join("web");
        std::fs::create_dir_all(app.join("src")).expect("dirs");
        std::fs::write(root.join("package.json"), "{}").expect("root");
        std::fs::write(app.join("package.json"), "{}").expect("app");
        let file = app.join("src").join("a.ts");
        assert_eq!(nearest_project_root(&file, Some(&root)), app);
        std::fs::remove_file(app.join("package.json")).expect("rm");
        assert_eq!(nearest_project_root(&file, Some(&root)), root);
    }

    #[test]
    fn without_a_marker_the_workspace_or_the_files_folder_is_used() {
        let dir = tempfile::tempdir().expect("tmp");
        let root = dir.path().join("w");
        std::fs::create_dir_all(root.join("x")).expect("dirs");
        let file = root.join("x").join("a.txt");
        assert_eq!(nearest_project_root(&file, Some(&root)), root);
        assert_eq!(nearest_project_root(&file, None), root.join("x"));
    }
}
