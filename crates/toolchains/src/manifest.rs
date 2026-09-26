//! `tools/toolchains.json`, the list of app-local tool versions that ship with (or were copied next to) the app.
//! It is read locally, never fetched; a damaged file is reported and ignored, never fatal.

use std::path::{Component, Path};

use serde::Deserialize;

#[derive(Debug, thiserror::Error)]
pub enum ManifestError {
    #[error("the toolchain manifest is not valid JSON: {0}")]
    Invalid(String),
    #[error("could not read the toolchain manifest: {0}")]
    Unreadable(String),
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Manifest {
    #[serde(default)]
    pub tools: Vec<ManifestTool>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ManifestTool {
    pub id: String,
    #[serde(default)]
    pub name: Option<String>,
    #[serde(default)]
    pub versions: Vec<ManifestVersion>,
    /// How many bundled versions to keep at most (packaging keeps the newest); default 5.
    #[serde(default)]
    pub max_bundled_versions: Option<usize>,
    /// The packager's default; the user's choice wins, and a value that isn't bundled is ignored.
    #[serde(default)]
    pub active_version: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ManifestVersion {
    pub version: String,
    /// `windows-x64`, `linux-x64`, `macos-arm64`... A version for another platform is ignored.
    pub platform: String,
    /// The program, relative to the app folder (`tools/git/2.47.0/cmd/git.exe`). Never absolute, never `..`.
    pub path: String,
    #[serde(default = "yes")]
    pub bundled: bool,
    #[serde(default)]
    pub license: Option<String>,
    #[serde(default)]
    pub license_url: Option<String>,
    #[serde(default)]
    pub size_bytes: Option<u64>,
    /// Arguments that make the program print its version (`["--version"]`). Only used by Verify, on a click.
    #[serde(default)]
    pub verify_args: Option<Vec<String>>,
}

fn yes() -> bool {
    true
}

/// The default cap of bundled versions per tool.
pub const DEFAULT_MAX_VERSIONS: usize = 5;

pub fn parse(text: &str) -> Result<Manifest, ManifestError> {
    serde_json::from_str(text).map_err(|err| ManifestError::Invalid(err.to_string()))
}

pub fn read(path: &Path) -> Result<Option<Manifest>, ManifestError> {
    match std::fs::read_to_string(path) {
        Ok(text) => parse(&text).map(Some),
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(err) => Err(ManifestError::Unreadable(err.to_string())),
    }
}

/// A manifest path must stay inside the app folder: relative, no `..`, no drive, no NUL.
pub fn is_safe_relative(path: &str) -> bool {
    if path.is_empty() || path.contains('\0') || path.contains(':') {
        return false;
    }
    let p = Path::new(path);
    !p.is_absolute()
        && p.components()
            .all(|c| matches!(c, Component::Normal(_) | Component::CurDir))
        && !path.starts_with('/')
        && !path.starts_with('\\')
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_the_documented_shape() {
        let m = parse(
            r#"{"tools":[{"id":"git","name":"Git","maxBundledVersions":5,"activeVersion":"2.47.0",
            "versions":[{"version":"2.47.0","platform":"windows-x64","path":"tools/git/2.47.0/cmd/git.exe","bundled":true,"verifyArgs":["--version"]}]}]}"#,
        )
        .expect("manifest");
        assert_eq!(
            m.tools[0].versions[0].verify_args.as_deref(),
            Some(&["--version".to_string()][..])
        );
        assert_eq!(m.tools[0].max_bundled_versions, Some(5));
    }

    #[test]
    fn a_damaged_manifest_is_an_error_not_a_panic() {
        assert!(parse("{ nope").is_err());
        assert!(parse(r#"{"tools":[{"name":"no id"}]}"#).is_err());
        assert!(parse("{}").expect("empty").tools.is_empty());
    }

    #[test]
    fn paths_cannot_leave_the_app_folder() {
        assert!(is_safe_relative("tools/git/2.47.0/cmd/git.exe"));
        for bad in [
            "../x",
            "tools/../../x",
            "/abs",
            "\\\\server\\x",
            "C:\\x",
            "",
            "a\0b",
            "D:/x",
        ] {
            assert!(!is_safe_relative(bad), "{bad}");
        }
    }
}
