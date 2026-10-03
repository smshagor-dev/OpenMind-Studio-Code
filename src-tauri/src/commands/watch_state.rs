//! What a project watcher's changes mean for that folder's canonical state (`crate::state`). One window's watcher or
//! two windows' watchers on the same folder lead to the same requests, which the folder's refresh gate merges into one
//! read per burst.
//!
//! - Any file change can change `git status` (Git).
//! - A manifest (package.json, pyproject.toml, Cargo.toml ...) changes the projects, their commands and their
//!   dependencies (Project + Dependencies).
//! - Installed packages (`node_modules`, `.venv`, `venv`, `vendor`) change the dependencies, the project-local tools and
//!   `git status` (they are untracked files unless the repository ignores them).
//! - `.git` (HEAD, index, refs ...) changes the repository state — a commit, checkout or stage, also from a terminal.

use std::path::Path;

use openmind_file_watch::{ChangeBatch, SyncTopic};
use tauri::{AppHandle, Manager};

use crate::state::Domain;

/// File names whose change changes what a folder's projects are, how they run and what they depend on.
const MANIFESTS: &[&str] = &[
    "package.json",
    "package-lock.json",
    "pnpm-lock.yaml",
    "yarn.lock",
    "bun.lockb",
    "requirements.txt",
    "pyproject.toml",
    "setup.py",
    "setup.cfg",
    "pipfile",
    "pipfile.lock",
    "poetry.lock",
    "composer.json",
    "composer.lock",
    "cargo.toml",
    "cargo.lock",
    "go.mod",
    "go.sum",
    "pom.xml",
    "build.gradle",
    "build.gradle.kts",
    "settings.gradle",
    "settings.gradle.kts",
    "cmakelists.txt",
    "cmakepresets.json",
    "pubspec.yaml",
    "gemfile",
    "manage.py",
    "artisan",
    "tsconfig.json",
    "dockerfile",
    "pyvenv.cfg",
];

fn is_manifest(path: &str) -> bool {
    let name = Path::new(path)
        .file_name()
        .map(|name| name.to_string_lossy().to_ascii_lowercase())
        .unwrap_or_default();
    MANIFESTS.contains(&name.as_str())
        || name.ends_with(".csproj")
        || name.ends_with(".sln")
        || name.starts_with("docker-compose")
}

/// The folder domains a batch of ordinary file changes affects.
pub fn domains_for_batch(batch: &ChangeBatch) -> &'static [Domain] {
    let manifest = batch.overflow
        || batch.changes.iter().any(|change| {
            is_manifest(&change.path) || change.from.as_deref().is_some_and(is_manifest)
        });
    if manifest {
        &[Domain::Git, Domain::Project, Domain::Dependencies]
    } else if batch.changes.is_empty() {
        &[]
    } else {
        &[Domain::Git]
    }
}

pub fn files_changed(app: &AppHandle, root: &Path, batch: &ChangeBatch) {
    schedule(app, root, domains_for_batch(batch));
}

/// Schedules `domains` of the folder; Git only while `git.autoRefresh` (user or workspace setting) is on — with it off,
/// Source Control refreshes after OpenMind's own Git operations and on Refresh, as the setting promises.
fn schedule(app: &AppHandle, root: &Path, domains: &[Domain]) {
    let auto_git = app
        .try_state::<crate::app_state::AppState>()
        .is_none_or(|state| {
            crate::commands::preferences::folder_bool(&state, root, "git.autoRefresh")
        });
    let wanted: Vec<Domain> = domains
        .iter()
        .copied()
        .filter(|domain| auto_git || *domain != Domain::Git)
        .collect();
    if !wanted.is_empty() {
        crate::state::schedule_root(app, root, &wanted);
    }
}

/// The folder domains a project watcher's topic affects.
pub fn domains_for_topic(topic: SyncTopic) -> &'static [Domain] {
    match topic {
        SyncTopic::Packages => &[Domain::Dependencies, Domain::Project, Domain::Git],
        SyncTopic::Git => &[Domain::Git],
        _ => &[],
    }
}

pub fn project_topic(app: &AppHandle, root: &Path, topic: SyncTopic) {
    schedule(app, root, domains_for_topic(topic));
}

#[cfg(test)]
mod tests {
    use super::*;
    use openmind_file_watch::{ChangeKind, FileChange};

    fn batch(paths: &[&str]) -> ChangeBatch {
        ChangeBatch {
            changes: paths
                .iter()
                .map(|path| FileChange {
                    path: (*path).to_string(),
                    kind: ChangeKind::Modified,
                    from: None,
                })
                .collect(),
            overflow: false,
        }
    }

    #[test]
    fn an_edit_refreshes_git_and_a_manifest_also_refreshes_the_projects_and_dependencies() {
        assert_eq!(
            domains_for_batch(&batch(&["C:/w/src/app.ts"])),
            &[Domain::Git]
        );
        let manifest = domains_for_batch(&batch(&["C:/w/src/app.ts", "C:/w/web/Package.json"]));
        assert_eq!(
            manifest,
            &[Domain::Git, Domain::Project, Domain::Dependencies]
        );
        assert!(domains_for_batch(&batch(&["C:/w/My.csproj"])).contains(&Domain::Project));
        assert!(domains_for_batch(&batch(&[])).is_empty());
        let overflow = ChangeBatch {
            changes: Vec::new(),
            overflow: true,
        };
        assert_eq!(domains_for_batch(&overflow).len(), 3);
    }

    #[test]
    fn packages_and_git_topics_go_to_their_domains_only() {
        assert_eq!(
            domains_for_topic(SyncTopic::Packages),
            &[Domain::Dependencies, Domain::Project, Domain::Git]
        );
        assert_eq!(domains_for_topic(SyncTopic::Git), &[Domain::Git]);
        assert!(domains_for_topic(SyncTopic::Runtimes).is_empty());
    }
}
