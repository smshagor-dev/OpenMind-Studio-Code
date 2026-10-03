//! Per-workspace canonical state: which window has which folder open, opening and closing a folder's scope, and the
//! refresh driver that reads a folder's domains (Git, dependencies, project, debug) — once per burst of changes, no
//! matter how many windows show that folder or how many events arrived.
//!
//! Scope life cycle: the first window that opens a folder opens its scope and reads all its domains; more windows on
//! the same folder share that state (nothing is read again for them); when the last window leaves (closes the folder,
//! opens another one, closes), the scope is closed and its state removed.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, MutexGuard};
use std::time::Duration;

use tauri::{AppHandle, Manager};

use super::domain::{Domain, WORKSPACE_DOMAINS};
use super::gate::RefreshGate;
use super::scope::{workspace_key, WorkspaceKey};
use super::store::StateStore;
use super::CanonicalState;
use crate::app_state::AppState;

/// How long a domain waits after a request before reading, so a burst of requests is one read.
fn debounce(domain: Domain) -> Duration {
    match domain {
        Domain::Git => Duration::from_millis(300),
        Domain::Dependencies => Duration::from_millis(500),
        _ => Duration::from_millis(200),
    }
}

/// The longest a caller waits for a refresh it asked for (a huge repository's status); the read itself goes on.
const WAIT_LIMIT: Duration = Duration::from_secs(60);

#[derive(Default)]
pub struct Workspaces {
    /// Held for one whole open/close transition (the folder's path, the store's scope and who has it open change
    /// together), so a window leaving a folder can't close its scope between another window's steps of opening it.
    lifecycle: Mutex<()>,
    /// Window label -> the folder it has open.
    interest: Mutex<HashMap<String, WorkspaceKey>>,
    /// Folder -> its path as the window opened it (reads use it).
    roots: Mutex<HashMap<WorkspaceKey, PathBuf>>,
    gate: RefreshGate<(WorkspaceKey, Domain)>,
    /// How many times each folder's domain was read (diagnostics: `state_reads`).
    reads: Mutex<HashMap<(WorkspaceKey, Domain), u64>>,
}

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

impl Workspaces {
    /// The folder `label` has open.
    pub fn of_window(&self, label: &str) -> Option<WorkspaceKey> {
        lock(&self.interest).get(label).cloned()
    }

    /// Records that `label` now has `key` open (or nothing). Returns the folder it left if no window has it open now,
    /// and whether `key` was opened for the first time (its domains must be read).
    fn set_interest(
        &self,
        label: &str,
        key: Option<&WorkspaceKey>,
    ) -> (Option<WorkspaceKey>, bool) {
        let mut interest = lock(&self.interest);
        let previous = match key {
            Some(key) => interest.insert(label.to_string(), key.clone()),
            None => interest.remove(label),
        };
        let first = key.is_some_and(|key| {
            previous.as_ref() != Some(key)
                && interest.values().filter(|other| *other == key).count() == 1
        });
        let left =
            previous.filter(|old| Some(old) != key && !interest.values().any(|other| other == old));
        (left, first)
    }

    fn root(&self, key: &WorkspaceKey) -> Option<PathBuf> {
        lock(&self.roots).get(key).cloned()
    }

    /// Every folder some window has open.
    pub fn open_folders(&self) -> Vec<WorkspaceKey> {
        lock(&self.roots).keys().cloned().collect()
    }

    /// The windows that have `key` open.
    pub fn windows_of(&self, key: &str) -> Vec<String> {
        lock(&self.interest)
            .iter()
            .filter(|(_, folder)| folder.as_str() == key)
            .map(|(label, _)| label.clone())
            .collect()
    }

    /// Reads per folder and domain so far.
    pub fn reads(&self) -> Vec<(String, Domain, u64)> {
        lock(&self.reads)
            .iter()
            .map(|((key, domain), count)| (key.as_str().to_string(), *domain, *count))
            .collect()
    }
}

fn canonical(app: &AppHandle) -> Option<tauri::State<'_, CanonicalState>> {
    app.try_state::<CanonicalState>()
}

impl Workspaces {
    /// The window `label` now has `folder` open (or none): the folder's path, the store's scope and who has it open
    /// change together, under one lock. Returns the folder's key and whether it was opened by its first window (its
    /// domains must be read). The folder the window left is closed when no window has it open any more: its state is
    /// removed, reads still in flight for it are dropped and its refresh requests are released.
    pub fn transition(
        &self,
        store: &StateStore,
        label: &str,
        folder: Option<&Path>,
    ) -> (Option<WorkspaceKey>, bool) {
        let key = folder.map(workspace_key);
        let _transition = lock(&self.lifecycle);
        if let (Some(key), Some(folder)) = (&key, folder) {
            lock(&self.roots)
                .entry(key.clone())
                .or_insert_with(|| folder.to_path_buf());
            store.open_scope(key);
        }
        let (left, first) = self.set_interest(label, key.as_ref());
        if let Some(left) = left {
            self.close(store, &left);
        }
        (key, first)
    }

    fn close(&self, store: &StateStore, key: &WorkspaceKey) {
        let removed = store.close_scope(key);
        lock(&self.roots).remove(key);
        for domain in WORKSPACE_DOMAINS {
            self.gate.forget(&(key.clone(), domain));
        }
        tracing::debug!(
            workspace = key.as_str(),
            removed,
            "a folder's canonical state was closed"
        );
    }
}

/// The window `label` has (re)opened its folder, or has none: the scopes follow, and the folder's key is returned.
/// A folder opened by its first window has its domains read in the background (the window resyncs its snapshot and
/// receives them as deltas).
pub async fn attach(app: &AppHandle, label: &str) -> Option<WorkspaceKey> {
    let state = app.try_state::<AppState>()?;
    let folder = crate::windows::window_workspace(&state, label)
        .await
        .ok()
        .flatten()
        .map(|info| PathBuf::from(info.path));
    let canonical = canonical(app)?;
    let (key, first) = canonical
        .workspaces
        .transition(&canonical.store, label, folder.as_deref());
    if let (Some(key), true) = (&key, first) {
        schedule(app, key, &WORKSPACE_DOMAINS);
    }
    key
}

/// The window `label` is gone: if it was the last one on its folder, the folder's scope is closed.
pub fn detach(app: &AppHandle, label: &str) {
    if let Some(canonical) = canonical(app) {
        canonical
            .workspaces
            .transition(&canonical.store, label, None);
    }
}

/// Asks for `domains` of `key` to be read (merged with every other request until the read starts).
pub fn schedule(app: &AppHandle, key: &WorkspaceKey, domains: &[Domain]) {
    let Some(canonical) = canonical(app) else {
        return;
    };
    for domain in domains
        .iter()
        .copied()
        .filter(|domain| domain.is_workspace_scoped())
    {
        let request = canonical.workspaces.gate.request(&(key.clone(), domain));
        if request.start {
            spawn_driver(app, key.clone(), domain);
        }
    }
}

/// [`schedule`] for every open folder (a global change: a runtime, a tool, packages).
pub fn schedule_all(app: &AppHandle, domains: &[Domain]) {
    let Some(canonical) = canonical(app) else {
        return;
    };
    for key in canonical.workspaces.open_folders() {
        schedule(app, &key, domains);
    }
}

/// [`schedule`] for the folder at `root` if a window has it open (a project watcher noticed a change there).
pub fn schedule_root(app: &AppHandle, root: &Path, domains: &[Domain]) {
    let key = workspace_key(root);
    let open = canonical(app).is_some_and(|canonical| canonical.workspaces.root(&key).is_some());
    if open {
        schedule(app, &key, domains);
    }
}

/// Asks for `domains` of `key` and waits until a read that started after this request has been applied.
pub async fn refresh_now(app: &AppHandle, key: &WorkspaceKey, domains: &[Domain]) {
    let Some(canonical) = canonical(app) else {
        return;
    };
    let mut waits = Vec::new();
    for domain in domains
        .iter()
        .copied()
        .filter(|domain| domain.is_workspace_scoped())
    {
        let request = canonical.workspaces.gate.request(&(key.clone(), domain));
        if request.start {
            spawn_driver(app, key.clone(), domain);
        }
        waits.push((request.number, request.done));
    }
    for (number, mut done) in waits {
        let reached =
            tokio::time::timeout(WAIT_LIMIT, done.wait_for(|value| *value >= number)).await;
        if reached.is_err() {
            tracing::warn!(
                workspace = key.as_str(),
                "a workspace refresh is taking long; not waiting for it"
            );
        }
    }
}

fn spawn_driver(app: &AppHandle, key: WorkspaceKey, domain: Domain) {
    let handle = app.clone();
    tauri::async_runtime::spawn(async move {
        drive(&handle, &key, domain).await;
    });
}

/// Reads `domain` of `key` until no request is left: wait for the burst to settle, read, apply, repeat if more came.
async fn drive(app: &AppHandle, key: &WorkspaceKey, domain: Domain) {
    let Some(state) = canonical(app) else {
        return;
    };
    let slot = (key.clone(), domain);
    let workspaces = state.workspaces.clone();
    super::gate::run_until_idle(&workspaces.gate, &slot, debounce(domain), || {
        let (app, key, slot) = (app.clone(), key.clone(), slot.clone());
        async move { read_and_apply(&app, &key, domain, &slot).await }
    })
    .await;
}

/// One read of a folder's domain, applied to the store (outside every lock until the short compare-and-replace).
async fn read_and_apply(
    app: &AppHandle,
    key: &WorkspaceKey,
    domain: Domain,
    slot: &(WorkspaceKey, Domain),
) {
    let Some(state) = canonical(app) else {
        return;
    };
    let Some(root) = state.workspaces.root(key) else {
        return; // closed meanwhile
    };
    let ticket = state.store.ticket_in(domain, key);
    if let Some(value) = super::read::read_scoped(app, domain, &root).await {
        let applied = state.store.apply(ticket, value);
        *lock(&state.workspaces.reads)
            .entry(slot.clone())
            .or_insert(0) += 1;
        tracing::debug!(
            workspace = key.as_str(),
            ?domain,
            ?applied,
            "workspace state refreshed"
        );
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn key(path: &str) -> WorkspaceKey {
        workspace_key(Path::new(path))
    }

    #[test]
    fn the_first_window_opens_a_folder_and_the_last_one_closes_it() {
        let spaces = Workspaces::default();
        let (a, b) = (key("C:/ProjectA"), key("C:/ProjectB"));
        assert_eq!(spaces.set_interest("main", Some(&a)), (None, true));
        // A second window on the same folder shares it: nothing to read.
        assert_eq!(spaces.set_interest("window-2", Some(&a)), (None, false));
        // The same window reporting the same folder again changes nothing.
        assert_eq!(spaces.set_interest("main", Some(&a)), (None, false));
        // main switches to B: A is still open in window-2.
        assert_eq!(spaces.set_interest("main", Some(&b)), (None, true));
        // window-2 closes: A has no window left.
        assert_eq!(
            spaces.set_interest("window-2", None),
            (Some(a.clone()), false)
        );
        assert_eq!(spaces.windows_of(b.as_str()), vec!["main".to_string()]);
        // main closes its folder: B goes too.
        assert_eq!(spaces.set_interest("main", None), (Some(b), false));
        assert!(spaces.of_window("main").is_none());
    }
}
