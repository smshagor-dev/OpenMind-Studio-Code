use std::path::{Component, Path, PathBuf};

use crate::error::PreviewError;

/// Checks a path the UI sent before anything reads it: absolute, no `..`, no NUL, not a network (UNC) path, and an
/// existing regular file. Returns the canonical path.
pub fn validate(raw: &str) -> Result<PathBuf, PreviewError> {
    if raw.is_empty() || raw.contains('\0') {
        return Err(PreviewError::InvalidPath);
    }
    let verbatim = raw.starts_with(r"\\?\");
    if (raw.starts_with(r"\\") && !verbatim) || raw.starts_with("//") {
        return Err(PreviewError::InvalidPath);
    }
    let path = Path::new(raw);
    if !path.is_absolute() || path.components().any(|part| part == Component::ParentDir) {
        return Err(PreviewError::InvalidPath);
    }
    let canonical = path.canonicalize().map_err(|_| PreviewError::NotFound)?;
    let metadata = std::fs::metadata(&canonical).map_err(|_| PreviewError::NotFound)?;
    if !metadata.is_file() {
        return Err(PreviewError::NotAFile);
    }
    Ok(canonical)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn traversal_unc_nul_relative_and_directories_are_refused() {
        let dir = tempfile::tempdir().expect("tempdir");
        let file = dir.path().join("a b.txt");
        std::fs::write(&file, "x").expect("write");
        assert!(validate(&file.to_string_lossy()).is_ok());
        let dotted = format!("{}/../a b.txt", dir.path().display());
        assert!(matches!(validate(&dotted), Err(PreviewError::InvalidPath)));
        assert!(matches!(validate("a.txt"), Err(PreviewError::InvalidPath)));
        assert!(matches!(validate(""), Err(PreviewError::InvalidPath)));
        assert!(matches!(
            validate("C:\\a\0b"),
            Err(PreviewError::InvalidPath)
        ));
        assert!(matches!(
            validate(r"\\server\share\a.pdf"),
            Err(PreviewError::InvalidPath)
        ));
        assert!(matches!(
            validate("//server/share/a.pdf"),
            Err(PreviewError::InvalidPath)
        ));
        assert!(matches!(
            validate(&dir.path().to_string_lossy()),
            Err(PreviewError::NotAFile)
        ));
        let missing = dir.path().join("nope.txt");
        assert!(matches!(
            validate(&missing.to_string_lossy()),
            Err(PreviewError::NotFound)
        ));
    }
}
