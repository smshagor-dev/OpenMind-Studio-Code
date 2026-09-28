use std::path::{Path, PathBuf};

use crate::error::RuntimeError;
use crate::manifest::is_safe_component;

/// Where runtimes and their downloads live, all under the portable app
/// directory — never Program Files, never the registry, never system PATH:
///
/// ```text
/// runtimes/<kind>/versions/<version>/    an installed version
/// runtimes/<kind>/versions/<version>.installing/   staging (never trusted)
/// cache/downloads/                       verified archives, resumable .part files
/// ```
#[derive(Debug, Clone)]
pub struct RuntimePaths {
    runtimes_dir: PathBuf,
    cache_dir: PathBuf,
}

impl RuntimePaths {
    pub fn new(runtimes_dir: impl Into<PathBuf>, cache_dir: impl Into<PathBuf>) -> Self {
        Self {
            runtimes_dir: runtimes_dir.into(),
            cache_dir: cache_dir.into(),
        }
    }

    pub fn runtimes_dir(&self) -> &Path {
        &self.runtimes_dir
    }

    /// The app's `cache` folder: tools' own caches (Go modules, Gradle, NuGet, pub) go under it, not the profile.
    pub fn cache_dir(&self) -> &Path {
        &self.cache_dir
    }

    pub fn downloads_dir(&self) -> PathBuf {
        self.cache_dir.join("downloads")
    }

    pub fn versions_dir(&self, kind: &str) -> Result<PathBuf, RuntimeError> {
        check(kind)?;
        Ok(self.runtimes_dir.join(kind).join("versions"))
    }

    pub fn version_dir(&self, kind: &str, version: &str) -> Result<PathBuf, RuntimeError> {
        check(version)?;
        Ok(self.versions_dir(kind)?.join(version))
    }

    /// Where a version's command shims live. Its layout is load-bearing: a
    /// shim reaches its runtime as `../../versions/<version>/` from here, so
    /// the two folders must stay siblings under the same `<kind>` folder.
    pub fn shim_dir(&self, kind: &str, version: &str) -> Result<PathBuf, RuntimeError> {
        check(version)?;
        Ok(self
            .runtimes_dir
            .join(check_kind(kind)?)
            .join("shims")
            .join(version))
    }

    pub fn shims_root(&self, kind: &str) -> Result<PathBuf, RuntimeError> {
        Ok(self.runtimes_dir.join(check_kind(kind)?).join("shims"))
    }

    pub fn staging_dir(&self, kind: &str, version: &str) -> Result<PathBuf, RuntimeError> {
        check(version)?;
        Ok(self
            .versions_dir(kind)?
            .join(format!("{version}.installing")))
    }

    /// The cache file for an artifact. Named by checksum so a changed
    /// manifest hash can never be satisfied by a stale file.
    pub fn download_path(&self, sha256: &str, url: &str) -> PathBuf {
        let name = url
            .rsplit('/')
            .next()
            .filter(|name| is_safe_component(name))
            .unwrap_or("download");
        self.downloads_dir()
            .join(format!("{}-{name}", &sha256[..sha256.len().min(16)]))
    }
}

fn check_kind(kind: &str) -> Result<&str, RuntimeError> {
    check(kind)?;
    Ok(kind)
}

fn check(component: &str) -> Result<(), RuntimeError> {
    if is_safe_component(component) {
        Ok(())
    } else {
        Err(RuntimeError::InvalidName(component.to_string()))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn paths() -> RuntimePaths {
        RuntimePaths::new("/app/runtimes", "/app/cache")
    }

    #[test]
    fn version_dirs_follow_the_documented_layout() {
        let paths = paths();

        assert_eq!(
            paths.version_dir("node", "24.21.0").expect("dir"),
            Path::new("/app/runtimes")
                .join("node")
                .join("versions")
                .join("24.21.0")
        );
        assert_eq!(
            paths.staging_dir("node", "24.21.0").expect("dir"),
            Path::new("/app/runtimes")
                .join("node")
                .join("versions")
                .join("24.21.0.installing")
        );
        assert_eq!(
            paths.downloads_dir(),
            Path::new("/app/cache").join("downloads")
        );
    }

    #[test]
    fn shims_sit_beside_their_version_so_a_relative_path_reaches_it() {
        let paths = paths();

        let shims = paths.shim_dir("python", "3.14.7").expect("shims");
        let version = paths.version_dir("python", "3.14.7").expect("version");

        assert_eq!(
            shims,
            Path::new("/app/runtimes")
                .join("python")
                .join("shims")
                .join("3.14.7")
        );
        // What the shim script does: `%~dp0..\..ersions\<version>`.
        assert_eq!(
            shims.join("..").join("..").join("versions").join("3.14.7"),
            Path::new("/app/runtimes")
                .join("python")
                .join("shims")
                .join("3.14.7")
                .join("..")
                .join("..")
                .join("versions")
                .join("3.14.7")
        );
        assert_eq!(
            shims.parent().and_then(Path::parent),
            version.parent().and_then(Path::parent)
        );
        assert!(paths.shim_dir("python", "..").is_err());
        assert!(paths.shim_dir("../x", "1").is_err());
    }

    #[test]
    fn names_that_could_escape_the_runtimes_directory_are_rejected() {
        let paths = paths();

        for bad in ["..", "../x", "a/b", "a\\b", "", "C:\\x", ".hidden"] {
            assert!(
                matches!(
                    paths.version_dir("node", bad),
                    Err(RuntimeError::InvalidName(_))
                ),
                "{bad}"
            );
            assert!(
                matches!(
                    paths.version_dir(bad, "1.0.0"),
                    Err(RuntimeError::InvalidName(_))
                ),
                "{bad}"
            );
            assert!(
                matches!(
                    paths.staging_dir("node", bad),
                    Err(RuntimeError::InvalidName(_))
                ),
                "{bad}"
            );
        }
    }

    #[test]
    fn download_paths_are_checksum_prefixed_and_use_a_safe_file_name() {
        let paths = paths();
        let sha = "abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789";

        let path = paths.download_path(sha, "https://example.com/dist/node-v1-win-x64.zip");
        assert_eq!(
            path.file_name().expect("name"),
            "abcdef0123456789-node-v1-win-x64.zip"
        );

        let odd = paths.download_path(sha, "https://example.com/a/..%2f..");
        assert!(odd.starts_with(paths.downloads_dir()));
        assert_eq!(odd.file_name().expect("name"), "abcdef0123456789-download");
    }
}
