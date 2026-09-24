use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

/// The searches currently running, by id, so the UI can cancel one. Starting a
/// search under an id that is still running cancels the older one first: the
/// user typed again, the previous answer no longer matters.
#[derive(Default)]
pub struct SearchRegistry {
    running: Mutex<HashMap<String, Arc<AtomicBool>>>,
}

impl SearchRegistry {
    pub fn new() -> Self {
        Self::default()
    }

    /// Registers `id` and returns its cancel flag.
    pub fn begin(&self, id: &str) -> Arc<AtomicBool> {
        let flag = Arc::new(AtomicBool::new(false));
        if let Ok(mut running) = self.running.lock() {
            if let Some(previous) = running.insert(id.to_string(), flag.clone()) {
                previous.store(true, Ordering::Relaxed);
            }
        }
        flag
    }

    /// Cancels `id`; `false` if nothing by that id is running.
    pub fn cancel(&self, id: &str) -> bool {
        let Ok(running) = self.running.lock() else {
            return false;
        };
        running.get(id).is_some_and(|flag| {
            flag.store(true, Ordering::Relaxed);
            true
        })
    }

    /// Forgets `id` once it finished — but only if it is still *this* run
    /// (a newer search under the same id must not be unregistered).
    pub fn finish(&self, id: &str, flag: &Arc<AtomicBool>) {
        if let Ok(mut running) = self.running.lock() {
            if running
                .get(id)
                .is_some_and(|current| Arc::ptr_eq(current, flag))
            {
                running.remove(id);
            }
        }
    }

    pub fn cancel_all(&self) {
        if let Ok(running) = self.running.lock() {
            for flag in running.values() {
                flag.store(true, Ordering::Relaxed);
            }
        }
    }

    pub fn running_count(&self) -> usize {
        self.running.lock().map_or(0, |running| running.len())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cancel_flags_the_running_search_and_unknown_ids_are_reported() {
        let registry = SearchRegistry::new();
        let flag = registry.begin("a");

        assert!(registry.cancel("a"));
        assert!(flag.load(Ordering::Relaxed));
        assert!(!registry.cancel("nope"));
    }

    #[test]
    fn a_newer_search_with_the_same_id_cancels_the_older_one() {
        let registry = SearchRegistry::new();
        let old = registry.begin("a");

        let new = registry.begin("a");

        assert!(old.load(Ordering::Relaxed));
        assert!(!new.load(Ordering::Relaxed));
        // The old run finishing must not unregister the new one.
        registry.finish("a", &old);
        assert_eq!(registry.running_count(), 1);
        registry.finish("a", &new);
        assert_eq!(registry.running_count(), 0);
    }

    #[test]
    fn cancel_all_stops_every_search() {
        let registry = SearchRegistry::new();
        let a = registry.begin("a");
        let b = registry.begin("b");

        registry.cancel_all();

        assert!(a.load(Ordering::Relaxed) && b.load(Ordering::Relaxed));
    }
}
