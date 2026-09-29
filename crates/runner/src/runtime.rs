use std::ffi::OsStr;
use std::path::{Path, PathBuf};

use serde::Serialize;

use crate::kind::RunnableKind;

/// What the Runtime Manager injects into launched processes: folders in front
/// of PATH (portable runtimes, first) and extra variables (`PYTHONNOUSERSITE`).
/// Plain data, so this crate doesn't depend on the manager.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct RunEnvironment {
    pub path_prepend: Vec<PathBuf>,
    pub vars: Vec<(String, String)>,
}

/// Where an interpreter came from, in priority order.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum RuntimeSource {
    /// One of OpenMind Studio's own portable runtimes (Runtime Manager).
    Portable,
    /// A tool inside the project (`node_modules/.bin`).
    Project,
    /// Whatever is on the system PATH — only when nothing portable provides it.
    System,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ResolvedExecutable {
    pub path: PathBuf,
    pub source: RuntimeSource,
}

/// A program name with no folder part. Only these are ever looked up, so a
/// command template can't point at an arbitrary path on disk.
pub fn is_bare_name(name: &str) -> bool {
    !name.is_empty()
        && !name.contains(['/', '\\', ':'])
        && name != "."
        && name != ".."
        && !name.contains('\0')
}

/// Finds `name`: portable runtime folders first, then project-local folders,
/// and the system PATH last. Nothing is executed.
pub fn resolve_executable(
    name: &str,
    environment: &RunEnvironment,
    project_dirs: &[PathBuf],
    system_path: Option<&OsStr>,
) -> Option<ResolvedExecutable> {
    if !is_bare_name(name) {
        return None;
    }
    let search = |dirs: &[PathBuf], source: RuntimeSource| {
        dirs.iter()
            .find_map(|dir| find_in(dir, name))
            .map(|path| ResolvedExecutable { path, source })
    };
    search(&environment.path_prepend, RuntimeSource::Portable)
        .or_else(|| search(project_dirs, RuntimeSource::Project))
        .or_else(|| {
            let dirs: Vec<PathBuf> = system_path
                .map(|path| std::env::split_paths(path).collect())
                .unwrap_or_default();
            search(&dirs, RuntimeSource::System)
        })
}

fn find_in(dir: &Path, name: &str) -> Option<PathBuf> {
    let extensions: &[&str] = if cfg!(windows) {
        &["exe", "cmd", "bat", "com"]
    } else {
        &[""]
    };
    for extension in extensions {
        let file = if extension.is_empty() {
            dir.join(name)
        } else {
            dir.join(format!("{name}.{extension}"))
        };
        if file.is_file() {
            return Some(file);
        }
    }
    None
}

/// "OpenMind portable Python 3.14.7", "System Python" — what the Output panel
/// shows as the runtime a run used (the resolved path is shown separately).
pub fn runtime_label(kind: RunnableKind, resolved: &ResolvedExecutable) -> String {
    match resolved.source {
        RuntimeSource::Portable => {
            let version = portable_version(&resolved.path);
            match version {
                Some(version) => format!("OpenMind portable {} {version}", kind.display_name()),
                None => format!("OpenMind portable {}", kind.display_name()),
            }
        }
        // `<project>/.venv/Scripts/python.exe` -> "Project environment .venv".
        RuntimeSource::Project if kind == RunnableKind::Python => {
            let env = resolved
                .path
                .parent()
                .and_then(Path::parent)
                .and_then(Path::file_name)
                .map(|name| name.to_string_lossy().into_owned())
                .unwrap_or_default();
            format!("Project environment {env}")
        }
        RuntimeSource::Project => format!("project-local {}", file_stem(&resolved.path)),
        RuntimeSource::System => format!("System {}", kind.display_name()),
    }
}

/// `runtimes/<kind>/versions/<version>/...` -> `<version>` (public: the PHP
/// server remembers which PHP it started with).
pub fn portable_version(path: &Path) -> Option<String> {
    let parts: Vec<_> = path.components().collect();
    let index = parts
        .iter()
        .position(|part| part.as_os_str() == "versions")?;
    Some(
        parts
            .get(index + 1)?
            .as_os_str()
            .to_string_lossy()
            .into_owned(),
    )
}

fn file_stem(path: &Path) -> String {
    path.file_stem()
        .map(|stem| stem.to_string_lossy().into_owned())
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::ffi::OsString;
    use std::fs;

    fn exe_name(name: &str) -> String {
        if cfg!(windows) {
            format!("{name}.exe")
        } else {
            name.to_string()
        }
    }

    fn touch(dir: &Path, name: &str) -> PathBuf {
        fs::create_dir_all(dir).expect("dir");
        let path = dir.join(exe_name(name));
        fs::write(&path, b"x").expect("file");
        path
    }

    fn joined(dirs: &[&Path]) -> OsString {
        std::env::join_paths(dirs).expect("join")
    }

    #[test]
    fn a_portable_runtime_wins_over_the_system_one() {
        let root = tempfile::tempdir().expect("tempdir");
        let portable = touch(&root.path().join("portable"), "python");
        touch(&root.path().join("system"), "python");
        let env = RunEnvironment {
            path_prepend: vec![root.path().join("portable")],
            vars: vec![],
        };
        let system = joined(&[&root.path().join("system")]);

        let found = resolve_executable("python", &env, &[], Some(&system)).expect("found");

        assert_eq!(found.path, portable);
        assert_eq!(found.source, RuntimeSource::Portable);
    }

    #[test]
    fn the_system_runtime_is_only_the_fallback() {
        let root = tempfile::tempdir().expect("tempdir");
        let system_exe = touch(&root.path().join("system"), "node");
        let system = joined(&[&root.path().join("system")]);

        let found = resolve_executable("node", &RunEnvironment::default(), &[], Some(&system))
            .expect("found");

        assert_eq!(
            (found.path, found.source),
            (system_exe, RuntimeSource::System)
        );
    }

    #[test]
    fn project_tools_sit_between_portable_and_system() {
        let root = tempfile::tempdir().expect("tempdir");
        let project = touch(&root.path().join("proj"), "tsx");
        touch(&root.path().join("system"), "tsx");
        let system = joined(&[&root.path().join("system")]);

        let found = resolve_executable(
            "tsx",
            &RunEnvironment::default(),
            &[root.path().join("proj")],
            Some(&system),
        )
        .expect("found");

        assert_eq!(
            (found.path, found.source),
            (project, RuntimeSource::Project)
        );
    }

    #[test]
    fn nothing_found_is_none_and_paths_are_never_looked_up() {
        let root = tempfile::tempdir().expect("tempdir");
        let exe = touch(root.path(), "python");
        let env = RunEnvironment {
            path_prepend: vec![root.path().to_path_buf()],
            vars: vec![],
        };

        assert!(resolve_executable("php", &env, &[], None).is_none());
        for sneaky in [
            exe.to_string_lossy().into_owned(),
            "../python".into(),
            "a/b".into(),
            "".into(),
            "C:python".into(),
        ] {
            assert!(
                resolve_executable(&sneaky, &env, &[], None).is_none(),
                "{sneaky}"
            );
        }
    }

    #[test]
    fn labels_name_the_runtime_version_and_where_it_came_from() {
        let portable = ResolvedExecutable {
            path: PathBuf::from("C:/app/runtimes/python/versions/3.14.7/python.exe"),
            source: RuntimeSource::Portable,
        };
        let system = ResolvedExecutable {
            path: PathBuf::from("C:/Python314/python.exe"),
            source: RuntimeSource::System,
        };
        let project = ResolvedExecutable {
            path: PathBuf::from("C:/p/node_modules/.bin/tsx.cmd"),
            source: RuntimeSource::Project,
        };

        assert_eq!(
            runtime_label(RunnableKind::Python, &portable),
            "OpenMind portable Python 3.14.7"
        );
        assert_eq!(
            runtime_label(RunnableKind::Python, &system),
            "System Python"
        );
        assert_eq!(
            runtime_label(RunnableKind::TypeScript, &project),
            "project-local tsx"
        );
    }
}
