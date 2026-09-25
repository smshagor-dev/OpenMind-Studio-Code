//! The installed extensions: what is in `installed/` and `disabled/`. There is no separate registry file —
//! the folders *are* the registry, so what the UI lists, what the host loads and what is on disk cannot
//! disagree, and enabling/disabling is a folder move that survives a restart by construction.

use std::fs;
use std::path::{Path, PathBuf};

use serde::Serialize;

use crate::contributions::{PointReport, Support};
use crate::error::ExtensionError;
use crate::manifest::{ActivationEvent, Manifest};
use crate::paths::{is_plain_folder_name, ExtensionPaths};
use crate::vsix;

/// One installed extension, everything the UI and the host need.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InstalledExtension {
    pub id: String,
    pub folder: String,
    pub path: PathBuf,
    pub enabled: bool,
    pub manifest: Manifest,
    /// Every contribution point it uses, with how far the app supports it.
    pub points: Vec<PointReport>,
    /// Set when it has code: what the extension host needs.
    pub runtime_requirement: Option<String>,
    pub warnings: Vec<String>,
    pub activation_events: Vec<String>,
}

/// A folder in `installed/` or `disabled/` that isn't a usable extension.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BrokenExtension {
    pub folder: String,
    pub enabled: bool,
    pub error: String,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Listing {
    pub extensions: Vec<InstalledExtension>,
    pub broken: Vec<BrokenExtension>,
}

/// The message shown for an extension with code when there is no Node.js.
pub const NODE_REQUIRED: &str = "Node.js runtime is required for extension host.";

fn describe(
    manifest: Manifest,
    folder: String,
    path: PathBuf,
    enabled: bool,
) -> InstalledExtension {
    let mut warnings = Vec::new();
    if manifest.activation_events.contains(&ActivationEvent::Star) {
        warnings
            .push("Activates at every start-up (\"*\"), which can slow the app down.".to_string());
    }
    for event in &manifest.activation_events {
        if !event.is_supported() {
            warnings.push(format!(
                "Activation event \"{}\" isn't supported yet, so it never triggers.",
                event.text()
            ));
        }
    }
    if manifest.browser.is_some() && manifest.main.is_none() {
        warnings.push("It only has a web (browser) entry, which isn't supported yet.".to_string());
    }
    InstalledExtension {
        id: manifest.id(),
        folder,
        path,
        enabled,
        points: manifest.contributes.report(),
        runtime_requirement: manifest.main.as_ref().map(|_| NODE_REQUIRED.to_string()),
        activation_events: manifest
            .effective_activation()
            .iter()
            .map(ActivationEvent::text)
            .collect(),
        warnings,
        manifest,
    }
}

/// What an extension would look like once installed, for the install confirmation (no path yet).
pub fn preview(manifest: Manifest) -> InstalledExtension {
    let folder = ExtensionPaths::folder_name(&manifest);
    describe(manifest, folder, PathBuf::new(), true)
}

#[cfg(test)]
pub(crate) fn describe_for_tests(manifest: Manifest, enabled: bool) -> InstalledExtension {
    let folder = ExtensionPaths::folder_name(&manifest);
    describe(manifest, folder.clone(), PathBuf::from(folder), enabled)
}

/// Canonical `target` must lie inside canonical `base`: the check every delete and read goes through.
pub fn ensure_inside(base: &Path, target: &Path) -> Result<PathBuf, ExtensionError> {
    let fail = |reason: &str| ExtensionError::Path {
        path: target.to_path_buf(),
        reason: reason.to_string(),
    };
    let base = base
        .canonicalize()
        .map_err(|_| fail("its folder doesn't exist"))?;
    let target = target
        .canonicalize()
        .map_err(|_| fail("it doesn't exist"))?;
    if target.starts_with(&base) && target != base {
        Ok(target)
    } else {
        Err(fail("it is outside the extensions folder"))
    }
}

#[derive(Debug, Clone)]
pub struct ExtensionStore {
    paths: ExtensionPaths,
}

impl ExtensionStore {
    pub fn new(paths: ExtensionPaths) -> Self {
        Self { paths }
    }

    pub fn paths(&self) -> &ExtensionPaths {
        &self.paths
    }

    fn scan(&self, dir: &Path, enabled: bool, into: &mut Listing) {
        let Ok(entries) = fs::read_dir(dir) else {
            return;
        };
        for entry in entries.filter_map(Result::ok) {
            let path = entry.path();
            if !path.is_dir() {
                continue;
            }
            let folder = entry.file_name().to_string_lossy().into_owned();
            let manifest = fs::read_to_string(path.join("package.json"))
                .map_err(|err| format!("package.json can't be read: {err}"))
                .and_then(|text| Manifest::parse(&text).map_err(|err| err.to_string()));
            match manifest {
                Ok(manifest) => into
                    .extensions
                    .push(describe(manifest, folder, path, enabled)),
                Err(error) => into.broken.push(BrokenExtension {
                    folder,
                    enabled,
                    error,
                }),
            }
        }
    }

    /// Everything installed, enabled first-class: sorted by display name. Missing dependencies are
    /// added to each extension's warnings.
    pub fn list(&self) -> Listing {
        let mut listing = Listing::default();
        self.scan(&self.paths.installed, true, &mut listing);
        self.scan(&self.paths.disabled, false, &mut listing);
        let ids: Vec<String> = listing.extensions.iter().map(|e| e.id.clone()).collect();
        for extension in &mut listing.extensions {
            for dependency in &extension.manifest.extension_dependencies {
                if !ids.contains(&dependency.to_lowercase()) {
                    extension
                        .warnings
                        .push(format!("Requires {dependency}, which isn't installed."));
                }
            }
        }
        listing.extensions.sort_by(|a, b| {
            let name = |e: &InstalledExtension| {
                e.manifest
                    .display_name
                    .clone()
                    .unwrap_or_else(|| e.manifest.name.clone())
                    .to_lowercase()
            };
            name(a).cmp(&name(b)).then_with(|| a.id.cmp(&b.id))
        });
        listing.broken.sort_by(|a, b| a.folder.cmp(&b.folder));
        listing
    }

    pub fn find(&self, id: &str) -> Result<InstalledExtension, ExtensionError> {
        let wanted = id.to_lowercase();
        self.list()
            .extensions
            .into_iter()
            .find(|extension| extension.id == wanted)
            .ok_or_else(|| ExtensionError::NotInstalled(id.to_string()))
    }

    /// Installs a `.vsix`. The extension is enabled (choosing the file is the user's decision to trust
    /// it). The same id already installed is refused unless `replace`, which swaps it in (keeping a
    /// disabled extension disabled).
    pub fn install(
        &self,
        vsix_path: &Path,
        replace: bool,
    ) -> Result<InstalledExtension, ExtensionError> {
        self.paths.ensure()?;
        let inspected = vsix::inspect(vsix_path)?;
        let manifest = inspected.manifest;
        let folder = ExtensionPaths::folder_name(&manifest);
        if !is_plain_folder_name(&folder) {
            return Err(ExtensionError::Manifest(format!(
                "\"{folder}\" is not a usable folder name"
            )));
        }
        let previous = self.find(&manifest.id()).ok();
        if let Some(existing) = &previous {
            if !replace {
                return Err(ExtensionError::AlreadyInstalled(format!(
                    "{} {}",
                    existing.id, existing.manifest.version
                )));
            }
        }
        let enabled = previous.as_ref().is_none_or(|existing| existing.enabled);
        let target = if enabled {
            self.paths.installed.join(&folder)
        } else {
            self.paths.disabled.join(&folder)
        };
        let staging = self
            .paths
            .staging
            .join(format!("{folder}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&staging);
        if let Err(error) = vsix::extract(vsix_path, &staging) {
            let _ = fs::remove_dir_all(&staging);
            return Err(error);
        }
        // The extracted manifest must be the one that was validated.
        let staged = fs::read_to_string(staging.join("package.json"))
            .map_err(|err| ExtensionError::io("Couldn't read the extracted package.json", err))
            .and_then(|text| Manifest::parse(&text));
        if let Err(error) = staged {
            let _ = fs::remove_dir_all(&staging);
            return Err(error);
        }
        if let Some(existing) = &previous {
            self.remove_folder(existing)?;
        }
        if let Err(err) = fs::rename(&staging, &target) {
            let _ = fs::remove_dir_all(&staging);
            return Err(ExtensionError::io(
                format!("Couldn't move the extension into {}", target.display()),
                err,
            ));
        }
        self.find(&manifest.id())
    }

    fn remove_folder(&self, extension: &InstalledExtension) -> Result<(), ExtensionError> {
        let base = if extension.enabled {
            &self.paths.installed
        } else {
            &self.paths.disabled
        };
        let target = ensure_inside(base, &extension.path)?;
        fs::remove_dir_all(&target)
            .map_err(|err| ExtensionError::io(format!("Couldn't remove {}", target.display()), err))
    }

    /// Deletes the extension's folder (only ever inside `installed/` or `disabled/`). Its own storage is
    /// kept, like VS Code does.
    pub fn uninstall(&self, id: &str) -> Result<(), ExtensionError> {
        let extension = self.find(id)?;
        self.remove_folder(&extension)
    }

    /// Enables or disables by moving the folder between `installed/` and `disabled/`.
    pub fn set_enabled(
        &self,
        id: &str,
        enabled: bool,
    ) -> Result<InstalledExtension, ExtensionError> {
        let extension = self.find(id)?;
        if extension.enabled == enabled {
            return Ok(extension);
        }
        self.paths.ensure()?;
        let (from_base, to_base) = if enabled {
            (&self.paths.disabled, &self.paths.installed)
        } else {
            (&self.paths.installed, &self.paths.disabled)
        };
        let source = ensure_inside(from_base, &extension.path)?;
        let target = to_base.join(&extension.folder);
        if target.exists() {
            return Err(ExtensionError::Refused(format!(
                "{} already exists, so {} can't be moved there.",
                target.display(),
                extension.id
            )));
        }
        fs::rename(&source, &target).map_err(|err| {
            ExtensionError::io(
                format!(
                    "Couldn't {} {} (is one of its files in use?)",
                    if enabled { "enable" } else { "disable" },
                    extension.id
                ),
                err,
            )
        })?;
        self.find(id)
    }

    /// A file inside an extension (a theme or snippet file), read as text. Only paths inside the
    /// extension's own folder, at most 2 MB.
    pub fn read_text(&self, id: &str, relative: &str) -> Result<String, ExtensionError> {
        const MAX: u64 = 2 * 1024 * 1024;
        let extension = self.find(id)?;
        let relative = vsix::safe_relative(relative)?.ok_or_else(|| ExtensionError::Path {
            path: PathBuf::from(relative),
            reason: "it names no file".into(),
        })?;
        let file = ensure_inside(&extension.path, &extension.path.join(relative))?;
        let meta = fs::metadata(&file)
            .map_err(|err| ExtensionError::io(format!("Couldn't read {}", file.display()), err))?;
        if !meta.is_file() || meta.len() > MAX {
            return Err(ExtensionError::Path {
                path: file,
                reason: "it isn't a file, or is larger than 2 MB".into(),
            });
        }
        fs::read_to_string(&file)
            .map_err(|err| ExtensionError::io(format!("Couldn't read {}", file.display()), err))
    }
}

/// The contribution point names of an extension that the app supports, for tests and the UI's summary.
pub fn supported_points(extension: &InstalledExtension) -> Vec<&str> {
    extension
        .points
        .iter()
        .filter(|point| point.support == Support::Supported)
        .map(|point| point.point.as_str())
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    struct Rig {
        _dir: tempfile::TempDir,
        store: ExtensionStore,
        root: PathBuf,
    }

    fn rig() -> Rig {
        let dir = tempfile::tempdir().expect("tempdir");
        let root = dir.path().join("My App").join("extensions");
        let store = ExtensionStore::new(ExtensionPaths::new(&root));
        store.paths().ensure().expect("layout");
        Rig {
            _dir: dir,
            store,
            root,
        }
    }

    fn make_vsix(root: &Path, name: &str, version: &str, extra: &str) -> PathBuf {
        let source = root.join(format!("src-{name}-{version}"));
        fs::create_dir_all(&source).expect("mkdir");
        fs::write(
            source.join("package.json"),
            format!(
                r#"{{"name":"{name}","version":"{version}","publisher":"acme","displayName":"{name} ext","main":"./extension.js"{extra}}}"#
            ),
        )
        .expect("manifest");
        fs::write(source.join("extension.js"), "exports.activate = () => {};").expect("code");
        fs::write(source.join("theme.json"), r#"{"colors":{}}"#).expect("theme");
        let out = root.join(format!("{name}-{version}.vsix"));
        vsix::pack(&source, &out).expect("packed");
        out
    }

    #[test]
    fn install_puts_the_extension_under_installed_and_lists_it() {
        let r = rig();
        let vsix = make_vsix(&r.root, "hello", "1.0.0", "");
        let installed = r.store.install(&vsix, false).expect("installed");
        assert_eq!(installed.id, "acme.hello");
        assert!(installed.enabled);
        assert_eq!(
            installed.path,
            r.root.join("installed").join("acme.hello-1.0.0")
        );
        assert!(installed.path.join("extension.js").is_file());
        assert_eq!(
            installed.runtime_requirement.as_deref(),
            Some(NODE_REQUIRED)
        );
        let listing = r.store.list();
        assert_eq!(listing.extensions.len(), 1);
        assert!(listing.broken.is_empty());
        assert!(
            fs::read_dir(&r.store.paths().staging)
                .map(|d| d.count())
                .unwrap_or(0)
                == 0,
            "staging is cleaned"
        );
    }

    #[test]
    fn installing_the_same_extension_again_is_refused_unless_replacing() {
        let r = rig();
        r.store
            .install(&make_vsix(&r.root, "hello", "1.0.0", ""), false)
            .expect("first");
        let again = r
            .store
            .install(&make_vsix(&r.root, "hello", "1.0.0", ""), false);
        assert!(
            matches!(again, Err(ExtensionError::AlreadyInstalled(ref id)) if id == "acme.hello 1.0.0")
        );
        let update = r
            .store
            .install(&make_vsix(&r.root, "hello", "1.1.0", ""), true)
            .expect("update");
        assert_eq!(update.manifest.version, "1.1.0");
        let listing = r.store.list();
        assert_eq!(listing.extensions.len(), 1, "the old version is gone");
        assert!(!r.root.join("installed").join("acme.hello-1.0.0").exists());
    }

    #[test]
    fn a_bad_archive_installs_nothing_and_leaves_no_staging_folder() {
        let r = rig();
        let bad = r.root.join("bad.vsix");
        fs::write(&bad, "nope").expect("write");
        assert!(r.store.install(&bad, false).is_err());
        assert!(r.store.list().extensions.is_empty());
        assert!(
            fs::read_dir(&r.store.paths().staging)
                .map(|d| d.count())
                .unwrap_or(0)
                == 0
        );
    }

    #[test]
    fn disabling_moves_the_folder_and_the_state_survives_a_new_store() {
        let r = rig();
        r.store
            .install(&make_vsix(&r.root, "hello", "1.0.0", ""), false)
            .expect("installed");

        let disabled = r.store.set_enabled("acme.hello", false).expect("disabled");
        assert!(!disabled.enabled);
        assert!(r.root.join("disabled").join("acme.hello-1.0.0").is_dir());
        assert!(!r.root.join("installed").join("acme.hello-1.0.0").exists());

        // A different store over the same folders (a restart) sees the same state.
        let restarted = ExtensionStore::new(ExtensionPaths::new(&r.root));
        assert!(!restarted.find("acme.hello").expect("found").enabled);

        let enabled = restarted.set_enabled("ACME.Hello", true).expect("enabled");
        assert!(enabled.enabled);
        assert!(r.root.join("installed").join("acme.hello-1.0.0").is_dir());
        // Enabling an enabled extension is a no-op.
        assert!(
            restarted
                .set_enabled("acme.hello", true)
                .expect("noop")
                .enabled
        );
    }

    #[test]
    fn a_disabled_extension_stays_disabled_when_it_is_updated() {
        let r = rig();
        r.store
            .install(&make_vsix(&r.root, "hello", "1.0.0", ""), false)
            .expect("installed");
        r.store.set_enabled("acme.hello", false).expect("disabled");
        let updated = r
            .store
            .install(&make_vsix(&r.root, "hello", "2.0.0", ""), true)
            .expect("update");
        assert!(!updated.enabled);
        assert!(r.root.join("disabled").join("acme.hello-2.0.0").is_dir());
    }

    #[test]
    fn uninstall_removes_only_that_extensions_folder() {
        let r = rig();
        r.store
            .install(&make_vsix(&r.root, "hello", "1.0.0", ""), false)
            .expect("a");
        r.store
            .install(&make_vsix(&r.root, "other", "1.0.0", ""), false)
            .expect("b");
        // An unrelated file next to them must survive.
        fs::write(r.root.join("installed").join("keep.txt"), "x").expect("keep");

        r.store.uninstall("acme.hello").expect("uninstalled");

        assert!(!r.root.join("installed").join("acme.hello-1.0.0").exists());
        assert!(r.root.join("installed").join("acme.other-1.0.0").is_dir());
        assert!(r.root.join("installed").join("keep.txt").is_file());
        assert!(matches!(
            r.store.uninstall("acme.hello"),
            Err(ExtensionError::NotInstalled(_))
        ));
    }

    #[test]
    fn a_disabled_extension_can_be_uninstalled_too() {
        let r = rig();
        r.store
            .install(&make_vsix(&r.root, "hello", "1.0.0", ""), false)
            .expect("a");
        r.store.set_enabled("acme.hello", false).expect("disabled");
        r.store.uninstall("acme.hello").expect("uninstalled");
        assert!(r.store.list().extensions.is_empty());
        assert!(fs::read_dir(r.root.join("disabled")).expect("dir").count() == 0);
    }

    #[test]
    fn ensure_inside_refuses_paths_outside_the_base() {
        let r = rig();
        let outside = r.root.parent().expect("parent").to_path_buf();
        assert!(ensure_inside(&r.root.join("installed"), &outside).is_err());
        assert!(
            ensure_inside(&r.root.join("installed"), &r.root.join("installed")).is_err(),
            "the base itself is not deletable"
        );
        assert!(ensure_inside(
            &r.root.join("installed"),
            &r.root.join("installed").join("nope")
        )
        .is_err());
    }

    #[test]
    fn broken_folders_are_reported_not_hidden_and_do_not_break_the_list() {
        let r = rig();
        r.store
            .install(&make_vsix(&r.root, "hello", "1.0.0", ""), false)
            .expect("a");
        fs::create_dir_all(r.root.join("installed").join("junk.folder-1.0.0")).expect("mkdir");
        fs::create_dir_all(r.root.join("disabled").join("bad.json-1.0.0")).expect("mkdir");
        fs::write(
            r.root
                .join("disabled")
                .join("bad.json-1.0.0")
                .join("package.json"),
            "{ nope",
        )
        .expect("write");
        let listing = r.store.list();
        assert_eq!(listing.extensions.len(), 1);
        assert_eq!(listing.broken.len(), 2);
        assert!(listing.broken.iter().any(|b| b.folder == "bad.json-1.0.0"
            && !b.enabled
            && b.error.contains("not valid JSON")));
        assert!(listing
            .broken
            .iter()
            .any(|b| b.folder == "junk.folder-1.0.0" && b.error.contains("can't be read")));
    }

    #[test]
    fn read_text_reads_only_inside_the_extension_folder() {
        let r = rig();
        r.store
            .install(&make_vsix(&r.root, "hello", "1.0.0", ""), false)
            .expect("a");
        assert_eq!(
            r.store
                .read_text("acme.hello", "./theme.json")
                .expect("read"),
            r#"{"colors":{}}"#
        );
        assert!(r
            .store
            .read_text("acme.hello", "../../installed/keep")
            .is_err());
        assert!(r.store.read_text("acme.hello", "missing.json").is_err());
        assert!(r.store.read_text("acme.nothing", "theme.json").is_err());
        assert!(r
            .store
            .read_text("acme.hello", "C:/Windows/win.ini")
            .is_err());
    }

    #[test]
    fn warnings_and_unsupported_points_are_reported() {
        let r = rig();
        let extra = r#","browser":"./web.js","activationEvents":["*","onDebug"],"extensionDependencies":["acme.base"],"contributes":{"grammars":[{"language":"x","scopeName":"s","path":"p"}],"commands":[{"command":"a.b","title":"B"}]}"#;
        let installed = r
            .store
            .install(&make_vsix(&r.root, "hello", "1.0.0", extra), false)
            .expect("a");
        let listing = r.store.list();
        let warnings = &listing.extensions[0].warnings;
        assert!(warnings.iter().any(|w| w.contains("every start-up")));
        assert!(warnings
            .iter()
            .any(|w| w.contains("\"onDebug\" isn't supported")));
        assert!(warnings.iter().any(|w| w.contains("Requires acme.base")));
        assert!(installed
            .points
            .iter()
            .any(|p| p.point == "grammars" && p.support == Support::Unsupported));
        assert_eq!(supported_points(&installed), ["commands"]);
        assert!(installed
            .activation_events
            .contains(&"onCommand:a.b".to_string()));
    }

    #[test]
    fn an_extension_without_code_has_no_runtime_requirement() {
        let r = rig();
        let source = r.root.join("themeonly");
        fs::create_dir_all(&source).expect("mkdir");
        fs::write(
            source.join("package.json"),
            r#"{"name":"tonly","version":"1.0.0","publisher":"acme"}"#,
        )
        .expect("w");
        let vsix = r.root.join("t.vsix");
        vsix::pack(&source, &vsix).expect("packed");
        assert_eq!(
            r.store
                .install(&vsix, false)
                .expect("ok")
                .runtime_requirement,
            None
        );
    }
}
