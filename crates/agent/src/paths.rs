//! Every path the model names is resolved here, against the open folder only. A path is accepted when it lies inside the
//! folder after links are followed; a file that doesn't exist yet must have its nearest existing folder inside it. The
//! `.git` folder can be read but never changed.

use std::path::{Component, Path, PathBuf};

#[derive(Debug, Clone)]
pub struct Workspace {
    /// The open folder, canonical.
    root: PathBuf,
}

impl Workspace {
    pub fn new(root: &Path) -> Result<Self, String> {
        let root = openmind_fs::normalize_path(root)
            .map_err(|_| format!("The folder {} can't be opened.", root.display()))?;
        if !root.is_dir() {
            return Err(format!("{} is not a folder.", root.display()));
        }
        Ok(Self { root })
    }

    pub fn root(&self) -> &Path {
        &self.root
    }

    /// `path` relative to the folder, with forward slashes (for messages and the panel).
    pub fn relative(&self, path: &Path) -> String {
        let rel = path.strip_prefix(&self.root).unwrap_or(path);
        let text = rel.to_string_lossy().replace('\\', "/");
        if text.is_empty() {
            ".".into()
        } else {
            text
        }
    }

    /// Resolves `text` (relative to the folder, or absolute inside it).
    pub fn resolve(&self, text: &str) -> Result<PathBuf, String> {
        let text = text.trim();
        if text.contains('\0') {
            return Err("The path contains a NUL character.".into());
        }
        let given = Path::new(if text.is_empty() { "." } else { text });
        let joined = if given.is_absolute() {
            given.to_path_buf()
        } else {
            self.root.join(given)
        };
        // Lexically first, so `a/../../x` is refused even when nothing exists.
        let mut clean = PathBuf::new();
        for component in joined.components() {
            match component {
                Component::ParentDir => {
                    if !clean.pop() {
                        return Err(outside(text));
                    }
                }
                Component::CurDir => {}
                other => clean.push(other.as_os_str()),
            }
        }
        // Then for real: the nearest existing folder, links followed, must be inside the open folder.
        let mut existing = clean.as_path();
        let mut rest = Vec::new();
        while !existing.exists() {
            let Some(name) = existing.file_name() else {
                return Err(outside(text));
            };
            rest.push(name.to_os_string());
            existing = existing.parent().ok_or_else(|| outside(text))?;
        }
        let canonical = openmind_fs::normalize_path(existing).map_err(|_| outside(text))?;
        if !canonical.starts_with(&self.root) {
            return Err(outside(text));
        }
        let mut resolved = canonical;
        for name in rest.into_iter().rev() {
            resolved.push(name);
        }
        Ok(resolved)
    }

    /// Like [`resolve`](Self::resolve), for a path the agent is about to change.
    pub fn resolve_for_change(&self, text: &str) -> Result<PathBuf, String> {
        let path = self.resolve(text)?;
        if path == self.root {
            return Err("The open folder itself can't be changed.".into());
        }
        let rel = path.strip_prefix(&self.root).unwrap_or(&path);
        if rel
            .components()
            .any(|c| c.as_os_str().eq_ignore_ascii_case(".git"))
        {
            return Err(
                "Files inside .git are managed by Git and can't be changed by the agent.".into(),
            );
        }
        Ok(path)
    }
}

fn outside(text: &str) -> String {
    format!("{text} is outside the open folder. The agent can only work inside it.")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ws() -> (tempfile::TempDir, Workspace) {
        let dir = tempfile::tempdir().expect("tmp");
        std::fs::create_dir_all(dir.path().join("my project/src")).expect("mkdir");
        std::fs::write(dir.path().join("my project/src/a.py"), "x").expect("write");
        std::fs::create_dir_all(dir.path().join("my project/.git")).expect("mkdir");
        let ws = Workspace::new(&dir.path().join("my project")).expect("ws");
        (dir, ws)
    }

    #[test]
    fn relative_and_absolute_paths_inside_the_folder_resolve() {
        let (_dir, ws) = ws();
        let a = ws.resolve("src/a.py").expect("a");
        assert!(a.ends_with("a.py"));
        assert_eq!(ws.resolve(&a.to_string_lossy()).expect("abs"), a);
        assert_eq!(ws.relative(&a), "src/a.py");
        let new = ws.resolve("src/new/deep/b.ts").expect("new");
        assert_eq!(ws.relative(&new), "src/new/deep/b.ts");
    }

    #[test]
    fn nothing_outside_the_folder_resolves() {
        let (dir, ws) = ws();
        std::fs::write(dir.path().join("secret.txt"), "x").expect("write");
        for bad in ["../secret.txt", "src/../../secret.txt", "../../x"] {
            assert!(ws.resolve(bad).is_err(), "{bad}");
        }
        assert!(ws
            .resolve(&dir.path().join("secret.txt").to_string_lossy())
            .is_err());
        assert!(ws.resolve("a\0b").is_err());
    }

    #[test]
    fn git_internals_and_the_folder_itself_are_never_changed() {
        let (_dir, ws) = ws();
        assert!(ws.resolve(".git/config").is_ok());
        assert!(ws.resolve_for_change(".git/config").is_err());
        assert!(ws.resolve_for_change(".GIT/HEAD").is_err());
        assert!(ws.resolve_for_change(".").is_err());
        assert!(ws.resolve_for_change("src/a.py").is_ok());
        assert!(ws.resolve_for_change(".gitignore").is_ok());
    }
}
