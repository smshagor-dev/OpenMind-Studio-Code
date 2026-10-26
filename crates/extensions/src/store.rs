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
use crate::permissions::{self, PermissionSet};
use crate::vsix::{self, Limits};

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
    pub permissions: PermissionSet,
    /// False when it asks for a newer VS Code engine than the host's API subset.
    pub engine_supported: bool,
    /// The user chose to run it although its engine isn't supported (see `engine_override`).
    pub run_anyway: bool,
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
    let engine_supported = crate::manifest::engine_compatible(&manifest);
    let run_anyway = !engine_supported && crate::engine_override::allowed(&path, &manifest);
    if !engine_supported {
        let engine = manifest.engines_vscode.as_deref().unwrap_or("unknown");
        let api = crate::manifest::EXTENSION_API_VERSION;
        warnings.push(if run_anyway {
            format!("Requires VS Code engine {engine}; OpenMind Studio has a {api} API subset. Running anyway at your request: a VS Code API it lacks fails when the extension calls it.")
        } else {
            format!("Requires VS Code engine {engine}, but OpenMind Studio currently exposes a {api} API subset. It isn't started unless you choose Run Anyway.")
        });
    }
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
    for event in &manifest.activation_events {
        if let ActivationEvent::OnView(view) = event {
            if !manifest.contributes.views.view_ids().any(|id| id == view) {
                warnings.push(format!(
                    "Activation event \"onView:{view}\" names a view that isn't shown, so it never triggers."
                ));
            }
        }
    }
    if manifest.browser.is_some() && manifest.main.is_none() {
        warnings.push("It only has a web (browser) entry, which isn't supported yet.".to_string());
    }
    let inferred = permissions::infer(&manifest.contributes);
    let permission_set = if path.as_os_str().is_empty() {
        permissions::for_install(&manifest.requested_permissions, &inferred)
    } else {
        permissions::for_installed(&manifest.requested_permissions, &inferred, &path)
    };
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
        permissions: permission_set,
        engine_supported,
        run_anyway,
        manifest,
    }
}

/// The files a manifest points at must exist in the package (a theme, a snippets file, an icon, the entry
/// point — for which VS Code allows leaving out `.js`).
fn check_files(dir: &Path, manifest: &Manifest) -> Result<(), ExtensionError> {
    let missing = |what: &str, path: &str| {
        ExtensionError::Manifest(format!("{what} \"{path}\" is missing from the package"))
    };
    let exists = |path: &str| dir.join(path.trim_start_matches("./")).exists();
    for theme in &manifest.contributes.themes {
        if !exists(&theme.path) {
            return Err(missing("the theme file", &theme.path));
        }
    }
    for snippets in &manifest.contributes.snippets {
        if !exists(&snippets.path) {
            return Err(missing("the snippets file", &snippets.path));
        }
    }
    if let Some(main) = &manifest.main {
        if !exists(main) && !exists(&format!("{main}.js")) {
            return Err(missing("the entry point", main));
        }
    }
    Ok(())
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
    limits: Limits,
}

impl ExtensionStore {
    pub fn new(paths: ExtensionPaths) -> Self {
        Self {
            paths,
            limits: Limits::default(),
        }
    }

    /// A store with other archive limits (tests use tiny ones).
    pub fn with_limits(mut self, limits: Limits) -> Self {
        self.limits = limits;
        self
    }

    pub fn paths(&self) -> &ExtensionPaths {
        &self.paths
    }

    /// Adds the extensions in `dir`. A folder that doesn't exist holds none; one that exists but can't be listed is
    /// an error, so a caller that must not mistake "can't tell" for "nothing installed" can tell them apart.
    fn scan(&self, dir: &Path, enabled: bool, into: &mut Listing) -> Result<(), String> {
        let entries = match fs::read_dir(dir) {
            Ok(entries) => entries,
            Err(err) if err.kind() == std::io::ErrorKind::NotFound => return Ok(()),
            Err(err) => return Err(format!("{} can't be listed: {err}", dir.display())),
        };
        for entry in entries.filter_map(Result::ok) {
            let path = entry.path();
            if !path.is_dir() {
                continue;
            }
            let folder = entry.file_name().to_string_lossy().into_owned();
            let manifest = fs::read_to_string(path.join("package.json"))
                .map_err(|err| format!("package.json can't be read: {err}"))
                .and_then(|text| {
                    let nls = fs::read_to_string(path.join("package.nls.json")).ok();
                    Manifest::parse_localized(&text, nls.as_deref()).map_err(|err| err.to_string())
                });
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
        Ok(())
    }

    /// Everything installed, enabled first-class: sorted by display name. Missing dependencies are
    /// added to each extension's warnings.
    pub fn list(&self) -> Listing {
        self.collect(false).unwrap_or_default()
    }

    /// [`ExtensionStore::list`], or why the extension folders can't be listed right now (instead of listing nothing).
    pub fn try_list(&self) -> Result<Listing, String> {
        self.collect(true)
    }

    fn collect(&self, strict: bool) -> Result<Listing, String> {
        let mut listing = Listing::default();
        for (dir, enabled) in [(&self.paths.installed, true), (&self.paths.disabled, false)] {
            if let Err(err) = self.scan(dir, enabled, &mut listing) {
                if strict {
                    return Err(err);
                }
                tracing::warn!(%err, "an extension folder couldn't be listed");
            }
        }
        let dependencies: std::collections::HashMap<String, bool> = listing
            .extensions
            .iter()
            .map(|extension| (extension.id.clone(), extension.enabled))
            .collect();
        for extension in &mut listing.extensions {
            for dependency in &extension.manifest.extension_dependencies {
                match dependencies.get(&dependency.to_lowercase()) {
                    None => extension
                        .warnings
                        .push(format!("Requires {dependency}, which isn't installed.")),
                    Some(false) => extension
                        .warnings
                        .push(format!("Requires {dependency}, which is disabled.")),
                    Some(true) => {}
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
        // Two enabled extensions contributing one command id: the first (in this order) keeps it.
        let mut owners: std::collections::HashMap<String, String> =
            std::collections::HashMap::new();
        for extension in listing.extensions.iter_mut().filter(|e| e.enabled) {
            for command in extension.manifest.contributes.commands.clone() {
                match owners.get(&command.command) {
                    Some(owner) if *owner != extension.id => extension.warnings.push(format!(
                        "Its command \"{}\" is already contributed by {owner}, which keeps it.",
                        command.command
                    )),
                    Some(_) => {}
                    None => {
                        owners.insert(command.command, extension.id.clone());
                    }
                }
            }
        }
        listing.broken.sort_by(|a, b| a.folder.cmp(&b.folder));
        Ok(listing)
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
        let inspected = vsix::inspect_with(vsix_path, &self.limits)?;
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
        // Unique per install: the extensions folder can be shared by several computers, whose process ids may match.
        let unique = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or_default();
        let staging = self
            .paths
            .staging
            .join(format!("{folder}-{}-{unique}", std::process::id()));
        let _ = fs::remove_dir_all(&staging);
        if let Err(error) = vsix::extract_with(vsix_path, &staging, &self.limits) {
            let _ = fs::remove_dir_all(&staging);
            return Err(error);
        }
        // The extracted manifest must be the one that was validated.
        let staged = fs::read_to_string(staging.join("package.json"))
            .map_err(|err| ExtensionError::io("Couldn't read the extracted package.json", err))
            .and_then(|text| {
                let nls = fs::read_to_string(staging.join("package.nls.json")).ok();
                Manifest::parse_localized(&text, nls.as_deref())
            });
        // A package can't bring grants, an accepted list or a "Run anyway" of its own.
        for file in permissions::APP_ONLY_FILES {
            let _ = fs::remove_file(staging.join(file));
        }
        let checked = staged
            .and_then(|staged| check_files(&staging, &staged))
            .and_then(|()| {
                let inferred = permissions::infer(&manifest.contributes);
                let accepted = permissions::for_install(&manifest.requested_permissions, &inferred);
                permissions::store_accepted(&staging, &accepted.accepted)
            });
        if let Err(error) = checked {
            let _ = fs::remove_dir_all(&staging);
            return Err(error);
        }
        let backup = self
            .paths
            .staging
            .join(format!("{folder}-backup-{}-{unique}", std::process::id()));
        if let Some(existing) = &previous {
            let base = if existing.enabled {
                &self.paths.installed
            } else {
                &self.paths.disabled
            };
            let source = ensure_inside(base, &existing.path)?;
            if let Err(err) = fs::rename(&source, &backup) {
                let _ = fs::remove_dir_all(&staging);
                return Err(ExtensionError::io(
                    "Couldn't back up the installed extension",
                    err,
                ));
            }
        }
        if let Err(err) = fs::rename(&staging, &target) {
            if previous.is_some() {
                if let Err(restore_error) = fs::rename(&backup, &target) {
                    return Err(ExtensionError::Refused(format!(
                        "Extension replacement failed: {err}; restoring the previous version also failed: {restore_error}. Backup remains at {}",
                        backup.display()
                    )));
                }
            }
            let _ = fs::remove_dir_all(&staging);
            return Err(ExtensionError::io(
                format!("Couldn't move the extension into {}", target.display()),
                err,
            ));
        }
        if previous.is_some() {
            if let Err(err) = fs::remove_dir_all(&backup) {
                tracing::warn!(path = %backup.display(), %err, "couldn't remove extension backup");
            }
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

    /// Adds a permission the user chose to give (see `permissions::USER_GRANTABLE`) and returns the extension.
    pub fn grant_permission(
        &self,
        id: &str,
        permission: permissions::Permission,
    ) -> Result<InstalledExtension, ExtensionError> {
        let extension = self.find(id)?;
        let folder = match &extension.path {
            path if path.is_dir() => path.clone(),
            _ => return Err(ExtensionError::NotInstalled(id.to_string())),
        };
        let inferred = permissions::infer(&extension.manifest.contributes);
        permissions::grant(
            &folder,
            &extension.manifest.requested_permissions,
            &inferred,
            permission,
        )?;
        self.find(id)
    }

    /// Records whether the user lets this extension run although its VS Code engine is newer than the host's.
    pub fn set_run_anyway(
        &self,
        id: &str,
        allow: bool,
    ) -> Result<InstalledExtension, ExtensionError> {
        let extension = self.find(id)?;
        if !extension.path.is_dir() {
            return Err(ExtensionError::NotInstalled(id.to_string()));
        }
        if allow && extension.engine_supported {
            return Err(ExtensionError::Refused(format!(
                "{id} already runs: its VS Code engine is supported."
            )));
        }
        crate::engine_override::set(&extension.path, &extension.manifest, allow)?;
        self.find(id)
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
#[path = "store_tests.rs"]
mod tests;
