//! Turns the operating system's chatty event stream into one small batch per
//! quiet period. Saving a file is often "write a temp file, delete the old one,
//! rename" and a Git checkout touches many files at once; the caller should see
//! "this file changed", not the plumbing. Pure: time is passed in.

use std::path::PathBuf;
use std::time::{Duration, Instant};

use crate::event::{ChangeBatch, ChangeKind, FileChange};

/// What the operating system reported, before merging.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Raw {
    Created(PathBuf),
    Modified(PathBuf),
    Removed(PathBuf),
    RenameFrom(PathBuf),
    RenameTo(PathBuf),
    RenameBoth { from: PathBuf, to: PathBuf },
}

pub struct Debouncer {
    quiet: Duration,
    max_paths: usize,
    pending: Vec<Raw>,
    last: Option<Instant>,
}

impl Debouncer {
    /// A batch is released after `quiet` without new events; more than
    /// `max_paths` different paths become an `overflow` batch.
    pub fn new(quiet: Duration, max_paths: usize) -> Self {
        Self {
            quiet,
            max_paths,
            pending: Vec::new(),
            last: None,
        }
    }

    pub fn push(&mut self, raw: Raw, now: Instant) {
        self.pending.push(raw);
        self.last = Some(now);
    }

    pub fn is_empty(&self) -> bool {
        self.pending.is_empty()
    }

    /// Whether the quiet period has passed and something is waiting.
    pub fn ready(&self, now: Instant) -> bool {
        match self.last {
            Some(last) => !self.pending.is_empty() && now.duration_since(last) >= self.quiet,
            None => false,
        }
    }

    /// Takes everything waiting and merges it.
    pub fn drain(&mut self) -> ChangeBatch {
        self.last = None;
        merge(std::mem::take(&mut self.pending), self.max_paths)
    }
}

fn text(path: &std::path::Path) -> String {
    path.to_string_lossy().into_owned()
}

fn merge(raws: Vec<Raw>, max_paths: usize) -> ChangeBatch {
    let mut changes: Vec<FileChange> = Vec::new();
    let mut pending_from: Option<PathBuf> = None;
    for raw in raws {
        match raw {
            Raw::RenameFrom(path) => {
                if let Some(orphan) = pending_from.replace(path) {
                    upsert(&mut changes, text(&orphan), ChangeKind::Removed, None);
                }
            }
            Raw::RenameTo(to) => match pending_from.take() {
                Some(from) => upsert(
                    &mut changes,
                    text(&to),
                    ChangeKind::Renamed,
                    Some(text(&from)),
                ),
                None => upsert(&mut changes, text(&to), ChangeKind::Created, None),
            },
            Raw::RenameBoth { from, to } => {
                upsert(
                    &mut changes,
                    text(&to),
                    ChangeKind::Renamed,
                    Some(text(&from)),
                );
            }
            other => {
                if let Some(orphan) = pending_from.take() {
                    upsert(&mut changes, text(&orphan), ChangeKind::Removed, None);
                }
                match other {
                    Raw::Created(path) => {
                        upsert(&mut changes, text(&path), ChangeKind::Created, None)
                    }
                    Raw::Modified(path) => {
                        upsert(&mut changes, text(&path), ChangeKind::Modified, None);
                    }
                    Raw::Removed(path) => {
                        upsert(&mut changes, text(&path), ChangeKind::Removed, None)
                    }
                    _ => {}
                }
            }
        }
    }
    if let Some(orphan) = pending_from {
        upsert(&mut changes, text(&orphan), ChangeKind::Removed, None);
    }
    if changes.len() > max_paths {
        return ChangeBatch {
            changes: Vec::new(),
            overflow: true,
        };
    }
    ChangeBatch {
        changes,
        overflow: false,
    }
}

/// Adds `kind` for `path`, folding it into what is already known about that path.
fn upsert(changes: &mut Vec<FileChange>, path: String, kind: ChangeKind, from: Option<String>) {
    let Some(index) = changes.iter().position(|change| change.path == path) else {
        changes.push(FileChange { path, kind, from });
        return;
    };
    let before = changes[index].kind;
    let merged = match (before, kind) {
        // Created and then deleted again: nothing happened.
        (ChangeKind::Created, ChangeKind::Removed) => None,
        (ChangeKind::Created, _) => Some(ChangeKind::Created),
        // Deleted and then created again is how many tools "save" a file.
        (ChangeKind::Removed, ChangeKind::Created) => Some(ChangeKind::Modified),
        (ChangeKind::Renamed, ChangeKind::Modified) => Some(ChangeKind::Renamed),
        (_, ChangeKind::Removed) => Some(ChangeKind::Removed),
        (_, later) => Some(later),
    };
    match merged {
        None => {
            changes.remove(index);
        }
        Some(kind) => {
            let keep_from = if kind == ChangeKind::Renamed {
                from.or_else(|| changes[index].from.clone())
            } else {
                None
            };
            changes[index] = FileChange {
                path,
                kind,
                from: keep_from,
            };
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn p(name: &str) -> PathBuf {
        PathBuf::from(format!("C:/My Site/{name}"))
    }

    fn drain(raws: Vec<Raw>) -> ChangeBatch {
        let mut debouncer = Debouncer::new(Duration::from_millis(200), 500);
        let now = Instant::now();
        for raw in raws {
            debouncer.push(raw, now);
        }
        debouncer.drain()
    }

    #[test]
    fn a_batch_is_released_only_after_the_quiet_period() {
        let mut debouncer = Debouncer::new(Duration::from_millis(200), 500);
        let start = Instant::now();
        assert!(!debouncer.ready(start));
        debouncer.push(Raw::Modified(p("a.txt")), start);
        assert!(!debouncer.ready(start + Duration::from_millis(100)));
        // A new event restarts the wait.
        debouncer.push(
            Raw::Modified(p("a.txt")),
            start + Duration::from_millis(150),
        );
        assert!(!debouncer.ready(start + Duration::from_millis(300)));
        assert!(debouncer.ready(start + Duration::from_millis(400)));
        let batch = debouncer.drain();
        assert_eq!(batch.changes.len(), 1);
        assert!(debouncer.is_empty() && !debouncer.ready(start + Duration::from_secs(5)));
    }

    #[test]
    fn repeated_modifications_are_one_change() {
        let batch = drain(vec![
            Raw::Modified(p("a b.txt")),
            Raw::Modified(p("a b.txt")),
        ]);
        assert_eq!(batch.changes.len(), 1);
        assert_eq!(batch.changes[0].kind, ChangeKind::Modified);
        assert_eq!(batch.changes[0].path, "C:/My Site/a b.txt");
    }

    #[test]
    fn delete_then_create_is_a_modification_the_way_atomic_saves_look() {
        let batch = drain(vec![Raw::Removed(p("a.txt")), Raw::Created(p("a.txt"))]);
        assert_eq!(batch.changes.len(), 1);
        assert_eq!(batch.changes[0].kind, ChangeKind::Modified);
    }

    #[test]
    fn a_file_created_and_deleted_within_the_period_is_not_reported() {
        let batch = drain(vec![
            Raw::Created(p("tmp.txt")),
            Raw::Modified(p("tmp.txt")),
            Raw::Removed(p("tmp.txt")),
        ]);
        assert!(batch.changes.is_empty() && !batch.overflow);
    }

    #[test]
    fn created_then_modified_stays_created_and_modified_then_removed_is_removed() {
        let batch = drain(vec![
            Raw::Created(p("new.txt")),
            Raw::Modified(p("new.txt")),
            Raw::Modified(p("old.txt")),
            Raw::Removed(p("old.txt")),
        ]);
        let kinds: Vec<(&str, ChangeKind)> = batch
            .changes
            .iter()
            .map(|change| (change.path.as_str(), change.kind))
            .collect();
        assert_eq!(
            kinds,
            vec![
                ("C:/My Site/new.txt", ChangeKind::Created),
                ("C:/My Site/old.txt", ChangeKind::Removed)
            ]
        );
    }

    #[test]
    fn renames_pair_up_and_lone_halves_become_a_removal_or_a_creation() {
        let paired = drain(vec![
            Raw::RenameFrom(p("old name.txt")),
            Raw::RenameTo(p("new name.txt")),
        ]);
        assert_eq!(paired.changes.len(), 1);
        assert_eq!(paired.changes[0].kind, ChangeKind::Renamed);
        assert_eq!(
            paired.changes[0].from.as_deref(),
            Some("C:/My Site/old name.txt")
        );
        assert_eq!(paired.changes[0].path, "C:/My Site/new name.txt");

        let both = drain(vec![Raw::RenameBoth {
            from: p("a"),
            to: p("b"),
        }]);
        assert_eq!(both.changes[0].kind, ChangeKind::Renamed);

        let moved_out = drain(vec![
            Raw::RenameFrom(p("gone.txt")),
            Raw::Modified(p("x.txt")),
        ]);
        assert_eq!(moved_out.changes[0].kind, ChangeKind::Removed);
        let moved_in = drain(vec![Raw::RenameTo(p("came.txt"))]);
        assert_eq!(moved_in.changes[0].kind, ChangeKind::Created);
    }

    #[test]
    fn a_renamed_file_that_is_then_written_stays_a_rename() {
        let batch = drain(vec![
            Raw::RenameBoth {
                from: p("a"),
                to: p("b"),
            },
            Raw::Modified(p("b")),
        ]);
        assert_eq!(batch.changes.len(), 1);
        assert_eq!(batch.changes[0].kind, ChangeKind::Renamed);
        assert_eq!(batch.changes[0].from.as_deref(), Some("C:/My Site/a"));
    }

    #[test]
    fn a_burst_over_the_limit_is_an_overflow_without_a_list() {
        let mut debouncer = Debouncer::new(Duration::from_millis(10), 3);
        let now = Instant::now();
        for index in 0..4 {
            debouncer.push(Raw::Modified(p(&format!("f{index}.txt"))), now);
        }
        let batch = debouncer.drain();
        assert!(batch.overflow && batch.changes.is_empty());
    }
}
