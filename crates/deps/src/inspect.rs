//! The workspace's dependency snapshot: the language crate finds the project folders (the folder and two levels
//! below, never inside `node_modules`, `.git`, `target`, `vendor`, environments or build output — see
//! `openmind_language::project::detect_projects`), then each folder's manifests are read.

use std::path::Path;

use openmind_language::tools::Os;

use crate::model::{DepsSnapshot, ProjectDeps, SetupHint, SetupKind};
use crate::{node, others, python};

/// Reads `root`. `portable_python` is OpenMind's portable Python folder (where Python packages go when a project has
/// no environment), shown for projects without one.
pub fn inspect(root: &Path, portable_python: Option<&Path>) -> DepsSnapshot {
    let mut folders: Vec<(String, String)> =
        openmind_language::project::detect_projects(root, Os::current())
            .into_iter()
            .map(|project| (project.root, project.name))
            .collect();
    // The workspace itself is always looked at (a bare requirements.txt is a project too).
    if !folders.iter().any(|(relative, _)| relative.is_empty()) {
        let name = root.file_name().map_or_else(
            || "workspace".to_string(),
            |n| n.to_string_lossy().into_owned(),
        );
        folders.insert(0, (String::new(), name));
    }
    let projects = folders
        .into_iter()
        .filter_map(|(relative, name)| {
            let path = if relative.is_empty() {
                root.to_path_buf()
            } else {
                relative
                    .split('/')
                    .fold(root.to_path_buf(), |p, part| p.join(part))
            };
            project(&path, relative, name, portable_python)
        })
        .collect();
    DepsSnapshot { projects }
}

/// One folder's dependencies, or `None` when it has no ecosystem the view manages.
pub fn project(
    path: &Path,
    root: String,
    name: String,
    portable_python: Option<&Path>,
) -> Option<ProjectDeps> {
    let mut deps = ProjectDeps {
        root,
        name,
        path: path.to_string_lossy().into_owned(),
        python: python::read(path, portable_python),
        node: node::read(path),
        php: others::read_php(path),
        rust: others::read_rust(path),
        java: others::read_java(path),
        cmake: others::read_cmake(path),
        setup: Vec::new(),
    };
    if deps.python.is_none()
        && deps.node.is_none()
        && deps.php.is_none()
        && deps.rust.is_none()
        && deps.java.is_none()
        && deps.cmake.is_none()
    {
        return None;
    }
    deps.setup = setup_hints(&deps);
    Some(deps)
}

fn setup_hints(deps: &ProjectDeps) -> Vec<SetupHint> {
    let mut hints = Vec::new();
    if let Some(python) = &deps.python {
        let declares = python.manifests.iter().any(|m| m != "setup.cfg");
        if declares && python.environments.is_empty() {
            hints.push(SetupHint {
                kind: SetupKind::PythonNoEnv,
            });
        }
    }
    if let Some(node) = &deps.node {
        if !node.node_modules && !(node.dependencies.is_empty() && node.dev_dependencies.is_empty())
        {
            hints.push(SetupHint {
                kind: SetupKind::NodeNotInstalled,
            });
        }
    }
    if let Some(php) = &deps.php {
        if !php.vendor && !(php.require.is_empty() && php.require_dev.is_empty()) {
            hints.push(SetupHint {
                kind: SetupKind::ComposerNotInstalled,
            });
        }
    }
    hints
}
