//! Watches what the app has installed — `runtimes/`, `tools/`, `language-servers/` and `extensions/` under the app
//! folder — for changes made outside the app (a folder copied in, deleted or replaced by hand) and reports one
//! coalesced live-sync topic per burst. The app folder itself is watched one level deep only (so a managed folder that
//! appears later is noticed without polling); each managed folder that exists is watched recursively.

use std::collections::BTreeSet;
use std::path::{Path, PathBuf};
use std::sync::mpsc::{channel, Receiver, RecvTimeoutError, Sender};
use std::sync::{Arc, Mutex};
use std::thread::JoinHandle;
use std::time::Instant;

use notify::event::{ModifyKind, RenameMode};
use notify::{Event, EventKind, RecommendedWatcher, RecursiveMode, Watcher};

use crate::coalesce::TopicCoalescer;
use crate::normalize::{normalize_event_path, without_verbatim};
use crate::topics::{classify_app, is_folder_timestamp, SyncTopic, APP_FOLDERS};
use crate::watcher::{TopicSink, WatchError, TOPIC_MAX_WAIT, TOPIC_QUIET};

const TICK: std::time::Duration = std::time::Duration::from_millis(50);

/// Watching stops, and its thread ends, when this is dropped (app closing).
pub struct SystemWatcher {
    root: PathBuf,
    stop: Sender<()>,
    thread: Option<JoinHandle<()>>,
    _watcher: Arc<Mutex<RecommendedWatcher>>,
}

impl SystemWatcher {
    /// Starts watching the app folder `root`. A managed folder that doesn't exist yet is watched once it appears.
    /// `on_topic` runs on the worker thread. A missing `root` is an error (nothing is created here).
    pub fn start(root: &Path, on_topic: TopicSink) -> Result<Self, WatchError> {
        let (events, incoming) = channel::<notify::Result<Event>>();
        let watcher = notify::recommended_watcher(move |event| {
            let _ = events.send(event);
        })
        .map_err(|err| WatchError::Start(err.to_string()))?;
        let watcher = Arc::new(Mutex::new(watcher));
        lock(&watcher)?
            .watch(root, RecursiveMode::NonRecursive)
            .map_err(|err| WatchError::Start(err.to_string()))?;
        let mut folders = Folders {
            root: without_verbatim(root),
            watcher: watcher.clone(),
            watched: BTreeSet::new(),
        };
        for (name, _) in APP_FOLDERS {
            folders.watch(name);
        }
        let (stop, stopped) = channel::<()>();
        let thread = std::thread::spawn(move || run(folders, &incoming, &stopped, &on_topic));
        Ok(Self {
            root: root.to_path_buf(),
            stop,
            thread: Some(thread),
            _watcher: watcher,
        })
    }

    pub fn root(&self) -> &Path {
        &self.root
    }
}

impl Drop for SystemWatcher {
    fn drop(&mut self) {
        let _ = self.stop.send(());
        if let Some(thread) = self.thread.take() {
            let _ = thread.join();
        }
    }
}

fn lock(
    watcher: &Mutex<RecommendedWatcher>,
) -> Result<std::sync::MutexGuard<'_, RecommendedWatcher>, WatchError> {
    watcher
        .lock()
        .map_err(|_| WatchError::Start("the watcher is unusable".into()))
}

/// The managed folders and which of them have a recursive watch.
struct Folders {
    root: PathBuf,
    watcher: Arc<Mutex<RecommendedWatcher>>,
    watched: BTreeSet<&'static str>,
}

impl Folders {
    /// Watches a managed folder recursively if it exists and isn't watched yet.
    fn watch(&mut self, name: &'static str) {
        let folder = self.root.join(name);
        if self.watched.contains(name) || !folder.is_dir() {
            return;
        }
        let result = lock(&self.watcher).and_then(|mut watcher| {
            watcher
                .watch(&folder, RecursiveMode::Recursive)
                .map_err(|err| WatchError::Start(err.to_string()))
        });
        match result {
            Ok(()) => {
                self.watched.insert(name);
            }
            Err(err) => {
                tracing::warn!(%err, folder = %folder.display(), "an app folder can't be watched")
            }
        }
    }

    /// The managed folder went away: its watch is dropped, so a new folder of that name is watched again.
    fn forget(&mut self, name: &'static str) {
        if self.watched.remove(name) {
            if let Ok(mut watcher) = lock(&self.watcher) {
                let _ = watcher.unwatch(&self.root.join(name));
            }
        }
    }

    /// A managed folder directly under the app folder that an event created or removed.
    fn follow(&mut self, event: &Event, path: &Path) {
        let Some(name) = managed_name(&self.root, path) else {
            return;
        };
        match event.kind {
            EventKind::Remove(_) | EventKind::Modify(ModifyKind::Name(RenameMode::From)) => {
                self.forget(name)
            }
            _ if path.is_dir() => self.watch(name),
            _ => self.forget(name),
        }
    }
}

/// `runtimes`, `tools` ... when `path` is that folder itself (directly under the app folder).
fn managed_name(root: &Path, path: &Path) -> Option<&'static str> {
    let relative = path.strip_prefix(root).ok()?;
    let mut components = relative.components();
    let only = components.next()?;
    if components.next().is_some() {
        return None;
    }
    let name = only.as_os_str().to_string_lossy();
    APP_FOLDERS
        .iter()
        .map(|(folder, _)| *folder)
        .find(|folder| name.eq_ignore_ascii_case(folder))
}

/// Whether an event about a managed folder itself says something about what is installed. A folder's own
/// "modified" (its timestamp changing because something inside it changed) is reported by the recursive watch already
/// — and for `extensions/` it is mostly `storage/` or `logs/` — so only creating, removing or renaming it counts.
fn counts_for_folder_itself(kind: &EventKind) -> bool {
    !matches!(kind, EventKind::Modify(modify) if !matches!(modify, ModifyKind::Name(_)))
}

/// The topics to read again after a watcher error or rescan request: those of the managed folders the paths lie in,
/// or — when the paths name none of them — every managed folder (conservative: one coalesced read each).
fn lost_topics(root: &Path, paths: &[PathBuf]) -> Vec<SyncTopic> {
    let mut named: Vec<SyncTopic> = paths
        .iter()
        .filter_map(|raw| normalize_event_path(root, raw))
        .filter_map(|path| {
            let relative = path.strip_prefix(root).ok()?;
            let first = relative.components().next()?.as_os_str().to_string_lossy();
            APP_FOLDERS
                .iter()
                .find(|(folder, _)| first.eq_ignore_ascii_case(folder))
                .map(|(_, topic)| *topic)
        })
        .collect();
    named.sort();
    named.dedup();
    if named.is_empty() {
        APP_FOLDERS.iter().map(|(_, topic)| *topic).collect()
    } else {
        named
    }
}

fn run(
    mut folders: Folders,
    incoming: &Receiver<notify::Result<Event>>,
    stopped: &Receiver<()>,
    on_topic: &TopicSink,
) {
    let mut topics = TopicCoalescer::new(TOPIC_QUIET, TOPIC_MAX_WAIT);
    loop {
        if stopped.try_recv().is_ok() {
            break;
        }
        match incoming.recv_timeout(TICK) {
            Ok(Ok(event)) if !matches!(event.kind, EventKind::Access(_)) => {
                let now = Instant::now();
                if event.need_rescan() {
                    tracing::warn!("the app folder watcher asked for a rescan");
                    for topic in lost_topics(&folders.root, &event.paths) {
                        topics.push(topic, now);
                    }
                }
                for raw in &event.paths {
                    let Some(path) = normalize_event_path(&folders.root, raw) else {
                        continue;
                    };
                    let itself = managed_name(&folders.root, &path).is_some();
                    if itself {
                        folders.follow(&event, &path);
                        if !counts_for_folder_itself(&event.kind) {
                            continue;
                        }
                    }
                    match classify_app(&folders.root, &path) {
                        Some(topic) if itself || !is_folder_timestamp(&event.kind, &path) => {
                            topics.push(topic, now);
                        }
                        _ => {}
                    }
                }
            }
            Ok(Ok(_)) => {}
            Ok(Err(err)) => {
                // Events may be missing: what the error names (or every managed folder) is read again once.
                let affected = lost_topics(&folders.root, &err.paths);
                tracing::warn!(
                    ?err,
                    ?affected,
                    "app folder watcher error; reading the affected state again"
                );
                let now = Instant::now();
                for topic in affected {
                    topics.push(topic, now);
                }
            }
            Err(RecvTimeoutError::Timeout) => {}
            Err(RecvTimeoutError::Disconnected) => break,
        }
        for (topic, burst) in topics.due(Instant::now()) {
            tracing::debug!(
                ?topic,
                events = burst.events,
                "an installed thing changed on disk"
            );
            on_topic(topic, burst);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_a_managed_folder_directly_under_the_app_folder_is_followed() {
        let root = Path::new("C:/OpenMind Studio");
        assert_eq!(
            managed_name(root, Path::new("C:/OpenMind Studio/tools")),
            Some("tools")
        );
        assert_eq!(
            managed_name(root, Path::new("C:/OpenMind Studio/Language-Servers")),
            Some("language-servers")
        );
        assert_eq!(
            managed_name(root, Path::new("C:/OpenMind Studio/tools/ruff")),
            None
        );
        assert_eq!(
            managed_name(root, Path::new("C:/OpenMind Studio/data")),
            None
        );
    }

    #[test]
    fn a_watcher_error_reads_what_it_names_again_or_every_managed_folder() {
        let root = Path::new("C:/OpenMind Studio");
        assert_eq!(
            lost_topics(
                root,
                &[PathBuf::from("C:/OpenMind Studio/tools/ruff/x.exe")]
            ),
            vec![SyncTopic::Tools]
        );
        assert_eq!(
            lost_topics(root, &[]),
            vec![
                SyncTopic::Runtimes,
                SyncTopic::Tools,
                SyncTopic::LanguageServers,
                SyncTopic::Extensions
            ]
        );
        // A path outside the managed folders names nothing: everything is read again.
        assert_eq!(
            lost_topics(root, &[PathBuf::from("C:/OpenMind Studio/data/x")]).len(),
            4
        );
    }

    #[test]
    fn a_managed_folder_merely_changing_its_timestamp_is_not_an_install() {
        assert!(!counts_for_folder_itself(&EventKind::Modify(
            ModifyKind::Any
        )));
        assert!(counts_for_folder_itself(&EventKind::Create(
            notify::event::CreateKind::Folder
        )));
        assert!(counts_for_folder_itself(&EventKind::Remove(
            notify::event::RemoveKind::Any
        )));
        assert!(counts_for_folder_itself(&EventKind::Modify(
            ModifyKind::Name(RenameMode::Any)
        )));
    }
}
