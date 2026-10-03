//! One refresh at a time per key (a workspace's domain), with every request that arrives meanwhile merged into at
//! most one more run: "one active refresh + one pending marker". A burst of requests — a package manager's thousand
//! file events, two windows on the same folder asking at once, a save plus a `.git` change — becomes one read, and
//! a request that arrives while a read runs gets one more read after it (the change may have happened mid-read).
//!
//! Pure bookkeeping (no I/O, no spawning); the driver in `workspace.rs` waits its debounce, then calls
//! [`RefreshGate::begin`] / [`RefreshGate::end`] around the read. A caller that must see the result waits on the
//! receiver until it reaches its request number.

use std::collections::HashMap;
use std::hash::Hash;
use std::sync::{Mutex, MutexGuard};

use tokio::sync::watch;

struct Slot {
    /// Requests so far (each gets the next number).
    requested: u64,
    /// A run is going on (or waiting for its debounce).
    running: bool,
    /// The highest request number a finished run covered.
    done: watch::Sender<u64>,
}

/// The answer to [`RefreshGate::request`].
pub struct Request {
    /// This request's number: it is satisfied once `done` reaches it.
    pub number: u64,
    /// Nothing was running: the caller must start the run (otherwise the running one picks the request up).
    pub start: bool,
    pub done: watch::Receiver<u64>,
}

pub struct RefreshGate<K> {
    slots: Mutex<HashMap<K, Slot>>,
}

impl<K: Eq + Hash + Clone> Default for RefreshGate<K> {
    fn default() -> Self {
        Self {
            slots: Mutex::new(HashMap::new()),
        }
    }
}

impl<K: Eq + Hash + Clone> RefreshGate<K> {
    fn lock(&self) -> MutexGuard<'_, HashMap<K, Slot>> {
        self.slots
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    /// Asks for a refresh of `key`.
    pub fn request(&self, key: &K) -> Request {
        let mut slots = self.lock();
        let slot = slots.entry(key.clone()).or_insert_with(|| Slot {
            requested: 0,
            running: false,
            done: watch::channel(0).0,
        });
        slot.requested += 1;
        let start = !slot.running;
        slot.running = true;
        Request {
            number: slot.requested,
            start,
            done: slot.done.subscribe(),
        }
    }

    /// A run reads now (after its debounce): it covers every request made so far. Returns that number.
    pub fn begin(&self, key: &K) -> u64 {
        self.lock().get(key).map_or(0, |slot| slot.requested)
    }

    /// The run that covered `upto` finished. Returns whether requests came in meanwhile (run once more) — otherwise
    /// the key is idle again.
    pub fn end(&self, key: &K, upto: u64) -> bool {
        let mut slots = self.lock();
        let Some(slot) = slots.get_mut(key) else {
            return false;
        };
        // Read first: a watch value's read guard must be gone before it is written.
        let covered = upto.max(*slot.done.borrow());
        slot.done.send_replace(covered);
        if slot.requested > upto {
            return true;
        }
        slot.running = false;
        false
    }

    /// The key is gone (its folder closed): waiters are released and a later request starts afresh.
    pub fn forget(&self, key: &K) {
        if let Some(slot) = self.lock().remove(key) {
            slot.done.send_replace(u64::MAX);
        }
    }

    #[cfg(test)]
    pub fn is_running(&self, key: &K) -> bool {
        self.lock().get(key).is_some_and(|slot| slot.running)
    }
}

/// The driver loop: wait `debounce` for the burst to settle, read (covering every request so far), and read again
/// while requests keep arriving during a read. Returns when the key is idle.
pub async fn run_until_idle<K, F, Fut>(
    gate: &RefreshGate<K>,
    key: &K,
    debounce: std::time::Duration,
    mut read: F,
) where
    K: Eq + Hash + Clone,
    F: FnMut() -> Fut,
    Fut: std::future::Future<Output = ()>,
{
    loop {
        tokio::time::sleep(debounce).await;
        let upto = gate.begin(key);
        read().await;
        if !gate.end(key, upto) {
            return;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Drives the gate the way the async driver does, counting reads.
    fn run_all(gate: &RefreshGate<&'static str>, key: &'static str, reads: &mut u32) {
        loop {
            let upto = gate.begin(&key);
            *reads += 1;
            if !gate.end(&key, upto) {
                break;
            }
        }
    }

    #[test]
    fn a_burst_of_requests_before_the_read_starts_is_one_read() {
        let gate = RefreshGate::default();
        let first = gate.request(&"a/git");
        assert!(first.start);
        let others: Vec<Request> = (0..99).map(|_| gate.request(&"a/git")).collect();
        assert!(others.iter().all(|request| !request.start));
        let mut reads = 0;
        run_all(&gate, "a/git", &mut reads);
        assert_eq!(reads, 1);
        assert!(others
            .iter()
            .all(|request| *request.done.borrow() >= request.number));
        assert!(!gate.is_running(&"a/git"));
    }

    #[test]
    fn requests_during_a_read_make_exactly_one_more_read() {
        let gate = RefreshGate::default();
        assert!(gate.request(&"a/deps").start);
        let upto = gate.begin(&"a/deps");
        // While the read runs, two windows ask again.
        let late_a = gate.request(&"a/deps");
        let late_b = gate.request(&"a/deps");
        assert!(!late_a.start && !late_b.start);
        assert!(gate.end(&"a/deps", upto), "one more read is due");
        assert!(*late_b.done.borrow() < late_b.number);
        let upto = gate.begin(&"a/deps");
        assert!(!gate.end(&"a/deps", upto));
        assert!(*late_b.done.borrow() >= late_b.number);
    }

    #[test]
    fn workspaces_and_domains_are_gated_independently() {
        let gate = RefreshGate::default();
        assert!(gate.request(&"a/git").start);
        assert!(gate.request(&"b/git").start);
        assert!(gate.request(&"a/deps").start);
        assert!(!gate.request(&"a/git").start);
    }

    #[test]
    fn forgetting_a_key_releases_its_waiters_and_starts_afresh() {
        let gate = RefreshGate::default();
        let waiting = gate.request(&"a/git");
        gate.forget(&"a/git");
        assert_eq!(*waiting.done.borrow(), u64::MAX);
        assert!(gate.request(&"a/git").start);
    }
}

#[cfg(test)]
mod driver_tests {
    use super::*;
    use std::sync::atomic::{AtomicU32, Ordering};
    use std::sync::Arc;
    use std::time::Duration;

    const DEBOUNCE: Duration = Duration::from_millis(30);

    /// What `workspace::schedule` does: request, and start the driver only when nothing runs.
    fn schedule(
        gate: &Arc<RefreshGate<&'static str>>,
        reads: &Arc<AtomicU32>,
        read_ms: u64,
    ) -> Request {
        let request = gate.request(&"a/deps");
        if request.start {
            let (gate, reads) = (gate.clone(), reads.clone());
            tauri::async_runtime::spawn(async move {
                run_until_idle(&gate, &"a/deps", DEBOUNCE, || {
                    let reads = reads.clone();
                    async move {
                        reads.fetch_add(1, Ordering::SeqCst);
                        tokio::time::sleep(Duration::from_millis(read_ms)).await;
                    }
                })
                .await;
            });
        }
        request
    }

    async fn wait(mut request: Request) {
        let number = request.number;
        let _ = request.done.wait_for(|done| *done >= number).await;
    }

    #[test]
    fn a_package_install_burst_from_two_windows_is_one_scan() {
        tauri::async_runtime::block_on(async {
            let gate = Arc::new(RefreshGate::default());
            let reads = Arc::new(AtomicU32::new(0));
            // Window A's and window B's watchers report the same `npm install`, many times each.
            let requests: Vec<Request> = (0..200).map(|_| schedule(&gate, &reads, 5)).collect();
            for request in requests {
                wait(request).await;
            }
            assert_eq!(reads.load(Ordering::SeqCst), 1);
        });
    }

    #[test]
    fn a_change_during_a_scan_gets_exactly_one_more_scan() {
        tauri::async_runtime::block_on(async {
            let gate = Arc::new(RefreshGate::default());
            let reads = Arc::new(AtomicU32::new(0));
            let first = schedule(&gate, &reads, 80);
            tokio::time::sleep(DEBOUNCE + Duration::from_millis(20)).await; // the scan is running now
            let late: Vec<Request> = (0..50).map(|_| schedule(&gate, &reads, 80)).collect();
            wait(first).await;
            for request in late {
                wait(request).await;
            }
            assert_eq!(reads.load(Ordering::SeqCst), 2);
        });
    }
}
