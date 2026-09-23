use std::path::Path;

use serde::Serialize;

use crate::error::FsError;

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DirEntryInfo {
    pub name: String,
    pub path: String,
    pub is_dir: bool,
    pub is_symlink: bool,
}

/// Lists the immediate children of `path` — one level only. The explorer
/// tree loads directories lazily (one `read_dir` call per expand), so this
/// never recurses and never risks walking into `node_modules`/`.git`/etc.
/// by itself.
///
/// Sorted directories-first, then case-insensitive alphabetical — the
/// conventional file-tree ordering.
pub async fn read_dir(path: &Path) -> Result<Vec<DirEntryInfo>, FsError> {
    let mut read_dir = tokio::fs::read_dir(path)
        .await
        .map_err(|source| FsError::ReadDir {
            path: path.to_path_buf(),
            source,
        })?;

    let mut entries = Vec::new();
    while let Some(entry) = read_dir
        .next_entry()
        .await
        .map_err(|source| FsError::ReadDir {
            path: path.to_path_buf(),
            source,
        })?
    {
        let file_type = entry.file_type().await.map_err(|source| FsError::ReadDir {
            path: path.to_path_buf(),
            source,
        })?;

        entries.push(DirEntryInfo {
            name: entry.file_name().to_string_lossy().into_owned(),
            path: entry.path().to_string_lossy().into_owned(),
            is_dir: file_type.is_dir(),
            is_symlink: file_type.is_symlink(),
        });
    }

    entries.sort_by(|a, b| match (a.is_dir, b.is_dir) {
        (true, false) => std::cmp::Ordering::Less,
        (false, true) => std::cmp::Ordering::Greater,
        _ => a.name.to_lowercase().cmp(&b.name.to_lowercase()),
    });

    Ok(entries)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn lists_entries_directories_first_then_alphabetical() {
        let dir = tempfile::tempdir().expect("tempdir");
        std::fs::write(dir.path().join("b.txt"), "").expect("write");
        std::fs::write(dir.path().join("a.txt"), "").expect("write");
        std::fs::create_dir(dir.path().join("z_folder")).expect("mkdir");

        let entries = read_dir(dir.path()).await.expect("read_dir");

        let names: Vec<&str> = entries.iter().map(|e| e.name.as_str()).collect();
        assert_eq!(names, vec!["z_folder", "a.txt", "b.txt"]);
        assert!(entries[0].is_dir);
        assert!(!entries[1].is_dir);
    }

    #[tokio::test]
    async fn read_dir_on_missing_path_returns_error() {
        let dir = tempfile::tempdir().expect("tempdir");
        let missing = dir.path().join("does-not-exist");

        let result = read_dir(&missing).await;

        assert!(matches!(result, Err(FsError::ReadDir { .. })));
    }
}
