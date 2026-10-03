use std::path::{Path, PathBuf};

use crate::error::FsError;
use crate::names::{join_segments, relative_segments, validate_name};

/// Creates an empty file named `name` in `parent_dir`. `name` may name sub-folders (`src/app.ts`, as VS Code's New
/// File allows): the missing ones are created; every segment is checked first, so nothing can land outside
/// `parent_dir`. An existing file is never touched.
pub async fn create_file(parent_dir: &Path, name: &str) -> Result<PathBuf, FsError> {
    let path = join_segments(parent_dir, &relative_segments(name)?);
    if path.exists() {
        return Err(FsError::AlreadyExists { path });
    }
    create_parents(&path).await?;
    tokio::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&path)
        .await
        .map_err(|source| FsError::Write {
            path: path.clone(),
            source,
        })?;
    Ok(path)
}

/// Creates the folder `name` (sub-folders allowed, like [`create_file`]) in `parent_dir`.
pub async fn create_dir(parent_dir: &Path, name: &str) -> Result<PathBuf, FsError> {
    let path = join_segments(parent_dir, &relative_segments(name)?);
    if path.exists() {
        return Err(FsError::AlreadyExists { path });
    }
    create_parents(&path).await?;
    tokio::fs::create_dir(&path)
        .await
        .map_err(|source| FsError::CreateDir {
            path: path.clone(),
            source,
        })?;
    Ok(path)
}

async fn create_parents(path: &Path) -> Result<(), FsError> {
    let Some(parent) = path.parent() else {
        return Ok(());
    };
    tokio::fs::create_dir_all(parent)
        .await
        .map_err(|source| FsError::CreateDir {
            path: parent.to_path_buf(),
            source,
        })
}

pub async fn rename(path: &Path, new_name: &str) -> Result<PathBuf, FsError> {
    validate_name(new_name)?;
    if !path.exists() {
        return Err(FsError::NotFound {
            path: path.to_path_buf(),
        });
    }
    let Some(parent) = path.parent() else {
        return Err(FsError::NotFound {
            path: path.to_path_buf(),
        });
    };
    let new_path = parent.join(new_name);
    // Windows: renaming "readme.md" to "README.md" is the same file, not a clash.
    if new_path.exists() && !same_entry(path, &new_path) {
        return Err(FsError::AlreadyExists { path: new_path });
    }
    tokio::fs::rename(path, &new_path)
        .await
        .map_err(|source| FsError::Rename {
            from: path.to_path_buf(),
            to: new_path.clone(),
            source,
        })?;
    Ok(new_path)
}

/// Moves `path` to the OS trash/recycle bin rather than permanently
/// deleting it — recoverable by the user, matching how VS Code's own
/// explorer delete behaves.
pub async fn delete(path: &Path) -> Result<(), FsError> {
    if !path.exists() {
        return Err(FsError::NotFound {
            path: path.to_path_buf(),
        });
    }
    let owned = path.to_path_buf();
    tokio::task::spawn_blocking(move || trash::delete(&owned))
        .await
        .expect("delete task should not panic")
        .map_err(|source| FsError::Delete {
            path: path.to_path_buf(),
            source,
        })
}

pub async fn move_path(source: &Path, dest_dir: &Path) -> Result<PathBuf, FsError> {
    let dest = target_path(source, dest_dir)?;
    if dest.exists() {
        return Err(FsError::AlreadyExists { path: dest });
    }

    match tokio::fs::rename(source, &dest).await {
        Ok(()) => Ok(dest),
        // EXDEV: rename can't cross filesystem/volume boundaries; fall back
        // to copy-then-delete-original.
        Err(_) => {
            copy_recursive(source, &dest).await?;
            delete(source).await?;
            Ok(dest)
        }
    }
}

pub async fn copy_path(source: &Path, dest_dir: &Path) -> Result<PathBuf, FsError> {
    let dest = target_path(source, dest_dir)?;
    if dest.exists() {
        return Err(FsError::AlreadyExists { path: dest });
    }
    copy_recursive(source, &dest).await?;
    Ok(dest)
}

/// Like [`copy_path`], but under an explicit `new_name` rather than
/// `source`'s own name — what "Duplicate" needs (copying within the same
/// directory, where reusing the source's name would always collide).
pub async fn copy_path_as(
    source: &Path,
    dest_dir: &Path,
    new_name: &str,
) -> Result<PathBuf, FsError> {
    validate_name(new_name)?;
    let dest = dest_dir.join(new_name);
    if dest.exists() {
        return Err(FsError::AlreadyExists { path: dest });
    }
    copy_recursive(source, &dest).await?;
    Ok(dest)
}

/// Whether two paths name one entry (a case-only rename on a case-insensitive file system).
fn same_entry(a: &Path, b: &Path) -> bool {
    match (dunce::canonicalize(a), dunce::canonicalize(b)) {
        (Ok(a), Ok(b)) => a == b,
        _ => false,
    }
}

fn target_path(source: &Path, dest_dir: &Path) -> Result<PathBuf, FsError> {
    let Some(name) = source.file_name() else {
        return Err(FsError::NotFound {
            path: source.to_path_buf(),
        });
    };
    Ok(dest_dir.join(name))
}

fn copy_recursive<'a>(
    source: &'a Path,
    dest: &'a Path,
) -> std::pin::Pin<Box<dyn std::future::Future<Output = Result<(), FsError>> + Send + 'a>> {
    Box::pin(async move {
        let file_type = tokio::fs::symlink_metadata(source)
            .await
            .map_err(|source_err| FsError::Copy {
                from: source.to_path_buf(),
                to: dest.to_path_buf(),
                source: source_err,
            })?
            .file_type();

        // Symlinks are neither followed (avoids loops) nor recreated as
        // links at the destination — skipped entirely. Safe default for a
        // file-explorer copy; nothing in this milestone needs symlink
        // preservation.
        if file_type.is_symlink() {
            return Ok(());
        }

        if file_type.is_dir() {
            tokio::fs::create_dir(dest)
                .await
                .map_err(|source_err| FsError::CreateDir {
                    path: dest.to_path_buf(),
                    source: source_err,
                })?;

            let mut entries =
                tokio::fs::read_dir(source)
                    .await
                    .map_err(|source_err| FsError::ReadDir {
                        path: source.to_path_buf(),
                        source: source_err,
                    })?;
            while let Some(entry) =
                entries
                    .next_entry()
                    .await
                    .map_err(|source_err| FsError::ReadDir {
                        path: source.to_path_buf(),
                        source: source_err,
                    })?
            {
                let child_dest = dest.join(entry.file_name());
                copy_recursive(&entry.path(), &child_dest).await?;
            }
            Ok(())
        } else {
            tokio::fs::copy(source, dest)
                .await
                .map_err(|source_err| FsError::Copy {
                    from: source.to_path_buf(),
                    to: dest.to_path_buf(),
                    source: source_err,
                })?;
            Ok(())
        }
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn create_file_creates_empty_file() {
        let dir = tempfile::tempdir().expect("tempdir");

        let path = create_file(dir.path(), "new.txt").await.expect("create");

        assert!(path.exists());
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "");
    }

    #[tokio::test]
    async fn create_file_rejects_existing_name() {
        let dir = tempfile::tempdir().expect("tempdir");
        create_file(dir.path(), "new.txt").await.expect("create");

        let result = create_file(dir.path(), "new.txt").await;

        assert!(matches!(result, Err(FsError::AlreadyExists { .. })));
    }

    #[tokio::test]
    async fn nested_names_create_the_missing_folders_inside_the_parent() {
        let dir = tempfile::tempdir().expect("tempdir");

        let path = create_file(dir.path(), "src/components/Button.tsx")
            .await
            .expect("create");

        assert_eq!(
            path,
            dir.path().join("src").join("components").join("Button.tsx")
        );
        assert!(path.is_file());
        let folder = create_dir(dir.path(), "a\\b").await.expect("folder");
        assert!(folder.is_dir());
    }

    #[tokio::test]
    async fn names_that_leave_the_parent_or_windows_cant_store_are_refused() {
        let root = tempfile::tempdir().expect("tempdir");
        let parent = root.path().join("inner");
        std::fs::create_dir(&parent).expect("inner");
        for name in [
            "../escape.txt",
            "..\\escape.txt",
            "C:/x.txt",
            "a/../b.txt",
            "con.txt",
            "x?.txt",
        ] {
            let result = create_file(&parent, name).await;
            assert!(matches!(result, Err(FsError::InvalidName { .. })), "{name}");
        }
        assert!(!root.path().join("escape.txt").exists());
        let file = create_file(&parent, "a.txt").await.expect("a");
        assert!(matches!(
            rename(&file, "..\\b.txt").await,
            Err(FsError::InvalidName { .. })
        ));
        assert!(matches!(
            rename(&file, "sub/b.txt").await,
            Err(FsError::InvalidName { .. })
        ));
        assert!(file.exists());
    }

    #[tokio::test]
    async fn unicode_and_spaces_are_fine_and_a_case_only_rename_works() {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = create_file(dir.path(), "привет мир.py")
            .await
            .expect("create");
        assert!(path.is_file());

        let renamed = rename(&path, "ПРИВЕТ мир.py")
            .await
            .expect("case-only rename");
        assert_eq!(renamed.file_name().unwrap(), "ПРИВЕТ мир.py");
    }

    #[tokio::test]
    async fn create_dir_creates_folder() {
        let dir = tempfile::tempdir().expect("tempdir");

        let path = create_dir(dir.path(), "sub").await.expect("create");

        assert!(path.is_dir());
    }

    #[tokio::test]
    async fn rename_renames_file_in_place() {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = create_file(dir.path(), "old.txt").await.expect("create");

        let new_path = rename(&path, "new.txt").await.expect("rename");

        assert!(!path.exists());
        assert!(new_path.exists());
        assert_eq!(new_path.file_name().unwrap(), "new.txt");
    }

    #[tokio::test]
    async fn rename_rejects_collision_with_existing_name() {
        let dir = tempfile::tempdir().expect("tempdir");
        create_file(dir.path(), "a.txt").await.expect("create a");
        let b = create_file(dir.path(), "b.txt").await.expect("create b");

        let result = rename(&b, "a.txt").await;

        assert!(matches!(result, Err(FsError::AlreadyExists { .. })));
    }

    #[tokio::test]
    async fn rename_missing_path_returns_not_found() {
        let dir = tempfile::tempdir().expect("tempdir");
        let missing = dir.path().join("missing.txt");

        let result = rename(&missing, "new.txt").await;

        assert!(matches!(result, Err(FsError::NotFound { .. })));
    }

    #[tokio::test]
    async fn delete_moves_file_to_trash() {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = create_file(dir.path(), "gone.txt").await.expect("create");

        delete(&path).await.expect("delete");

        assert!(!path.exists());
    }

    #[tokio::test]
    async fn delete_missing_path_returns_not_found() {
        let dir = tempfile::tempdir().expect("tempdir");
        let missing = dir.path().join("missing.txt");

        let result = delete(&missing).await;

        assert!(matches!(result, Err(FsError::NotFound { .. })));
    }

    #[tokio::test]
    async fn move_path_moves_file_into_destination_dir() {
        let dir = tempfile::tempdir().expect("tempdir");
        let source = create_file(dir.path(), "a.txt").await.expect("create");
        let dest_dir = create_dir(dir.path(), "dest").await.expect("create dir");

        let moved = move_path(&source, &dest_dir).await.expect("move");

        assert!(!source.exists());
        assert!(moved.exists());
        assert_eq!(moved, dest_dir.join("a.txt"));
    }

    #[tokio::test]
    async fn move_path_moves_directory_recursively() {
        let dir = tempfile::tempdir().expect("tempdir");
        let source_dir = create_dir(dir.path(), "source").await.expect("create");
        create_file(&source_dir, "inner.txt")
            .await
            .expect("create inner");
        let dest_dir = create_dir(dir.path(), "dest").await.expect("create dest");

        let moved = move_path(&source_dir, &dest_dir).await.expect("move");

        assert!(!source_dir.exists());
        assert!(moved.join("inner.txt").exists());
    }

    #[tokio::test]
    async fn copy_path_copies_file_leaving_original() {
        let dir = tempfile::tempdir().expect("tempdir");
        let source = create_file(dir.path(), "a.txt").await.expect("create");
        std::fs::write(&source, "content").unwrap();
        let dest_dir = create_dir(dir.path(), "dest").await.expect("create dir");

        let copied = copy_path(&source, &dest_dir).await.expect("copy");

        assert!(source.exists());
        assert_eq!(std::fs::read_to_string(&copied).unwrap(), "content");
    }

    #[tokio::test]
    async fn copy_path_copies_directory_recursively() {
        let dir = tempfile::tempdir().expect("tempdir");
        let source_dir = create_dir(dir.path(), "source").await.expect("create");
        create_file(&source_dir, "inner.txt")
            .await
            .expect("create inner");
        let dest_dir = create_dir(dir.path(), "dest").await.expect("create dest");

        let copied = copy_path(&source_dir, &dest_dir).await.expect("copy");

        assert!(source_dir.join("inner.txt").exists());
        assert!(copied.join("inner.txt").exists());
    }

    #[tokio::test]
    async fn copy_path_as_copies_within_the_same_directory_under_a_new_name() {
        let dir = tempfile::tempdir().expect("tempdir");
        let source = create_file(dir.path(), "a.txt").await.expect("create");
        std::fs::write(&source, "content").unwrap();

        let copied = copy_path_as(&source, dir.path(), "a copy.txt")
            .await
            .expect("copy");

        assert!(source.exists());
        assert_eq!(copied.file_name().unwrap(), "a copy.txt");
        assert_eq!(std::fs::read_to_string(&copied).unwrap(), "content");
    }

    #[tokio::test]
    async fn copy_path_as_rejects_existing_destination() {
        let dir = tempfile::tempdir().expect("tempdir");
        let source = create_file(dir.path(), "a.txt").await.expect("create");
        create_file(dir.path(), "a copy.txt")
            .await
            .expect("create collide");

        let result = copy_path_as(&source, dir.path(), "a copy.txt").await;

        assert!(matches!(result, Err(FsError::AlreadyExists { .. })));
    }

    #[tokio::test]
    async fn copy_path_rejects_existing_destination() {
        let dir = tempfile::tempdir().expect("tempdir");
        let source = create_file(dir.path(), "a.txt").await.expect("create");
        let dest_dir = create_dir(dir.path(), "dest").await.expect("create dir");
        create_file(&dest_dir, "a.txt")
            .await
            .expect("create collide");

        let result = copy_path(&source, &dest_dir).await;

        assert!(matches!(result, Err(FsError::AlreadyExists { .. })));
    }
}
