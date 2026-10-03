//! Multi-window and rapid-change stress for the canonical state's pure parts: the store, the scope transitions of
//! `Workspaces` and the refresh gate, driven from many threads at once the way windows, watchers and readers do.

use std::path::Path;
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::mpsc::channel;
use std::sync::{Arc, Barrier};
use std::time::Duration;

use serde_json::{json, Value};

use super::domain::{Domain, StateDelta};
use super::gate::{run_until_idle, RefreshGate};
use super::scope::{workspace_key, WorkspaceKey};
use super::store::{Applied, StateStore};
use super::workspace::Workspaces;

const PROJECT_A: &str = "C:/Stress/ProjectA";
const PROJECT_B: &str = "C:/Stress/ProjectB";

fn key(path: &str) -> WorkspaceKey {
    workspace_key(Path::new(path))
}

/// A folder's state names the folder it was read from, so contamination is visible in the data itself.
fn folder_state(folder: &WorkspaceKey, n: u32) -> Value {
    json!({ "folder": folder.as_str(), "n": n })
}

/// Every delta in the order the publisher would send them.
fn drain(deltas: &std::sync::mpsc::Receiver<StateDelta>) -> Vec<StateDelta> {
    deltas.try_iter().collect()
}

fn assert_ordered_and_clean(deltas: &[StateDelta]) {
    for (index, delta) in deltas.iter().enumerate() {
        assert_eq!(
            delta.revision,
            index as u64 + 1,
            "revisions are gapless and ordered"
        );
        if let (Some(scope), false) = (&delta.scope, delta.removed) {
            assert_eq!(
                delta.data["folder"].as_str(),
                Some(scope.as_str()),
                "a folder's slot only ever holds that folder's state"
            );
        }
    }
}

#[test]
fn three_windows_on_two_folders_with_concurrent_changes_stay_ordered_and_separate() {
    let (out, deltas) = channel();
    let store = Arc::new(StateStore::new(Some(out)));
    let spaces = Arc::new(Workspaces::default());
    let (a, b) = (key(PROJECT_A), key(PROJECT_B));
    // Window A on ProjectA, B on ProjectB, C on ProjectA.
    assert!(
        spaces
            .transition(&store, "main", Some(Path::new(PROJECT_A)))
            .1
    );
    assert!(
        spaces
            .transition(&store, "window-2", Some(Path::new(PROJECT_B)))
            .1
    );
    assert!(
        !spaces
            .transition(&store, "window-3", Some(Path::new(PROJECT_A)))
            .1,
        "the second window on a folder shares its state: nothing is read again"
    );

    let start = Arc::new(Barrier::new(5));
    let mut threads = Vec::new();
    // Readers of both folders' domains (package changes, Git changes ...), racing each other.
    for (folder, domain) in [(a.clone(), Domain::Git), (b.clone(), Domain::Dependencies)] {
        let (store, start) = (store.clone(), start.clone());
        threads.push(std::thread::spawn(move || {
            start.wait();
            for n in 0..300 {
                let ticket = store.ticket_in(domain, &folder);
                store.apply(ticket, folder_state(&folder, n));
            }
        }));
    }
    // Global changes: a runtime switch, a tool and an extension change.
    {
        let (store, start) = (store.clone(), start.clone());
        threads.push(std::thread::spawn(move || {
            start.wait();
            for n in 0..300 {
                for domain in [Domain::Runtimes, Domain::Tools, Domain::Extensions] {
                    let ticket = store.ticket(domain);
                    store.apply(ticket, json!({ "n": n }));
                }
            }
        }));
    }
    // Window B switching between the folders, window C closing and reopening ProjectA.
    {
        let (store, spaces, start) = (store.clone(), spaces.clone(), start.clone());
        threads.push(std::thread::spawn(move || {
            start.wait();
            for round in 0..100 {
                let folder = if round % 2 == 0 { PROJECT_A } else { PROJECT_B };
                spaces.transition(&store, "window-2", Some(Path::new(folder)));
                spaces.transition(&store, "window-3", None);
                spaces.transition(&store, "window-3", Some(Path::new(PROJECT_A)));
            }
        }));
    }
    start.wait();
    for thread in threads {
        thread.join().expect("a stress thread panicked");
    }

    let all = drain(&deltas);
    assert!(!all.is_empty());
    assert_ordered_and_clean(&all);
    // Window A never left ProjectA, so its state survived every switch around it.
    assert_eq!(spaces.of_window("main"), Some(a.clone()));
    assert!(store
        .snapshot_for(Some(&a))
        .domains
        .iter()
        .any(|entry| entry.scope.as_deref() == Some(a.as_str())));
}

#[test]
fn closing_one_of_two_windows_keeps_the_folder_and_closing_the_last_removes_it() {
    let (out, deltas) = channel();
    let store = StateStore::new(Some(out));
    let spaces = Workspaces::default();
    let a = key(PROJECT_A);
    spaces.transition(&store, "main", Some(Path::new(PROJECT_A)));
    spaces.transition(&store, "window-2", Some(Path::new(PROJECT_A)));
    let ticket = store.ticket_in(Domain::Git, &a);
    assert_eq!(
        store.apply(ticket, folder_state(&a, 1)),
        Applied::Changed(1)
    );

    spaces.transition(&store, "window-2", None);
    assert_eq!(
        store.snapshot_for(Some(&a)).domains.len(),
        1,
        "main still shows ProjectA"
    );
    assert_eq!(spaces.windows_of(a.as_str()), vec!["main".to_string()]);

    // A read that started before the last window left finishes after it: dropped.
    let late = store.ticket_in(Domain::Dependencies, &a);
    spaces.transition(&store, "main", None);
    assert_eq!(store.apply(late, folder_state(&a, 2)), Applied::Stale);
    assert!(store.snapshot_for(Some(&a)).domains.is_empty());
    let all = drain(&deltas);
    assert!(
        all.last().is_some_and(|delta| delta.removed),
        "the last window's leaving removes the state"
    );
    assert!(
        spaces.open_folders().is_empty(),
        "no scope remains for a folder no window shows"
    );
}

#[test]
fn opening_and_closing_windows_repeatedly_leaves_no_scope_or_interest_behind() {
    let store = StateStore::new(None);
    let spaces = Workspaces::default();
    for round in 0..200 {
        let label = format!("window-{}", round % 7 + 2);
        let folder = if round % 3 == 0 { PROJECT_A } else { PROJECT_B };
        spaces.transition(&store, &label, Some(Path::new(folder)));
        spaces.transition(&store, "main", Some(Path::new(PROJECT_A)));
        spaces.transition(&store, &label, None);
    }
    spaces.transition(&store, "main", None);
    assert!(spaces.open_folders().is_empty());
    assert!(spaces.of_window("main").is_none());
    assert!(store.snapshot_for(Some(&key(PROJECT_A))).domains.is_empty());
}

#[test]
fn a_flood_of_refresh_requests_from_many_threads_is_bounded_to_two_reads() {
    tauri::async_runtime::block_on(async {
        let gate: Arc<RefreshGate<&'static str>> = Arc::new(RefreshGate::default());
        let reads = Arc::new(AtomicU32::new(0));
        let mut requests = Vec::new();
        let mut started = 0;
        // Eight watcher threads' worth of events (hundreds of file events from `npm install`).
        let collected: Vec<_> = (0..8)
            .map(|_| {
                let gate = gate.clone();
                std::thread::spawn(move || {
                    (0..250)
                        .map(|_| gate.request(&"a/deps"))
                        .collect::<Vec<_>>()
                })
            })
            .collect();
        for thread in collected {
            for request in thread.join().expect("a request thread panicked") {
                if request.start {
                    started += 1;
                }
                requests.push(request);
            }
        }
        assert_eq!(started, 1, "only the first request starts a driver");
        let (driver_gate, driver_reads) = (gate.clone(), reads.clone());
        run_until_idle(&driver_gate, &"a/deps", Duration::from_millis(1), || {
            let reads = driver_reads.clone();
            async move {
                reads.fetch_add(1, Ordering::SeqCst);
            }
        })
        .await;
        for request in &requests {
            assert!(
                *request.done.borrow() >= request.number,
                "every request was covered"
            );
        }
        assert_eq!(
            reads.load(Ordering::SeqCst),
            1,
            "2000 requests made before the read are one read"
        );
    });
}

#[test]
fn reads_racing_a_folder_close_never_resurrect_it() {
    let store = Arc::new(StateStore::new(None));
    let spaces = Arc::new(Workspaces::default());
    let a = key(PROJECT_A);
    spaces.transition(&store, "main", Some(Path::new(PROJECT_A)));
    let tickets: Vec<_> = (0..64).map(|_| store.ticket_in(Domain::Git, &a)).collect();
    spaces.transition(&store, "main", None);
    spaces.transition(&store, "main", Some(Path::new(PROJECT_A)));
    let threads: Vec<_> = tickets
        .into_iter()
        .enumerate()
        .map(|(n, ticket)| {
            let (store, folder) = (store.clone(), a.clone());
            std::thread::spawn(move || store.apply(ticket, folder_state(&folder, n as u32)))
        })
        .collect();
    for thread in threads {
        assert_eq!(thread.join().expect("a reader panicked"), Applied::Stale);
    }
    assert!(store.snapshot_for(Some(&a)).domains.is_empty());
}
