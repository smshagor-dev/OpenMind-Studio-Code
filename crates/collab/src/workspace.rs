//! Layer 3's path check: turns a validated [`RelPath`] into a path inside the Owner's workspace, refusing every way
//! out. It only reads metadata — it never creates, writes or deletes; the actual change still goes through the
//! app's own file operations, which run `ensure_within_root` once more.
//!
//! Checks, in order: each existing component is looked at with `symlink_metadata` and a link refuses the path
//! (on Windows a junction is a name-surrogate reparse point, which `is_symlink` reports, so junctions are refused
//! too); then `openmind_fs::path_safety::ensure_within_root` canonicalizes and checks containment, which also
//! catches anything the walk could not see (a link created between the two steps still fails the second one).

use std::path::{Path, PathBuf};

use crate::error::CollabError;
use crate::files::RelPath;

/// The Owner's workspace folder, canonical.
#[derive(Debug, Clone)]
pub struct WorkspaceRoot {
    root: PathBuf,
}

impl WorkspaceRoot {
    pub fn new(root: &Path) -> Result<Self, CollabError> {
        let root = openmind_fs::path_safety::normalize_path(root)
            .map_err(|err| CollabError::UnsafePath(err.to_string()))?;
        if !root.is_dir() {
            return Err(CollabError::UnsafePath(
                "the workspace is not a folder".into(),
            ));
        }
        Ok(Self { root })
    }

    pub fn path(&self) -> &Path {
        &self.root
    }

    /// The absolute path for `rel`, which may not exist yet (its parent must). Never outside the workspace, never
    /// through a link.
    pub fn resolve(&self, rel: &RelPath) -> Result<PathBuf, CollabError> {
        let mut current = self.root.clone();
        for segment in rel.segments() {
            current.push(segment);
            match std::fs::symlink_metadata(&current) {
                Ok(meta) if meta.file_type().is_symlink() => {
                    return Err(CollabError::UnsafePath(
                        "the path goes through a link or junction".into(),
                    ))
                }
                Ok(_) => {}
                Err(err) if err.kind() == std::io::ErrorKind::NotFound => break,
                Err(err) => return Err(CollabError::UnsafePath(err.to_string())),
            }
        }
        let joined = openmind_fs::names::join_segments(
            &self.root,
            &rel.segments().map(str::to_string).collect::<Vec<_>>(),
        );
        openmind_fs::path_safety::ensure_within_root(&self.root, &joined)
            .map_err(|_| CollabError::UnsafePath("the path leads outside the workspace".into()))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rel(text: &str) -> RelPath {
        RelPath::parse(text).expect("path")
    }

    #[test]
    fn ordinary_paths_resolve_inside_the_workspace() {
        let dir = tempfile::tempdir().expect("tempdir");
        let ws = dir.path().join("My Work");
        std::fs::create_dir_all(ws.join("src")).expect("mkdir");
        std::fs::write(ws.join("src/main.ts"), "x").expect("write");
        let root = WorkspaceRoot::new(&ws).expect("root");
        let existing = root.resolve(&rel("src/main.ts")).expect("resolve");
        assert!(existing.starts_with(root.path()));
        let new = root.resolve(&rel("src/new.ts")).expect("resolve new");
        assert!(new.ends_with("new.ts"));
        assert!(
            root.resolve(&rel("missing/deeper/x.ts")).is_err(),
            "parent must exist"
        );
    }

    #[cfg(windows)]
    #[test]
    fn a_junction_out_of_the_workspace_is_refused() {
        let dir = tempfile::tempdir().expect("tempdir");
        let ws = dir.path().join("ws");
        let outside = dir.path().join("outside");
        std::fs::create_dir_all(&ws).expect("mkdir");
        std::fs::create_dir_all(&outside).expect("mkdir");
        std::fs::write(outside.join("secret.txt"), "s").expect("write");
        let status = std::process::Command::new("cmd")
            .args(["/C", "mklink", "/J"])
            .arg(ws.join("escape"))
            .arg(&outside)
            .output()
            .expect("mklink");
        assert!(status.status.success(), "a junction needs no rights");
        let root = WorkspaceRoot::new(&ws).expect("root");
        assert!(matches!(
            root.resolve(&rel("escape/secret.txt")),
            Err(CollabError::UnsafePath(_))
        ));
        assert!(matches!(
            root.resolve(&rel("escape")),
            Err(CollabError::UnsafePath(_))
        ));
        assert!(matches!(
            root.resolve(&rel("escape/new.txt")),
            Err(CollabError::UnsafePath(_))
        ));
    }

    #[test]
    fn a_symlink_out_of_the_workspace_is_refused_where_links_can_be_made() {
        let dir = tempfile::tempdir().expect("tempdir");
        let ws = dir.path().join("ws");
        std::fs::create_dir_all(&ws).expect("mkdir");
        std::fs::write(dir.path().join("secret.txt"), "s").expect("write");
        #[cfg(windows)]
        let made =
            std::os::windows::fs::symlink_file(dir.path().join("secret.txt"), ws.join("link.txt"));
        #[cfg(unix)]
        let made = std::os::unix::fs::symlink(dir.path().join("secret.txt"), ws.join("link.txt"));
        if made.is_err() {
            return; // Creating file symlinks needs Developer Mode or administrator rights on Windows.
        }
        let root = WorkspaceRoot::new(&ws).expect("root");
        assert!(matches!(
            root.resolve(&rel("link.txt")),
            Err(CollabError::UnsafePath(_))
        ));
    }

    #[test]
    fn a_file_is_not_a_workspace() {
        let dir = tempfile::tempdir().expect("tempdir");
        let file = dir.path().join("f.txt");
        std::fs::write(&file, "x").expect("write");
        assert!(WorkspaceRoot::new(&file).is_err());
    }
}
