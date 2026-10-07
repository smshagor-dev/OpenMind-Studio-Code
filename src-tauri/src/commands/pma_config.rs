//! Where phpMyAdmin's generated configuration lives.
//!
//! The phpMyAdmin install (`runtimes/phpmyadmin/versions/<v>/`) is shared by every computer that runs this copy, but its
//! configuration is not: the cookie secret, the login, the MariaDB port and the temp folder are this computer's (see
//! `docs/data-scope.md`). So the install only holds a fixed [`STUB`] — the same bytes on every computer, with no secret
//! and no path — which loads the file named by [`ENV_VAR`]; OpenMind sets that variable on the phpMyAdmin process it
//! starts to this computer's [`real_file`].

use std::path::{Path, PathBuf};

use openmind_core::AppPaths;

/// Names this computer's generated configuration for the phpMyAdmin process.
pub const ENV_VAR: &str = "OPENMIND_PMA_CONFIG";

/// The `config.inc.php` inside the shared install. phpMyAdmin includes it inside a function, and `require` shares that
/// scope, so the `$cfg` the real file sets is the one phpMyAdmin reads.
pub const STUB: &str = concat!(
    "<?php\n",
    "// Written by OpenMind Studio. This phpMyAdmin is shared by every computer that runs this copy; each computer's own\n",
    "// configuration (secret, login, port, temp folder) is in its profile and named by OPENMIND_PMA_CONFIG.\n",
    "declare(strict_types=1);\n",
    "$openmindConfig = getenv('OPENMIND_PMA_CONFIG');\n",
    "if (is_string($openmindConfig) && $openmindConfig !== '' && is_file($openmindConfig)) {\n",
    "    require $openmindConfig;\n",
    "}\n",
);

/// This computer's generated configuration (in its own cache folder; the one-profile `cache/` without data scope).
pub fn real_file(paths: &AppPaths) -> PathBuf {
    paths.machine_cache_dir.join("phpmyadmin-config.inc.php")
}

/// Writes this computer's configuration, and the [`STUB`] into the install when it isn't there yet (an install made by
/// an earlier version holds a real configuration, which is replaced). Another computer writing the same stub at the
/// same moment is harmless: the bytes are identical and each write is a rename.
pub fn install(install_dir: &Path, real: &Path, text: &str) -> std::io::Result<()> {
    write_replacing(real, text)?;
    let stub = install_dir.join("config.inc.php");
    if std::fs::read_to_string(&stub).ok().as_deref() != Some(STUB) {
        write_replacing(&stub, STUB)?;
    }
    Ok(())
}

fn write_replacing(file: &Path, text: &str) -> std::io::Result<()> {
    if let Some(parent) = file.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let partial = file.with_extension(format!("{}.tmp", std::process::id()));
    std::fs::write(&partial, text)?;
    std::fs::rename(&partial, file).inspect_err(|_| {
        let _ = std::fs::remove_file(&partial);
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_shared_install_gets_the_stub_and_the_computer_keeps_its_configuration() {
        let dir = tempfile::tempdir().expect("tempdir");
        let install_dir = dir.path().join("runtimes/phpmyadmin/versions/5.2.3");
        std::fs::create_dir_all(&install_dir).expect("dir");
        // An install from an earlier version holds a computer's real configuration.
        std::fs::write(
            install_dir.join("config.inc.php"),
            "$cfg['blowfish_secret'] = 'A';",
        )
        .expect("old");
        let pc_a = dir
            .path()
            .join("data/machines/aaaa/cache/phpmyadmin-config.inc.php");
        let pc_b = dir
            .path()
            .join("data/machines/bbbb/cache/phpmyadmin-config.inc.php");
        install(&install_dir, &pc_a, "secret A").expect("A");
        install(&install_dir, &pc_b, "secret B").expect("B");

        let stub = std::fs::read_to_string(install_dir.join("config.inc.php")).expect("stub");
        assert_eq!(stub, STUB);
        assert!(stub.contains(ENV_VAR));
        assert!(!stub.contains("blowfish"), "no secret in the shared file");
        assert_eq!(std::fs::read_to_string(&pc_a).expect("a"), "secret A");
        assert_eq!(std::fs::read_to_string(&pc_b).expect("b"), "secret B");
        let leftovers = std::fs::read_dir(&install_dir).expect("dir").count();
        assert_eq!(leftovers, 1, "no temporary file left in the install");
    }

    #[test]
    fn the_real_file_is_in_the_computers_own_cache() {
        let root = PathBuf::from("/drive/OpenMind Studio");
        let one = AppPaths::from_root(root.clone());
        assert_eq!(
            real_file(&one),
            one.machine_cache_dir.join("phpmyadmin-config.inc.php")
        );
        assert!(real_file(&one).starts_with(&root));
    }
}
