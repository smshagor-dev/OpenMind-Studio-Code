//! Where extensions live, always relative to the app's own `extensions/` folder (never AppData):
//!
//! ```text
//! extensions/
//!     installed/<publisher>.<name>-<version>/   enabled extensions
//!     disabled/<publisher>.<name>-<version>/    disabled extensions (moved here, so the state survives a restart)
//!     cache/                                    staging while installing, the extension host's own files
//!     storage/<id>/                             what an extension stores (globalStorage, workspaceStorage)
//!     logs/extension-host.log
//! ```

use std::path::{Path, PathBuf};

use crate::error::ExtensionError;
use crate::manifest::Manifest;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ExtensionPaths {
    pub root: PathBuf,
    pub installed: PathBuf,
    pub disabled: PathBuf,
    pub cache: PathBuf,
    pub staging: PathBuf,
    pub host_dir: PathBuf,
    pub storage: PathBuf,
    pub logs: PathBuf,
    pub host_log: PathBuf,
}

impl ExtensionPaths {
    /// `root` is `AppPaths::extensions_dir`.
    pub fn new(root: &Path) -> Self {
        let cache = root.join("cache");
        let logs = root.join("logs");
        Self {
            installed: root.join("installed"),
            disabled: root.join("disabled"),
            staging: cache.join("staging"),
            host_dir: cache.join("host"),
            storage: root.join("storage"),
            host_log: logs.join("extension-host.log"),
            root: root.to_path_buf(),
            cache,
            logs,
        }
    }

    /// The same layout with the host's log in `logs` instead of `<root>/logs`: a per-computer data scope keeps it in
    /// that computer's log folder (`openmind_core::AppPaths::extension_logs_dir`).
    pub fn with_logs(root: &Path, logs: &Path) -> Self {
        Self {
            host_log: logs.join("extension-host.log"),
            logs: logs.to_path_buf(),
            ..Self::new(root)
        }
    }

    pub fn ensure(&self) -> Result<(), ExtensionError> {
        for dir in [
            &self.installed,
            &self.disabled,
            &self.cache,
            &self.logs,
            &self.storage,
        ] {
            std::fs::create_dir_all(dir).map_err(|err| {
                ExtensionError::io(format!("Couldn't create {}", dir.display()), err)
            })?;
        }
        Ok(())
    }

    /// `publisher.name-version`, the folder an extension is installed into.
    pub fn folder_name(manifest: &Manifest) -> String {
        format!(
            "{}.{}-{}",
            manifest.publisher, manifest.name, manifest.version
        )
    }

    pub fn installed_dir(&self, manifest: &Manifest) -> PathBuf {
        self.installed.join(Self::folder_name(manifest))
    }

    pub fn disabled_dir(&self, manifest: &Manifest) -> PathBuf {
        self.disabled.join(Self::folder_name(manifest))
    }

    /// Where an extension keeps its own files: `storage/<id>/global` and `storage/<id>/workspace/<key>`.
    pub fn global_storage(&self, id: &str) -> PathBuf {
        self.storage.join(id).join("global")
    }

    pub fn workspace_storage(&self, id: &str, workspace_key: &str) -> PathBuf {
        self.storage.join(id).join("workspace").join(workspace_key)
    }

    pub fn extension_logs(&self, id: &str) -> PathBuf {
        self.logs.join(id)
    }
}

/// A folder name made only of what a manifest may contain, so it can never point outside its parent.
pub fn is_plain_folder_name(name: &str) -> bool {
    !name.is_empty() && name != "." && name != ".." && !name.contains(['/', '\\', ':', '\0'])
}

/// A short stable name for a workspace folder (FNV-1a of its normalized path), the folder name of its
/// per-workspace extension storage.
pub fn workspace_key(folder: &str) -> String {
    let normalized = folder
        .replace('\\', "/")
        .trim_end_matches('/')
        .to_lowercase();
    let mut hash: u64 = 0xcbf2_9ce4_8422_2325;
    for byte in normalized.bytes() {
        hash ^= u64::from(byte);
        hash = hash.wrapping_mul(0x0100_0000_01b3);
    }
    format!("{hash:016x}")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn everything_is_under_the_apps_extensions_folder_even_with_spaces() {
        let root = Path::new("D:/Portable Apps/OpenMind Studio/extensions");
        let paths = ExtensionPaths::new(root);
        for path in [
            &paths.installed,
            &paths.disabled,
            &paths.cache,
            &paths.staging,
            &paths.host_dir,
            &paths.storage,
            &paths.logs,
            &paths.host_log,
        ] {
            assert!(path.starts_with(root), "{path:?}");
            assert!(!path.to_string_lossy().to_lowercase().contains("appdata"));
        }
        assert_eq!(paths.host_log, root.join("logs/extension-host.log"));
        assert_eq!(paths.installed, root.join("installed"));
    }

    #[test]
    fn folders_are_named_publisher_name_version() {
        let manifest = Manifest::parse(r#"{"name":"hello","version":"1.2.3","publisher":"acme"}"#)
            .expect("valid");
        let paths = ExtensionPaths::new(Path::new("x"));
        assert_eq!(ExtensionPaths::folder_name(&manifest), "acme.hello-1.2.3");
        assert_eq!(
            paths.installed_dir(&manifest),
            Path::new("x/installed/acme.hello-1.2.3")
        );
        assert_eq!(
            paths.disabled_dir(&manifest),
            Path::new("x/disabled/acme.hello-1.2.3")
        );
        assert_eq!(
            paths.global_storage("acme.hello"),
            Path::new("x/storage/acme.hello/global")
        );
        assert_eq!(
            paths.workspace_storage("acme.hello", "abc"),
            Path::new("x/storage/acme.hello/workspace/abc")
        );
    }

    #[test]
    fn plain_folder_names_reject_separators_and_dots() {
        assert!(is_plain_folder_name("acme.hello-1.0.0"));
        for bad in ["", ".", "..", "a/b", "a\\b", "c:x"] {
            assert!(!is_plain_folder_name(bad), "{bad:?}");
        }
    }

    #[test]
    fn ensure_creates_the_layout() {
        let dir = tempfile::tempdir().expect("tempdir");
        let paths = ExtensionPaths::new(&dir.path().join("My Extensions"));
        paths.ensure().expect("created");
        for path in [
            &paths.installed,
            &paths.disabled,
            &paths.cache,
            &paths.logs,
            &paths.storage,
        ] {
            assert!(path.is_dir(), "{path:?}");
        }
    }
}

#[cfg(test)]
mod workspace_key_tests {
    use super::*;

    #[test]
    fn a_workspace_key_ignores_case_separators_and_a_trailing_slash() {
        let a = workspace_key("C:\\Work\\My Site\\");
        assert_eq!(a, workspace_key("c:/work/my site"));
        assert_ne!(a, workspace_key("c:/work/other"));
        assert_eq!(a.len(), 16);
    }
}
