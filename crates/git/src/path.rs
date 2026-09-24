use std::path::{Component, Path, PathBuf};

use crate::error::GitError;

/// A repository-relative path as the UI sends it, checked and normalized to
/// forward slashes. Refuses anything that could leave the repository: empty
/// or absolute paths, drive letters, `..`, NUL and control characters.
pub fn repo_relative(path: &str) -> Result<String, GitError> {
    let invalid = || GitError::InvalidPath(path.to_string());
    if path.is_empty() || path.chars().any(|c| c == '\0' || c.is_control()) {
        return Err(invalid());
    }
    let unified = path.replace('\\', "/");
    if unified.starts_with('/') || unified.contains(':') {
        return Err(GitError::OutsideRepository(path.to_string()));
    }
    let mut parts = Vec::new();
    for part in unified.split('/') {
        match part {
            "" | "." => {}
            ".." => return Err(GitError::OutsideRepository(path.to_string())),
            other => parts.push(other),
        }
    }
    if parts.is_empty() || parts.first() == Some(&".git") {
        return Err(invalid());
    }
    Ok(parts.join("/"))
}

/// An absolute path made relative to the repository root (either slash style,
/// case-insensitive on Windows), then checked like any repo-relative path.
pub fn relative_to_root(root: &Path, absolute: &str) -> Result<String, GitError> {
    let unify = |text: &str| text.replace('\\', "/");
    let root_text = unify(&root.to_string_lossy());
    let root_text = root_text.trim_end_matches('/');
    let path_text = unify(absolute);
    let outside = || GitError::OutsideRepository(absolute.to_string());
    if path_text.len() <= root_text.len() {
        return Err(outside());
    }
    let (head, tail) = path_text
        .split_at_checked(root_text.len())
        .ok_or_else(outside)?;
    let same_prefix = if cfg!(windows) {
        head.eq_ignore_ascii_case(root_text)
    } else {
        head == root_text
    };
    match tail.strip_prefix('/') {
        Some(relative) if same_prefix => repo_relative(relative),
        _ => Err(outside()),
    }
}

/// The absolute path of a checked repo-relative path.
pub fn absolute_in(root: &Path, relative: &str) -> PathBuf {
    relative
        .split('/')
        .fold(root.to_path_buf(), |path, part| path.join(part))
}

/// Whether `path` (or any folder between `root` and it) is a symlink or
/// reparse point. Destructive file operations refuse those so a link can't
/// aim a delete at something outside the repository.
pub fn crosses_symlink(root: &Path, relative: &str) -> bool {
    let mut current = root.to_path_buf();
    for part in relative.split('/') {
        current.push(part);
        match std::fs::symlink_metadata(&current) {
            Ok(meta) if meta.file_type().is_symlink() => return true,
            Ok(_) => {}
            Err(_) => return false,
        }
    }
    false
}

/// Whether `path` is inside `root` after resolving `..` lexically (no I/O).
pub fn is_lexically_inside(root: &Path, path: &Path) -> bool {
    let mut depth: i32 = 0;
    let Ok(rest) = path.strip_prefix(root) else {
        return false;
    };
    for component in rest.components() {
        match component {
            Component::ParentDir => depth -= 1,
            Component::Normal(_) => depth += 1,
            _ => {}
        }
        if depth < 0 {
            return false;
        }
    }
    true
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalizes_separators_and_keeps_spaces() {
        assert_eq!(
            repo_relative("src\\my folder\\a b.txt").unwrap(),
            "src/my folder/a b.txt"
        );
        assert_eq!(repo_relative("./a/./b").unwrap(), "a/b");
    }

    #[test]
    fn refuses_anything_that_can_leave_the_repository() {
        for bad in [
            "../x",
            "a/../../x",
            "/etc/passwd",
            "C:/x",
            "C:\\x",
            "a/b/../../../c",
        ] {
            assert!(
                matches!(repo_relative(bad), Err(GitError::OutsideRepository(_))),
                "{bad}"
            );
        }
        for bad in ["", ".", "a\0b", "a\nb", ".git/config"] {
            assert!(
                matches!(repo_relative(bad), Err(GitError::InvalidPath(_))),
                "{bad:?}"
            );
        }
    }

    #[test]
    fn a_path_that_dips_out_and_back_in_is_still_refused_when_it_leaves() {
        assert!(is_lexically_inside(Path::new("/r"), Path::new("/r/a/../b")));
        assert!(!is_lexically_inside(Path::new("/r"), Path::new("/r/../x")));
        assert!(!is_lexically_inside(Path::new("/r"), Path::new("/other/x")));
    }

    #[test]
    fn absolute_paths_become_repo_relative_in_either_slash_style() {
        let root = Path::new("E:/my repos/site");
        assert_eq!(
            relative_to_root(root, "E:\\my repos\\site\\src\\a b.txt").unwrap(),
            "src/a b.txt"
        );
        assert_eq!(
            relative_to_root(root, "E:/my repos/site/a.txt").unwrap(),
            "a.txt"
        );
        for outside in [
            "E:/my repos/other/a.txt",
            "E:/my repos/site",
            "E:/my repos/site2/a.txt",
            "E:/my repos/site/../x.txt",
            "D:/elsewhere/a.txt",
        ] {
            assert!(relative_to_root(root, outside).is_err(), "{outside}");
        }
    }

    #[test]
    fn absolute_in_joins_each_part() {
        assert_eq!(
            absolute_in(Path::new("/r s"), "a b/c.txt"),
            Path::new("/r s").join("a b").join("c.txt")
        );
    }

    #[test]
    fn a_plain_file_does_not_cross_a_symlink() {
        let temp = tempfile::tempdir().unwrap();
        std::fs::write(temp.path().join("a.txt"), "x").unwrap();
        assert!(!crosses_symlink(temp.path(), "a.txt"));
        assert!(!crosses_symlink(temp.path(), "missing/file"));
    }
}
