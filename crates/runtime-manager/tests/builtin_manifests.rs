//! The shipped manifests, checked as data: nothing here touches the network.

use openmind_runtime_manager::{RuntimePaths, RuntimeRegistry};

#[test]
fn every_builtin_artifact_is_https_with_a_full_sha256() {
    for manifest in RuntimeRegistry::builtin().all() {
        for version in &manifest.versions {
            for artifact in &version.artifacts {
                let context = format!("{} {} {}", manifest.id, version.version, artifact.platform);
                assert!(artifact.url.starts_with("https://"), "{context}");
                assert_eq!(artifact.sha256.len(), 64, "{context}");
                assert!(
                    artifact.sha256.chars().all(|c| c.is_ascii_hexdigit()),
                    "{context}"
                );
            }
        }
    }
}

#[test]
fn php_offers_every_minor_line_from_8_0_to_8_4_with_8_4_as_the_default() {
    let registry = RuntimeRegistry::builtin();
    let php = registry.get("php").expect("php");

    let versions = php.versions_for("windows-x64");
    for minor in ["8.0.", "8.1.", "8.2.", "8.3.", "8.4."] {
        assert!(
            versions.iter().any(|v| v.starts_with(minor)),
            "PHP {minor}x is missing: {versions:?}"
        );
    }
    assert!(
        php.default_version.starts_with("8.4."),
        "{}",
        php.default_version
    );
    assert_eq!(
        versions.first().copied(),
        Some(php.default_version.as_str()),
        "the recommended version is listed first"
    );
}

#[test]
fn every_php_version_is_an_official_https_nts_x64_download_with_a_checksum() {
    let registry = RuntimeRegistry::builtin();
    let php = registry.get("php").expect("php");
    for version in &php.versions {
        let artifact = php
            .artifact(&version.version, "windows-x64")
            .expect("windows artifact");
        assert!(
            artifact
                .url
                .starts_with("https://downloads.php.net/~windows/releases/"),
            "{}",
            artifact.url
        );
        assert!(artifact.url.contains("-nts-Win32-"), "{}", artifact.url);
        assert!(artifact.url.ends_with("-x64.zip"), "{}", artifact.url);
        assert!(
            artifact.url.contains(&format!("php-{}-", version.version)),
            "{}",
            artifact.url
        );
        assert_eq!(artifact.sha256.len(), 64, "{}", version.version);
        assert!(artifact.size_bytes.is_some(), "{}", version.version);
    }
}

#[test]
fn php_8_0_and_8_1_do_not_load_a_zip_dll_they_do_not_have() {
    let registry = RuntimeRegistry::builtin();
    let php = registry.get("php").expect("php");
    let ini_for = |version: &str| {
        let entry = php
            .versions
            .iter()
            .find(|v| v.version.starts_with(version))
            .expect("version");
        entry
            .seed_files
            .first()
            .or_else(|| php.seed_files.first())
            .expect("php.ini")
            .content
            .clone()
    };
    for old in ["8.0.", "8.1."] {
        assert!(!ini_for(old).contains("extension=zip"), "{old}");
    }
    for current in ["8.2.", "8.3.", "8.4."] {
        assert!(ini_for(current).contains("extension=zip"), "{current}");
    }
}

#[test]
fn every_runtime_declares_features_so_its_card_can_show_real_status() {
    let registry = RuntimeRegistry::builtin();
    let ids = |runtime: &str| -> Vec<String> {
        registry
            .get(runtime)
            .expect(runtime)
            .features
            .iter()
            .map(|f| f.id.clone())
            .collect()
    };
    assert_eq!(
        ids("python"),
        ["pip", "venv", "tkinter", "bundled-packages"]
    );
    assert_eq!(ids("node"), ["npm", "npx"]);
    assert_eq!(ids("git"), ["git"]);
    assert_eq!(ids("php"), ["cli", "server", "ini"]);
    assert_eq!(ids("fortran"), ["gfortran", "gcc-toolchain", "make"]);
    assert_eq!(ids("pascal"), ["compiler", "win64-target", "rtl-units"]);
    assert_eq!(ids("composer"), ["phar"]);
}

#[test]
fn fortran_and_pascal_are_portable_windows_compilers() {
    let registry = RuntimeRegistry::builtin();

    let fortran = registry.get("fortran").expect("fortran");
    let artifact = fortran
        .artifact(&fortran.default_version, "windows-x64")
        .expect("windows artifact");
    // w64devkit's `bin` also holds BusyBox's find, sort, tar, timeout, bash ...: it is never put on a terminal's PATH.
    // Only launchers for the toolchain are, and each gives its own command that folder (gcc runs `as` and `ld`).
    assert!(fortran.bin_dirs.is_empty(), "{:?}", fortran.bin_dirs);
    let names: Vec<&str> = fortran
        .shims
        .iter()
        .map(|shim| shim.name.as_str())
        .collect();
    for tool in [
        "gfortran",
        "gcc",
        "g++",
        "gdb",
        "make",
        "mingw32-make",
        "ld",
        "as",
    ] {
        assert!(names.contains(&tool), "{tool} missing from {names:?}");
    }
    for busybox in [
        "find", "sort", "tar", "timeout", "bash", "sh", "which", "wget", "whoami", "cc",
    ] {
        assert!(
            !names.contains(&busybox),
            "{busybox} must not shadow the system's"
        );
    }
    for shim in &fortran.shims {
        assert_eq!(shim.path_dirs, ["bin"], "{}", shim.name);
        assert!(shim.target.starts_with("bin/") && shim.target.ends_with(".exe"));
    }
    assert!(
        artifact.url.contains("w64devkit-fortran"),
        "{}",
        artifact.url
    );
    assert_eq!(
        artifact.archive,
        openmind_runtime_manager::manifest::ArchiveKind::Zip
    );
    assert_eq!(artifact.strip_components, 1);
    for file in [
        "bin/gfortran.exe",
        "bin/gcc.exe",
        "bin/ld.exe",
        "bin/as.exe",
    ] {
        assert!(fortran.verify_files.iter().any(|f| f == file), "{file}");
    }

    let pascal = registry.get("pascal").expect("pascal");
    let artifact = pascal
        .artifact(&pascal.default_version, "windows-x64")
        .expect("windows artifact");
    assert_eq!(pascal.bin_dirs, ["bin/i386-win32"]);
    assert!(
        artifact
            .url
            .starts_with("https://downloads.freepascal.org/fpc/snapshot/"),
        "{}",
        artifact.url
    );
    assert_eq!(
        artifact.archive,
        openmind_runtime_manager::manifest::ArchiveKind::Zip
    );
    assert!(pascal
        .verify_files
        .iter()
        .any(|f| f == "bin/i386-win32/ppcrossx64.exe"));
    assert_eq!(pascal.shims[0].name, "fpc64");
}

#[test]
fn mariadb_and_phpmyadmin_are_official_https_downloads_that_need_no_service_or_admin_rights() {
    let registry = RuntimeRegistry::builtin();

    let mariadb = registry.get("mariadb").expect("mariadb");
    let artifact = mariadb
        .artifact(&mariadb.default_version, "windows-x64")
        .expect("windows artifact");
    assert!(
        artifact.url.starts_with("https://archive.mariadb.org/"),
        "{}",
        artifact.url
    );
    assert!(artifact.url.ends_with("-winx64.zip"), "{}", artifact.url);
    assert_eq!(artifact.sha256.len(), 64);
    // The server, the initializer and the admin tool are all verified files.
    for file in [
        "bin/mysqld.exe",
        "bin/mariadb-install-db.exe",
        "bin/mariadb-admin.exe",
    ] {
        assert!(mariadb.verify_files.iter().any(|f| f == file), "{file}");
    }
    assert_eq!(mariadb.bin_dirs, ["bin"]);
    assert!(mariadb.env.is_empty(), "no environment is injected");

    let pma = registry.get("phpmyadmin").expect("phpmyadmin");
    let artifact = pma
        .artifact(&pma.default_version, "windows-x64")
        .expect("windows artifact");
    assert!(
        artifact
            .url
            .starts_with("https://files.phpmyadmin.net/phpMyAdmin/"),
        "{}",
        artifact.url
    );
    assert_eq!(artifact.strip_components, 1);
    assert!(pma.bin_dirs.is_empty(), "phpMyAdmin puts nothing on PATH");
    assert!(
        pma.seed_files.is_empty(),
        "its config is written at start, not baked in"
    );
}

#[test]
fn python_is_the_nuget_distribution_with_relocatable_pip_and_venv() {
    let registry = RuntimeRegistry::builtin();
    let python = registry.get("python").expect("python");

    let artifact = python
        .artifact(&python.default_version, "windows-x64")
        .expect("windows artifact");
    assert!(artifact.url.contains("nuget.org"), "{}", artifact.url);
    assert_eq!(artifact.extract_root.as_deref(), Some("tools"));

    // pip is inside the package; no absolute-path pip.exe is generated or required.
    assert!(python.post_install.is_empty());
    assert!(!python.verify_files.iter().any(|f| f.contains("pip.exe")));
    assert!(python
        .verify_files
        .iter()
        .any(|f| f == "Lib/site-packages/pip/__init__.py"));

    // pip / pip3 are relative-path shims over `python.exe -m pip`.
    let shims: Vec<(&str, &str, Vec<&str>)> = python
        .shims
        .iter()
        .map(|s| {
            (
                s.name.as_str(),
                s.target.as_str(),
                s.args.iter().map(String::as_str).collect(),
            )
        })
        .collect();
    assert_eq!(
        shims,
        [
            ("pip", "python.exe", vec!["-m", "pip"]),
            ("pip3", "python.exe", vec!["-m", "pip"]),
        ]
    );

    let features: Vec<&str> = python.features.iter().map(|f| f.id.as_str()).collect();
    assert_eq!(features, ["pip", "venv", "tkinter", "bundled-packages"]);
    // Tcl/Tk is an optional add-on of the default version only: python.org's signed tcltk.msi, extracted.
    for version in &python.versions {
        let addons: Vec<&str> = version.addons.iter().map(|a| a.id.as_str()).collect();
        let expected: &[&str] = if version.version == "3.14.7" {
            &["tcltk"]
        } else {
            &[]
        };
        assert_eq!(addons, expected, "{}", version.version);
    }
    let tcltk = &python.versions[0].addons[0];
    assert_eq!(tcltk.verify_file, "DLLs/_tkinter.pyd");
    assert_eq!(
        tcltk.artifacts[0].url,
        "https://www.python.org/ftp/python/3.14.7/amd64/tcltk.msi"
    );
    assert_eq!(
        tcltk.artifacts[0].archive,
        openmind_runtime_manager::manifest::ArchiveKind::Msi
    );
    assert_eq!(python.bin_dirs, [".", "Scripts"]);
    assert_eq!(
        python.env.get("PYTHONNOUSERSITE").map(String::as_str),
        Some("1")
    );
}

#[test]
fn git_is_mingit_with_its_launcher_under_cmd() {
    let registry = RuntimeRegistry::builtin();
    let git = registry.get("git").expect("git");

    assert_eq!(git.bin_dirs, ["cmd"]);
    assert_eq!(git.verify_files, ["cmd/git.exe"]);
    assert!(git.post_install.is_empty());
    let artifact = git
        .artifact(&git.default_version, "windows-x64")
        .expect("windows artifact");
    assert!(artifact.url.contains("MinGit"), "{}", artifact.url);
}

#[test]
fn install_paths_are_rooted_under_the_runtimes_folder_and_downloads_under_cache() {
    let paths = RuntimePaths::new("root/runtimes", "root/cache");

    for (kind, version) in [
        ("python", "3.14.7"),
        ("git", "2.55.0.5"),
        ("node", "24.21.0"),
    ] {
        let dir = paths.version_dir(kind, version).expect("dir");
        assert!(dir.starts_with("root/runtimes"), "{}", dir.display());
        assert!(dir.ends_with(std::path::Path::new(kind).join("versions").join(version)));
    }
    assert!(paths.downloads_dir().starts_with("root/cache"));
    assert!(paths.version_dir("python", "..").is_err());
    assert!(paths.version_dir("../python", "1").is_err());
}
