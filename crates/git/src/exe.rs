use std::ffi::OsString;
use std::path::{Path, PathBuf};

use serde::Serialize;

use crate::error::GitError;

/// Where the Git executable came from.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum GitSource {
    /// OpenMind's own portable Git (Runtime Manager).
    Portable,
    /// Git found on the machine's PATH — only when the user allowed it.
    System,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GitExecutable {
    pub path: PathBuf,
    pub source: GitSource,
}

impl GitExecutable {
    /// What the UI shows: the portable one by name, a system one with its path.
    pub fn label(&self) -> String {
        match self.source {
            GitSource::Portable => "OpenMind portable Git".to_string(),
            GitSource::System => format!("System Git at {}", self.path.display()),
        }
    }
}

fn executable_name() -> &'static str {
    if cfg!(windows) {
        "git.exe"
    } else {
        "git"
    }
}

fn find_in<'a>(dirs: impl IntoIterator<Item = &'a Path>) -> Option<PathBuf> {
    dirs.into_iter()
        .map(|dir| dir.join(executable_name()))
        .find(|candidate| candidate.is_file())
}

/// The portable Git if the Runtime Manager injects one, else — only with
/// `allow_system` — the first Git on the system PATH, else "not installed".
pub fn resolve(
    portable_dirs: &[PathBuf],
    allow_system: bool,
    system_path: Option<OsString>,
) -> Result<GitExecutable, GitError> {
    if let Some(path) = find_in(portable_dirs.iter().map(PathBuf::as_path)) {
        return Ok(GitExecutable {
            path,
            source: GitSource::Portable,
        });
    }
    if allow_system {
        if let Some(path) = find_system(system_path) {
            return Ok(GitExecutable {
                path,
                source: GitSource::System,
            });
        }
    }
    Err(GitError::NotInstalled)
}

/// The first Git on the system PATH, whether or not it may be used — so the
/// UI can offer it ("Use System Git at ...") without silently using it.
pub fn find_system(system_path: Option<OsString>) -> Option<PathBuf> {
    let path = system_path?;
    let dirs: Vec<PathBuf> = std::env::split_paths(&path).collect();
    find_in(dirs.iter().map(PathBuf::as_path))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fake_git(dir: &Path) -> PathBuf {
        std::fs::create_dir_all(dir).unwrap();
        let file = dir.join(executable_name());
        std::fs::write(&file, b"").unwrap();
        file
    }

    #[test]
    fn portable_git_is_preferred_over_system_git() {
        let temp = tempfile::tempdir().unwrap();
        let portable = fake_git(&temp.path().join("portable cmd"));
        let system_dir = temp.path().join("system");
        fake_git(&system_dir);
        let found = resolve(
            &[temp.path().join("portable cmd")],
            true,
            Some(system_dir.into_os_string()),
        )
        .unwrap();
        assert_eq!(found.source, GitSource::Portable);
        assert_eq!(found.path, portable);
        assert_eq!(found.label(), "OpenMind portable Git");
    }

    #[test]
    fn the_first_folder_wins_so_a_bundled_git_beats_a_portable_one() {
        // The app puts the active bundled tools' folders in front of the Runtime Manager's.
        let temp = tempfile::tempdir().unwrap();
        let bundled = fake_git(&temp.path().join("tools").join("git").join("2.47.0"));
        fake_git(&temp.path().join("runtimes").join("git"));
        let found = resolve(
            &[
                temp.path().join("tools").join("git").join("2.47.0"),
                temp.path().join("runtimes").join("git"),
            ],
            false,
            None,
        )
        .unwrap();
        assert_eq!(found.path, bundled);
    }

    #[test]
    fn system_git_needs_permission_and_is_labelled_with_its_path() {
        let temp = tempfile::tempdir().unwrap();
        let system_dir = temp.path().join("system");
        let system = fake_git(&system_dir);
        let path = Some(system_dir.clone().into_os_string());

        assert_eq!(
            resolve(&[], false, path.clone()),
            Err(GitError::NotInstalled)
        );
        let found = resolve(&[], true, path.clone()).unwrap();
        assert_eq!(found.source, GitSource::System);
        assert_eq!(found.label(), format!("System Git at {}", system.display()));
        // Offered to the UI even when not allowed.
        assert_eq!(find_system(path), Some(system));
    }

    #[test]
    fn missing_git_is_a_clear_error() {
        let temp = tempfile::tempdir().unwrap();
        assert_eq!(
            resolve(&[temp.path().to_path_buf()], true, None),
            Err(GitError::NotInstalled)
        );
        assert_eq!(
            GitError::NotInstalled.to_string(),
            "Git runtime is not installed yet."
        );
    }
}
