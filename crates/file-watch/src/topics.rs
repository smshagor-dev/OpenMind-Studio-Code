//! Which live-sync topic a changed path belongs to. Pure: names only, apart from one cached look at a `pyvenv.cfg`
//! for folders whose name alone doesn't say they are a Python environment.

use std::collections::HashMap;
use std::path::{Component, Path, PathBuf};

use serde::{Deserialize, Serialize};

/// What kind of installed thing changed (routed into the app's canonical state by `sync.rs`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum SyncTopic {
    /// Portable runtimes (Runtime Manager): installed, removed, repaired, switched, add-ons.
    Runtimes,
    /// Language Tools tool packages and bundled toolchains: installed, removed, active version chosen.
    Tools,
    /// Language servers: installed, unpacked from the bundle, removed.
    LanguageServers,
    /// Extensions: installed, enabled, disabled, uninstalled.
    Extensions,
    /// Packages inside a runtime or a project (pip, npm, Composer ...).
    Packages,
    /// A project's repository state changed in `.git` (a commit, checkout, stage, fetch — also from a terminal). Only
    /// a project's own watcher reports it, for that workspace; it only refreshes that folder's Git state.
    Git,
}

/// The app folders whose changes are announced, and their topics.
pub const APP_FOLDERS: &[(&str, SyncTopic)] = &[
    ("runtimes", SyncTopic::Runtimes),
    ("tools", SyncTopic::Tools),
    ("language-servers", SyncTopic::LanguageServers),
    ("extensions", SyncTopic::Extensions),
];

/// Inside `extensions/`, only these hold extensions; `storage/`, `logs/` and `cache/` change while extensions run.
const EXTENSION_FOLDERS: &[&str] = &["installed", "disabled"];

/// Names that change while programs merely run, never because something was installed: Python's byte-code caches,
/// build/dev-server caches kept inside `node_modules`, and partial downloads. Matched against every path component.
const NOISE: &[&str] = &[
    "__pycache__",
    ".cache",
    ".vite",
    ".vite-temp",
    ".parcel-cache",
    ".angular",
    ".turbo",
    ".eslintcache",
];

/// Folders inside a runtime that hold packages installed into it (`pip install` into the portable Python, `npm i -g`
/// with the portable Node): such a change is `Packages`, not a different runtime.
const RUNTIME_PACKAGE_FOLDERS: &[&str] = &["site-packages", "node_modules"];

/// Folders inside a project that hold its installed packages.
const PROJECT_PACKAGE_FOLDERS: &[&str] = &["node_modules", ".venv", "venv", "vendor"];

/// The entries of `.git` whose change means the repository's state changed. `objects/` (every blob written), `logs/`,
/// hooks and `*.lock` files (`index.lock` is renamed to `index`, which counts) are churn and ignored.
const GIT_STATE: &[&str] = &[
    "head",
    "index",
    "refs",
    "packed-refs",
    "merge_head",
    "cherry_pick_head",
    "revert_head",
    "rebase-merge",
    "rebase-apply",
    "fetch_head",
];

/// Folders that are a Python environment only when they hold a `pyvenv.cfg` (`env` is often ordinary source).
const MAYBE_ENVIRONMENTS: &[&str] = &["env", ".env"];

fn name_of(component: Component<'_>) -> Option<String> {
    match component {
        Component::Normal(name) => Some(name.to_string_lossy().to_ascii_lowercase()),
        _ => None,
    }
}

/// A change that says nothing about what is installed (a cache, byte code, a partial download, or an install's
/// staging folder — `<version>.installing`, `.installing`, `.unpacking` — whose rename into place is the real change).
pub fn is_noise(relative: &Path) -> bool {
    relative.components().filter_map(name_of).any(|name| {
        NOISE.contains(&name.as_str())
            || name.ends_with(".pyc")
            || name.ends_with(".pyo")
            || name.ends_with(".part")
            || name.ends_with(".tmp")
            || name.ends_with(".installing")
            || name.ends_with(".unpacking")
    })
}

/// A folder reported as "modified" only had its timestamp changed because something inside it changed — that change
/// is reported on its own (and may be noise such as a new `__pycache__`), so the folder's own event says nothing.
/// Only "modified" events of paths that would count are checked, so a burst costs one look per such path.
pub fn is_folder_timestamp(kind: &notify::EventKind, path: &Path) -> bool {
    use notify::event::ModifyKind;
    matches!(kind, notify::EventKind::Modify(modify) if !matches!(modify, ModifyKind::Name(_)))
        && path.is_dir()
}

/// The topic of a change at `path` under the app folder `root` (`runtimes/...`, `tools/...` ...), or `None`.
/// A change of the managed folder itself (created, removed, renamed) counts too.
pub fn classify_app(root: &Path, path: &Path) -> Option<SyncTopic> {
    let relative = path.strip_prefix(root).ok()?;
    if is_noise(relative) {
        return None;
    }
    let mut names = relative.components().filter_map(name_of);
    let first = names.next()?;
    if first == "runtimes"
        && relative
            .components()
            .filter_map(name_of)
            .any(|name| RUNTIME_PACKAGE_FOLDERS.contains(&name.as_str()))
    {
        return Some(SyncTopic::Packages);
    }
    let topic = APP_FOLDERS
        .iter()
        .find(|(folder, _)| *folder == first)
        .map(|(_, topic)| *topic)?;
    if topic == SyncTopic::Extensions {
        // `extensions` itself appearing or going counts; below it only installed/ and disabled/ do.
        if let Some(second) = names.next() {
            if !EXTENSION_FOLDERS.contains(&second.as_str()) {
                return None;
            }
        }
    }
    Some(topic)
}

/// Remembers which `env`-like folders are Python environments, so a burst of events asks the disk once per folder.
#[derive(Debug, Default)]
pub struct EnvironmentCache {
    known: HashMap<PathBuf, bool>,
}

impl EnvironmentCache {
    fn is_environment(&mut self, folder: &Path) -> bool {
        if let Some(known) = self.known.get(folder) {
            return *known;
        }
        let found = folder.join("pyvenv.cfg").is_file();
        // A folder that isn't one yet may become one (`python -m venv env`): only a positive answer is kept.
        if found {
            self.known.insert(folder.to_path_buf(), true);
        }
        found
    }
}

/// The topic of a change at `path` inside the open project `root`: its installed packages (`node_modules`, `.venv`,
/// `venv`, Composer's `vendor`, an `env` folder with a `pyvenv.cfg`) at any depth, or `None` for everything else
/// (ordinary files are the Explorer's business, not the live-sync channel's).
pub fn classify_project(
    root: &Path,
    path: &Path,
    environments: &mut EnvironmentCache,
) -> Option<SyncTopic> {
    let relative = path.strip_prefix(root).ok()?;
    if is_noise(relative) {
        return None;
    }
    let mut names = relative.components().filter_map(name_of);
    if names.next().as_deref() == Some(".git") {
        let entry = names.next()?;
        let lock = relative.file_name().is_some_and(|name| {
            name.to_string_lossy()
                .to_ascii_lowercase()
                .ends_with(".lock")
        });
        return (GIT_STATE.contains(&entry.as_str()) && !lock).then_some(SyncTopic::Git);
    }
    let mut folder = root.to_path_buf();
    let components: Vec<Component<'_>> = relative.components().collect();
    for (index, component) in components.iter().enumerate() {
        let name = name_of(*component)?;
        folder.push(component.as_os_str());
        if PROJECT_PACKAGE_FOLDERS.contains(&name.as_str()) {
            return Some(SyncTopic::Packages);
        }
        // `.env` the file (dotenv) is not an environment: there has to be something below the folder, or the folder
        // itself appearing with its `pyvenv.cfg`.
        let below = index + 1 < components.len();
        if MAYBE_ENVIRONMENTS.contains(&name.as_str())
            && (below || folder.is_dir())
            && environments.is_environment(&folder)
        {
            return Some(SyncTopic::Packages);
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    fn app(path: &str) -> Option<SyncTopic> {
        classify_app(Path::new("C:/OpenMind Studio"), Path::new(path))
    }

    #[test]
    fn app_folders_map_to_their_topics() {
        assert_eq!(
            app("C:/OpenMind Studio/runtimes/python/versions/3.14.7/Lib/site-packages/six.py"),
            Some(SyncTopic::Packages)
        );
        assert_eq!(
            app("C:/OpenMind Studio/runtimes/node/versions/24.1.0/node_modules/left-pad/index.js"),
            Some(SyncTopic::Packages)
        );
        assert_eq!(
            app("C:/OpenMind Studio/runtimes/node/versions/24.1.0/node.exe"),
            Some(SyncTopic::Runtimes)
        );
        assert_eq!(
            app("C:/OpenMind Studio/runtimes"),
            Some(SyncTopic::Runtimes)
        );
        assert_eq!(
            app("C:/OpenMind Studio/tools/ruff/0.6.0/ruff.exe"),
            Some(SyncTopic::Tools)
        );
        assert_eq!(
            app("C:/OpenMind Studio/language-servers/pyright/1/x.js"),
            Some(SyncTopic::LanguageServers)
        );
        assert_eq!(
            app("C:/OpenMind Studio/extensions/installed/a.b-1.0.0/package.json"),
            Some(SyncTopic::Extensions)
        );
        assert_eq!(
            app("C:/OpenMind Studio/extensions/disabled/a.b-1.0.0"),
            Some(SyncTopic::Extensions)
        );
        assert_eq!(
            app("C:/OpenMind Studio/extensions"),
            Some(SyncTopic::Extensions)
        );
    }

    #[test]
    fn running_programs_and_other_folders_are_not_installs() {
        for path in [
            "C:/OpenMind Studio/extensions/storage/a.b/global/state.json",
            "C:/OpenMind Studio/extensions/logs/extension-host.log",
            "C:/OpenMind Studio/extensions/cache/host/host.js",
            "C:/OpenMind Studio/runtimes/python/versions/3.14.7/Lib/__pycache__/os.cpython-314.pyc",
            "C:/OpenMind Studio/runtimes/python/versions/3.14.7/Lib/x.pyc",
            "C:/OpenMind Studio/cache/downloads/node.zip.part",
            "C:/OpenMind Studio/runtimes/node/versions/24.21.0.installing/node_modules/npm/package.json",
            "C:/OpenMind Studio/language-servers/pyright/.installing/x.js",
            "C:/OpenMind Studio/language-servers/clangd/.unpacking/bin/clangd.exe",
            "C:/OpenMind Studio/tools/ruff/.installing/ruff.exe",
            "C:/OpenMind Studio/data/openmind-studio.db",
            "C:/OpenMind Studio/logs/openmind.log",
            "C:/OpenMind Studio/runtimesx/a",
            "C:/elsewhere/runtimes/a",
        ] {
            assert_eq!(app(path), None, "{path}");
        }
    }

    #[test]
    fn project_package_folders_are_packages_at_any_depth_and_caches_are_not() {
        let root = Path::new("C:/My Work/site");
        let mut cache = EnvironmentCache::default();
        let mut project = |path: &str| classify_project(root, Path::new(path), &mut cache);
        assert_eq!(
            project("C:/My Work/site/node_modules/left-pad/index.js"),
            Some(SyncTopic::Packages)
        );
        assert_eq!(
            project("C:/My Work/site/web/node_modules"),
            Some(SyncTopic::Packages)
        );
        assert_eq!(
            project("C:/My Work/site/.venv/Lib/site-packages/six.py"),
            Some(SyncTopic::Packages)
        );
        assert_eq!(
            project("C:/My Work/site/venv/pyvenv.cfg"),
            Some(SyncTopic::Packages)
        );
        assert_eq!(
            project("C:/My Work/site/vendor/autoload.php"),
            Some(SyncTopic::Packages)
        );
        assert_eq!(
            project("C:/My Work/site/NODE_MODULES/x"),
            Some(SyncTopic::Packages)
        );
        assert_eq!(
            project("C:/My Work/site/node_modules/.vite/deps/x.js"),
            None
        );
        assert_eq!(project("C:/My Work/site/node_modules/.cache/babel/x"), None);
        assert_eq!(
            project("C:/My Work/site/.venv/Lib/__pycache__/six.cpython-314.pyc"),
            None
        );
        assert_eq!(project("C:/My Work/site/src/app.ts"), None);
        assert_eq!(project("C:/My Work/site/.git/HEAD"), Some(SyncTopic::Git));
        assert_eq!(project("C:/My Work/site/.git/index"), Some(SyncTopic::Git));
        assert_eq!(
            project("C:/My Work/site/.git/refs/heads/main"),
            Some(SyncTopic::Git)
        );
        assert_eq!(project("C:/My Work/site/.git/index.lock"), None);
        assert_eq!(project("C:/My Work/site/.git/objects/ab/cdef"), None);
        assert_eq!(project("C:/My Work/site/.git/logs/HEAD"), None);
        assert_eq!(project("C:/My Work/site/.git"), None);
        assert_eq!(project("C:/My Work/site/package.json"), None);
        assert_eq!(project("C:/elsewhere/node_modules/x"), None);
    }

    #[test]
    fn an_env_folder_counts_only_when_it_is_a_python_environment() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("my site");
        std::fs::create_dir_all(root.join("env").join("Lib")).unwrap();
        std::fs::write(root.join(".env"), "KEY=1").unwrap();
        let mut cache = EnvironmentCache::default();
        let site_packages = root.join("env").join("Lib").join("six.py");
        assert_eq!(classify_project(&root, &site_packages, &mut cache), None);
        assert_eq!(
            classify_project(&root, &root.join(".env"), &mut cache),
            None
        );

        std::fs::write(root.join("env").join("pyvenv.cfg"), "home = C:/Python").unwrap();
        assert_eq!(
            classify_project(&root, &site_packages, &mut cache),
            Some(SyncTopic::Packages)
        );
        assert_eq!(
            classify_project(&root, &root.join("env"), &mut cache),
            Some(SyncTopic::Packages)
        );
    }
}
