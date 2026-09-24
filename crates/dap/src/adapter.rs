//! Debug adapters as data: which runtime kind holds each adapter's files, the interpreter a
//! program runs on (OpenMind's portable one first, a system one only as a labelled fallback),
//! whether a target is ready, and how the adapter process is started.

use std::ffi::OsString;
use std::path::{Path, PathBuf};

use openmind_lsp::process::SpawnSpec;
use serde::Serialize;

use crate::target::Target;

/// The Python or Node.js executable a program runs on.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Interpreter {
    pub path: PathBuf,
    pub portable: bool,
}

impl Interpreter {
    pub fn label(&self, target: Target) -> String {
        if self.portable {
            format!("OpenMind portable {}", target.label())
        } else {
            format!("System {} at {}", target.label(), self.path.display())
        }
    }
}

fn executable_name(target: Target) -> Option<&'static str> {
    match (target, cfg!(windows)) {
        (Target::Python, true) => Some("python.exe"),
        (Target::Python, false) => Some("python3"),
        (Target::Node, true) => Some("node.exe"),
        (Target::Node, false) => Some("node"),
        (Target::Php, _) => None,
    }
}

fn find_in<'a>(name: &str, dirs: impl IntoIterator<Item = &'a Path>) -> Option<PathBuf> {
    dirs.into_iter()
        .map(|dir| dir.join(name))
        .find(|candidate| candidate.is_file())
}

/// Portable first (the Runtime Manager's folders), then the system PATH.
pub fn resolve_interpreter(
    target: Target,
    portable_dirs: &[PathBuf],
    system_path: Option<OsString>,
) -> Option<Interpreter> {
    let name = executable_name(target)?;
    if let Some(path) = find_in(name, portable_dirs.iter().map(PathBuf::as_path)) {
        return Some(Interpreter {
            path,
            portable: true,
        });
    }
    let system: Vec<PathBuf> = system_path
        .map(|path| std::env::split_paths(&path).collect())
        .unwrap_or_default();
    find_in(name, system.iter().map(PathBuf::as_path)).map(|path| Interpreter {
        path,
        portable: false,
    })
}

/// Where a target's debug adapter lives: a runtime kind of the Runtime Manager and the file
/// inside its install that proves it is there.
#[derive(Debug, Clone, Copy)]
pub struct AdapterInfo {
    pub name: &'static str,
    pub runtime_kind: &'static str,
    pub entry: &'static str,
    pub runtime_name: &'static str,
    pub adapter_missing: &'static str,
    pub runtime_missing: &'static str,
}

pub fn adapter_for(target: Target) -> Option<AdapterInfo> {
    match target {
        Target::Python => Some(AdapterInfo {
            name: "debugpy",
            runtime_kind: "debugpy",
            entry: "debugpy/adapter/__main__.py",
            runtime_name: "Python",
            adapter_missing: "Python debugger is not installed yet.",
            runtime_missing: "Python runtime is not installed yet.",
        }),
        Target::Node => Some(AdapterInfo {
            name: "js-debug",
            runtime_kind: "js-debug",
            entry: "src/dapDebugServer.js",
            runtime_name: "Node.js",
            adapter_missing: "Node.js debugger is not installed yet.",
            runtime_missing: "Node.js runtime is not installed yet.",
        }),
        Target::Php => None,
    }
}

/// Whether a target can be debugged right now, and if not, why.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Readiness {
    pub target: Target,
    pub ready: bool,
    /// The reason, when not ready.
    pub problem: Option<String>,
    /// Which interpreter would run the program ("OpenMind portable Python").
    pub interpreter: Option<String>,
    /// The Runtime Manager kind to install to get the adapter (only when that is the missing part).
    pub install_kind: Option<String>,
}

pub fn readiness(
    target: Target,
    interpreter: Option<&Interpreter>,
    adapter_dir: Option<&Path>,
) -> Readiness {
    let mut result = Readiness {
        target,
        ready: false,
        problem: None,
        interpreter: interpreter.map(|found| found.label(target)),
        install_kind: None,
    };
    let Some(adapter) = adapter_for(target) else {
        result.problem = Some("PHP debugging requires Xdebug and is not available yet.".into());
        return result;
    };
    if interpreter.is_none() {
        result.problem = Some(adapter.runtime_missing.into());
        return result;
    }
    let installed = adapter_dir.is_some_and(|dir| dir.join(adapter.entry).is_file());
    if !installed {
        result.problem = Some(adapter.adapter_missing.into());
        result.install_kind = Some(adapter.runtime_kind.into());
        return result;
    }
    result.ready = true;
    result
}

/// How the adapter process is started. Python's debugpy speaks DAP on stdio; js-debug is a
/// server that listens on a free port of 127.0.0.1 and tells us which.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Transport {
    Stdio,
    /// TCP on 127.0.0.1; the adapter prints the port it chose.
    Tcp,
}

pub fn transport(target: Target) -> Transport {
    match target {
        Target::Python | Target::Php => Transport::Stdio,
        Target::Node => Transport::Tcp,
    }
}

pub fn adapter_spawn(
    target: Target,
    interpreter: &Interpreter,
    adapter_dir: &Path,
    cwd: &Path,
    path_prepend: Vec<PathBuf>,
    vars: Vec<(String, String)>,
) -> Option<SpawnSpec> {
    let info = adapter_for(target)?;
    let mut vars = vars;
    let args = match target {
        Target::Python => {
            vars.push(("PYTHONPATH".into(), adapter_dir.display().to_string()));
            vars.push(("PYTHONNOUSERSITE".into(), "1".into()));
            vars.push(("PYTHONUNBUFFERED".into(), "1".into()));
            vec!["-m".into(), "debugpy.adapter".into()]
        }
        Target::Node => vec![
            adapter_dir.join(info.entry).display().to_string(),
            "0".into(),
            "127.0.0.1".into(),
        ],
        Target::Php => return None,
    };
    Some(SpawnSpec {
        program: interpreter.path.clone(),
        args,
        cwd: cwd.to_path_buf(),
        vars,
        path_prepend,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn touch(path: &Path) {
        std::fs::create_dir_all(path.parent().expect("parent")).expect("mkdir");
        std::fs::write(path, b"").expect("file");
    }

    #[test]
    fn the_portable_interpreter_beats_the_system_one_and_is_labelled() {
        let root = tempfile::tempdir().expect("tempdir");
        let portable = root.path().join("My Runtimes").join("python");
        let system = root.path().join("system");
        let name = executable_name(Target::Python).expect("name");
        touch(&portable.join(name));
        touch(&system.join(name));
        let path = std::env::join_paths([&system]).expect("path");
        let found = resolve_interpreter(
            Target::Python,
            std::slice::from_ref(&portable),
            Some(path.clone()),
        )
        .expect("found");
        assert!(found.portable);
        assert_eq!(found.label(Target::Python), "OpenMind portable Python");
        let fallback = resolve_interpreter(Target::Python, &[], Some(path)).expect("system");
        assert!(!fallback.portable);
        assert!(fallback
            .label(Target::Python)
            .starts_with("System Python at "));
        assert!(resolve_interpreter(Target::Python, &[], None).is_none());
        assert!(resolve_interpreter(Target::Php, &[], None).is_none());
    }

    #[test]
    fn readiness_says_what_is_missing_in_the_order_the_user_can_fix_it() {
        let python = Interpreter {
            path: PathBuf::from("C:/py/python.exe"),
            portable: true,
        };
        let none = readiness(Target::Python, None, None);
        assert_eq!(
            none.problem.as_deref(),
            Some("Python runtime is not installed yet.")
        );
        assert!(none.install_kind.is_none());

        let no_adapter = readiness(Target::Python, Some(&python), None);
        assert!(!no_adapter.ready);
        assert_eq!(
            no_adapter.problem.as_deref(),
            Some("Python debugger is not installed yet.")
        );
        assert_eq!(no_adapter.install_kind.as_deref(), Some("debugpy"));

        let dir = tempfile::tempdir().expect("tempdir");
        touch(&dir.path().join("debugpy/adapter/__main__.py"));
        let ready = readiness(Target::Python, Some(&python), Some(dir.path()));
        assert!(ready.ready);
        assert_eq!(
            ready.interpreter.as_deref(),
            Some("OpenMind portable Python")
        );
        assert!(ready.problem.is_none());
    }

    #[test]
    fn node_and_php_have_their_own_messages() {
        let node = Interpreter {
            path: PathBuf::from("C:/n/node.exe"),
            portable: false,
        };
        assert_eq!(
            readiness(Target::Node, None, None).problem.as_deref(),
            Some("Node.js runtime is not installed yet.")
        );
        let missing = readiness(Target::Node, Some(&node), None);
        assert_eq!(
            missing.problem.as_deref(),
            Some("Node.js debugger is not installed yet.")
        );
        assert_eq!(missing.install_kind.as_deref(), Some("js-debug"));
        let php = readiness(Target::Php, None, None);
        assert_eq!(
            php.problem.as_deref(),
            Some("PHP debugging requires Xdebug and is not available yet.")
        );
        assert!(!php.ready && php.install_kind.is_none());
    }

    #[test]
    fn python_starts_debugpy_with_its_folder_on_pythonpath_and_no_user_site() {
        let python = Interpreter {
            path: PathBuf::from("C:/My Runtimes/python.exe"),
            portable: true,
        };
        let spec = adapter_spawn(
            Target::Python,
            &python,
            Path::new("C:/My App/runtimes/debugpy/versions/1.8.22"),
            Path::new("C:/My Site"),
            vec![PathBuf::from("C:/My Runtimes")],
            vec![],
        )
        .expect("spec");
        assert_eq!(spec.args, vec!["-m", "debugpy.adapter"]);
        assert!(spec
            .vars
            .iter()
            .any(|(k, v)| k == "PYTHONPATH" && v.contains("debugpy")));
        assert!(spec
            .vars
            .iter()
            .any(|(k, v)| k == "PYTHONNOUSERSITE" && v == "1"));
        assert_eq!(transport(Target::Python), Transport::Stdio);
    }

    #[test]
    fn node_starts_js_debug_on_a_free_loopback_port() {
        let node = Interpreter {
            path: PathBuf::from("C:/n/node.exe"),
            portable: true,
        };
        let spec = adapter_spawn(
            Target::Node,
            &node,
            Path::new("C:/My App/js-debug"),
            Path::new("C:/My Site"),
            vec![],
            vec![],
        )
        .expect("spec");
        assert!(spec.args[0]
            .replace('\\', "/")
            .ends_with("src/dapDebugServer.js"));
        assert_eq!(&spec.args[1..], ["0", "127.0.0.1"]);
        assert_eq!(transport(Target::Node), Transport::Tcp);
        assert!(adapter_spawn(
            Target::Php,
            &node,
            Path::new("x"),
            Path::new("y"),
            vec![],
            vec![]
        )
        .is_none());
    }
}
