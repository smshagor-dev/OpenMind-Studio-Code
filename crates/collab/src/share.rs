//! Keeping the Owner's [`FileTable`] in step with the workspace. The caller supplies what the crawler found (files
//! that pass `.gitignore`, `.openmindignore` and the always-excluded folders) and the renames the file watcher
//! reported; this module adds the privacy floor ([`crate::privacy`]) and decides ids:
//!
//! - a file keeps its id while it stays at its path, and across a rename or move the watcher reported (a folder's
//!   rename moves everything inside it, ids kept);
//! - a path that disappears (deleted, now ignored, now sensitive) loses its id for good — requests for that id are
//!   answered "unavailable";
//! - a path that appears (created, moved in from an ignored place, no longer ignored) gets a new random id, also
//!   when an earlier file at that path had one: a deleted-then-recreated file is a new collaboration file.
//!
//! Folders are listed when they hold at least one shared file. Paths are compared ignoring case (Windows can't hold
//! two names that differ only by case), so the first one seen wins and the other is skipped.

use std::collections::BTreeSet;

use crate::files::{FileId, FileKind, FileTable, RelPath};
use crate::privacy;

/// What one synchronization changed, for persisting the table.
#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub struct TableChanges {
    /// Entries added or moved (their stored row must be written).
    pub written: Vec<FileId>,
    /// Entries gone (their stored row must be deleted).
    pub removed: Vec<FileId>,
}

impl TableChanges {
    pub fn is_empty(&self) -> bool {
        self.written.is_empty() && self.removed.is_empty()
    }
}

fn ancestors(path: &RelPath) -> Vec<RelPath> {
    let segments: Vec<&str> = path.segments().collect();
    (1..segments.len())
        .filter_map(|n| RelPath::parse(&segments[..n].join("/")).ok())
        .collect()
}

/// Applies renames, then makes the table hold exactly the shareable `files` and their folders.
pub fn sync_table(
    table: &mut FileTable,
    files: &[RelPath],
    renames: &[(RelPath, RelPath)],
) -> TableChanges {
    let mut changes = TableChanges::default();
    for (from, to) in renames {
        let Some(id) = table.id_of(from).cloned() else {
            continue;
        };
        if privacy::is_shareable(to) {
            if let Ok(moved) = table.rename(&id, to.clone()) {
                changes.written.extend(moved); // a folder's children moved too: their rows must follow
            }
        }
    }
    let mut wanted_files: Vec<&RelPath> =
        files.iter().filter(|p| privacy::is_shareable(p)).collect();
    wanted_files.sort();
    let mut keys = BTreeSet::new();
    let mut wanted: Vec<(RelPath, FileKind)> = Vec::new();
    for file in wanted_files {
        if !keys.insert(file.key()) {
            continue; // a case-only twin of a path already listed
        }
        wanted.push((file.clone(), FileKind::File));
        for folder in ancestors(file) {
            if keys.insert(folder.key()) {
                wanted.push((folder, FileKind::Folder));
            }
        }
    }
    let wanted_keys: std::collections::HashMap<String, FileKind> =
        wanted.iter().map(|(p, k)| (p.key(), *k)).collect();
    let stale: Vec<FileId> = table
        .iter()
        .filter(|(_, entry)| wanted_keys.get(&entry.path.key()) != Some(&entry.kind))
        .map(|(id, _)| id.clone())
        .collect();
    for id in stale {
        for gone in table.remove(&id) {
            changes.written.retain(|w| *w != gone);
            changes.removed.push(gone);
        }
    }
    wanted.sort_by_key(|(path, _)| path.segments().count());
    for (path, kind) in wanted {
        if table.id_of(&path).is_none() {
            if let Ok(id) = table.insert(path, kind) {
                changes.written.push(id);
            }
        }
    }
    changes.removed.sort();
    changes.removed.dedup();
    changes
}

#[cfg(test)]
mod tests {
    use super::*;

    fn p(text: &str) -> RelPath {
        RelPath::parse(text).expect("path")
    }

    fn paths(table: &FileTable) -> Vec<String> {
        let mut all: Vec<String> = table.iter().map(|(_, e)| e.path.to_string()).collect();
        all.sort();
        all
    }

    #[test]
    fn files_and_their_folders_are_listed_and_secrets_never() {
        let mut table = FileTable::default();
        sync_table(
            &mut table,
            &[
                p("src/main.ts"),
                p("src/util/a.ts"),
                p(".env"),
                p(".env.example"),
                p("keys/id_rsa"),
                p("README.md"),
            ],
            &[],
        );
        assert_eq!(
            paths(&table),
            [
                "README.md",
                "src",
                "src/main.ts",
                "src/util",
                "src/util/a.ts"
            ]
        );
    }

    #[test]
    fn ids_survive_resyncs_and_renames_but_not_deletion() {
        let mut table = FileTable::default();
        sync_table(&mut table, &[p("src/a.ts"), p("src/b.ts")], &[]);
        let a = table.id_of(&p("src/a.ts")).cloned().expect("a");
        let src = table.id_of(&p("src")).cloned().expect("src");
        sync_table(&mut table, &[p("src/a.ts"), p("src/b.ts")], &[]);
        assert_eq!(
            table.id_of(&p("src/a.ts")),
            Some(&a),
            "stable while unchanged"
        );
        let changes = sync_table(
            &mut table,
            &[p("app/a.ts"), p("app/b.ts")],
            &[(p("src"), p("app"))],
        );
        assert_eq!(
            table.id_of(&p("app/a.ts")),
            Some(&a),
            "a folder rename keeps the ids inside"
        );
        assert_eq!(table.id_of(&p("app")), Some(&src));
        assert!(changes.removed.is_empty());
        assert!(
            changes.written.contains(&a),
            "a moved child is written, or a restart would lose its id"
        );
        sync_table(&mut table, &[p("app/b.ts")], &[]);
        assert!(table.get(&a).is_none(), "deleted");
        sync_table(&mut table, &[p("app/a.ts"), p("app/b.ts")], &[]);
        let recreated = table.id_of(&p("app/a.ts")).cloned().expect("recreated");
        assert_ne!(recreated, a, "a recreated file is a new collaboration file");
    }

    #[test]
    fn a_rename_into_a_sensitive_or_ignored_place_removes_the_file() {
        let mut table = FileTable::default();
        sync_table(&mut table, &[p("config.json")], &[]);
        let id = table.id_of(&p("config.json")).cloned().expect("id");
        let changes = sync_table(&mut table, &[], &[(p("config.json"), p(".env.local"))]);
        assert!(table.get(&id).is_none());
        assert_eq!(changes.removed, vec![id]);
        // Moved back out of an ignored place: a new id.
        sync_table(&mut table, &[p("config.json")], &[]);
        assert!(table.id_of(&p("config.json")).is_some());
    }

    #[test]
    fn case_only_twins_keep_one_entry() {
        let mut table = FileTable::default();
        sync_table(&mut table, &[p("Readme.md"), p("README.md")], &[]);
        assert_eq!(table.len(), 1);
    }

    #[test]
    fn a_file_replaced_by_a_folder_gets_new_entries() {
        let mut table = FileTable::default();
        sync_table(&mut table, &[p("docs")], &[]);
        let file = table.id_of(&p("docs")).cloned().expect("file");
        sync_table(&mut table, &[p("docs/index.md")], &[]);
        let folder = table.id_of(&p("docs")).cloned().expect("folder");
        assert_ne!(file, folder);
        assert_eq!(table.get(&folder).map(|e| e.kind), Some(FileKind::Folder));
    }
}
