//! The canonical state's domains and its two wire formats: a full [`StateSnapshot`] and one-domain [`StateDelta`]s.
//! Every domain's data is the same typed structure the domain's own command already returns, serialized once;
//! `src/services/state/canonicalIpc.ts` mirrors it.
//!
//! Scope: a domain is either **global** (one value for the whole app, shared by every window) or **per workspace**
//! (one value per open folder, keyed by [`super::scope::WorkspaceKey`], shared by the windows that have that folder
//! open and never seen by the others). Global deltas look exactly as before scopes existed (no `scope` field).

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::sync::Topic;

/// One part of the canonical state.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Domain {
    /// Global. `Vec<openmind_runtime_manager::RuntimeStatus>` (what `runtime_list` returns).
    Runtimes,
    /// Global. `openmind_toolchains::Packs` (what `toolchains_list` returns).
    Tools,
    /// Global. `commands::lsp::LspSnapshot` (what `lsp_status` returns).
    LanguageServers,
    /// Global. `commands::extensions::ExtensionsSnapshot` (what `ext_list` returns).
    Extensions,
    /// Global. [`PackagesState`]: packages changed in a runtime or through an OpenMind install (a project's own
    /// packages are its `Dependencies`).
    Packages,
    /// Global. `servers::ServersState`: OpenMind's managed servers (PHP, MariaDB, phpMyAdmin) — app-wide, like
    /// XAMPP's, not tied to a folder — with their ports.
    Servers,
    /// Global. `commands::collab::CollabSnapshot`: the collaboration rooms this machine created or joined, with their
    /// members (presence, cursors and voice levels are event streams, never canonical state).
    Collaboration,
    /// Per workspace. `commands::git::GitSnapshot` (what `git_snapshot` returns for that folder).
    Git,
    /// Per workspace. `openmind_deps::DepsSnapshot` (what `deps_scan` returns for that folder).
    Dependencies,
    /// Per workspace. `openmind_language::WorkspaceStatus` (what `language_workspace_status` returns).
    Project,
    /// Per workspace. `commands::debug::DebugReadiness`: which debuggers can start for that folder.
    Debug,
}

impl Domain {
    pub fn is_workspace_scoped(self) -> bool {
        matches!(
            self,
            Domain::Git | Domain::Dependencies | Domain::Project | Domain::Debug
        )
    }
}

/// Every per-workspace domain, read when a folder is first opened by some window.
pub const WORKSPACE_DOMAINS: [Domain; 4] = [
    Domain::Git,
    Domain::Dependencies,
    Domain::Project,
    Domain::Debug,
];

/// A counter that rises once per package change in a runtime or an OpenMind package install.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PackagesState {
    pub generation: u64,
}

fn is_false(value: &bool) -> bool {
    !*value
}

/// One domain's new state at `revision` (the revision right after this change).
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StateDelta {
    pub revision: u64,
    pub domain: Domain,
    /// The workspace key of a per-workspace domain; absent for a global one.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub scope: Option<String>,
    /// The new state (`null` when `removed` or `tick`).
    pub data: Value,
    /// The workspace's state of this domain is gone (no window has the folder open any more).
    #[serde(skip_serializing_if = "is_false")]
    pub removed: bool,
    /// Sent instead of the data to a window that doesn't have this workspace open: only the revision moves on, so
    /// every window still sees every revision (gap detection keeps working) without other folders' data.
    #[serde(skip_serializing_if = "is_false")]
    pub tick: bool,
}

impl StateDelta {
    /// The same revision without its data, for a window that doesn't show this workspace.
    pub fn tick(&self) -> StateDelta {
        StateDelta {
            revision: self.revision,
            domain: self.domain,
            scope: self.scope.clone(),
            data: Value::Null,
            removed: false,
            tick: true,
        }
    }
}

/// One domain inside a snapshot.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DomainEntry {
    pub domain: Domain,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub scope: Option<String>,
    pub data: Value,
}

/// Everything a window needs at `revision`: every global domain read so far and its own workspace's domains.
/// A domain that hasn't been read yet (start-up, a folder just opened) is absent, not empty.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StateSnapshot {
    pub revision: u64,
    /// The workspace this snapshot's scoped domains belong to (the window's open folder), if any.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub workspace: Option<String>,
    pub domains: Vec<DomainEntry>,
}

/// Which global domains a live-sync topic changes. A runtime change also changes what the language servers can run
/// on; a package change can change a runtime's reported features (the bundled packages).
pub fn domains_for(topic: Topic) -> &'static [Domain] {
    match topic {
        // MySQL reports which runtimes it is missing (MariaDB, phpMyAdmin, PHP).
        Topic::Runtimes => &[Domain::Runtimes, Domain::LanguageServers, Domain::Servers],
        Topic::Tools => &[Domain::Tools],
        Topic::LanguageServers => &[Domain::LanguageServers],
        Topic::Extensions => &[Domain::Extensions],
        Topic::Packages => &[Domain::Packages, Domain::Runtimes],
        // A project's own `.git` changed: per workspace only (see `workspace_domains_for`).
        Topic::Git => &[],
    }
}

/// Which per-workspace domains a global change makes every open workspace read again: what can run, format, debug or
/// be installed depends on the runtimes and tools (Git's own availability too); packages change the project's tools.
pub fn workspace_domains_for(topic: Topic) -> &'static [Domain] {
    match topic {
        Topic::Runtimes | Topic::Tools => &WORKSPACE_DOMAINS,
        Topic::LanguageServers => &[Domain::Project],
        Topic::Packages => &[Domain::Dependencies, Domain::Project],
        Topic::Extensions => &[],
        Topic::Git => &[Domain::Git],
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_global_delta_has_the_shape_it_had_before_scopes() {
        let delta = StateDelta {
            revision: 121,
            domain: Domain::LanguageServers,
            scope: None,
            data: serde_json::json!({ "servers": [] }),
            removed: false,
            tick: false,
        };
        assert_eq!(
            serde_json::to_string(&delta).unwrap_or_default(),
            r#"{"revision":121,"domain":"languageServers","data":{"servers":[]}}"#
        );
    }

    #[test]
    fn scoped_deltas_ticks_removals_and_snapshots_carry_their_workspace() {
        let delta = StateDelta {
            revision: 7,
            domain: Domain::Git,
            scope: Some("c:/projects/app".into()),
            data: serde_json::json!({ "state": "repository" }),
            removed: false,
            tick: false,
        };
        assert_eq!(
            serde_json::to_string(&delta.tick()).unwrap_or_default(),
            r#"{"revision":7,"domain":"git","scope":"c:/projects/app","data":null,"tick":true}"#
        );
        let gone = StateDelta {
            data: Value::Null,
            removed: true,
            ..delta
        };
        assert_eq!(
            serde_json::to_string(&gone).unwrap_or_default(),
            r#"{"revision":7,"domain":"git","scope":"c:/projects/app","data":null,"removed":true}"#
        );
        let snapshot = StateSnapshot {
            revision: 3,
            workspace: Some("c:/projects/app".into()),
            domains: vec![DomainEntry {
                domain: Domain::Packages,
                scope: None,
                data: serde_json::to_value(PackagesState { generation: 2 }).unwrap_or_default(),
            }],
        };
        assert_eq!(
            serde_json::to_string(&snapshot).unwrap_or_default(),
            r#"{"revision":3,"workspace":"c:/projects/app","domains":[{"domain":"packages","data":{"generation":2}}]}"#
        );
    }

    #[test]
    fn scoped_and_global_domains_are_told_apart() {
        for domain in WORKSPACE_DOMAINS {
            assert!(domain.is_workspace_scoped(), "{domain:?}");
        }
        for domain in [
            Domain::Runtimes,
            Domain::Tools,
            Domain::LanguageServers,
            Domain::Extensions,
            Domain::Packages,
            Domain::Servers,
            Domain::Collaboration,
        ] {
            assert!(!domain.is_workspace_scoped(), "{domain:?}");
        }
    }

    #[test]
    fn every_topic_changes_at_least_its_own_domain() {
        assert_eq!(domains_for(Topic::Runtimes)[0], Domain::Runtimes);
        assert_eq!(domains_for(Topic::Tools), &[Domain::Tools]);
        assert_eq!(
            domains_for(Topic::LanguageServers),
            &[Domain::LanguageServers]
        );
        assert_eq!(domains_for(Topic::Extensions), &[Domain::Extensions]);
        assert_eq!(domains_for(Topic::Packages)[0], Domain::Packages);
        assert_eq!(workspace_domains_for(Topic::Git), &[Domain::Git]);
        assert!(workspace_domains_for(Topic::Extensions).is_empty());
    }
}
