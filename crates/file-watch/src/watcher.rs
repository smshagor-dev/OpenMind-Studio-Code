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

use crate::coalesce::{Burst, TopicCoalescer};
use crate::debounce::{Debouncer, Raw};
use crate::event::ChangeBatch;
use crate::ignore::is_ignored;
use crate::normalize::normalize_event_path;
use crate::topics::{classify_project, is_folder_timestamp, EnvironmentCache, SyncTopic};

/// How long the folder must be quiet before a batch is reported.
const QUIET: Duration = Duration::from_millis(250);
/// More distinct paths than this in one batch is reported as an overflow.
const MAX_PATHS: usize = 500;
/// How often the worker checks whether a batch is due.
const TICK: Duration = Duration::from_millis(50);
/// How long a topic (a package install) must be quiet before it is announced ...
pub const TOPIC_QUIET: Duration = Duration::from_millis(1000);
/// ... or how long a burst that never goes quiet waits at most.
pub const TOPIC_MAX_WAIT: Duration = Duration::from_secs(15);

/// Receives one coalesced live-sync topic per burst (on the watcher's worker thread).
pub type TopicSink = Arc<dyn Fn(SyncTopic, Burst) + Send + Sync>;

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
        Self::start_with_topics(root, on_batch, None)
    }

    /// Like [`FileWatcher::start`]; besides, changes to the project's installed packages (`node_modules`, `.venv`,
    /// `venv`, `vendor`, an `env` with `pyvenv.cfg` — at any depth, including folders created later) go to `on_topic`
    /// as one coalesced [`SyncTopic::Packages`] per burst. Those folders still never reach `on_batch`.
    pub fn start_with_topics(
        root: &Path,
        on_batch: Arc<dyn Fn(ChangeBatch) + Send + Sync>,
        on_topic: Option<TopicSink>,
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
        let plain_root = crate::normalize::without_verbatim(root);
        let thread = std::thread::spawn(move || {
            let mut debouncer = Debouncer::new(QUIET, MAX_PATHS);
            let mut topics = TopicCoalescer::new(TOPIC_QUIET, TOPIC_MAX_WAIT);
            let mut environments = EnvironmentCache::default();
            loop {
                if stopped.try_recv().is_ok() {
                    break;
                }
                match incoming.recv_timeout(TICK) {
                    Ok(Ok(event)) => {
                        let now = Instant::now();
                        if event.need_rescan() {
                            // The platform says events were dropped: one "re-check everything" batch.
                            tracing::warn!(root = %watched.display(), "the file watcher asked for a rescan");
                            debouncer.mark_lost(now);
                        }
                        for raw in raws_of(&event, &watched) {
                            debouncer.push(raw, now);
                        }
                        if on_topic.is_some() {
                            for topic in topics_of(&event, &plain_root, &mut environments) {
                                topics.push(topic, now);
                            }
                        }
                    }
                    Ok(Err(err)) => {
                        // Events may be missing: the folder is re-checked once (an overflow batch), not ignored.
                        tracing::warn!(?err, root = %watched.display(), "file watcher error; re-checking the folder");
                        debouncer.mark_lost(Instant::now());
                    }
                    Err(RecvTimeoutError::Timeout) => {}
                    Err(RecvTimeoutError::Disconnected) => break,
                }
                if debouncer.ready(Instant::now()) {
                    on_batch(debouncer.drain());
                }
                if let Some(sink) = &on_topic {
                    for (topic, burst) in topics.due(Instant::now()) {
                        sink(topic, burst);
                    }
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

/// The live-sync topics an event touches (each path once; the coalescer merges the rest).
fn topics_of(event: &Event, root: &Path, environments: &mut EnvironmentCache) -> Vec<SyncTopic> {
    if matches!(event.kind, EventKind::Access(_)) {
        return Vec::new();
    }
    event
        .paths
        .iter()
        .filter_map(|path| normalize_event_path(root, path))
        .filter_map(|path| {
            let topic = classify_project(root, &path, environments)?;
            (!is_folder_timestamp(&event.kind, &path)).then_some(topic)
        })
        .collect()
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
