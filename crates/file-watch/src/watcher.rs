//! The operating-system side: one recursive watcher on the workspace folder
//! feeding the debouncer from a worker thread.

use std::path::{Path, PathBuf};
use std::sync::mpsc::{channel, RecvTimeoutError, Sender};
use std::sync::Arc;
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

use notify::event::{ModifyKind, RenameMode};
use notify::{Event, EventKind, RecommendedWatcher, RecursiveMode, Watcher};
use thiserror::Error;

use crate::debounce::{Debouncer, Raw};
use crate::event::ChangeBatch;
use crate::ignore::is_ignored;
use crate::normalize::normalize_event_path;

/// How long the folder must be quiet before a batch is reported.
const QUIET: Duration = Duration::from_millis(250);
/// More distinct paths than this in one batch is reported as an overflow.
const MAX_PATHS: usize = 500;
/// How often the worker checks whether a batch is due.
const TICK: Duration = Duration::from_millis(50);

#[derive(Debug, Error)]
pub enum WatchError {
    #[error("The workspace folder can't be watched: {0}")]
    Start(String),
}

/// Watching stops when this is dropped (folder closed, app closing).
pub struct FileWatcher {
    root: PathBuf,
    _watcher: RecommendedWatcher,
    stop: Sender<()>,
    thread: Option<JoinHandle<()>>,
}

impl FileWatcher {
    /// Starts watching `root` (recursively). `on_batch` runs on the worker thread.
    pub fn start(
        root: &Path,
        on_batch: Arc<dyn Fn(ChangeBatch) + Send + Sync>,
    ) -> Result<Self, WatchError> {
        let (events, incoming) = channel::<notify::Result<Event>>();
        let mut watcher = notify::recommended_watcher(move |event| {
            let _ = events.send(event);
        })
        .map_err(|err| WatchError::Start(err.to_string()))?;
        watcher
            .watch(root, RecursiveMode::Recursive)
            .map_err(|err| WatchError::Start(err.to_string()))?;

        let (stop, stopped) = channel::<()>();
        let watched = root.to_path_buf();
        let thread = std::thread::spawn(move || {
            let mut debouncer = Debouncer::new(QUIET, MAX_PATHS);
            loop {
                if stopped.try_recv().is_ok() {
                    break;
                }
                match incoming.recv_timeout(TICK) {
                    Ok(Ok(event)) => {
                        let now = Instant::now();
                        for raw in raws_of(&event, &watched) {
                            debouncer.push(raw, now);
                        }
                    }
                    Ok(Err(err)) => tracing::warn!(?err, "file watcher error"),
                    Err(RecvTimeoutError::Timeout) => {}
                    Err(RecvTimeoutError::Disconnected) => break,
                }
                if debouncer.ready(Instant::now()) {
                    on_batch(debouncer.drain());
                }
            }
        });
        Ok(Self {
            root: root.to_path_buf(),
            _watcher: watcher,
            stop,
            thread: Some(thread),
        })
    }

    pub fn root(&self) -> &Path {
        &self.root
    }
}

impl Drop for FileWatcher {
    fn drop(&mut self) {
        let _ = self.stop.send(());
        if let Some(thread) = self.thread.take() {
            let _ = thread.join();
        }
    }
}

/// The events worth keeping: inside the workspace, not in an ignored folder.
fn allowed(root: &Path, path: &Path) -> Option<PathBuf> {
    let path = normalize_event_path(root, path)?;
    (!is_ignored(root, &path)).then_some(path)
}

fn raws_of(event: &Event, root: &Path) -> Vec<Raw> {
    let paths: Vec<Option<PathBuf>> = event.paths.iter().map(|path| allowed(root, path)).collect();
    match &event.kind {
        EventKind::Create(_) => paths.into_iter().flatten().map(Raw::Created).collect(),
        EventKind::Remove(_) => paths.into_iter().flatten().map(Raw::Removed).collect(),
        EventKind::Modify(ModifyKind::Name(RenameMode::From)) => {
            paths.into_iter().flatten().map(Raw::RenameFrom).collect()
        }
        EventKind::Modify(ModifyKind::Name(RenameMode::To)) => {
            paths.into_iter().flatten().map(Raw::RenameTo).collect()
        }
        EventKind::Modify(ModifyKind::Name(RenameMode::Both)) => match paths.as_slice() {
            [Some(from), Some(to)] => vec![Raw::RenameBoth {
                from: from.clone(),
                to: to.clone(),
            }],
            // One side is outside the workspace or ignored: a plain create/remove.
            [Some(from), None] => vec![Raw::Removed(from.clone())],
            [None, Some(to)] => vec![Raw::Created(to.clone())],
            _ => Vec::new(),
        },
        EventKind::Modify(_) => paths.into_iter().flatten().map(Raw::Modified).collect(),
        EventKind::Any | EventKind::Access(_) | EventKind::Other => Vec::new(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::event::ChangeKind;
    use std::sync::Mutex;

    #[test]
    fn a_real_watcher_reports_a_created_and_a_modified_file_and_skips_ignored_folders() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("my site");
        std::fs::create_dir_all(root.join("node_modules")).unwrap();
        std::fs::write(root.join("existing.txt"), "one").unwrap();

        let seen: Arc<Mutex<Vec<ChangeBatch>>> = Arc::new(Mutex::new(Vec::new()));
        let sink = seen.clone();
        let watcher = FileWatcher::start(
            &root,
            Arc::new(move |batch| sink.lock().unwrap().push(batch)),
        )
        .unwrap();
        assert_eq!(watcher.root(), root);

        std::fs::write(root.join("new file.txt"), "hello").unwrap();
        std::fs::write(root.join("existing.txt"), "two").unwrap();
        std::fs::write(root.join("node_modules").join("ignored.js"), "x").unwrap();

        let deadline = Instant::now() + Duration::from_secs(10);
        loop {
            let paths: Vec<String> = seen
                .lock()
                .unwrap()
                .iter()
                .flat_map(|batch| batch.changes.iter().map(|change| change.path.clone()))
                .collect();
            if paths.iter().any(|path| path.ends_with("new file.txt"))
                && paths.iter().any(|path| path.ends_with("existing.txt"))
            {
                assert!(
                    !paths.iter().any(|path| path.contains("node_modules")),
                    "{paths:?}"
                );
                break;
            }
            assert!(Instant::now() < deadline, "no events: {paths:?}");
            std::thread::sleep(Duration::from_millis(100));
        }
        let created = seen
            .lock()
            .unwrap()
            .iter()
            .flat_map(|batch| batch.changes.clone())
            .find(|change| change.path.ends_with("new file.txt"))
            .unwrap();
        assert!(matches!(
            created.kind,
            ChangeKind::Created | ChangeKind::Modified
        ));
        drop(watcher);
    }

    #[test]
    fn watching_a_folder_that_does_not_exist_is_a_clear_error() {
        let temp = tempfile::tempdir().unwrap();
        let result = FileWatcher::start(&temp.path().join("missing"), Arc::new(|_| {}));
        assert!(matches!(result, Err(WatchError::Start(_))));
    }
}
