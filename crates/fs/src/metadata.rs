use std::path::Path;

use serde::Serialize;

use crate::error::FsError;

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PathMetadata {
    pub path: String,
    pub is_dir: bool,
    pub is_file: bool,
    pub is_symlink: bool,
    pub size: u64,
    pub readonly: bool,
    /// RFC 3339 timestamp, when the platform provides one.
    pub modified: Option<String>,
}

/// Stats `path`. Used both to answer "reveal" requests and, defensively,
/// to check a path still exists before acting on it (e.g. a file deleted
/// outside the app between an explorer refresh and the user clicking it).
pub async fn metadata(path: &Path) -> Result<PathMetadata, FsError> {
    let symlink_meta =
        tokio::fs::symlink_metadata(path)
            .await
            .map_err(|source| FsError::Metadata {
                path: path.to_path_buf(),
                source,
            })?;
    let is_symlink = symlink_meta.file_type().is_symlink();

    // Follow the symlink (if any) for the "real" file/dir classification and
    // size, but the symlink-ness itself comes from the unfollowed stat above.
    let meta = tokio::fs::metadata(path)
        .await
        .map_err(|source| FsError::Metadata {
            path: path.to_path_buf(),
            source,
        })?;

    let modified = meta
        .modified()
        .ok()
        .and_then(|time| time.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|duration| duration.as_secs().to_string());

    Ok(PathMetadata {
        path: path.to_string_lossy().into_owned(),
        is_dir: meta.is_dir(),
        is_file: meta.is_file(),
        is_symlink,
        size: meta.len(),
        readonly: meta.permissions().readonly(),
        modified,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn reports_file_metadata() {
        let dir = tempfile::tempdir().expect("tempdir");
        let file = dir.path().join("note.txt");
        std::fs::write(&file, "hello").expect("write");

        let meta = metadata(&file).await.expect("metadata");

        assert!(meta.is_file);
        assert!(!meta.is_dir);
        assert!(!meta.is_symlink);
        assert_eq!(meta.size, 5);
    }

    #[tokio::test]
    async fn reports_directory_metadata() {
        let dir = tempfile::tempdir().expect("tempdir");

        let meta = metadata(dir.path()).await.expect("metadata");

        assert!(meta.is_dir);
        assert!(!meta.is_file);
    }

    #[tokio::test]
    async fn missing_path_returns_error() {
        let dir = tempfile::tempdir().expect("tempdir");
        let missing = dir.path().join("missing.txt");

        let result = metadata(&missing).await;

        assert!(matches!(result, Err(FsError::Metadata { .. })));
    }
}
