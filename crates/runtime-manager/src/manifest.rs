use std::collections::BTreeMap;
use std::path::Path;

use serde::{Deserialize, Serialize};

use crate::error::RuntimeError;

const BUILTIN: [&str; 7] = [
    include_str!("../manifests/node.json"),
    include_str!("../manifests/python.json"),
    include_str!("../manifests/git.json"),
    include_str!("../manifests/php.json"),
    include_str!("../manifests/composer.json"),
    include_str!("../manifests/mariadb.json"),
    include_str!("../manifests/phpmyadmin.json"),
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
    /// The download is the one file to install (Composer's `composer.phar`),
    /// stored under the artifact's `installAs` name.
    File,
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

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeVersion {
    pub version: String,
    pub artifacts: Vec<Artifact>,
    /// Replaces the manifest's `seedFiles` for this version (PHP 8.0/8.1 have
    /// zip built in, so their `php.ini` must not load `php_zip.dll`).
    #[serde(default)]
    pub seed_files: Vec<SeedFile>,
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
            let via_ok = shim.via_env.as_deref().is_none_or(|name| {
                !name.is_empty()
                    && name
                        .chars()
                        .all(|c| c.is_ascii_uppercase() || c.is_ascii_digit() || c == '_')
            });
            if !via_ok {
                return bad(format!(
                    "shim \"{}\": viaEnv must be an upper-case variable name",
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
                if let Some(root) = &artifact.extract_root {
                    if !is_safe_relative(root) || root == "." {
                        return bad(format!("extractRoot \"{root}\" must be a folder name"));
                    }
                }
                match (artifact.archive, artifact.install_as.as_deref()) {
                    (ArchiveKind::File, Some(name)) if is_safe_component(name) => {}
                    (ArchiveKind::File, _) => {
                        return bad("a \"file\" artifact needs a plain installAs file name".into());
                    }
                    (ArchiveKind::Zip, None) => {}
                    (ArchiveKind::Zip, Some(_)) => {
                        return bad("installAs only applies to \"file\" artifacts".into());
                    }
                }
                if !artifact.url.to_ascii_lowercase().starts_with("https://") {
                    return Err(RuntimeError::InsecureUrl(artifact.url.clone()));
                }
                let hash = &artifact.sha256;
                if hash.len() != 64 || !hash.chars().all(|c| c.is_ascii_hexdigit()) {
                    return bad(format!(
                        "{} {}: sha256 must be 64 hex characters",
                        version.version, artifact.platform
                    ));
                }
            }
        }
        Ok(())
    }
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
mod tests {
    use super::*;

    fn valid_json() -> String {
        r#"{
          "id": "demo", "displayName": "Demo", "description": "d", "defaultVersion": "1.0.0",
          "versionCommand": { "executable": "demo.exe", "args": ["--version"] },
          "binDirs": ["."], "verifyFiles": ["demo.exe"],
          "versions": [ { "version": "1.0.0", "artifacts": [
            { "platform": "windows-x64", "url": "https://example.com/demo.zip",
              "sha256": "0000000000000000000000000000000000000000000000000000000000000000",
              "archive": "zip" } ] } ]
        }"#
        .to_string()
    }

    #[test]
    fn builtin_registry_has_the_shipped_runtimes_with_usable_windows_artifacts() {
        let registry = RuntimeRegistry::builtin();

        for id in [
            "node",
            "python",
            "git",
            "php",
            "composer",
            "mariadb",
            "phpmyadmin",
        ] {
            let manifest = registry.get(id).expect(id);
            assert!(
                manifest
                    .artifact(&manifest.default_version, "windows-x64")
                    .is_some(),
                "{id}"
            );
        }
        assert_eq!(registry.all().count(), 7);
    }

    #[test]
    fn the_php_manifest_is_portable_https_only_and_uses_a_relative_php_ini() {
        let registry = RuntimeRegistry::builtin();
        let php = registry.get("php").expect("php");

        assert_eq!(
            php.env.get("OPENMIND_PHP").map(String::as_str),
            Some("{dir}\\php.exe")
        );
        assert!(php.verify_files.iter().any(|file| file == "php.ini"));
        let ini = php
            .seed_files
            .iter()
            .find(|f| f.path == "php.ini")
            .expect("php.ini");
        assert!(
            ini.content.contains("extension_dir = \"ext\""),
            "relative extension dir"
        );
        assert!(
            !ini.content.contains(":\\"),
            "no absolute path may be baked in"
        );
        for version in &php.versions {
            for artifact in &version.artifacts {
                assert!(artifact.url.starts_with("https://downloads.php.net/"));
                assert_eq!(artifact.sha256.len(), 64);
            }
        }
    }

    #[test]
    fn the_composer_manifest_installs_one_phar_and_runs_it_through_the_active_php() {
        let registry = RuntimeRegistry::builtin();
        let composer = registry.get("composer").expect("composer");
        let artifact = composer
            .artifact(&composer.default_version, "windows-x64")
            .expect("artifact");

        assert_eq!(artifact.archive, ArchiveKind::File);
        assert_eq!(artifact.install_as.as_deref(), Some("composer.phar"));
        assert_eq!(composer.shims[0].name, "composer");
        assert_eq!(composer.shims[0].via_env.as_deref(), Some("OPENMIND_PHP"));
    }

    #[test]
    fn a_file_artifact_needs_a_plain_install_name_and_a_zip_may_not_have_one() {
        let file = valid_json().replace("\"archive\": \"zip\"", "\"archive\": \"file\"");
        assert!(
            RuntimeManifest::parse(&file).is_err(),
            "file without installAs"
        );
        let traversal = valid_json().replace(
            "\"archive\": \"zip\"",
            "\"archive\": \"file\", \"installAs\": \"../x\"",
        );
        assert!(RuntimeManifest::parse(&traversal).is_err());
        let stray = valid_json().replace(
            "\"archive\": \"zip\"",
            "\"archive\": \"zip\", \"installAs\": \"x.phar\"",
        );
        assert!(RuntimeManifest::parse(&stray).is_err());
    }

    #[test]
    fn a_seed_file_path_and_a_shim_variable_are_validated() {
        let escaping = valid_json().replace(
            "\"versions\"",
            "\"seedFiles\": [{ \"path\": \"../php.ini\", \"content\": \"x\" }], \"versions\"",
        );
        assert!(RuntimeManifest::parse(&escaping).is_err());
        let bad_var = valid_json().replace(
            "\"versions\"",
            "\"shims\": [{ \"name\": \"t\", \"target\": \"t.exe\", \"viaEnv\": \"php; calc\" }], \"versions\"",
        );
        assert!(RuntimeManifest::parse(&bad_var).is_err());
    }

    #[test]
    fn parses_a_valid_manifest_with_defaults() {
        let manifest = RuntimeManifest::parse(&valid_json()).expect("parse");

        assert_eq!(manifest.id, "demo");
        let artifact = manifest.artifact("1.0.0", "windows-x64").expect("artifact");
        assert_eq!(artifact.strip_components, 0);
        assert!(manifest.env.is_empty());
        assert!(manifest.artifact("1.0.0", "linux-x64").is_none());
        assert_eq!(manifest.versions_for("windows-x64"), vec!["1.0.0"]);
        assert!(manifest.versions_for("linux-x64").is_empty());
    }

    #[test]
    fn rejects_http_urls() {
        let json = valid_json().replace("https://", "http://");

        assert!(matches!(
            RuntimeManifest::parse(&json),
            Err(RuntimeError::InsecureUrl(_))
        ));
    }

    #[test]
    fn rejects_bad_checksums_ids_and_paths() {
        for json in [
            valid_json().replace(&"0".repeat(64), "abc"),
            valid_json().replace("\"id\": \"demo\"", "\"id\": \"../evil\""),
            valid_json().replace("\"binDirs\": [\".\"]", "\"binDirs\": [\"..\"]"),
            valid_json().replace(
                "\"verifyFiles\": [\"demo.exe\"]",
                "\"verifyFiles\": [\"C:/Windows/x.exe\"]",
            ),
            valid_json().replace(
                "\"defaultVersion\": \"1.0.0\"",
                "\"defaultVersion\": \"9.9.9\"",
            ),
            valid_json().replace("\"verifyFiles\": [\"demo.exe\"]", "\"verifyFiles\": []"),
        ] {
            assert!(
                matches!(
                    RuntimeManifest::parse(&json),
                    Err(RuntimeError::InvalidManifest(_))
                ),
                "{json}"
            );
        }
    }

    #[test]
    fn rejects_unsafe_extract_roots_setup_steps_and_feature_files() {
        for json in [
            valid_json().replace("\"archive\": \"zip\"", "\"archive\": \"zip\", \"extractRoot\": \"../x\""),
            valid_json().replace("\"archive\": \"zip\"", "\"archive\": \"zip\", \"extractRoot\": \".\""),
            valid_json().replace(
                "\"binDirs\"",
                "\"postInstall\": [{ \"description\": \"d\", \"executable\": \"C:/evil.exe\", \"args\": [] }], \"binDirs\"",
            ),
            valid_json().replace(
                "\"binDirs\"",
                "\"features\": [{ \"id\": \"f\", \"label\": \"f\", \"verifyFile\": \"../x\" }], \"binDirs\"",
            ),
        ] {
            assert!(
                matches!(
                    RuntimeManifest::parse(&json),
                    Err(RuntimeError::InvalidManifest(_))
                ),
                "{json}"
            );
        }
    }

    #[test]
    fn accepts_an_extract_root_setup_steps_and_features() {
        let json = valid_json()
            .replace("\"archive\": \"zip\"", "\"archive\": \"zip\", \"extractRoot\": \"tools\"")
            .replace(
                "\"binDirs\"",
                "\"postInstall\": [{ \"description\": \"d\", \"executable\": \"demo.exe\", \"args\": [\"-x\"] }], \"features\": [{ \"id\": \"f\", \"label\": \"F\", \"verifyFile\": \"Scripts/f.exe\" }], \"binDirs\"",
            );

        let manifest = RuntimeManifest::parse(&json).expect("parse");

        let artifact = manifest.artifact("1.0.0", "windows-x64").expect("artifact");
        assert_eq!(artifact.extract_root.as_deref(), Some("tools"));
        assert_eq!(manifest.post_install.len(), 1);
        assert_eq!(manifest.features[0].missing_note, "");
    }

    #[test]
    fn rejects_shims_that_could_inject_script_text_or_escape_the_install() {
        let shim = |name: &str, target: &str, args: &str| {
            valid_json().replace(
                "\"binDirs\"",
                &format!(
                    "\"shims\": [{{ \"name\": \"{name}\", \"target\": \"{target}\", \"args\": {args} }}], \"binDirs\""
                ),
            )
        };
        for json in [
            shim("pip", "python.exe", r#"["-m", "pip & calc"]"#),
            shim("pip", "python.exe", r#"["%PATH%"]"#),
            shim("pip", "python.exe", r#"["\"quoted\""]"#),
            shim("pip", "../python.exe", "[]"),
            shim("pip", "C:/python.exe", "[]"),
            shim("..", "python.exe", "[]"),
            shim("a b", "python.exe", "[]"),
        ] {
            assert!(
                matches!(
                    RuntimeManifest::parse(&json),
                    Err(RuntimeError::InvalidManifest(_))
                ),
                "{json}"
            );
        }
        let ok = RuntimeManifest::parse(&shim("pip3", "python.exe", r#"["-m", "pip"]"#))
            .expect("valid shim");
        assert_eq!(ok.shims[0].name, "pip3");
    }

    #[test]
    fn rejects_malformed_json() {
        assert!(matches!(
            RuntimeManifest::parse("{ nope"),
            Err(RuntimeError::InvalidManifest(_))
        ));
    }

    #[test]
    fn overrides_replace_add_and_skip_broken_files_without_failing() {
        let dir = tempfile::tempdir().expect("tempdir");
        std::fs::write(
            dir.path().join("node.json"),
            valid_json().replace("demo", "node"),
        )
        .expect("write");
        std::fs::write(dir.path().join("extra.json"), valid_json()).expect("write");
        std::fs::write(dir.path().join("broken.json"), "{ not json").expect("write");
        std::fs::write(dir.path().join("readme.txt"), "ignored").expect("write");

        let (registry, warnings) = RuntimeRegistry::builtin().with_overrides(dir.path());

        assert_eq!(registry.get("node").expect("node").display_name, "Demo");
        assert!(registry.get("demo").is_ok());
        assert!(registry.get("python").is_ok());
        assert_eq!(warnings.len(), 1);
        assert!(warnings[0].contains("broken.json"));
    }

    #[test]
    fn a_missing_overrides_directory_is_fine() {
        let (registry, warnings) =
            RuntimeRegistry::builtin().with_overrides(Path::new("Z:/does/not/exist"));

        assert_eq!(registry.all().count(), 7);
        assert!(warnings.is_empty());
    }

    #[test]
    fn unknown_runtime_is_a_typed_error() {
        assert!(matches!(
            RuntimeRegistry::builtin().get("cobol"),
            Err(RuntimeError::UnknownRuntime(_))
        ));
    }

    #[test]
    fn safe_component_rules() {
        for ok in ["node", "24.21.0", "2.55.0.5", "a-b_c+d"] {
            assert!(is_safe_component(ok), "{ok}");
        }
        for bad in ["", ".", "..", "../x", "a/b", "a\\b", ".hidden", "a b", "C:"] {
            assert!(!is_safe_component(bad), "{bad}");
        }
    }
}
