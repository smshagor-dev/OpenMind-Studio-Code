//! The offline LSP bundle a release build ships next to the executable:
//!
//! ```text
//! lsp/bundle.json              what is in it (written by scripts/prepare-lsp-bundle.mjs)
//! lsp/node/node.exe            the Node.js the Node-based servers run on
//! lsp/packs/<package>-<rev>.zip one archive per package, pre-built from its pinned lockfile or release
//! ```
//!
//! Nothing here touches the network. A pack is unpacked (see `unpack`) into the
//! same `language-servers/<package>/<revision>/` folder a download would use, the
//! first time one of its servers is needed. A damaged or foreign `bundle.json`
//! is reported and ignored; a pack for another revision than the app's is not used.

use std::path::{Component, Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::registry::Package;

pub const BUNDLE_DIR: &str = "lsp";
pub const BUNDLE_FORMAT: &str = "openmind-lsp-bundle";
pub const BUNDLE_VERSION: u32 = 1;
/// The only platform the bundle is built for today.
pub const BUNDLE_PLATFORM: &str = "windows-x64";

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NodeEntry {
    pub version: String,
    /// Relative to `lsp/`, forward slashes.
    pub path: String,
    pub sha256: String,
    pub size: u64,
    #[serde(default)]
    pub license: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PackEntry {
    pub package: String,
    pub revision: String,
    pub contents: String,
    /// Relative to `lsp/`, forward slashes.
    pub file: String,
    pub sha256: String,
    pub size: u64,
    #[serde(default)]
    pub license: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct BundleFile {
    format: String,
    version: u32,
    platform: String,
    node: Option<NodeEntry>,
    #[serde(default)]
    packs: Vec<PackEntry>,
}

/// A loaded, checked `lsp/bundle.json`.
#[derive(Debug, Clone)]
pub struct Bundle {
    dir: PathBuf,
    pub platform: String,
    pub node: Option<NodeEntry>,
    pub packs: Vec<PackEntry>,
}

/// Where the bundle lives for an app folder (next to the program when the data folder is elsewhere).
pub fn bundle_dir(app_root: &Path) -> PathBuf {
    openmind_core::paths::shipped_dir(app_root, BUNDLE_DIR)
}

/// A bundle path must stay inside `lsp/`: relative, no `..`, no drive or root.
pub fn safe_relative(path: &str) -> bool {
    !path.is_empty()
        && !path.contains(['\\', ':', '\0'])
        && Path::new(path)
            .components()
            .all(|component| matches!(component, Component::Normal(_)))
}

fn is_hex_sha256(text: &str) -> bool {
    text.len() == 64 && text.chars().all(|c| c.is_ascii_hexdigit())
}

/// Reads `lsp/bundle.json`. `Ok(None)` when there is no bundle (a development
/// build, or an edition without one); `Err` with a readable reason when the file
/// is there but can't be used.
pub fn load(app_root: &Path) -> Result<Option<Bundle>, String> {
    load_dir(&bundle_dir(app_root))
}

/// [`load`] for a bundle folder given directly (the prepared `lsp-bundle/` in tests and tools).
pub fn load_dir(dir: &Path) -> Result<Option<Bundle>, String> {
    let dir = dir.to_path_buf();
    let file = dir.join("bundle.json");
    let text = match std::fs::read_to_string(&file) {
        Ok(text) => text,
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(err) => return Err(format!("The LSP bundle can't be read: {err}")),
    };
    let parsed: BundleFile = serde_json::from_str(&text)
        .map_err(|err| format!("The LSP bundle's bundle.json is damaged: {err}"))?;
    if parsed.format != BUNDLE_FORMAT {
        return Err(format!(
            "lsp/bundle.json is not an OpenMind LSP bundle (format \"{}\").",
            parsed.format
        ));
    }
    if parsed.version > BUNDLE_VERSION {
        return Err(format!(
            "The LSP bundle is version {}; this OpenMind Studio reads version {BUNDLE_VERSION}.",
            parsed.version
        ));
    }
    if let Some(node) = &parsed.node {
        if !safe_relative(&node.path) || !is_hex_sha256(&node.sha256) {
            return Err("The LSP bundle lists an invalid Node.js entry.".into());
        }
    }
    for pack in &parsed.packs {
        if !safe_relative(&pack.file) || !is_hex_sha256(&pack.sha256) {
            return Err(format!(
                "The LSP bundle lists an invalid pack for \"{}\".",
                pack.package
            ));
        }
    }
    Ok(Some(Bundle {
        dir,
        platform: parsed.platform,
        node: parsed.node,
        packs: parsed.packs,
    }))
}

fn windows_is_64_bit() -> bool {
    if cfg!(any(target_arch = "x86_64", target_arch = "aarch64")) {
        return true;
    }
    // A 32-bit process on 64-bit Windows sees the real architecture here.
    std::env::var("PROCESSOR_ARCHITEW6432")
        .is_ok_and(|arch| arch.eq_ignore_ascii_case("AMD64") || arch.eq_ignore_ascii_case("ARM64"))
}

impl Bundle {
    /// Whether this computer can run what the bundle holds: 64-bit Windows (x64, or
    /// ARM64 through Windows' x64 emulation) — also from a 32-bit build of the app.
    pub fn platform_supported(&self) -> bool {
        cfg!(windows) && self.platform == BUNDLE_PLATFORM && windows_is_64_bit()
    }

    fn resolve(&self, relative: &str) -> PathBuf {
        relative
            .split('/')
            .fold(self.dir.clone(), |path, part| path.join(part))
    }

    /// The pack for `package`'s *current* revision, when its archive is present.
    /// A package that may not be redistributed is never taken from a bundle.
    pub fn pack_for(&self, package: &Package) -> Option<&PackEntry> {
        if !self.platform_supported() || !package.redistributable {
            return None;
        }
        self.packs.iter().find(|pack| {
            pack.package == package.id
                && pack.revision == package.revision
                && self.resolve(&pack.file).is_file()
        })
    }

    pub fn pack_path(&self, pack: &PackEntry) -> PathBuf {
        self.resolve(&pack.file)
    }

    /// The bundled `node.exe`, when it is present and has the size the bundle recorded
    /// (a truncated copy is not used).
    pub fn node_path(&self) -> Option<PathBuf> {
        if !self.platform_supported() {
            return None;
        }
        let node = self.node.as_ref()?;
        let path = self.resolve(&node.path);
        let size = std::fs::metadata(&path).ok()?.len();
        (size == node.size).then_some(path)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::registry::package_by_id;

    const SHA: &str = "158f7685b44de51f6c0df1d153526cbcd3e1bc739a8dfc607721cef75de9e541";

    fn write_bundle(root: &Path, json: &str) {
        let dir = bundle_dir(root);
        std::fs::create_dir_all(dir.join("packs")).expect("mkdir");
        std::fs::write(dir.join("bundle.json"), json).expect("write");
    }

    fn manifest(pack_file: &str, platform: &str) -> String {
        format!(
            r#"{{"format":"openmind-lsp-bundle","version":1,"platform":"{platform}",
            "node":{{"version":"24.21.0","path":"node/node.exe","sha256":"{SHA}","size":4}},
            "packs":[{{"package":"python","revision":"1","contents":"pyright 1.1.414",
            "file":"{pack_file}","sha256":"{SHA}","size":10}}]}}"#
        )
    }

    #[test]
    fn no_bundle_is_not_an_error() {
        let root = tempfile::tempdir().expect("tempdir");
        assert!(load(root.path()).expect("ok").is_none());
    }

    #[test]
    fn a_damaged_or_foreign_bundle_is_reported() {
        let root = tempfile::tempdir().expect("tempdir");
        write_bundle(root.path(), "{ not json");
        assert!(load(root.path()).expect_err("damaged").contains("damaged"));
        write_bundle(
            root.path(),
            r#"{"format":"other","version":1,"platform":"windows-x64"}"#,
        );
        assert!(load(root.path()).expect_err("foreign").contains("not an"));
        write_bundle(
            root.path(),
            r#"{"format":"openmind-lsp-bundle","version":9,"platform":"windows-x64"}"#,
        );
        assert!(load(root.path()).expect_err("newer").contains("version 9"));
    }

    #[test]
    fn paths_that_leave_the_bundle_folder_are_refused() {
        for bad in [
            "../x.zip",
            "packs/../../x.zip",
            "C:/x.zip",
            "/abs.zip",
            r"packs\x.zip",
            "",
        ] {
            assert!(!safe_relative(bad), "{bad}");
            let root = tempfile::tempdir().expect("tempdir");
            write_bundle(root.path(), &manifest(bad, BUNDLE_PLATFORM));
            assert!(load(root.path()).is_err(), "{bad}");
        }
        assert!(safe_relative("packs/python-1.zip"));
    }

    #[test]
    fn a_pack_is_offered_only_for_the_current_revision_when_its_archive_exists() {
        let root = tempfile::tempdir().expect("tempdir");
        write_bundle(
            root.path(),
            &manifest("packs/python-1.zip", BUNDLE_PLATFORM),
        );
        let bundle = load(root.path()).expect("ok").expect("bundle");
        let python = package_by_id("python").expect("package");
        assert!(bundle.pack_for(python).is_none(), "archive missing");
        std::fs::write(bundle_dir(root.path()).join("packs/python-1.zip"), b"zip").expect("w");
        assert_eq!(bundle.pack_for(python).is_some(), cfg!(windows));
        let other_revision = Package {
            revision: "2",
            ..*python
        };
        assert!(bundle.pack_for(&other_revision).is_none());
        assert!(bundle
            .pack_for(package_by_id("php").expect("php"))
            .is_none());
    }

    #[test]
    fn a_pack_of_a_package_that_may_not_be_redistributed_is_never_used() {
        let root = tempfile::tempdir().expect("tempdir");
        let json = format!(
            r#"{{"format":"openmind-lsp-bundle","version":1,"platform":"windows-x64",
            "packs":[{{"package":"php","revision":"1","contents":"intelephense",
            "file":"packs/php-1.zip","sha256":"{SHA}","size":3}}]}}"#
        );
        write_bundle(root.path(), &json);
        std::fs::write(bundle_dir(root.path()).join("packs/php-1.zip"), b"zip").expect("w");
        let bundle = load(root.path()).expect("ok").expect("bundle");
        assert!(bundle
            .pack_for(package_by_id("php").expect("php"))
            .is_none());
    }

    #[test]
    fn the_bundled_node_needs_the_recorded_size_and_the_right_platform() {
        let root = tempfile::tempdir().expect("tempdir");
        write_bundle(
            root.path(),
            &manifest("packs/python-1.zip", BUNDLE_PLATFORM),
        );
        let node_dir = bundle_dir(root.path()).join("node");
        std::fs::create_dir_all(&node_dir).expect("mkdir");
        std::fs::write(node_dir.join("node.exe"), b"abc").expect("short");
        let bundle = load(root.path()).expect("ok").expect("bundle");
        assert!(bundle.node_path().is_none(), "truncated");
        std::fs::write(node_dir.join("node.exe"), b"abcd").expect("full");
        assert_eq!(bundle.node_path().is_some(), cfg!(windows));

        write_bundle(root.path(), &manifest("packs/python-1.zip", "linux-arm64"));
        let foreign = load(root.path()).expect("ok").expect("bundle");
        assert!(!foreign.platform_supported());
        assert!(foreign.node_path().is_none());
    }
}
