//! What changed on the system, routed into the canonical state (`crate::state`). Whatever is installed, removed or
//! switched — a runtime, a Language Tools tool, a language server, an extension, packages — names a topic here; the
//! canonical domains of that topic are read again (and every open folder's dependent domains scheduled), and every
//! window receives the result as `state:delta`. Nothing here sends an event of its own.
//!
//! Two sources feed it: OpenMind's own operations ([`announce_now`], when an install/removal/switch ends: the
//! canonical state (`crate::state`) is updated first) and changes made
//! outside OpenMind that the file watchers notice ([`announce_observed`]: the app's `runtimes/`, `tools/`,
//! `language-servers/`, `extensions/` through [`start_watching`], a project's `node_modules`/`.venv`/... through the
//! project's own watcher). A watched burst that OpenMind itself caused and already announced is not announced twice.

use std::collections::HashMap;
use std::path::Path;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use openmind_file_watch::{Burst, SystemWatcher};
use tauri::{AppHandle, Manager};

/// The topics, shared with the file watchers (one definition: `runtimes`, `tools`, `languageServers`, `extensions`,
/// `packages`).
pub use openmind_file_watch::SyncTopic as Topic;

/// A watched burst whose last event came no later than this after OpenMind's own announcement of the same topic was
/// that operation's own file traffic (events arrive a little after the files are written).
const OWN_CHANGE_SLACK: Duration = Duration::from_millis(500);

/// Managed by the app: when each topic was last announced by OpenMind itself, and the app-folder watcher.
#[derive(Default)]
pub struct SyncState {
    announced: Mutex<HashMap<Topic, Instant>>,
    watcher: Mutex<Option<SystemWatcher>>,
}

fn record_own(app: &AppHandle, topic: Topic) {
    if let Some(state) = app.try_state::<SyncState>() {
        if let Ok(mut announced) = state.announced.lock() {
            announced.insert(topic, Instant::now());
        }
    }
}

/// OpenMind's own operation changed `topic` and it has ended: the canonical state is read again and updated *before*
/// this returns (so the command's caller can rely on it), and every open folder's dependent domains are scheduled.
pub async fn announce_now(app: &AppHandle, topic: Topic) {
    tracing::debug!(?topic, "system change announced");
    record_own(app, topic);
    crate::state::refresh(app, crate::state::domains_for(topic)).await;
    // What every open folder can run, format, debug or install follows (read once per folder, in the background).
    crate::state::schedule_all(app, crate::state::workspace_domains_for(topic));
}

/// Whether a watched burst was only the file traffic of an operation OpenMind already announced: nothing in it came
/// after that announcement (beyond the slack for event delivery).
pub fn is_own_change(announced: Option<Instant>, burst: &Burst) -> bool {
    announced.is_some_and(|at| burst.last <= at + OWN_CHANGE_SLACK)
}

/// Which OpenMind operations a watched burst of `topic` can be the file traffic of. A burst from the app folder's
/// watcher that is `packages` lies inside `runtimes/` (a runtime's `site-packages`/`node_modules`): installing,
/// repairing or deleting the runtime itself writes those files too. A project's packages are only its own topic.
pub fn own_topics(topic: Topic, from_app_folder: bool) -> &'static [Topic] {
    match (topic, from_app_folder) {
        (Topic::Packages, true) => &[Topic::Packages, Topic::Runtimes],
        (Topic::Runtimes, _) => &[Topic::Runtimes],
        (Topic::Tools, _) => &[Topic::Tools],
        (Topic::LanguageServers, _) => &[Topic::LanguageServers],
        (Topic::Extensions, _) => &[Topic::Extensions],
        (Topic::Packages, false) => &[Topic::Packages],
        (Topic::Git, _) => &[Topic::Git],
    }
}

/// A change the file watchers noticed (one coalesced burst), announced unless OpenMind's own operation already did.
/// `from_app_folder`: the app folder's watcher (not a project's) noticed it.
pub fn announce_observed(app: &AppHandle, topic: Topic, burst: Burst, from_app_folder: bool) {
    let announced = app.try_state::<SyncState>().and_then(|state| {
        let map = state.announced.lock().ok()?;
        own_topics(topic, from_app_folder)
            .iter()
            .filter_map(|own| map.get(own).copied())
            .max()
    });
    let own = is_own_change(announced, &burst);
    if own {
        tracing::debug!(
            ?topic,
            events = burst.events,
            "a watched change was OpenMind's own and is announced already"
        );
    } else {
        tracing::info!(
            ?topic,
            events = burst.events,
            "an installed thing changed on disk"
        );
    }
    // Either way the canonical state reconciles with the disk; a read that finds nothing new changes nothing. Only an
    // outside change makes the open folders look again (OpenMind's own operation scheduled that already).
    let handle = app.clone();
    tauri::async_runtime::spawn(async move {
        crate::state::refresh(&handle, reconcile_domains(own, topic)).await;
        if !own {
            crate::state::schedule_all(&handle, crate::state::workspace_domains_for(topic));
        }
    });
}

/// The domains a watched burst reads again. OpenMind's own package change was counted when it was announced, so
/// reconciling it must not count it a second time (the packages marker always changes when bumped).
pub fn reconcile_domains(own: bool, topic: Topic) -> &'static [crate::state::Domain] {
    match (own, topic) {
        (true, Topic::Packages) => &[crate::state::Domain::Runtimes],
        _ => crate::state::domains_for(topic),
    }
}

/// Starts watching the app's `runtimes/`, `tools/`, `language-servers/` and `extensions/` (those that exist now, and
/// each one as soon as it appears). Calling it again replaces the watcher (a different app folder); a folder that
/// can't be watched is logged and the app goes on without it.
pub fn start_watching(app: &AppHandle, root: &Path) {
    let Some(state) = app.try_state::<SyncState>() else {
        return;
    };
    let handle = app.clone();
    let started = SystemWatcher::start(
        root,
        Arc::new(move |topic, burst| announce_observed(&handle, topic, burst, true)),
    );
    let watcher = match started {
        Ok(watcher) => Some(watcher),
        Err(err) => {
            tracing::warn!(%err, root = %root.display(), "the app folder can't be watched for outside changes");
            None
        }
    };
    // The old watcher (if any) is dropped after the lock is released, which ends its thread.
    let old = match state.watcher.lock() {
        Ok(mut slot) => std::mem::replace(&mut *slot, watcher),
        Err(_) => None,
    };
    drop(old);
}

/// Stops the app-folder watcher (app closing); its thread ends before this returns.
pub fn stop_watching(app: &AppHandle) {
    if let Some(state) = app.try_state::<SyncState>() {
        let watcher = state.watcher.lock().ok().and_then(|mut slot| slot.take());
        drop(watcher);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn burst(first_ms: u64, last_ms: u64, base: Instant) -> Burst {
        Burst {
            first: base + Duration::from_millis(first_ms),
            last: base + Duration::from_millis(last_ms),
            events: 40,
        }
    }

    #[test]
    fn a_runtime_operation_owns_the_package_files_inside_the_runtime_but_not_a_projects() {
        assert_eq!(
            own_topics(Topic::Packages, true),
            &[Topic::Packages, Topic::Runtimes]
        );
        assert_eq!(own_topics(Topic::Packages, false), &[Topic::Packages]);
        assert_eq!(own_topics(Topic::Tools, true), &[Topic::Tools]);
    }

    #[test]
    fn reconciling_an_own_package_change_does_not_count_it_twice() {
        use crate::state::Domain;
        assert_eq!(
            reconcile_domains(true, Topic::Packages),
            &[Domain::Runtimes]
        );
        assert_eq!(
            reconcile_domains(false, Topic::Packages)[0],
            Domain::Packages
        );
        assert_eq!(reconcile_domains(true, Topic::Tools), &[Domain::Tools]);
    }

    #[test]
    fn an_installs_own_file_traffic_is_not_announced_a_second_time() {
        let base = Instant::now();
        // The install wrote its files (0-2000 ms), then announced (2000 ms); its last events arrived at 2100 ms.
        let announced = Some(base + Duration::from_millis(2000));
        assert!(is_own_change(announced, &burst(0, 2100, base)));
        // Something else changed afterwards: announced.
        assert!(!is_own_change(announced, &burst(0, 4000, base)));
        assert!(!is_own_change(announced, &burst(5000, 5200, base)));
        // Nothing announced by OpenMind: an outside change is always announced.
        assert!(!is_own_change(None, &burst(0, 100, base)));
    }
}
