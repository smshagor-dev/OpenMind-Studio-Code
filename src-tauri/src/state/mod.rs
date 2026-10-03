//! The canonical application state (live sync, step 2): one versioned, Rust-side copy of the system state the windows
//! show, delivered to them as `state:delta` events (and as a snapshot on request), in one revision order.
//!
//! - **Global** domains (runtimes, tools, language servers, extensions, packages marker, managed servers) are shared
//!   by every window.
//! - **Per-workspace** domains (Git, dependencies, project status, debug readiness) exist once per open folder
//!   (`scope::WorkspaceKey`) and go only to the windows that have that folder open (`workspace.rs`); the others get a
//!   revision-only tick, so every window still sees every revision and can detect a gap.
//!
//! Flow: something changed → the affected domains are read again with the same functions their commands use, *outside*
//! any lock → [`store::StateStore::apply`] compares and replaces in one short critical section (no revision, no delta
//! when nothing changed) → the publisher thread routes the delta. The domain services keep all business rules; this
//! is the only way backend system state reaches the windows.

mod domain;
mod gate;
mod read;
mod scope;
mod servers;
mod store;
mod workspace;

#[cfg(test)]
mod stress_tests;

use std::collections::HashMap;
use std::sync::mpsc::channel;
use std::sync::{Arc, Mutex, MutexGuard};
use std::thread::JoinHandle;
use std::time::Duration;

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager};

pub use domain::{domains_for, workspace_domains_for, Domain, StateDelta, StateSnapshot};
pub use store::StateStore;
pub use workspace::{attach, detach, schedule_all, schedule_root};

use gate::RefreshGate;

/// The event that carries one [`StateDelta`] to a window.
pub const DELTA_EVENT: &str = "state:delta";

/// How long a global domain waits after a request before reading, so a burst of requests (ten language servers
/// changing state, an extension folder copied in file by file) is one read.
const GLOBAL_DEBOUNCE: Duration = Duration::from_millis(100);

/// The longest [`refresh`] waits for a read it asked for (a slow runtime listing); the read itself goes on.
const GLOBAL_WAIT_LIMIT: Duration = Duration::from_secs(60);

/// Managed by the app: the store, who has which folder open, and the thread that publishes the deltas.
pub struct CanonicalState {
    store: StateStore,
    workspaces: Arc<workspace::Workspaces>,
    /// One read at a time per global domain, every request meanwhile merged into at most one more (as for folders).
    global: Arc<RefreshGate<Domain>>,
    /// How many times each global domain was read (diagnostics: `state_reads`).
    global_reads: Mutex<HashMap<Domain, u64>>,
    publisher: Mutex<Option<JoinHandle<()>>>,
}

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

/// Who gets what: a global delta goes to every window as it is; a per-workspace delta goes with its data to the
/// windows that have that folder open and as a revision-only tick to the others.
fn route(delta: &StateDelta, windows: &[(String, Option<String>)]) -> Vec<(String, StateDelta)> {
    windows
        .iter()
        .map(|(label, folder)| {
            let interested = delta.scope.is_none() || folder.as_deref() == delta.scope.as_deref();
            let sent = if interested {
                delta.clone()
            } else {
                delta.tick()
            };
            (label.clone(), sent)
        })
        .collect()
}

impl CanonicalState {
    /// A store whose deltas are routed to the windows by a dedicated thread, in the order they were made.
    pub fn start(app: &AppHandle) -> Self {
        let (out, deltas) = channel::<StateDelta>();
        let handle = app.clone();
        let workspaces = Arc::new(workspace::Workspaces::default());
        let interest = workspaces.clone();
        let publisher = std::thread::spawn(move || {
            // Ends when the store closes its sender (shutdown).
            // Every delta is addressed to each window (a page listens only to its own), so a folder's data never
            // reaches a window that doesn't have that folder open.
            for delta in deltas {
                let windows: Vec<(String, Option<String>)> = handle
                    .webview_windows()
                    .into_keys()
                    .map(|label| {
                        let folder = interest
                            .of_window(&label)
                            .map(|key| key.as_str().to_string());
                        (label, folder)
                    })
                    .collect();
                for (label, sent) in route(&delta, &windows) {
                    if let Err(err) = handle.emit_to(label.as_str(), DELTA_EVENT, &sent) {
                        tracing::warn!(?err, revision = sent.revision, %label, "a state change couldn't be sent");
                    }
                }
            }
        });
        Self {
            store: StateStore::new(Some(out)),
            workspaces,
            global: Arc::new(RefreshGate::default()),
            global_reads: Mutex::new(HashMap::new()),
            publisher: Mutex::new(Some(publisher)),
        }
    }
}

/// Reads global `domains` again and applies what changed, and returns once a read that started after this request
/// has been applied. Requests for one domain are merged: at most one read runs and at most one more follows it,
/// however many callers ask meanwhile. Each read happens outside the store's lock; a read that a newer one overtook is
/// dropped. (Per-workspace domains are read by `workspace::schedule`.)
pub async fn refresh(app: &AppHandle, domains: &[Domain]) {
    let Some(canonical) = app.try_state::<CanonicalState>() else {
        return;
    };
    let mut waits = Vec::new();
    for domain in domains
        .iter()
        .copied()
        .filter(|domain| !domain.is_workspace_scoped())
    {
        if domain == Domain::Packages {
            canonical.store.bump_packages();
            continue;
        }
        let request = canonical.global.request(&domain);
        if request.start {
            spawn_global_driver(app, domain);
        }
        waits.push((domain, request.number, request.done));
    }
    for (domain, number, mut done) in waits {
        let reached =
            tokio::time::timeout(GLOBAL_WAIT_LIMIT, done.wait_for(|value| *value >= number)).await;
        if reached.is_err() {
            tracing::warn!(
                ?domain,
                "a canonical refresh is taking long; not waiting for it"
            );
        }
    }
}

fn spawn_global_driver(app: &AppHandle, domain: Domain) {
    let handle = app.clone();
    tauri::async_runtime::spawn(async move {
        let Some(gate) = handle
            .try_state::<CanonicalState>()
            .map(|canonical| canonical.global.clone())
        else {
            return;
        };
        gate::run_until_idle(&gate, &domain, GLOBAL_DEBOUNCE, || {
            let handle = handle.clone();
            async move { read_and_apply(&handle, domain).await }
        })
        .await;
    });
}

/// One read of a global domain, applied to the store (outside every lock until the short compare-and-replace).
async fn read_and_apply(app: &AppHandle, domain: Domain) {
    let Some(canonical) = app.try_state::<CanonicalState>() else {
        return;
    };
    let ticket = canonical.store.ticket(domain);
    if let Some(value) = read::read(app, domain).await {
        let applied = canonical.store.apply(ticket, value);
        *lock(&canonical.global_reads).entry(domain).or_insert(0) += 1;
        tracing::debug!(?domain, ?applied, "canonical state refreshed");
    }
}

/// [`refresh`] in the background (from a synchronous caller: an event sink, a watcher thread).
pub fn refresh_soon(app: &AppHandle, domains: &'static [Domain]) {
    let handle = app.clone();
    tauri::async_runtime::spawn(async move {
        refresh(&handle, domains).await;
    });
}

/// A managed server started, stopped or changed state: the servers domain (with its ports) is read again.
pub fn servers_changed(app: &AppHandle) {
    refresh_soon(app, &[Domain::Servers]);
}

/// The global domains every window needs from the start.
const STARTUP_DOMAINS: [Domain; 5] = [
    Domain::Runtimes,
    Domain::Tools,
    Domain::LanguageServers,
    Domain::Extensions,
    Domain::Servers,
];

/// Reads every global domain once at start-up, in the background (the window can show before it ends). A domain that
/// can't be read is tried again a few times, so no window is left without it; stores show "loading" meanwhile.
pub fn fill(app: &AppHandle) {
    let handle = app.clone();
    tauri::async_runtime::spawn(async move {
        let started = std::time::Instant::now();
        let mut missing: Vec<Domain> = STARTUP_DOMAINS.to_vec();
        for attempt in 0..4u64 {
            if attempt > 0 {
                tokio::time::sleep(std::time::Duration::from_secs(2 * attempt)).await;
            }
            refresh(&handle, &missing).await;
            let Some(canonical) = handle.try_state::<CanonicalState>() else {
                return;
            };
            missing = canonical.store.missing(&missing);
            if missing.is_empty() {
                break;
            }
            tracing::warn!(
                ?missing,
                attempt,
                "some canonical domains couldn't be read at start-up; trying again"
            );
        }
        if let Some(canonical) = handle.try_state::<CanonicalState>() {
            let snapshot = canonical.store.snapshot();
            let bytes = serde_json::to_vec(&snapshot).map(|b| b.len()).unwrap_or(0);
            tracing::info!(
                revision = snapshot.revision,
                bytes,
                elapsed_ms = started.elapsed().as_millis() as u64,
                ?missing,
                "canonical state filled"
            );
        }
    });
}

/// Stops publishing and waits for the publisher thread (app closing). Refreshes still running finish into a store
/// that no longer publishes.
pub fn stop(app: &AppHandle) {
    let Some(canonical) = app.try_state::<CanonicalState>() else {
        return;
    };
    canonical.store.close();
    let publisher = lock(&canonical.publisher).take();
    if let Some(thread) = publisher {
        let _ = thread.join();
    }
}

/// The global state and the calling window's own folder's state, with their revision. A window asks for this once
/// (after it started listening for deltas), after it opened another folder, and when it notices a gap.
#[tauri::command]
pub fn state_snapshot(window: tauri::Window, app: AppHandle) -> Option<StateSnapshot> {
    let canonical = app.try_state::<CanonicalState>()?;
    let folder = canonical.workspaces.of_window(window.label());
    Some(canonical.store.snapshot_for(folder.as_ref()))
}

/// The current revision only: after an operation, a window waits until it has applied at least this one.
#[tauri::command]
pub fn state_revision(app: AppHandle) -> u64 {
    app.try_state::<CanonicalState>()
        .map(|canonical| canonical.store.revision())
        .unwrap_or(0)
}

/// The calling window opened a folder, closed it or started: its scope follows. Returns the folder's key (`None`
/// without a folder); the window then reads its snapshot again.
#[tauri::command]
pub async fn state_workspace_attach(window: tauri::Window, app: AppHandle) -> Option<String> {
    attach(&app, window.label())
        .await
        .map(|key| key.as_str().to_string())
}

/// Brings `domains` up to date: global ones are read again; the calling window's folder's ones are read once for
/// every window asking at the same time, and this waits until that read was applied.
#[tauri::command]
pub async fn state_refresh(
    window: tauri::Window,
    app: AppHandle,
    domains: Vec<Domain>,
) -> Result<(), String> {
    let (scoped, global): (Vec<Domain>, Vec<Domain>) = domains
        .into_iter()
        .partition(|domain| domain.is_workspace_scoped());
    refresh(&app, &global).await;
    if scoped.is_empty() {
        return Ok(());
    }
    let folder = app
        .try_state::<CanonicalState>()
        .and_then(|canonical| canonical.workspaces.of_window(window.label()));
    if let Some(folder) = folder {
        workspace::refresh_now(&app, &folder, &scoped).await;
    }
    Ok(())
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReadCount {
    workspace: String,
    domain: Domain,
    reads: u64,
    windows: Vec<String>,
}

/// The workspace name of a global domain's read count.
const GLOBAL_SCOPE: &str = "(global)";

/// How often each global domain and each open folder's domains were read, and which windows show the folder
/// (diagnostics and stress tests: shared work is visible). Not used by the app's own pages.
#[tauri::command]
pub fn state_reads(app: AppHandle) -> Vec<ReadCount> {
    let Some(canonical) = app.try_state::<CanonicalState>() else {
        return Vec::new();
    };
    let global = lock(&canonical.global_reads)
        .iter()
        .map(|(domain, reads)| ReadCount {
            workspace: GLOBAL_SCOPE.to_string(),
            domain: *domain,
            reads: *reads,
            windows: Vec::new(),
        })
        .collect::<Vec<_>>();
    let scoped = canonical
        .workspaces
        .reads()
        .into_iter()
        .map(|(workspace, domain, reads)| ReadCount {
            windows: canonical.workspaces.windows_of(&workspace),
            workspace,
            domain,
            reads,
        });
    global.into_iter().chain(scoped).collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::{json, Value};

    fn delta(scope: Option<&str>) -> StateDelta {
        StateDelta {
            revision: 9,
            domain: if scope.is_some() {
                Domain::Git
            } else {
                Domain::Runtimes
            },
            scope: scope.map(str::to_string),
            data: json!({ "x": 1 }),
            removed: false,
            tick: false,
        }
    }

    fn windows() -> Vec<(String, Option<String>)> {
        vec![
            ("main".into(), Some("c:/a".into())),
            ("window-2".into(), Some("c:/b".into())),
            ("window-3".into(), Some("c:/a".into())),
            ("php-server".into(), None),
        ]
    }

    #[test]
    fn a_global_delta_reaches_every_window_with_its_data() {
        let routed = route(&delta(None), &windows());
        assert_eq!(routed.len(), 4);
        assert!(routed
            .iter()
            .all(|(_, sent)| sent.data == json!({ "x": 1 }) && !sent.tick));
    }

    #[test]
    fn a_folders_delta_carries_data_only_to_its_windows_and_a_tick_to_the_others() {
        let routed = route(&delta(Some("c:/a")), &windows());
        let with_data: Vec<&str> = routed
            .iter()
            .filter(|(_, sent)| !sent.tick)
            .map(|(label, _)| label.as_str())
            .collect();
        assert_eq!(with_data, vec!["main", "window-3"]);
        for (label, sent) in &routed {
            assert_eq!(sent.revision, 9, "{label}: every window sees the revision");
            if sent.tick {
                assert_eq!(sent.data, Value::Null, "{label}: no other folder's data");
            }
        }
    }
}
