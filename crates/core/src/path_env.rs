//! The one way a child process's PATH is built: OpenMind's folders (shims, bundled tools, the active portable
//! runtimes) in front, then the PATH the process would otherwise get, each folder once. Used by every launcher —
//! terminals, Run Code, language servers, debug adapters, the extension host, formatters, notebook kernels — so they all
//! find the same `node`, `python` or `gfortran`. Only the child's environment is built here; nothing global changes.

use std::ffi::{OsStr, OsString};
use std::path::{Path, PathBuf};

/// A folder's identity on a PATH: Windows paths ignore case and a trailing separator (`F:\Tools\` and `f:\tools` are
/// one folder); elsewhere only the trailing separator is ignored.
pub fn path_key(dir: &Path) -> String {
    let text = dir.to_string_lossy();
    let mut key = if cfg!(windows) {
        text.replace('/', "\\").to_lowercase()
    } else {
        text.into_owned()
    };
    while key.len() > 1 && (key.ends_with('\\') || key.ends_with('/')) && !key.ends_with(":\\") {
        key.pop();
    }
    key
}

/// `first` in front of `existing`, every folder once (the first occurrence wins, so OpenMind's own folders keep their
/// place ahead of a system copy of the same tool), empty entries dropped. Folders are joined as paths, never quoted by
/// hand: a folder with spaces stays one entry. `None` only when a folder can't be on a PATH at all (on Windows one
/// containing `"`; elsewhere `:`), which the caller reports.
pub fn prepend_path(first: &[PathBuf], existing: Option<&OsStr>) -> Option<OsString> {
    let mut seen = std::collections::HashSet::new();
    let rest: Vec<PathBuf> = existing
        .map(|path| std::env::split_paths(path).collect())
        .unwrap_or_default();
    let all: Vec<&PathBuf> = first
        .iter()
        .chain(rest.iter())
        .filter(|dir| !dir.as_os_str().is_empty())
        .filter(|dir| seen.insert(path_key(dir)))
        .collect();
    std::env::join_paths(all).ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn split(path: &OsString) -> Vec<String> {
        std::env::split_paths(path)
            .map(|dir| dir.to_string_lossy().into_owned())
            .collect()
    }

    #[cfg(windows)]
    #[test]
    fn the_runtime_folder_goes_first_and_the_system_path_follows_unchanged() {
        let joined = prepend_path(
            &[PathBuf::from(
                r"F:\OpenMind Studio\runtimes\node\versions\24.21.0",
            )],
            Some(OsStr::new(r"C:\Windows\System32;C:\Tools")),
        )
        .expect("path");
        assert_eq!(
            split(&joined),
            [
                r"F:\OpenMind Studio\runtimes\node\versions\24.21.0",
                r"C:\Windows\System32",
                r"C:\Tools"
            ]
        );
        // A folder with spaces is one entry, written as it is (no quotes added).
        assert!(!joined.to_string_lossy().contains('"'));
    }

    #[cfg(windows)]
    #[test]
    fn a_folder_already_on_the_path_appears_once_whatever_its_case_or_trailing_slash() {
        let node = PathBuf::from(r"F:\OpenMind Studio\runtimes\node");
        let joined = prepend_path(
            std::slice::from_ref(&node),
            Some(OsStr::new(r"C:\Windows;f:\openmind studio\runtimes\node\;F:/OpenMind Studio/runtimes/node;C:\Tools")),
        )
        .expect("path");
        assert_eq!(
            split(&joined),
            [
                r"F:\OpenMind Studio\runtimes\node",
                r"C:\Windows",
                r"C:\Tools"
            ]
        );
        // Building it again from its own result changes nothing (a terminal opened from a terminal).
        assert_eq!(prepend_path(&[node], Some(&joined)).expect("again"), joined);
    }

    #[cfg(windows)]
    #[test]
    fn without_runtimes_the_path_is_kept_and_empty_entries_dropped() {
        let joined = prepend_path(&[], Some(OsStr::new(r"C:\Windows;;C:\Tools;"))).expect("path");
        assert_eq!(split(&joined), [r"C:\Windows", r"C:\Tools"]);
        assert_eq!(prepend_path(&[], None).expect("empty"), OsString::new());
    }

    #[cfg(windows)]
    #[test]
    fn switching_the_active_version_replaces_the_old_folder() {
        // The runtime list is rebuilt from the active version every time, so the inherited PATH (the system's) never
        // carries the previous version: the new one is the only OpenMind Node folder.
        let v1 = PathBuf::from(r"F:\OM\runtimes\node\versions\24.20.0");
        let v2 = PathBuf::from(r"F:\OM\runtimes\node\versions\24.21.0");
        let system = OsStr::new(r"C:\Windows");
        let before = prepend_path(std::slice::from_ref(&v1), Some(system)).expect("v1");
        let after = prepend_path(std::slice::from_ref(&v2), Some(system)).expect("v2");
        assert!(split(&before).contains(&v1.to_string_lossy().into_owned()));
        assert_eq!(
            split(&after),
            [v2.to_string_lossy().into_owned(), r"C:\Windows".to_string()]
        );
    }

    #[test]
    fn a_folder_that_cannot_be_on_a_path_is_reported() {
        let bad = PathBuf::from(if cfg!(windows) { "C:\\a\"b" } else { "/a:b" });
        assert!(prepend_path(&[bad], None).is_none());
    }

    #[test]
    fn keys_ignore_trailing_separators() {
        assert_eq!(path_key(Path::new("/a/b/")), path_key(Path::new("/a/b")));
        #[cfg(not(windows))]
        assert_eq!(path_key(Path::new("/")), "/");
        #[cfg(windows)]
        assert_eq!(path_key(Path::new(r"C:\")), r"c:\");
    }
}
