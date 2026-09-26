//! Running the index in the background: one state per workspace root, a worker thread per pass, status pushed to
//! whoever listens (the app forwards it to the window). Tauri-agnostic.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use serde::Serialize;

use crate::error::SearchError;
use crate::index::settings::IndexSettings;
use crate::index::store::IndexStore;
use crate::index::sync::{apply_changes, sync_workspace, Change, Progress};

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct IndexStatus {
    pub root: String,
    /// `none` (nothing indexed), `disabled`, `indexing`, `idle` or `error`.
    pub state: String,
    pub discovered: usize,
    pub processed: usize,
    pub indexed: u64,
    pub skipped: u64,
    pub errors: u64,
    pub symbols: u64,
    pub content_bytes: u64,
    pub db_bytes: u64,
    pub last_indexed_ms: Option<i64>,
    pub error: Option<String>,
}

impl IndexStatus {
    fn blank(root: &Path, state: &str) -> Self {
        Self {
            root: root.to_string_lossy().into_owned(),
            state: state.into(),
            discovered: 0,
            processed: 0,
            indexed: 0,
            skipped: 0,
            errors: 0,
            symbols: 0,
            content_bytes: 0,
            db_bytes: 0,
            last_indexed_ms: None,
            error: None,
        }
    }
}

/// Where status goes (the app pushes it to the window as an event).
pub trait IndexEvents: Send + Sync {
    fn status(&self, status: &IndexStatus);
}

struct RootIndex {
    root: PathBuf,
    db_path: PathBuf,
    settings: Mutex<IndexSettings>,
    status: Mutex<IndexStatus>,
    cancel: Mutex<Arc<AtomicBool>>,
    write_lock: Mutex<()>,
    running: AtomicBool,
    rerun: AtomicBool,
    /// Set once the app asked for indexing (or for it to be off): before that, watcher changes are not indexed.
    configured: AtomicBool,
}

/// FNV-1a: a stable file name for a workspace root, whatever its characters.
fn root_key(root: &Path) -> String {
    let text = root.to_string_lossy().to_lowercase().replace('\\', "/");
    let mut hash: u64 = 0xcbf2_9ce4_8422_2325;
    for byte in text.bytes() {
        hash ^= u64::from(byte);
        hash = hash.wrapping_mul(0x0100_0000_01b3);
    }
    format!("{hash:016x}")
}

fn file_size(path: &Path) -> u64 {
    let mut total = std::fs::metadata(path).map_or(0, |m| m.len());
    for suffix in ["-wal", "-shm"] {
        let mut name = path.as_os_str().to_os_string();
        name.push(suffix);
        total += std::fs::metadata(PathBuf::from(name)).map_or(0, |m| m.len());
    }
    total
}

pub struct IndexManager {
    dir: PathBuf,
    events: Arc<dyn IndexEvents>,
    roots: Mutex<HashMap<PathBuf, Arc<RootIndex>>>,
}

impl IndexManager {
    /// `dir` is the app's own `data/search-index` folder.
    pub fn new(dir: PathBuf, events: Arc<dyn IndexEvents>) -> Self {
        Self {
            dir,
            events,
            roots: Mutex::new(HashMap::new()),
        }
    }

    fn state_for(&self, root: &Path) -> Arc<RootIndex> {
        let mut roots = self
            .roots
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        roots
            .entry(root.to_path_buf())
            .or_insert_with(|| {
                Arc::new(RootIndex {
                    root: root.to_path_buf(),
                    db_path: self.dir.join(format!("{}.sqlite", root_key(root))),
                    settings: Mutex::new(IndexSettings::default()),
                    status: Mutex::new(IndexStatus::blank(root, "none")),
                    cancel: Mutex::new(Arc::new(AtomicBool::new(false))),
                    write_lock: Mutex::new(()),
                    running: AtomicBool::new(false),
                    rerun: AtomicBool::new(false),
                    configured: AtomicBool::new(false),
                })
            })
            .clone()
    }

    fn publish(&self, state: &RootIndex, change: impl FnOnce(&mut IndexStatus)) {
        let snapshot = {
            let mut status = state
                .status
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            change(&mut status);
            status.clone()
        };
        self.events.status(&snapshot);
    }

    /// A store connection for reading or writing (a new connection each time; SQLite handles concurrency).
    pub fn open_store(&self, root: &Path) -> Result<IndexStore, SearchError> {
        IndexStore::open(&self.state_for(root).db_path)
    }

    fn fill_from_store(status: &mut IndexStatus, store: &IndexStore, db_path: &Path) {
        if let Ok(stats) = store.stats() {
            status.indexed = stats.indexed;
            status.skipped = stats.skipped;
            status.errors = stats.errors;
            status.symbols = stats.symbols;
            status.content_bytes = stats.content_bytes;
        }
        status.last_indexed_ms = store
            .meta("last_indexed_ms")
            .ok()
            .flatten()
            .and_then(|v| v.parse().ok());
        status.db_bytes = file_size(db_path);
    }

    /// The current status; when nothing ran in this session, what the persisted index holds.
    pub fn status(&self, root: &Path) -> IndexStatus {
        let state = self.state_for(root);
        let current = state
            .status
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .clone();
        if current.state != "none" || !state.db_path.exists() {
            return current;
        }
        let mut status = current;
        if let Ok(store) = IndexStore::open(&state.db_path) {
            Self::fill_from_store(&mut status, &store, &state.db_path);
            if status.indexed + status.skipped + status.errors > 0 {
                status.state = "idle".into();
            }
        }
        status
    }

    /// Starts (or, if a pass is running, queues one more after it) an incremental pass on a worker thread.
    /// With indexing disabled nothing runs and the status says so.
    pub fn start(self: &Arc<Self>, root: &Path, settings: IndexSettings) {
        let state = self.state_for(root);
        state.configured.store(true, Ordering::SeqCst);
        *state
            .settings
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner) = settings.clone();
        if !settings.enabled {
            self.cancel(root);
            self.publish(&state, |s| {
                s.state = "disabled".into();
                s.error = None;
            });
            return;
        }
        *state
            .settings
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner) = settings;
        if state.running.swap(true, Ordering::SeqCst) {
            state.rerun.store(true, Ordering::SeqCst);
            return;
        }
        let manager = Arc::clone(self);
        std::thread::spawn(move || manager.run_passes(&state));
    }

    fn run_passes(&self, state: &Arc<RootIndex>) {
        loop {
            state.rerun.store(false, Ordering::SeqCst);
            let cancel = Arc::new(AtomicBool::new(false));
            *state
                .cancel
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner) = cancel.clone();
            self.one_pass(state, &cancel);
            if !state.rerun.load(Ordering::SeqCst) {
                break;
            }
        }
        state.running.store(false, Ordering::SeqCst);
    }

    fn one_pass(&self, state: &RootIndex, cancel: &Arc<AtomicBool>) {
        let settings = state
            .settings
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .clone();
        self.publish(state, |s| {
            s.state = "indexing".into();
            s.error = None;
            s.discovered = 0;
            s.processed = 0;
        });
        let store = match IndexStore::open(&state.db_path) {
            Ok(store) => store,
            Err(err) => {
                self.publish(state, |s| {
                    s.state = "error".into();
                    s.error = Some(err.to_string());
                });
                return;
            }
        };
        let _ = store.set_meta("root", &state.root.to_string_lossy());
        let mut report = |progress: Progress| {
            self.publish(state, |s| {
                s.discovered = progress.discovered;
                s.processed = progress.processed;
            });
        };
        let result = sync_workspace(
            &state.root,
            &store,
            &settings,
            cancel,
            &state.write_lock,
            &mut report,
        );
        match result {
            Ok(summary) => self.publish(state, |s| {
                s.state = "idle".into();
                s.discovered = summary.progress.discovered;
                s.processed = summary.progress.processed;
                Self::fill_from_store(s, &store, &state.db_path);
                if summary.cancelled {
                    s.error = Some("Indexing was stopped before it finished.".into());
                }
            }),
            Err(err) => self.publish(state, |s| {
                s.state = "error".into();
                s.error = Some(err.to_string());
                Self::fill_from_store(s, &store, &state.db_path);
            }),
        }
    }

    /// Settings changed: the running pass (if any) is stopped and one more starts with the new settings.
    pub fn restart(self: &Arc<Self>, root: &Path, settings: IndexSettings) {
        let state = self.state_for(root);
        if state.running.load(Ordering::SeqCst) && settings.enabled {
            *state
                .settings
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner) = settings;
            state.rerun.store(true, Ordering::SeqCst);
            state
                .cancel
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner)
                .store(true, Ordering::Relaxed);
        } else {
            self.start(root, settings);
        }
    }

    /// Stops a running pass (the index keeps what it has).
    pub fn cancel(&self, root: &Path) {
        let state = self.state_for(root);
        state.rerun.store(false, Ordering::SeqCst);
        state
            .cancel
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .store(true, Ordering::Relaxed);
    }

    pub fn stop_all(&self) {
        let roots: Vec<PathBuf> = self
            .roots
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .keys()
            .cloned()
            .collect();
        for root in roots {
            self.cancel(&root);
        }
    }

    /// Empties the index (Clear Search Index): stops a pass, waits for the current batch, deletes everything and
    /// gives the disk space back. Nothing is indexed again until a pass is started.
    pub fn clear(&self, root: &Path) -> Result<(), SearchError> {
        let state = self.state_for(root);
        self.cancel(root);
        let _guard = state
            .write_lock
            .lock()
            .map_err(|_| SearchError::Index("index lock poisoned".into()))?;
        let mut store = IndexStore::open(&state.db_path)?;
        store.clear()?;
        store.compact()?;
        self.publish(&state, |s| {
            *s = IndexStatus::blank(&state.root, "none");
            s.db_bytes = file_size(&state.db_path);
        });
        Ok(())
    }

    /// Applies watcher or save changes right away (in the caller's thread; they are small). Returns an error for a
    /// path outside the workspace. A changed folder starts a full pass.
    pub fn apply_changes(
        self: &Arc<Self>,
        root: &Path,
        paths: &[PathBuf],
    ) -> Result<(), SearchError> {
        let state = self.state_for(root);
        let settings = state
            .settings
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .clone();
        if !state.configured.load(Ordering::SeqCst) || !settings.enabled || !state.db_path.exists()
        {
            return Ok(());
        }
        let store = IndexStore::open(&state.db_path)?;
        let changes: Vec<Change> = paths
            .iter()
            .map(|path| Change { path: path.clone() })
            .collect();
        let need_pass = apply_changes(&state.root, &store, &settings, &changes, &state.write_lock)?;
        self.publish(&state, |s| {
            if s.state != "indexing" {
                Self::fill_from_store(s, &store, &state.db_path);
                if s.state == "none" {
                    s.state = "idle".into();
                }
            }
        });
        if need_pass {
            self.start(root, settings);
        }
        Ok(())
    }

    /// A pass with the settings of the last start (Refresh Index, or the watcher lost track of changes).
    pub fn refresh(self: &Arc<Self>, root: &Path) {
        let settings = self
            .state_for(root)
            .settings
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .clone();
        if self.state_for(root).configured.load(Ordering::SeqCst) {
            self.start(root, settings);
        }
    }

    /// Wipes the index and builds it again from scratch (Rebuild Workspace Index).
    pub fn rebuild(
        self: &Arc<Self>,
        root: &Path,
        settings: IndexSettings,
    ) -> Result<(), SearchError> {
        self.clear(root)?;
        self.start(root, settings);
        Ok(())
    }

    /// Whether a pass is running now.
    pub fn is_running(&self, root: &Path) -> bool {
        self.state_for(root).running.load(Ordering::SeqCst)
    }
}
