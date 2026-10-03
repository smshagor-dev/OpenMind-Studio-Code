use super::*;
use crate::state::scope::workspace_key;
use serde_json::json;
use std::path::Path;
use std::sync::mpsc::channel;
use std::sync::Arc;

fn set(store: &StateStore, domain: Domain, value: Value) -> Applied {
    let ticket = store.ticket(domain);
    store.apply(ticket, value)
}

fn set_in(store: &StateStore, domain: Domain, scope: &WorkspaceKey, value: Value) -> Applied {
    let ticket = store.ticket_in(domain, scope);
    store.apply(ticket, value)
}

fn key(path: &str) -> WorkspaceKey {
    workspace_key(Path::new(path))
}

#[test]
fn a_meaningful_change_bumps_the_revision_once_and_queues_one_delta() {
    let (tx, rx) = channel();
    let store = StateStore::new(Some(tx));
    assert_eq!(store.revision(), 0);
    assert_eq!(
        set(&store, Domain::Runtimes, json!([{ "id": "node" }])),
        Applied::Changed(1)
    );
    assert_eq!(
        set(&store, Domain::Tools, json!({ "tools": [] })),
        Applied::Changed(2)
    );
    let deltas: Vec<StateDelta> = rx.try_iter().collect();
    assert_eq!(
        deltas.iter().map(|d| d.revision).collect::<Vec<_>>(),
        vec![1, 2]
    );
    assert_eq!(deltas[0].domain, Domain::Runtimes);
    assert_eq!(deltas[0].scope, None);
    assert_eq!(deltas[1].data, json!({ "tools": [] }));
}

#[test]
fn an_identical_refresh_changes_nothing_even_with_map_keys_in_another_order() {
    let (tx, rx) = channel();
    let store = StateStore::new(Some(tx));
    set(
        &store,
        Domain::Extensions,
        json!({ "activity": { "a": 1, "b": 2 } }),
    );
    let again: Value =
        serde_json::from_str(r#"{ "activity": { "b": 2, "a": 1 } }"#).unwrap_or_default();
    assert_eq!(set(&store, Domain::Extensions, again), Applied::Unchanged);
    assert_eq!(store.revision(), 1);
    assert_eq!(rx.try_iter().count(), 1);
}

#[test]
fn an_older_read_finishing_last_never_overwrites_a_newer_one() {
    let store = StateStore::new(None);
    let old = store.ticket(Domain::Runtimes);
    let new = store.ticket(Domain::Runtimes);
    assert_eq!(store.apply(new, json!(["node 24"])), Applied::Changed(1));
    assert_eq!(store.apply(old, json!(["node 22"])), Applied::Stale);
    assert_eq!(store.snapshot().domains[0].data, json!(["node 24"]));
    assert_eq!(set(&store, Domain::Tools, json!({})), Applied::Changed(2));
}

#[test]
fn packages_is_a_rising_marker() {
    let store = StateStore::new(None);
    assert_eq!(store.bump_packages(), 1);
    assert_eq!(store.bump_packages(), 2);
    assert_eq!(store.snapshot().domains[0].data, json!({ "generation": 2 }));
}

#[test]
fn many_threads_changing_global_and_scoped_slots_produce_gapless_ordered_deltas() {
    let (tx, rx) = channel();
    let store = Arc::new(StateStore::new(Some(tx)));
    let threads: Vec<_> = (0..8)
        .map(|thread| {
            let store = store.clone();
            std::thread::spawn(move || {
                let scope = key(if thread % 2 == 0 { "C:/A" } else { "C:/B" });
                for step in 0..50 {
                    let ticket = store.ticket(Domain::Runtimes);
                    store.apply(ticket, json!([thread, step]));
                    let ticket = store.ticket_in(Domain::Git, &scope);
                    store.apply(ticket, json!({ "step": [thread, step] }));
                    store.bump_packages();
                }
            })
        })
        .collect();
    for handle in threads {
        assert!(handle.join().is_ok());
    }
    let revisions: Vec<u64> = rx.try_iter().map(|delta| delta.revision).collect();
    assert_eq!(revisions.len() as u64, store.revision());
    assert!(
        revisions.windows(2).all(|pair| pair[1] == pair[0] + 1),
        "{revisions:?}"
    );
    assert_eq!(revisions.first(), Some(&1));
}

#[test]
fn the_snapshot_holds_only_domains_read_so_far() {
    let store = StateStore::new(None);
    assert_eq!(store.snapshot().domains.len(), 0);
    set(&store, Domain::LanguageServers, json!({ "servers": [] }));
    let snapshot = store.snapshot();
    assert_eq!(snapshot.revision, 1);
    assert_eq!(snapshot.domains.len(), 1);
    assert_eq!(snapshot.domains[0].domain, Domain::LanguageServers);
}

#[test]
fn after_close_changes_are_kept_but_nothing_is_published() {
    let (tx, rx) = channel();
    let store = StateStore::new(Some(tx));
    store.close();
    assert_eq!(
        set(&store, Domain::Runtimes, json!([])),
        Applied::Changed(1)
    );
    assert_eq!(rx.try_iter().count(), 0);
    assert_eq!(store.snapshot().revision, 1);
}

#[test]
fn two_workspaces_keep_independent_state_and_a_window_sees_only_its_own() {
    let store = StateStore::new(None);
    let (a, b) = (key("C:/ProjectA"), key("C:/ProjectB"));
    set(&store, Domain::Runtimes, json!(["node"]));
    set_in(&store, Domain::Git, &a, json!({ "branch": "main" }));
    set_in(&store, Domain::Git, &b, json!({ "branch": "dev" }));
    // A's refresh never touches B's state.
    assert_eq!(
        set_in(&store, Domain::Git, &a, json!({ "branch": "feature" })),
        Applied::Changed(4)
    );
    let only_a = store.snapshot_for(Some(&a));
    assert_eq!(only_a.workspace.as_deref(), Some(a.as_str()));
    let git: Vec<&Value> = only_a
        .domains
        .iter()
        .filter(|e| e.domain == Domain::Git)
        .map(|e| &e.data)
        .collect();
    assert_eq!(git, vec![&json!({ "branch": "feature" })]);
    assert!(only_a.domains.iter().any(|e| e.domain == Domain::Runtimes));
    let only_b = store.snapshot_for(Some(&b));
    assert!(only_b
        .domains
        .iter()
        .any(|e| e.data == json!({ "branch": "dev" })));
    assert!(!only_b
        .domains
        .iter()
        .any(|e| e.data == json!({ "branch": "feature" })));
    // Without a folder: global domains only.
    assert_eq!(store.snapshot().domains.len(), 1);
}

#[test]
fn closing_a_workspace_removes_its_state_and_drops_reads_still_in_flight() {
    let (tx, rx) = channel();
    let store = StateStore::new(Some(tx));
    let (a, b) = (key("C:/ProjectA"), key("C:/ProjectB"));
    set_in(&store, Domain::Git, &a, json!({ "branch": "main" }));
    set_in(&store, Domain::Dependencies, &a, json!({ "projects": [] }));
    set_in(&store, Domain::Git, &b, json!({ "branch": "dev" }));
    let late = store.ticket_in(Domain::Git, &a);
    assert_eq!(store.close_scope(&a), 2);
    assert_eq!(
        store.apply(late, json!({ "branch": "late" })),
        Applied::Stale
    );
    assert!(store.snapshot_for(Some(&a)).domains.is_empty());
    assert_eq!(store.snapshot_for(Some(&b)).domains.len(), 1);
    let removals: Vec<StateDelta> = rx.try_iter().filter(|d| d.removed).collect();
    assert_eq!(removals.len(), 2);
    assert!(removals
        .iter()
        .all(|d| d.scope.as_deref() == Some(a.as_str()) && d.data == Value::Null));
    // Opened again: it can be read and kept again.
    store.open_scope(&a);
    assert!(matches!(
        set_in(&store, Domain::Git, &a, json!({ "branch": "main" })),
        Applied::Changed(_)
    ));
}

#[test]
fn the_domains_not_read_yet_are_reported_as_missing() {
    let store = StateStore::new(None);
    set(&store, Domain::Runtimes, json!([]));
    assert_eq!(
        store.missing(&[Domain::Runtimes, Domain::Tools, Domain::Extensions]),
        vec![Domain::Tools, Domain::Extensions]
    );
}

#[test]
fn a_read_from_before_a_close_cannot_bring_old_state_into_the_reopened_folder() {
    let store = StateStore::new(None);
    let a = key("C:/ProjectA");
    store.open_scope(&a);
    let before_close = store.ticket_in(Domain::Git, &a);
    store.close_scope(&a);
    store.open_scope(&a);
    let after_reopen = store.ticket_in(Domain::Git, &a);
    // The old read finishes late, after the folder was opened again: dropped.
    assert_eq!(
        store.apply(before_close, json!({ "branch": "old" })),
        Applied::Stale
    );
    assert_eq!(
        store.apply(after_reopen, json!({ "branch": "new" })),
        Applied::Changed(1)
    );
    let snapshot = store.snapshot_for(Some(&a));
    assert_eq!(snapshot.domains[0].data, json!({ "branch": "new" }));
}
