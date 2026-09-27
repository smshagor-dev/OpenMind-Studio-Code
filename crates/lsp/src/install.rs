//! Installing a language server package. Nothing is downloaded without the
//! user asking: `install` runs `npm ci` with Node's own npm against the
//! lockfile embedded in this crate, so every downloaded file is checked against
//! a pinned integrity hash, and install scripts are turned off. The result goes
//! into `language-servers/<package>/<revision>/`, staged first and renamed into
//! place, so a failed or interrupted install leaves nothing half-there.

use std::path::{Path, PathBuf};
use std::time::Duration;

use crate::error::LspError;
use crate::node::NodeExecutable;
use crate::process::{run_to_end, SpawnSpec};
use crate::registry::{Package, ServerDef, Source, SERVERS};

const INSTALL_TIMEOUT: Duration = Duration::from_secs(15 * 60);

fn packages_root(app_root: &Path) -> PathBuf {
    app_root.join("language-servers")
}

/// Where a package's current revision lives.
pub fn package_dir(app_root: &Path, package: &Package) -> PathBuf {
    packages_root(app_root)
        .join(package.id)
        .join(package.revision)
}

/// The script Node runs for `server`, when it is installed.
pub fn entry_path(app_root: &Path, server: &ServerDef, package: &Package) -> Option<PathBuf> {
    let entry = package_dir(app_root, package).join(server.entry);
    entry.is_file().then_some(entry)
}

pub fn is_installed(app_root: &Path, server: &ServerDef, package: &Package) -> bool {
    entry_path(app_root, server, package).is_some()
}

fn staging_dir(app_root: &Path, package: &Package) -> PathBuf {
    packages_root(app_root).join(package.id).join(".installing")
}

/// The `npm ci` arguments: exact lockfile, no scripts, no telemetry or update checks.
pub fn npm_args(npm_cli: &Path) -> Vec<String> {
    vec![
        npm_cli.display().to_string(),
        "ci".into(),
        "--ignore-scripts".into(),
        "--no-audit".into(),
        "--no-fund".into(),
        "--no-progress".into(),
        "--loglevel=error".into(),
    ]
}

/// Installs `package`. `log` gets every line npm prints.
pub fn install(
    app_root: &Path,
    package: &Package,
    node: &NodeExecutable,
    log: impl Fn(&str) + Send + Sync + Clone + 'static,
) -> Result<(), LspError> {
    let Source::Npm {
        package_json,
        package_lock,
    } = package.source
    else {
        return Err(LspError::InstallFailed(format!(
            "{} is only shipped in OpenMind Studio's LSP bundle and can't be downloaded here.",
            package.contents
        )));
    };
    let npm_cli = node.npm_cli().ok_or_else(|| {
        LspError::InstallFailed(
            "npm was not found next to Node.js. Repair the Node.js runtime.".into(),
        )
    })?;
    let staging = staging_dir(app_root, package);
    if staging.exists() {
        std::fs::remove_dir_all(&staging).map_err(io_err)?;
    }
    std::fs::create_dir_all(&staging).map_err(io_err)?;
    let lock = (package_json, package_lock);
    let outcome = install_into(&staging, app_root, package, lock, node, &npm_cli, log);
    if outcome.is_err() {
        let _ = std::fs::remove_dir_all(&staging);
        return outcome;
    }
    let final_dir = package_dir(app_root, package);
    if final_dir.exists() {
        std::fs::remove_dir_all(&final_dir).map_err(io_err)?;
    }
    std::fs::rename(&staging, &final_dir).map_err(io_err)?;
    remove_other_revisions(app_root, package);
    Ok(())
}

fn install_into(
    staging: &Path,
    app_root: &Path,
    package: &Package,
    (package_json, package_lock): (&str, &str),
    node: &NodeExecutable,
    npm_cli: &Path,
    log: impl Fn(&str) + Send + Sync + Clone + 'static,
) -> Result<(), LspError> {
    std::fs::write(staging.join("package.json"), package_json).map_err(io_err)?;
    std::fs::write(staging.join("package-lock.json"), package_lock).map_err(io_err)?;
    let spec = SpawnSpec {
        program: node.path.clone(),
        args: npm_args(npm_cli),
        cwd: staging.to_path_buf(),
        vars: vec![
            // npm's download cache stays inside the app folder.
            (
                "npm_config_cache".into(),
                app_root.join("cache").join("npm").display().to_string(),
            ),
            ("npm_config_update_notifier".into(), "false".into()),
        ],
        path_prepend: node
            .path
            .parent()
            .map(|dir| vec![dir.to_path_buf()])
            .unwrap_or_default(),
    };
    match run_to_end(&spec, INSTALL_TIMEOUT, log)? {
        Some(0) => {}
        Some(code) => {
            return Err(LspError::InstallFailed(format!(
                "npm exited with code {code}. See the LSP output for details."
            )))
        }
        None => return Err(LspError::InstallFailed("npm was stopped.".into())),
    }
    let missing: Vec<&str> = SERVERS
        .iter()
        .filter(|server| server.package == package.id)
        .filter(|server| !staging.join(server.entry).is_file())
        .map(|server| server.id)
        .collect();
    if missing.is_empty() {
        Ok(())
    } else {
        Err(LspError::InstallFailed(format!(
            "the download is missing files for: {}",
            missing.join(", ")
        )))
    }
}

/// Older revisions of the same package are no longer used.
fn remove_other_revisions(app_root: &Path, package: &Package) {
    let Ok(entries) = std::fs::read_dir(packages_root(app_root).join(package.id)) else {
        return;
    };
    for entry in entries.flatten() {
        let name = entry.file_name();
        if name != package.revision {
            let _ = std::fs::remove_dir_all(entry.path());
        }
    }
}

fn io_err(err: std::io::Error) -> LspError {
    LspError::InstallFailed(err.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::registry::{package_by_id, server_by_id};

    #[test]
    fn a_package_lives_under_language_servers_with_its_revision() {
        let package = package_by_id("python").expect("package");
        let dir = package_dir(Path::new("C:/My App"), package);
        assert!(dir.ends_with(Path::new("language-servers/python/1")));
    }

    #[test]
    fn installed_means_the_entry_script_exists() {
        let root = tempfile::tempdir().expect("tempdir");
        let server = server_by_id("python").expect("server");
        let package = package_by_id(server.package).expect("package");
        assert!(!is_installed(root.path(), server, package));
        let entry = package_dir(root.path(), package).join(server.entry);
        std::fs::create_dir_all(entry.parent().expect("parent")).expect("mkdir");
        std::fs::write(&entry, b"").expect("entry");
        assert!(is_installed(root.path(), server, package));
        assert_eq!(entry_path(root.path(), server, package), Some(entry));
    }

    #[test]
    fn npm_runs_from_the_lockfile_without_scripts() {
        let args = npm_args(Path::new("C:/My Node/node_modules/npm/bin/npm-cli.js"));
        assert_eq!(args[1], "ci");
        assert!(args.contains(&"--ignore-scripts".to_string()));
        // The path with spaces is one argument, not split.
        assert!(args[0].contains("My Node"));
    }

    #[test]
    fn a_missing_npm_is_reported_before_anything_is_written() {
        let root = tempfile::tempdir().expect("tempdir");
        let package = package_by_id("php").expect("package");
        let node = NodeExecutable {
            path: root.path().join("node.exe"),
            source: crate::node::NodeSource::Portable,
        };
        let err = install(root.path(), package, &node, |_| {}).expect_err("no npm");
        assert!(matches!(err, LspError::InstallFailed(text) if text.contains("npm")));
        assert!(!root.path().join("language-servers").exists());
    }

    #[test]
    fn a_native_package_can_only_come_from_the_bundle() {
        let root = tempfile::tempdir().expect("tempdir");
        let package = package_by_id("rust").expect("package");
        let node = NodeExecutable {
            path: root.path().join("node.exe"),
            source: crate::node::NodeSource::Portable,
        };
        let err = install(root.path(), package, &node, |_| {}).expect_err("native");
        assert!(err.to_string().contains("LSP bundle"), "{err}");
        assert!(!root.path().join("language-servers").exists());
    }

    #[test]
    fn old_revisions_are_removed_but_the_current_one_stays() {
        let root = tempfile::tempdir().expect("tempdir");
        let package = package_by_id("php").expect("package");
        let base = root.path().join("language-servers").join("php");
        std::fs::create_dir_all(base.join("0")).expect("old");
        std::fs::create_dir_all(base.join(package.revision)).expect("current");
        remove_other_revisions(root.path(), package);
        assert!(!base.join("0").exists());
        assert!(base.join(package.revision).exists());
    }
}
