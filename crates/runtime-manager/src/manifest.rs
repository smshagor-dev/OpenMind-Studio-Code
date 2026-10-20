use std::collections::BTreeMap;
use std::path::Path;

use serde::{Deserialize, Serialize};

use crate::error::RuntimeError;

const BUILTIN: [&str; 34] = [
    include_str!("../manifests/node.json"),
    include_str!("../manifests/python.json"),
    include_str!("../manifests/git.json"),
    include_str!("../manifests/php.json"),
    include_str!("../manifests/fortran.json"),
    include_str!("../manifests/pascal.json"),
    include_str!("../manifests/pascalabc.json"),
    include_str!("../manifests/assembly.json"),
    include_str!("../manifests/composer.json"),
    include_str!("../manifests/mariadb.json"),
    include_str!("../manifests/phpmyadmin.json"),
    include_str!("../manifests/debugpy.json"),
    include_str!("../manifests/js-debug.json"),
    include_str!("../manifests/jdk.json"),
    include_str!("../manifests/maven.json"),
    include_str!("../manifests/gradle.json"),
    include_str!("../manifests/kotlin.json"),
    include_str!("../manifests/go.json"),
    include_str!("../manifests/cmake.json"),
    include_str!("../manifests/ninja.json"),
    include_str!("../manifests/llvm-mingw.json"),
    include_str!("../manifests/git-lfs.json"),
    include_str!("../manifests/kubectl.json"),
    include_str!("../manifests/terraform.json"),
    include_str!("../manifests/helm.json"),
    include_str!("../manifests/dotnet.json"),
    include_str!("../manifests/dart.json"),
    include_str!("../manifests/flutter.json"),
    include_str!("../manifests/android-cmdline-tools.json"),
    include_str!("../manifests/android-platform-tools.json"),
    include_str!("../manifests/sqlite.json"),
    include_str!("../manifests/postgresql.json"),
    include_str!("../manifests/livekit.json"),
    include_str!("../manifests/llamacpp.json"),
];

/// The platform id used in manifests for the machine this build runs on.
pub fn current_platform() -> &'static str {
    if cfg!(all(windows, target_arch = "x86_64")) {
        "windows-x64"
    } else if cfg!(all(target_os = "linux", target_arch = "x86_64")) {
        "linux-x64"
    } else if cfg!(all(target_os = "macos", target_arch = "aarch64")) {
        "macos-arm64"
    } else if cfg!(all(target_os = "macos", target_arch = "x86_64")) {
        "macos-x64"
    } else {
        "unsupported"
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ArchiveKind {
    Zip,
    /// A gzip-compressed tar (`js-debug`'s release). Same safety rules as a zip: every entry is
    /// validated, links are refused.
    #[serde(rename = "tar.gz")]
    TarGz,
    /// The download is the one file to install (Composer's `composer.phar`),
    /// stored under the artifact's `installAs` name.
    File,
    /// A Windows Installer package read as an archive (`msi_archive.rs`): its files are extracted, nothing is
    /// installed through Windows Installer.
    Msi,
    /// A conda-forge package (`.conda`: a zip holding a zstd-compressed tar of the files). Same checks as a zip.
    Conda,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Artifact {
    pub platform: String,
    pub url: String,
    /// Lowercase hex SHA256 of the archive, checked before anything is extracted.
    pub sha256: String,
    pub size_bytes: Option<u64>,
    pub archive: ArchiveKind,
    /// Leading path components to drop from every archive entry (e.g. the
    /// `node-v24-win-x64/` wrapper folder).
    #[serde(default)]
    pub strip_components: usize,
    /// If set, only this folder of the archive is installed (a NuGet package's
    /// `tools/`, say) and everything beside it is ignored.
    #[serde(default)]
    pub extract_root: Option<String>,
    /// For `archive: "file"`: the file name it is installed as.
    #[serde(default)]
    pub install_as: Option<String>,
    /// Other https addresses of the same file, tried in order when the main one fails. The checksum is the same,
    /// so a mirror can't hand over a different file.
    #[serde(default)]
    pub mirrors: Vec<String>,
    /// Bytes on disk after extraction (measured from the archive), for size estimates before anything downloads.
    #[serde(default)]
    pub install_bytes: Option<u64>,
    /// The code page of entry names stored without the ZIP UTF-8 flag (`"cp866"`); ASCII and UTF-8 names are kept.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name_encoding: Option<crate::entry_names::NameEncoding>,
}

impl Artifact {
    /// The main address, then the mirrors.
    pub fn urls(&self) -> Vec<String> {
        std::iter::once(self.url.clone())
            .chain(self.mirrors.iter().cloned())
            .collect()
    }
}

/// A small config file written into a fresh install (PHP's `php.ini`). Content
/// is static text from the manifest and may only use paths relative to the
/// install, so an install stays valid when the app folder moves.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SeedFile {
    /// Path relative to the install dir.
    pub path: String,
    pub content: String,
}

/// A command run once, from the freshly installed and checksum-verified
/// runtime itself, to finish setting it up (e.g. `python -m ensurepip`).
/// Runs in the install dir; a failure fails the whole install.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PostInstallStep {
    pub description: String,
    /// Path of the executable relative to the install dir.
    pub executable: String,
    pub args: Vec<String>,
}

/// A tiny launcher generated per installed version so a command keeps working
/// when the whole app folder is moved: it locates its runtime relative to
/// itself, unlike launchers a tool generates with an absolute path baked in.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Shim {
    /// The command name (`pip`), without extension.
    pub name: String,
    /// Executable to run, relative to the install dir.
    pub target: String,
    /// Fixed arguments placed before the caller's own (`-m pip`).
    #[serde(default)]
    pub args: Vec<String>,
    /// Run the target through the interpreter named by this environment
    /// variable (`OPENMIND_PHP` for Composer's phar). The variable is set
    /// per launch from the *active* install, so nothing absolute is written.
    #[serde(default)]
    pub via_env: Option<String>,
    /// The environment variable that may hold a proxy address for this command only (`OPENMIND_COMPOSER_PROXY`: the
    /// gateway's tunnel for Composer). The launcher sets `HTTPS_PROXY` from it inside its own scope, so the variable
    /// never reaches the shell that called it or any other program.
    #[serde(default)]
    pub proxy_env: Option<String>,
    /// Folders of the install (relative) put in front of PATH for this command only, inside the launcher's own scope:
    /// a toolchain whose programs call each other (gcc runs `as` and `ld`) works without its whole `bin` folder being
    /// on every terminal's PATH.
    #[serde(default)]
    pub path_dirs: Vec<String>,
}

/// A capability of a runtime that an install may or may not have (pip for
/// Python). Reported per installed version by checking `verify_file` exists,
/// so the UI never claims support the install doesn't actually have.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Feature {
    pub id: String,
    pub label: String,
    pub verify_file: String,
    /// Shown when the file is absent — why this install lacks the feature.
    #[serde(default)]
    pub missing_note: String,
}

/// An optional part installed *into* an installed version of a runtime, from its own pinned download (Tcl/Tk for
/// Python's tkinter). Only files the install doesn't have yet are added, the list of them is recorded, and removing
/// the add-on deletes exactly those files.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Addon {
    pub id: String,
    pub label: String,
    pub description: String,
    /// Relative to the install: present means the add-on is there.
    pub verify_file: String,
    pub artifacts: Vec<Artifact>,
    #[serde(default)]
    pub license: Option<License>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeVersion {
    pub version: String,
    pub artifacts: Vec<Artifact>,
    /// Replaces the manifest's `seedFiles` for this version (PHP 8.0/8.1 have
    /// zip built in, so their `php.ini` must not load `php_zip.dll`).
    #[serde(default)]
    pub seed_files: Vec<SeedFile>,
    /// Optional parts for this exact version (see [`Addon`]).
    #[serde(default)]
    pub addons: Vec<Addon>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VersionCommand {
    /// Path of the executable relative to the install dir.
    pub executable: String,
    pub args: Vec<String>,
    /// Text the tool prints before the version number ("v", "Python ", ...).
    #[serde(default)]
    pub output_prefix: String,
}

/// The licence of a runtime's download. `acceptanceRequired` means the vendor's terms must be accepted before
/// the download (Android SDK): the install is refused until the user has accepted them.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct License {
    pub name: String,
    pub url: String,
    #[serde(default)]
    pub acceptance_required: bool,
}

fn yes() -> bool {
    true
}

/// One runtime kind, described entirely as data: where to get it, how to
/// check an install is intact, which folders go on PATH. Adding Go, Java, ...
/// later is a new manifest file, not a change to the manager.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeManifest {
    pub id: String,
    pub display_name: String,
    pub description: String,
    pub default_version: String,
    pub version_command: VersionCommand,
    /// Directories, relative to the install dir, prepended to PATH for launched processes.
    pub bin_dirs: Vec<String>,
    /// Files that must exist for an install to count as healthy (and repairs check).
    pub verify_files: Vec<String>,
    /// Extra environment variables for launched processes.
    #[serde(default)]
    pub env: BTreeMap<String, String>,
    #[serde(default)]
    pub notes: String,
    /// Run in order, after the archive is in place, before the install counts.
    #[serde(default)]
    pub post_install: Vec<PostInstallStep>,
    #[serde(default)]
    pub features: Vec<Feature>,
    /// Command launchers generated after install (see [`Shim`]). Their folder
    /// goes first on the injected PATH.
    #[serde(default)]
    pub shims: Vec<Shim>,
    /// Files written into every fresh install before it is checked.
    #[serde(default)]
    pub seed_files: Vec<SeedFile>,
    /// Other runtimes this one needs to work (Maven needs a JDK). Shown, and added by the workload installer.
    #[serde(default)]
    pub requires: Vec<String>,
    #[serde(default)]
    pub license: Option<License>,
    /// Ask a copy on the system PATH for its version when listing. Off for tools whose version command is slow
    /// or can start work of its own (a system Flutter may download on `--version`).
    #[serde(default = "yes")]
    pub probe_system: bool,
    pub versions: Vec<RuntimeVersion>,
}

impl RuntimeManifest {
    pub fn parse(json: &str) -> Result<Self, RuntimeError> {
        let manifest: Self = serde_json::from_str(json)
            .map_err(|err| RuntimeError::InvalidManifest(err.to_string()))?;
        manifest.validate()?;
        Ok(manifest)
    }

    pub fn artifact(&self, version: &str, platform: &str) -> Option<&Artifact> {
        self.versions
            .iter()
            .find(|candidate| candidate.version == version)?
            .artifacts
            .iter()
            .find(|artifact| artifact.platform == platform)
    }

    /// Why an install can't start yet: the vendor's terms must be accepted first (`None` = it may start).
    pub fn license_blocker(&self, accepted: bool) -> Option<String> {
        self.license
            .as_ref()
            .filter(|license| license.acceptance_required && !accepted)
            .map(|license| {
                format!(
                    "Accept the {} ({}) to install {}.",
                    license.name, license.url, self.display_name
                )
            })
    }

    /// Download and install size of `version` for `platform` (`None` when unknown).
    pub fn sizes(&self, version: &str, platform: &str) -> (Option<u64>, Option<u64>) {
        self.artifact(version, platform)
            .map_or((None, None), |a| (a.size_bytes, a.install_bytes))
    }

    /// Versions that actually have a download for `platform`, in manifest order.
    pub fn versions_for(&self, platform: &str) -> Vec<&str> {
        self.versions
            .iter()
            .filter(|version| version.artifacts.iter().any(|a| a.platform == platform))
            .map(|version| version.version.as_str())
            .collect()
    }

    fn validate(&self) -> Result<(), RuntimeError> {
        let bad = |message: String| {
            Err(RuntimeError::InvalidManifest(format!(
                "{}: {message}",
                self.id
            )))
        };
        if !is_safe_component(&self.id) {
            return Err(RuntimeError::InvalidManifest(format!(
                "\"{}\" is not a valid runtime id",
                self.id
            )));
        }
        if self.versions.is_empty() {
            return bad("no versions".into());
        }
        if !self
            .versions
            .iter()
            .any(|v| v.version == self.default_version)
        {
            return bad(format!(
                "default version {} isn't listed",
                self.default_version
            ));
        }
        for path in self
            .bin_dirs
            .iter()
            .chain(&self.verify_files)
            .chain(self.post_install.iter().map(|step| &step.executable))
            .chain(self.features.iter().map(|feature| &feature.verify_file))
            .chain(self.shims.iter().map(|shim| &shim.target))
            .chain(self.seed_files.iter().map(|file| &file.path))
            .chain(std::iter::once(&self.version_command.executable))
        {
            if !is_safe_relative(path) {
                return bad(format!(
                    "\"{path}\" must be a relative path inside the install"
                ));
            }
        }
        for shim in &self.shims {
            let plain = |arg: &str| {
                !arg.is_empty()
                    && arg
                        .chars()
                        .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.' | '='))
            };
            let variable = |name: &Option<String>| {
                name.as_deref().is_none_or(|name| {
                    !name.is_empty()
                        && name
                            .chars()
                            .all(|c| c.is_ascii_uppercase() || c.is_ascii_digit() || c == '_')
                })
            };
            if !variable(&shim.via_env) || !variable(&shim.proxy_env) {
                return bad(format!(
                    "shim \"{}\": viaEnv and proxyEnv must be upper-case variable names",
                    shim.name
                ));
            }
            // Written into a script: a plain relative path only (no quotes, `%`, `&`, `;`).
            let plain_dir = |dir: &String| {
                is_safe_relative(dir)
                    && dir.chars().all(|c| {
                        c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.' | '/' | '+')
                    })
            };
            if !shim.path_dirs.iter().all(plain_dir) {
                return bad(format!(
                    "shim \"{}\": pathDirs must be plain relative folders inside the install",
                    shim.name
                ));
            }
            if !is_safe_component(&shim.name) || !shim.args.iter().all(|arg| plain(arg)) {
                return bad(format!(
                    "shim \"{}\": names and arguments may only use letters, digits and - _ . =",
                    shim.name
                ));
            }
        }
        if self.verify_files.is_empty() {
            return bad("verifyFiles is empty, so an install could never be checked".into());
        }
        if let Some(required) = self.requires.iter().find(|id| !is_safe_component(id)) {
            return bad(format!("requires \"{required}\" is not a runtime id"));
        }
        if let Some(license) = &self.license {
            if license.name.trim().is_empty()
                || !license.url.to_ascii_lowercase().starts_with("https://")
            {
                return bad("license needs a name and an https:// url".into());
            }
        }
        for version in &self.versions {
            if version
                .seed_files
                .iter()
                .any(|file| !is_safe_relative(&file.path))
            {
                return bad(format!(
                    "{}: seedFiles paths must be relative paths inside the install",
                    version.version
                ));
            }
            if !is_safe_component(&version.version) {
                return bad(format!("\"{}\" is not a valid version", version.version));
            }
            for artifact in &version.artifacts {
                validate_artifact(artifact, &version.version).map_err(|err| self.named(err))?;
            }
            for addon in &version.addons {
                validate_addon(addon, &version.version).map_err(|err| self.named(err))?;
            }
        }
        Ok(())
    }

    /// Prefixes a manifest error with this runtime's id.
    fn named(&self, error: RuntimeError) -> RuntimeError {
        match error {
            RuntimeError::InvalidManifest(message) => {
                RuntimeError::InvalidManifest(format!("{}: {message}", self.id))
            }
            other => other,
        }
    }
}

fn invalid_manifest(message: String) -> RuntimeError {
    RuntimeError::InvalidManifest(message)
}

fn validate_artifact(artifact: &Artifact, version: &str) -> Result<(), RuntimeError> {
    if let Some(root) = &artifact.extract_root {
        if !is_safe_relative(root) || root == "." {
            return Err(invalid_manifest(format!(
                "extractRoot \"{root}\" must be a folder name"
            )));
        }
    }
    match (artifact.archive, artifact.install_as.as_deref()) {
        (ArchiveKind::File, Some(name)) if is_safe_component(name) => {}
        (ArchiveKind::File, _) => {
            return Err(invalid_manifest(
                "a \"file\" artifact needs a plain installAs file name".into(),
            ));
        }
        (ArchiveKind::Zip | ArchiveKind::TarGz | ArchiveKind::Msi | ArchiveKind::Conda, None) => {}
        (
            ArchiveKind::Zip | ArchiveKind::TarGz | ArchiveKind::Msi | ArchiveKind::Conda,
            Some(_),
        ) => {
            return Err(invalid_manifest(
                "installAs only applies to \"file\" artifacts".into(),
            ));
        }
    }
    for url in artifact.urls() {
        if !url.to_ascii_lowercase().starts_with("https://") {
            return Err(RuntimeError::InsecureUrl(url));
        }
    }
    let hash = &artifact.sha256;
    if hash.len() != 64 || !hash.chars().all(|c| c.is_ascii_hexdigit()) {
        return Err(invalid_manifest(format!(
            "{version} {}: sha256 must be 64 hex characters",
            artifact.platform
        )));
    }
    Ok(())
}

fn validate_addon(addon: &Addon, version: &str) -> Result<(), RuntimeError> {
    let bad = |message: &str| {
        Err(invalid_manifest(format!(
            "{version} add-on \"{}\": {message}",
            addon.id
        )))
    };
    if !is_safe_component(&addon.id) {
        return bad("the id may only use letters, digits and . - _ +");
    }
    if addon.label.trim().is_empty()
        || !is_safe_relative(&addon.verify_file)
        || addon.verify_file == "."
    {
        return bad("needs a label and a verifyFile inside the install");
    }
    if addon.artifacts.is_empty() {
        return bad("has no download");
    }
    if let Some(license) = &addon.license {
        if license.name.trim().is_empty()
            || !license.url.to_ascii_lowercase().starts_with("https://")
        {
            return bad("license needs a name and an https:// url");
        }
    }
    for artifact in &addon.artifacts {
        if artifact.archive == ArchiveKind::File {
            return bad("an add-on must be an archive (zip, tar.gz or msi)");
        }
        validate_artifact(artifact, version)?;
    }
    Ok(())
}

/// A single folder name that can't escape its parent: no separators, no `..`.
pub(crate) fn is_safe_component(name: &str) -> bool {
    !name.is_empty()
        && name != "."
        && name != ".."
        && name
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | '_' | '+'))
        && !name.starts_with('.')
}

/// A relative path with only normal components ("." alone is fine).
fn is_safe_relative(path: &str) -> bool {
    if path == "." {
        return true;
    }
    let path = Path::new(path);
    !path.as_os_str().is_empty()
        && path
            .components()
            .all(|c| matches!(c, std::path::Component::Normal(_)))
        && !path.to_string_lossy().contains(':')
}

#[derive(Debug, Clone, Default)]
pub struct RuntimeRegistry {
    manifests: BTreeMap<String, RuntimeManifest>,
}

impl RuntimeRegistry {
    pub fn builtin() -> Self {
        let mut registry = Self::default();
        for json in BUILTIN {
            // The built-in manifests are compile-time constants covered by tests.
            if let Ok(manifest) = RuntimeManifest::parse(json) {
                registry.manifests.insert(manifest.id.clone(), manifest);
            }
        }
        registry
    }

    pub fn from_manifests(manifests: Vec<RuntimeManifest>) -> Self {
        Self {
            manifests: manifests.into_iter().map(|m| (m.id.clone(), m)).collect(),
        }
    }

    /// Adds/replaces definitions from `*.json` files in `dir`. A broken file
    /// is skipped and reported, never fatal — a bad override must not take
    /// the built-in runtimes down with it.
    pub fn with_overrides(mut self, dir: &Path) -> (Self, Vec<String>) {
        let mut warnings = Vec::new();
        let Ok(entries) = std::fs::read_dir(dir) else {
            return (self, warnings);
        };
        let mut files: Vec<_> = entries
            .filter_map(Result::ok)
            .map(|entry| entry.path())
            .filter(|path| path.extension().is_some_and(|ext| ext == "json"))
            .collect();
        files.sort();
        for path in files {
            match std::fs::read_to_string(&path)
                .map_err(|err| err.to_string())
                .and_then(|text| RuntimeManifest::parse(&text).map_err(|err| err.to_string()))
            {
                Ok(manifest) => {
                    self.manifests.insert(manifest.id.clone(), manifest);
                }
                Err(err) => warnings.push(format!("{}: {err}", path.display())),
            }
        }
        (self, warnings)
    }

    pub fn get(&self, id: &str) -> Result<&RuntimeManifest, RuntimeError> {
        self.manifests
            .get(id)
            .ok_or_else(|| RuntimeError::UnknownRuntime(id.to_string()))
    }

    pub fn all(&self) -> impl Iterator<Item = &RuntimeManifest> {
        self.manifests.values()
    }
}

#[cfg(test)]
#[path = "manifest_tests.rs"]
mod tests;
