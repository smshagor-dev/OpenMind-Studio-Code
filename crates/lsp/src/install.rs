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
use crate::registry::{Package, Runtime, ServerDef, Source, SERVERS};

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

/// The script Node runs, native executable, or Python module marker for `server`, when it is installed.
pub fn entry_path(app_root: &Path, server: &ServerDef, package: &Package) -> Option<PathBuf> {
    let root = package_dir(app_root, package);
    let entry = root.join(server.entry);
    match server.runtime {
        Runtime::PythonModule => entry.join("__main__.py").is_file().then_some(entry),
        _ => entry.is_file().then_some(entry),
    }
}

pub fn is_installed(app_root: &Path, server: &ServerDef, package: &Package) -> bool {
    entry_path(app_root, server, package).is_some()
}

fn staging_dir(app_root: &Path, package: &Package) -> PathBuf {
    staging_dir_of(app_root, package.id)
}

/// Where a package is put together before it is renamed into place.
pub(crate) fn staging_dir_of(app_root: &Path, package_id: &str) -> PathBuf {
    packages_root(app_root).join(package_id).join(".installing")
}

/// A forward-slash path inside a package (no drive, no backslash, no `.` or `..` part).
pub(crate) fn is_plain_relative(name: &str) -> bool {
    !name.is_empty()
        && !name.contains(['\\', ':'])
        && name
            .split('/')
            .all(|part| !part.is_empty() && part != "." && part != "..")
}

/// Renames a finished `staging` folder to the package's revision folder and drops older revisions.
pub(crate) fn move_into_place(
    app_root: &Path,
    package: &Package,
    staging: &Path,
) -> Result<(), LspError> {
    let final_dir = package_dir(app_root, package);
    if final_dir.exists() {
        std::fs::remove_dir_all(&final_dir).map_err(io_err)?;
    }
    std::fs::rename(staging, &final_dir).map_err(io_err)?;
    remove_other_revisions(app_root, package);
    Ok(())
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

/// OpenMind's own pip settings (the download gateway's index, offline wheels) and the option each becomes. A proxy is
/// never one of them: pip reaches the network through the download gateway's index, and a proxy (with its password)
/// must never appear on a command line other processes can read (`crates/network/tests/policy.rs`).
const PIP_SETTINGS: &[(&str, &str)] = &[
    ("PIP_INDEX_URL", "--index-url"),
    ("PIP_EXTRA_INDEX_URL", "--extra-index-url"),
    ("PIP_TRUSTED_HOST", "--trusted-host"),
    ("PIP_FIND_LINKS", "--find-links"),
    ("PIP_CERT", "--cert"),
];

/// The pip command for a Python-package server, isolated from the Python it runs on: `-I` (no user site, no
/// `PYTHON*` variables) and `--isolated` (no `pip.ini`, no inherited `PIP_*` such as `PIP_USER`, `PIP_TARGET` or
/// `PIP_REQUIRE_VIRTUALENV`), so even a system Python's own packages and the user's pip setup are never read or changed.
/// The settings OpenMind passes in `env` go on the command line instead, and the cache stays in the app folder.
pub fn pip_args(
    requirements: &Path,
    target: &Path,
    cache: &Path,
    env: &[(String, String)],
) -> Vec<String> {
    let mut args: Vec<String> = [
        "-I",
        "-m",
        "pip",
        "install",
        "--isolated",
        "--disable-pip-version-check",
        "--no-warn-script-location",
        "--no-input",
        "--cache-dir",
    ]
    .map(String::from)
    .to_vec();
    args.push(cache.display().to_string());
    for (variable, option) in PIP_SETTINGS {
        let Some((_, value)) = env
            .iter()
            .find(|(key, _)| key.eq_ignore_ascii_case(variable))
        else {
            continue;
        };
        for part in value.split_whitespace() {
            args.extend([(*option).to_string(), part.to_string()]);
        }
    }
    args.extend([
        "--target".into(),
        target.display().to_string(),
        "-r".into(),
        requirements.display().to_string(),
    ]);
    args
}

/// Installs `package`. `log` gets every line npm prints. `env` is added to npm's environment (the app's proxy
/// variables, when a proxy is configured).
pub fn install(
    app_root: &Path,
    package: &Package,
    node: &NodeExecutable,
    env: &[(String, String)],
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
    // One install or unpack of this package at a time, on every computer sharing the folder.
    let _lock = crate::unpack::lock_package(app_root, package.id)?;
    let staging = staging_dir(app_root, package);
    if staging.exists() {
        std::fs::remove_dir_all(&staging).map_err(io_err)?;
    }
    std::fs::create_dir_all(&staging).map_err(io_err)?;
    let lock = (package_json, package_lock);
    let outcome = install_into(
        &staging,
        app_root,
        package,
        lock,
        (node, &npm_cli),
        env,
        log,
    );
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

/// Installs a Python-package language server into `language-servers/<package>/<revision>/` with `pip --target`.
pub fn install_python(
    app_root: &Path,
    package: &Package,
    python: &Path,
    env: &[(String, String)],
    log: impl Fn(&str) + Send + Sync + Clone + 'static,
) -> Result<(), LspError> {
    let Source::Python { requirements } = package.source else {
        return Err(LspError::InstallFailed(format!(
            "{} is not a Python language server package.",
            package.contents
        )));
    };
    // One install or unpack of this package at a time, on every computer sharing the folder.
    let _lock = crate::unpack::lock_package(app_root, package.id)?;
    let staging = staging_dir(app_root, package);
    if staging.exists() {
        std::fs::remove_dir_all(&staging).map_err(io_err)?;
    }
    std::fs::create_dir_all(&staging).map_err(io_err)?;
    let requirements_path = staging.join("requirements.txt");
    std::fs::write(&requirements_path, requirements).map_err(io_err)?;
    // The proxy variables still reach pip (`--isolated` ignores only pip's own settings); OpenMind's `PIP_*` settings
    // are passed as options by `pip_args`.
    let mut vars: Vec<(String, String)> = env
        .iter()
        .filter(|(key, _)| !key.to_ascii_uppercase().starts_with("PIP_"))
        .cloned()
        .collect();
    vars.push(("PYTHONNOUSERSITE".into(), "1".into()));
    let cache = app_root.join("cache").join("pip");
    let spec = SpawnSpec {
        program: python.to_path_buf(),
        args: pip_args(&requirements_path, &staging, &cache, env),
        cwd: staging.clone(),
        vars,
        path_prepend: python
            .parent()
            .map(|dir| vec![dir.to_path_buf()])
            .unwrap_or_default(),
    };
    let outcome = match run_to_end(&spec, INSTALL_TIMEOUT, log) {
        Ok(Some(0)) => Ok(()),
        Ok(Some(code)) => Err(LspError::InstallFailed(format!(
            "pip exited with code {code}. See the LSP output for details."
        ))),
        Ok(None) => Err(LspError::InstallFailed("pip was stopped.".into())),
        Err(err) => Err(err),
    };
    if outcome.is_err() {
        let _ = std::fs::remove_dir_all(&staging);
        return outcome;
    }
    let missing: Vec<&str> = SERVERS
        .iter()
        .filter(|server| server.package == package.id)
        .filter(|server| match server.runtime {
            Runtime::PythonModule => !staging.join(server.entry).join("__main__.py").is_file(),
            _ => !staging.join(server.entry).is_file(),
        })
        .map(|server| server.id)
        .collect();
    if !missing.is_empty() {
        let _ = std::fs::remove_dir_all(&staging);
        return Err(LspError::InstallFailed(format!(
            "the download is missing files for: {}",
            missing.join(", ")
        )));
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
    (node, npm_cli): (&NodeExecutable, &Path),
    env: &[(String, String)],
    log: impl Fn(&str) + Send + Sync + Clone + 'static,
) -> Result<(), LspError> {
    std::fs::write(staging.join("package.json"), package_json).map_err(io_err)?;
    std::fs::write(staging.join("package-lock.json"), package_lock).map_err(io_err)?;
    let mut vars: Vec<(String, String)> = env.to_vec();
    vars.extend([
        // npm's download cache stays inside the app folder.
        (
            "npm_config_cache".into(),
            app_root.join("cache").join("npm").display().to_string(),
        ),
        ("npm_config_update_notifier".into(), "false".into()),
    ]);
    let spec = SpawnSpec {
        program: node.path.clone(),
        args: npm_args(npm_cli),
        cwd: staging.to_path_buf(),
        vars,
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

/// Removes everything installed for `package` (`language-servers/<package>/`: every revision and a leftover staging
/// folder). Nothing else is touched: a link in its place is refused rather than followed. Removing a package that isn't
/// there is not an error.
pub fn uninstall(app_root: &Path, package: &Package) -> Result<(), LspError> {
    let dir = packages_root(app_root).join(package.id);
    match std::fs::symlink_metadata(&dir) {
        Err(_) => Ok(()),
        Ok(meta) if meta.file_type().is_symlink() || !meta.is_dir() => {
            Err(LspError::InstallFailed(format!(
                "{} is not a folder OpenMind created; it was left alone.",
                dir.display()
            )))
        }
        Ok(_) => std::fs::remove_dir_all(&dir).map_err(|err| {
            LspError::InstallFailed(format!("Couldn't remove {}: {err}", dir.display()))
        }),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::registry::{package_by_id, server_by_id};

    #[test]
    fn pip_is_isolated_from_the_python_and_the_users_pip_setup() {
        let env = vec![
            (
                "PIP_INDEX_URL".to_string(),
                "http://127.0.0.1:5/t/pypi/simple/".to_string(),
            ),
            (
                "PIP_TRUSTED_HOST".to_string(),
                "127.0.0.1 localhost".to_string(),
            ),
            ("HTTPS_PROXY".to_string(), "http://proxy:8080".to_string()),
        ];
        let args = pip_args(
            Path::new("C:/app/req.txt"),
            Path::new("C:/app/language-servers/fortran/.installing"),
            Path::new("C:/app/cache/pip"),
            &env,
        );
        assert_eq!(args[..5], ["-I", "-m", "pip", "install", "--isolated"]);
        let joined = args.join(" ");
        assert!(joined.contains("--cache-dir C:/app/cache/pip"), "{joined}");
        assert!(
            joined.contains("--index-url http://127.0.0.1:5/t/pypi/simple/"),
            "{joined}"
        );
        assert!(
            joined.contains("--trusted-host 127.0.0.1 --trusted-host localhost"),
            "{joined}"
        );
        assert!(joined
            .ends_with("--target C:/app/language-servers/fortran/.installing -r C:/app/req.txt"));
        for never in [
            "--user",
            "--upgrade",
            "proxy:8080",
            "--break-system-packages",
        ] {
            assert!(!joined.contains(never), "{never} in {joined}");
        }
    }

    #[test]
    fn uninstall_removes_only_the_package_folder() {
        let root = tempfile::tempdir().expect("tempdir");
        let server = server_by_id("fortran").expect("fortls");
        let package = package_by_id(server.package).expect("package");
        let entry = package_dir(root.path(), package)
            .join(server.entry)
            .join("__main__.py");
        std::fs::create_dir_all(entry.parent().expect("parent")).expect("mkdir");
        std::fs::write(&entry, b"").expect("entry");
        std::fs::create_dir_all(staging_dir(root.path(), package)).expect("staging");
        let neighbour = packages_root(root.path()).join("python").join("1");
        std::fs::create_dir_all(&neighbour).expect("neighbour");
        assert!(is_installed(root.path(), server, package));

        uninstall(root.path(), package).expect("uninstall");

        assert!(!is_installed(root.path(), server, package));
        assert!(!packages_root(root.path()).join("fortran").exists());
        assert!(neighbour.exists(), "another server's files stay");
        uninstall(root.path(), package).expect("removing it again is fine");
    }

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
        let err = install(root.path(), package, &node, &[], |_| {}).expect_err("no npm");
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
        let err = install(root.path(), package, &node, &[], |_| {}).expect_err("native");
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
