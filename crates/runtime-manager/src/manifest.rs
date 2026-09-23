use std::collections::BTreeMap;
use std::path::Path;

use serde::{Deserialize, Serialize};

use crate::error::RuntimeError;

const BUILTIN: [&str; 3] = [
    include_str!("../manifests/node.json"),
    include_str!("../manifests/python.json"),
    include_str!("../manifests/git.json"),
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
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeVersion {
    pub version: String,
    pub artifacts: Vec<Artifact>,
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
            .chain(std::iter::once(&self.version_command.executable))
        {
            if !is_safe_relative(path) {
                return bad(format!(
                    "\"{path}\" must be a relative path inside the install"
                ));
            }
        }
        if self.verify_files.is_empty() {
            return bad("verifyFiles is empty, so an install could never be checked".into());
        }
        for version in &self.versions {
            if !is_safe_component(&version.version) {
                return bad(format!("\"{}\" is not a valid version", version.version));
            }
            for artifact in &version.artifacts {
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
    fn builtin_registry_has_node_python_and_git_with_usable_windows_artifacts() {
        let registry = RuntimeRegistry::builtin();

        for id in ["node", "python", "git"] {
            let manifest = registry.get(id).expect(id);
            assert!(
                manifest
                    .artifact(&manifest.default_version, "windows-x64")
                    .is_some(),
                "{id}"
            );
        }
        assert_eq!(registry.all().count(), 3);
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

        assert_eq!(registry.all().count(), 3);
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
