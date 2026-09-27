//! Finding Node.js, which runs the Node-based language servers (and installs
//! them with the npm that ships next to it). The Node inside the app's LSP
//! bundle comes first, then OpenMind's portable Node; a Node on the machine's
//! PATH is only a labelled fallback.

use std::ffi::OsString;
use std::path::{Path, PathBuf};

use serde::Serialize;

use crate::error::LspError;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum NodeSource {
    /// The Node shipped in the app's LSP bundle (`lsp/node/node.exe`; it has no npm).
    Bundled,
    /// OpenMind's own portable Node (Runtime Manager).
    Portable,
    /// A Node found on the machine's PATH.
    System,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NodeExecutable {
    pub path: PathBuf,
    pub source: NodeSource,
}

impl NodeExecutable {
    /// What the UI shows.
    pub fn label(&self) -> String {
        match self.source {
            NodeSource::Bundled => "OpenMind bundled Node.js".to_string(),
            NodeSource::Portable => "OpenMind portable Node.js".to_string(),
            NodeSource::System => format!("System Node.js at {}", self.path.display()),
        }
    }

    /// npm's entry script, shipped beside `node` — run as `node npm-cli.js`, so no `.cmd` shim is involved.
    pub fn npm_cli(&self) -> Option<PathBuf> {
        let cli = self
            .path
            .parent()?
            .join("node_modules")
            .join("npm")
            .join("bin")
            .join("npm-cli.js");
        cli.is_file().then_some(cli)
    }
}

fn executable_name() -> &'static str {
    if cfg!(windows) {
        "node.exe"
    } else {
        "node"
    }
}

fn find_in<'a>(dirs: impl IntoIterator<Item = &'a Path>) -> Option<PathBuf> {
    dirs.into_iter()
        .map(|dir| dir.join(executable_name()))
        .find(|candidate| candidate.is_file())
}

/// For language servers: the bundled Node when the bundle has one, else [`resolve_node`].
pub fn resolve_lsp_node(
    bundled: Option<PathBuf>,
    portable_dirs: &[PathBuf],
    system_path: Option<OsString>,
) -> Result<NodeExecutable, LspError> {
    match bundled {
        Some(path) if path.is_file() => Ok(NodeExecutable {
            path,
            source: NodeSource::Bundled,
        }),
        _ => resolve_node(portable_dirs, system_path),
    }
}

/// The portable Node (in the Runtime Manager's injected folders), else the first
/// Node on the system PATH, else "not installed".
pub fn resolve_node(
    portable_dirs: &[PathBuf],
    system_path: Option<OsString>,
) -> Result<NodeExecutable, LspError> {
    if let Some(path) = find_in(portable_dirs.iter().map(PathBuf::as_path)) {
        return Ok(NodeExecutable {
            path,
            source: NodeSource::Portable,
        });
    }
    let system = system_path.map(|path| std::env::split_paths(&path).collect::<Vec<_>>());
    if let Some(path) = system
        .as_ref()
        .and_then(|dirs| find_in(dirs.iter().map(PathBuf::as_path)))
    {
        return Ok(NodeExecutable {
            path,
            source: NodeSource::System,
        });
    }
    Err(LspError::NodeMissing)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fake_node(dir: &Path) {
        std::fs::create_dir_all(dir).expect("mkdir");
        std::fs::write(dir.join(executable_name()), b"").expect("node");
    }

    #[test]
    fn the_portable_node_beats_the_system_one() {
        let root = tempfile::tempdir().expect("tempdir");
        let portable = root.path().join("My Runtimes").join("node");
        let system = root.path().join("system");
        fake_node(&portable);
        fake_node(&system);
        let found = resolve_node(
            std::slice::from_ref(&portable),
            Some(std::env::join_paths([&system]).expect("path")),
        )
        .expect("node");
        assert_eq!(found.source, NodeSource::Portable);
        assert_eq!(found.path, portable.join(executable_name()));
        assert_eq!(found.label(), "OpenMind portable Node.js");
    }

    #[test]
    fn the_bundled_node_beats_the_portable_one_only_when_it_exists() {
        let root = tempfile::tempdir().expect("tempdir");
        let bundled = root.path().join("My App").join("lsp").join("node");
        let portable = root.path().join("portable");
        fake_node(&portable);
        let missing = resolve_lsp_node(
            Some(bundled.join(executable_name())),
            std::slice::from_ref(&portable),
            None,
        )
        .expect("node");
        assert_eq!(missing.source, NodeSource::Portable);
        fake_node(&bundled);
        let found = resolve_lsp_node(
            Some(bundled.join(executable_name())),
            std::slice::from_ref(&portable),
            None,
        )
        .expect("node");
        assert_eq!(found.source, NodeSource::Bundled);
        assert_eq!(found.label(), "OpenMind bundled Node.js");
        assert!(found.npm_cli().is_none());
    }

    #[test]
    fn the_system_node_is_a_labelled_fallback() {
        let root = tempfile::tempdir().expect("tempdir");
        let system = root.path().join("system");
        fake_node(&system);
        let found =
            resolve_node(&[], Some(std::env::join_paths([&system]).expect("path"))).expect("node");
        assert_eq!(found.source, NodeSource::System);
        assert!(found.label().starts_with("System Node.js at "));
    }

    #[test]
    fn no_node_anywhere_is_the_not_installed_error() {
        let root = tempfile::tempdir().expect("tempdir");
        let empty = root.path().join("empty");
        std::fs::create_dir_all(&empty).expect("mkdir");
        let err = resolve_node(
            std::slice::from_ref(&empty),
            Some(std::env::join_paths([&empty]).expect("p")),
        )
        .expect_err("missing");
        assert!(matches!(err, LspError::NodeMissing));
        assert_eq!(err.to_string(), "Node.js runtime is not installed yet.");
    }

    #[test]
    fn npm_is_found_next_to_node_only_when_it_is_there() {
        let root = tempfile::tempdir().expect("tempdir");
        let dir = root.path().join("node");
        fake_node(&dir);
        let node = NodeExecutable {
            path: dir.join(executable_name()),
            source: NodeSource::Portable,
        };
        assert!(node.npm_cli().is_none());
        let bin = dir.join("node_modules").join("npm").join("bin");
        std::fs::create_dir_all(&bin).expect("mkdir");
        std::fs::write(bin.join("npm-cli.js"), b"").expect("cli");
        assert_eq!(node.npm_cli(), Some(bin.join("npm-cli.js")));
    }
}
