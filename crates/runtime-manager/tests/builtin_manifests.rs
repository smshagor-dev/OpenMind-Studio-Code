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
    assert_eq!(features, ["pip", "venv"]);
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
