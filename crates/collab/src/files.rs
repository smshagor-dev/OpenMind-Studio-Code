//! Shared files are addressed by [`FileId`]; the Owner keeps the only map from an id to a relative path. A path
//! that does arrive from a peer (a new file's name, a rename target) must first become a [`RelPath`]: forward
//! slashes only, every segment a name Windows can store (`openmind_fs::names`), never `.`/`..`, a drive, a root,
//! a backslash or a stream (`:`). Absolute Owner paths are never part of this model.

use std::collections::{BTreeMap, HashMap};
use std::fmt;

use serde::{Deserialize, Serialize};

use crate::error::{invalid, CollabError};
pub use crate::ids::FileId;

pub const MAX_PATH_BYTES: usize = 1024;
pub const MAX_DEPTH: usize = 64;
/// Entries one room's table may hold.
pub const MAX_ENTRIES: usize = 200_000;

/// A validated workspace-relative path (`src/main.ts`).
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(try_from = "String", into = "String")]
pub struct RelPath(String);

impl RelPath {
    pub fn parse(text: &str) -> Result<Self, CollabError> {
        if text.is_empty() {
            return Err(invalid("path", "it can't be empty"));
        }
        if text.len() > MAX_PATH_BYTES {
            return Err(invalid("path", format!("at most {MAX_PATH_BYTES} bytes")));
        }
        if text.contains('\\') {
            return Err(invalid("path", "use \"/\" between folders"));
        }
        let segments: Vec<&str> = text.split('/').collect();
        if segments.len() > MAX_DEPTH {
            return Err(invalid("path", format!("at most {MAX_DEPTH} folders deep")));
        }
        for segment in &segments {
            if let Some(reason) = openmind_fs::names::segment_problem(segment) {
                return Err(invalid("path", reason));
            }
        }
        Ok(Self(text.to_string()))
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }

    pub fn segments(&self) -> impl Iterator<Item = &str> {
        self.0.split('/')
    }

    /// The comparison key: Windows file names don't differ by case alone.
    pub fn key(&self) -> String {
        self.0.to_lowercase()
    }

    pub fn file_name(&self) -> &str {
        self.0.rsplit('/').next().unwrap_or(&self.0)
    }

    /// Whether `self` is inside the folder `folder` (not equal to it).
    pub fn is_inside(&self, folder: &RelPath) -> bool {
        let key = self.key();
        let prefix = format!("{}/", folder.key());
        key.starts_with(&prefix)
    }

    /// `self` with the folder prefix `from` replaced by `to` (for a folder rename).
    fn moved(&self, from: &RelPath, to: &RelPath) -> Result<RelPath, CollabError> {
        let rest = &self.0[from.0.len()..];
        RelPath::parse(&format!("{}{rest}", to.0))
    }
}

impl TryFrom<String> for RelPath {
    type Error = CollabError;
    fn try_from(text: String) -> Result<Self, Self::Error> {
        Self::parse(&text)
    }
}

impl From<RelPath> for String {
    fn from(path: RelPath) -> String {
        path.0
    }
}

impl fmt::Display for RelPath {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.0)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum FileKind {
    File,
    Folder,
}

impl FileKind {
    pub fn as_str(self) -> &'static str {
        match self {
            FileKind::File => "file",
            FileKind::Folder => "folder",
        }
    }

    pub fn parse(text: &str) -> Result<Self, CollabError> {
        match text {
            "file" => Ok(FileKind::File),
            "folder" => Ok(FileKind::Folder),
            _ => Err(invalid("file kind", format!("unknown kind \"{text}\""))),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FileEntry {
    pub path: RelPath,
    pub kind: FileKind,
}

/// The Owner's map of shared entries: id <-> path, unique by path ignoring case.
#[derive(Debug, Clone, Default)]
pub struct FileTable {
    by_id: BTreeMap<FileId, FileEntry>,
    by_key: HashMap<String, FileId>,
}

impl FileTable {
    pub fn len(&self) -> usize {
        self.by_id.len()
    }

    pub fn is_empty(&self) -> bool {
        self.by_id.is_empty()
    }

    pub fn get(&self, id: &FileId) -> Option<&FileEntry> {
        self.by_id.get(id)
    }

    pub fn id_of(&self, path: &RelPath) -> Option<&FileId> {
        self.by_key.get(&path.key())
    }

    pub fn iter(&self) -> impl Iterator<Item = (&FileId, &FileEntry)> {
        self.by_id.iter()
    }

    /// Adds a new entry with a fresh random id.
    pub fn insert(&mut self, path: RelPath, kind: FileKind) -> Result<FileId, CollabError> {
        let id = FileId::random()?;
        self.restore(id.clone(), path, kind)?;
        Ok(id)
    }

    /// Adds an entry with a known id (loading a stored table).
    pub fn restore(
        &mut self,
        id: FileId,
        path: RelPath,
        kind: FileKind,
    ) -> Result<(), CollabError> {
        if self.by_id.len() >= MAX_ENTRIES {
            return Err(invalid(
                "file table",
                format!("at most {MAX_ENTRIES} entries"),
            ));
        }
        if self.by_id.contains_key(&id) {
            return Err(invalid("file id", "already in use"));
        }
        if self.by_key.contains_key(&path.key()) {
            return Err(invalid("path", format!("\"{path}\" is already shared")));
        }
        self.by_key.insert(path.key(), id.clone());
        self.by_id.insert(id, FileEntry { path, kind });
        Ok(())
    }

    /// Renames an entry; a folder's descendants move with it. Nothing changes if any new path collides. Returns
    /// every id whose path changed (the entry and, for a folder, everything inside it), so callers persist them all.
    pub fn rename(&mut self, id: &FileId, to: RelPath) -> Result<Vec<FileId>, CollabError> {
        let entry = self.by_id.get(id).ok_or(CollabError::UnknownFile)?.clone();
        if to.is_inside(&entry.path) {
            return Err(invalid("path", "a folder can't move into itself"));
        }
        let mut moves = vec![(id.clone(), to.clone())];
        if entry.kind == FileKind::Folder {
            for (child, child_entry) in &self.by_id {
                if child_entry.path.is_inside(&entry.path) {
                    moves.push((child.clone(), child_entry.path.moved(&entry.path, &to)?));
                }
            }
        }
        let moving: std::collections::HashSet<&FileId> = moves.iter().map(|(id, _)| id).collect();
        for (_, path) in &moves {
            if let Some(owner) = self.by_key.get(&path.key()) {
                if !moving.contains(owner) {
                    return Err(invalid("path", format!("\"{path}\" already exists")));
                }
            }
        }
        for (moved, _) in &moves {
            if let Some(old) = self.by_id.get(moved) {
                self.by_key.remove(&old.path.key());
            }
        }
        let mut moved_ids = Vec::with_capacity(moves.len());
        for (moved, path) in moves {
            self.by_key.insert(path.key(), moved.clone());
            if let Some(entry) = self.by_id.get_mut(&moved) {
                entry.path = path;
            }
            moved_ids.push(moved);
        }
        Ok(moved_ids)
    }

    /// Removes an entry (a folder with everything inside it); returns the removed ids.
    pub fn remove(&mut self, id: &FileId) -> Vec<FileId> {
        let Some(entry) = self.by_id.get(id).cloned() else {
            return Vec::new();
        };
        let mut removed = vec![id.clone()];
        if entry.kind == FileKind::Folder {
            removed.extend(
                self.by_id
                    .iter()
                    .filter(|(_, e)| e.path.is_inside(&entry.path))
                    .map(|(child, _)| child.clone()),
            );
        }
        for gone in &removed {
            if let Some(e) = self.by_id.remove(gone) {
                self.by_key.remove(&e.path.key());
            }
        }
        removed
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn p(text: &str) -> RelPath {
        RelPath::parse(text).expect("path")
    }

    #[test]
    fn hostile_paths_are_refused() {
        for bad in [
            "",
            "/etc/passwd",
            "../secret",
            "src/../../x",
            "a/./b",
            "C:/Windows",
            "C:",
            "src\\main.ts",
            "a//b",
            "a/",
            "file.txt:stream",
            "con",
            "src/aux.js",
            "trail. ",
            "\u{0000}x",
            "a/b?",
        ] {
            assert!(RelPath::parse(bad).is_err(), "{bad:?}");
        }
        assert!(RelPath::parse("a/".repeat(65).trim_end_matches('/')).is_err());
        assert_eq!(p("src/components/Button.tsx").file_name(), "Button.tsx");
        assert!(serde_json::from_str::<RelPath>("\"../x\"").is_err());
    }

    #[test]
    fn the_table_is_unique_by_path_ignoring_case() {
        let mut table = FileTable::default();
        let id = table
            .insert(p("src/Main.ts"), FileKind::File)
            .expect("insert");
        assert!(table.insert(p("SRC/main.TS"), FileKind::File).is_err());
        assert_eq!(table.id_of(&p("src/main.ts")), Some(&id));
        assert!(table
            .restore(id.clone(), p("other.ts"), FileKind::File)
            .is_err());
    }

    #[test]
    fn folder_renames_move_children_and_collisions_change_nothing() {
        let mut table = FileTable::default();
        let src = table.insert(p("src"), FileKind::Folder).expect("insert");
        let main = table
            .insert(p("src/main.ts"), FileKind::File)
            .expect("insert");
        let deep = table
            .insert(p("src/a/b.ts"), FileKind::File)
            .expect("insert");
        let taken = table
            .insert(p("lib/main.ts"), FileKind::File)
            .expect("insert");
        let moved = table.rename(&src, p("app")).expect("rename");
        assert_eq!(moved.len(), 3, "the folder and both files inside it");
        assert_eq!(
            table.get(&main).map(|e| e.path.as_str()),
            Some("app/main.ts")
        );
        assert_eq!(
            table.get(&deep).map(|e| e.path.as_str()),
            Some("app/a/b.ts")
        );
        assert!(table.id_of(&p("src/main.ts")).is_none());
        assert!(
            table.rename(&src, p("lib")).is_err(),
            "app/main.ts would land on lib/main.ts"
        );
        assert_eq!(
            table.get(&main).map(|e| e.path.as_str()),
            Some("app/main.ts"),
            "nothing moved"
        );
        assert!(
            table.rename(&main, p("LIB/Main.ts")).is_err(),
            "taken, ignoring case"
        );
        assert!(table.rename(&src, p("app/x")).is_err(), "into itself");
        table
            .rename(&taken, p("lib/other.ts"))
            .expect("rename file");
        table.rename(&src, p("lib")).expect("rename folder");
        assert_eq!(
            table.get(&deep).map(|e| e.path.as_str()),
            Some("lib/a/b.ts")
        );
    }

    #[test]
    fn a_folder_rename_onto_a_child_collision_is_refused_whole() {
        let mut table = FileTable::default();
        let a = table.insert(p("a"), FileKind::Folder).expect("insert");
        table.insert(p("a/x.ts"), FileKind::File).expect("insert");
        table.insert(p("b/x.ts"), FileKind::File).expect("insert");
        assert!(table.rename(&a, p("b")).is_err());
        assert!(table.id_of(&p("a/x.ts")).is_some(), "nothing moved");
    }

    #[test]
    fn removing_a_folder_removes_its_contents() {
        let mut table = FileTable::default();
        let src = table.insert(p("src"), FileKind::Folder).expect("insert");
        table
            .insert(p("src/main.ts"), FileKind::File)
            .expect("insert");
        table.insert(p("srcx.ts"), FileKind::File).expect("insert");
        assert_eq!(table.remove(&src).len(), 2);
        assert_eq!(table.len(), 1, "a sibling with the same prefix stays");
    }
}
