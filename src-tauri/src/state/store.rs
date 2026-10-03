//! The canonical state owner: one revision counter and the latest state of each slot — a global domain, or a
//! per-workspace domain of one open folder. Pure (no Tauri, no I/O): callers read a slot *outside* the lock, then
//! [`StateStore::apply`] compares and replaces it in one short critical section. A change bumps the revision by exactly
//! one and queues exactly one [`StateDelta`] — queued while the lock is held, so deltas leave in revision order — on an
//! unbounded channel that a publisher drains (sending never blocks). Global and scoped slots share the one revision.
//! Nothing here is held across an `.await`.

use std::collections::{BTreeMap, BTreeSet, HashMap};
use std::sync::mpsc::Sender;
use std::sync::{Mutex, MutexGuard};

use serde_json::Value;

use super::domain::{Domain, DomainEntry, PackagesState, StateDelta, StateSnapshot};
use super::scope::WorkspaceKey;

/// A domain, and for a per-workspace domain the folder it belongs to.
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Hash)]
struct Slot {
    domain: Domain,
    scope: Option<WorkspaceKey>,
}

/// A read of one slot that started at some point. Reads can finish out of order (two refreshes racing); a read that
/// started before one that was already applied is stale and dropped, so an older read never overwrites a newer one.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Ticket {
    slot: Slot,
    seq: u64,
}

/// What [`StateStore::apply`] did.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Applied {
    /// The slot changed; this is the new revision (one delta was queued).
    Changed(u64),
    /// The read found the same state: no revision, no delta.
    Unchanged,
    /// A newer read was applied already, or the folder was closed meanwhile: this one was dropped.
    Stale,
}

#[derive(Default)]
struct Inner {
    revision: u64,
    slots: BTreeMap<Slot, Value>,
    issued: HashMap<Slot, u64>,
    applied: HashMap<Slot, u64>,
    /// Folders no window has open: a read for them that finishes late is dropped instead of bringing them back.
    closed: BTreeSet<WorkspaceKey>,
    out: Option<Sender<StateDelta>>,
}

#[derive(Default)]
pub struct StateStore {
    inner: Mutex<Inner>,
}

impl StateStore {
    /// A store whose deltas go to `out` (none: nothing is published, e.g. in tests or after shutdown).
    pub fn new(out: Option<Sender<StateDelta>>) -> Self {
        Self {
            inner: Mutex::new(Inner {
                out,
                ..Inner::default()
            }),
        }
    }

    // A poisoned lock only means another thread panicked mid-update of plain data; the data is still usable.
    fn lock(&self) -> MutexGuard<'_, Inner> {
        self.inner
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    fn issue(&self, slot: Slot) -> Ticket {
        let mut inner = self.lock();
        let seq = inner.issued.entry(slot.clone()).or_insert(0);
        *seq += 1;
        Ticket { slot, seq: *seq }
    }

    /// Call before reading a global `domain`; pass the ticket to [`StateStore::apply`] with what was read.
    pub fn ticket(&self, domain: Domain) -> Ticket {
        self.issue(Slot {
            domain,
            scope: None,
        })
    }

    /// Call before reading a per-workspace `domain` of the folder `scope`.
    pub fn ticket_in(&self, domain: Domain, scope: &WorkspaceKey) -> Ticket {
        self.issue(Slot {
            domain,
            scope: Some(scope.clone()),
        })
    }

    /// Replaces the ticket's slot with `value` when it is the newest read and differs from what is stored.
    pub fn apply(&self, ticket: Ticket, value: Value) -> Applied {
        let mut inner = self.lock();
        if let Some(scope) = &ticket.slot.scope {
            if inner.closed.contains(scope) {
                return Applied::Stale;
            }
        }
        if inner
            .applied
            .get(&ticket.slot)
            .is_some_and(|seq| *seq > ticket.seq)
        {
            return Applied::Stale;
        }
        inner.applied.insert(ticket.slot.clone(), ticket.seq);
        if inner.slots.get(&ticket.slot) == Some(&value) {
            return Applied::Unchanged;
        }
        Self::change(&mut inner, ticket.slot, value, false)
    }

    /// Packages changed somewhere: the marker's generation rises (always a change).
    pub fn bump_packages(&self) -> u64 {
        let mut inner = self.lock();
        let slot = Slot {
            domain: Domain::Packages,
            scope: None,
        };
        let current: PackagesState = inner
            .slots
            .get(&slot)
            .and_then(|value| serde_json::from_value(value.clone()).ok())
            .unwrap_or_default();
        let next = PackagesState {
            generation: current.generation + 1,
        };
        let value = serde_json::to_value(next).unwrap_or(Value::Null);
        match Self::change(&mut inner, slot, value, false) {
            Applied::Changed(revision) => revision,
            _ => inner.revision,
        }
    }

    /// A window opened `scope`: its state may be read and kept again.
    pub fn open_scope(&self, scope: &WorkspaceKey) {
        self.lock().closed.remove(scope);
    }

    /// No window has `scope` open any more: every slot of it is removed (one removal delta each) and reads still in
    /// flight for it are dropped when they finish. Returns how many slots were removed.
    pub fn close_scope(&self, scope: &WorkspaceKey) -> usize {
        let mut inner = self.lock();
        inner.closed.insert(scope.clone());
        // Every read issued so far for this folder is now stale, even if the folder is opened again before it ends:
        // a read from before the close must not bring the old state back into the reopened scope.
        let issued: Vec<(Slot, u64)> = inner
            .issued
            .iter()
            .filter(|(slot, _)| slot.scope.as_ref() == Some(scope))
            .map(|(slot, seq)| (slot.clone(), *seq + 1))
            .collect();
        inner.applied.extend(issued);
        let gone: Vec<Slot> = inner
            .slots
            .keys()
            .filter(|slot| slot.scope.as_ref() == Some(scope))
            .cloned()
            .collect();
        for slot in &gone {
            Self::change(&mut inner, slot.clone(), Value::Null, true);
        }
        gone.len()
    }

    fn change(inner: &mut Inner, slot: Slot, value: Value, removed: bool) -> Applied {
        inner.revision += 1;
        let revision = inner.revision;
        if removed {
            inner.slots.remove(&slot);
        } else {
            inner.slots.insert(slot.clone(), value.clone());
        }
        if let Some(out) = &inner.out {
            let delta = StateDelta {
                revision,
                domain: slot.domain,
                scope: slot.scope.map(|key| key.as_str().to_string()),
                data: value,
                removed,
                tick: false,
            };
            if out.send(delta).is_err() {
                // The publisher is gone (shutting down): later changes are kept but not sent.
                inner.out = None;
            }
        }
        Applied::Changed(revision)
    }

    /// Which of the global `domains` have no state yet.
    pub fn missing(&self, domains: &[Domain]) -> Vec<Domain> {
        let inner = self.lock();
        domains
            .iter()
            .copied()
            .filter(|domain| {
                !inner.slots.contains_key(&Slot {
                    domain: *domain,
                    scope: None,
                })
            })
            .collect()
    }

    pub fn revision(&self) -> u64 {
        self.lock().revision
    }

    /// The global domains (taken under one lock: consistent).
    pub fn snapshot(&self) -> StateSnapshot {
        self.snapshot_for(None)
    }

    /// The global domains and `workspace`'s own domains — never another folder's — with their revision.
    pub fn snapshot_for(&self, workspace: Option<&WorkspaceKey>) -> StateSnapshot {
        let inner = self.lock();
        StateSnapshot {
            revision: inner.revision,
            workspace: workspace.map(|key| key.as_str().to_string()),
            domains: inner
                .slots
                .iter()
                .filter(|(slot, _)| slot.scope.is_none() || slot.scope.as_ref() == workspace)
                .map(|(slot, data)| DomainEntry {
                    domain: slot.domain,
                    scope: slot.scope.as_ref().map(|key| key.as_str().to_string()),
                    data: data.clone(),
                })
                .collect(),
        }
    }

    /// Stops publishing (shutdown): the publisher's channel closes and its thread ends.
    pub fn close(&self) {
        self.lock().out = None;
    }
}

#[cfg(test)]
#[path = "store_tests.rs"]
mod tests;
