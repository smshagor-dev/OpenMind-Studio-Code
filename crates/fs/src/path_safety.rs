use std::path::{Path, PathBuf};

use crate::error::FsError;

/// Canonicalizes `path`, stripping the `\\?\` extended-length prefix
/// Windows' own `std::fs::canonicalize` adds (via `dunce`) so paths are
/// consistent and readable wherever they're displayed or compared.
pub fn normalize_path(path: &Path) -> Result<PathBuf, FsError> {
    dunce::canonicalize(path).map_err(|source| FsError::Canonicalize {
        path: path.to_path_buf(),
        source,
    })
}

/// Verifies `target` resolves to a location inside `root`, rejecting path
/// traversal (`..`) and symlink escapes. `target` need not exist yet (e.g.
/// when creating a new file); in that case its *parent* must exist and be
/// verified instead, and `target`'s final component is appended back on.
pub fn ensure_within_root(root: &Path, target: &Path) -> Result<PathBuf, FsError> {
    let root_canon = normalize_path(root)?;

    if target.exists() {
        let target_canon = normalize_path(target)?;
        if !target_canon.starts_with(&root_canon) {
            return Err(FsError::OutsideWorkspaceRoot {
                path: target.to_path_buf(),
            });
        }
        return Ok(target_canon);
    }

    let Some(parent) = target.parent() else {
        return Err(FsError::OutsideWorkspaceRoot {
            path: target.to_path_buf(),
        });
    };
    let Some(file_name) = target.file_name() else {
        return Err(FsError::OutsideWorkspaceRoot {
            path: target.to_path_buf(),
        });
    };

    let parent_canon = normalize_path(parent)?;
    if !parent_canon.starts_with(&root_canon) {
        return Err(FsError::OutsideWorkspaceRoot {
            path: target.to_path_buf(),
        });
    }

    Ok(parent_canon.join(file_name))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalize_path_strips_windows_unc_prefix() {
        let dir = tempfile::tempdir().expect("tempdir");

        let normalized = normalize_path(dir.path()).expect("normalize");

        assert!(
            !normalized
                .as_os_str()
                .to_string_lossy()
                .starts_with(r"\\?\"),
            "expected no UNC prefix, got {normalized:?}"
        );
    }

    #[test]
    fn ensure_within_root_accepts_existing_path_inside_root() {
        let dir = tempfile::tempdir().expect("tempdir");
        let nested = dir.path().join("nested.txt");
        std::fs::write(&nested, "x").expect("write");

        let result = ensure_within_root(dir.path(), &nested).expect("should be allowed");

        assert!(result.starts_with(normalize_path(dir.path()).unwrap()));
    }

    #[test]
    fn ensure_within_root_accepts_new_path_whose_parent_is_inside_root() {
        let dir = tempfile::tempdir().expect("tempdir");
        let new_file = dir.path().join("new.txt");

        let result = ensure_within_root(dir.path(), &new_file).expect("should be allowed");

        assert_eq!(result.file_name().unwrap(), "new.txt");
    }

    #[test]
    fn ensure_within_root_rejects_traversal_outside_root() {
        let dir = tempfile::tempdir().expect("tempdir");
        let escape = dir.path().join("..").join("escaped.txt");

        let result = ensure_within_root(dir.path(), &escape);

        assert!(matches!(result, Err(FsError::OutsideWorkspaceRoot { .. })));
    }

    #[test]
    fn ensure_within_root_rejects_existing_sibling_directory() {
        let root = tempfile::tempdir().expect("tempdir");
        let sibling = tempfile::tempdir().expect("tempdir");

        let result = ensure_within_root(root.path(), sibling.path());

        assert!(matches!(result, Err(FsError::OutsideWorkspaceRoot { .. })));
    }
}
