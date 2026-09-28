use super::*;

fn zip_with(path: &Path, files: &[(&str, &str)]) {
    let file = File::create(path).expect("create");
    let mut writer = zip::ZipWriter::new(file);
    let options = zip::write::SimpleFileOptions::default();
    for (name, text) in files {
        writer.start_file(*name, options).expect("start");
        writer.write_all(text.as_bytes()).expect("write");
    }
    writer.finish().expect("finish");
}

fn vsix(path: &Path, target: Option<&str>) {
    let manifest = match target {
        Some(t) => format!(
            "<PackageManifest><Identity Id=\"x\" TargetPlatform=\"{t}\"/></PackageManifest>"
        ),
        None => "<PackageManifest><Identity Id=\"x\"/></PackageManifest>".to_string(),
    };
    zip_with(
        path,
        &[
            (
                "extension/package.json",
                r#"{"publisher":"acme","name":"tool","version":"1.2.3"}"#,
            ),
            ("extension.vsixmanifest", manifest.as_str()),
        ],
    );
}

#[test]
fn a_vsix_is_recognized_and_its_platform_checked() {
    let dir = tempfile::tempdir().expect("tempdir");
    let universal = dir.path().join("acme.tool-1.2.3.vsix");
    vsix(&universal, None);
    let found = inspect(&universal, &[], "windows-x64").expect("inspect");
    assert_eq!(found.kind, Some(PackageKind::Vsix));
    assert_eq!(
        (found.name.as_str(), found.version.as_deref()),
        ("acme.tool", Some("1.2.3"))
    );
    assert!(found.compatible);
    let linux = dir.path().join("linux.vsix");
    vsix(&linux, Some("linux-arm64"));
    let refused = inspect(&linux, &[], "windows-x64").expect("inspect");
    assert!(!refused.compatible);
    assert!(refused.reason.unwrap_or_default().contains("linux-arm64"));
    let windows = dir.path().join("win.vsix");
    vsix(&windows, Some("win32-x64"));
    assert!(
        inspect(&windows, &[], "windows-x64")
            .expect("inspect")
            .compatible
    );
}

#[test]
fn wheels_npm_and_zips_are_recognized() {
    let dir = tempfile::tempdir().expect("tempdir");
    let any = dir.path().join("six-1.16.0-py2.py3-none-any.whl");
    fs::write(&any, b"wheel").expect("write");
    let found = inspect(&any, &[], "windows-x64").expect("inspect");
    assert_eq!(
        (found.kind, found.name.as_str(), found.compatible),
        (Some(PackageKind::Wheel), "six", true)
    );
    let linux = dir
        .path()
        .join("numpy-2.0.0-cp312-cp312-manylinux_2_17_x86_64.whl");
    fs::write(&linux, b"wheel").expect("write");
    assert!(
        !inspect(&linux, &[], "windows-x64")
            .expect("inspect")
            .compatible
    );
    let win = dir.path().join("numpy-2.0.0-cp312-cp312-win_amd64.whl");
    fs::write(&win, b"wheel").expect("write");
    assert!(
        inspect(&win, &[], "windows-x64")
            .expect("inspect")
            .compatible
    );

    let tgz = dir.path().join("left-pad-1.3.0.tgz");
    fs::write(&tgz, b"tgz").expect("write");
    let npm = inspect(&tgz, &[], "windows-x64").expect("inspect");
    assert_eq!(
        (npm.name.as_str(), npm.version.as_deref()),
        ("left-pad", Some("1.3.0"))
    );

    let composer = dir.path().join("log.zip");
    zip_with(
        &composer,
        &[(
            "log-3.0/composer.json",
            r#"{"name":"psr/log","version":"3.0.0"}"#,
        )],
    );
    let found = inspect(&composer, &[], "windows-x64").expect("inspect");
    assert_eq!(
        (found.kind, found.name.as_str()),
        (Some(PackageKind::ComposerPackage), "psr/log")
    );

    let source = dir.path().join("repo-main.zip");
    zip_with(&source, &[("repo-main/README.md", "hi")]);
    assert_eq!(
        inspect(&source, &[], "windows-x64").expect("inspect").kind,
        Some(PackageKind::SourceArchive)
    );

    let unknown = dir.path().join("thing.exe");
    fs::write(&unknown, b"MZ").expect("write");
    let found = inspect(&unknown, &[], "windows-x64").expect("inspect");
    assert_eq!(found.kind, None);
    assert!(found.reason.is_some());
}

#[test]
fn a_runtime_archive_is_matched_by_checksum_and_its_platform_checked() {
    let dir = tempfile::tempdir().expect("tempdir");
    let file = dir.path().join("node.zip");
    fs::write(&file, b"runtime bytes").expect("write");
    let (sha, _) = sha256_file(&file).expect("hash");
    let artifact = |platform: &str| KnownArtifact {
        runtime: "node".into(),
        display_name: "Node.js".into(),
        version: "24.21.0".into(),
        platform: platform.into(),
        sha256: sha.to_uppercase(),
    };
    let found = inspect(&file, &[artifact("windows-x64")], "windows-x64").expect("inspect");
    assert_eq!(found.kind, Some(PackageKind::Runtime));
    assert_eq!(
        found.runtime,
        Some(("node".to_string(), "24.21.0".to_string()))
    );
    assert!(found.compatible);
    let other = inspect(&file, &[artifact("windows-arm64")], "windows-x64").expect("inspect");
    assert!(!other.compatible);
    let cache = OfflineCache::new(dir.path().join("cache"));
    assert!(matches!(
        cache.import(&other, None),
        Err(OfflineError::Refused(_))
    ));
}

#[test]
fn imports_are_verified_indexed_listed_removed_and_cleared() {
    let dir = tempfile::tempdir().expect("tempdir");
    let cache_root = dir.path().join("cache");
    let cache = OfflineCache::new(&cache_root);
    let wheel = dir.path().join("six-1.16.0-py2.py3-none-any.whl");
    fs::write(&wheel, b"wheel").expect("write");
    let found = inspect(&wheel, &[], "windows-x64").expect("inspect");
    let entry = cache.import(&found, None).expect("import");
    assert_eq!(entry.file, "offline/wheels/six-1.16.0-py2.py3-none-any.whl");
    assert!(cache
        .wheelhouse()
        .join("six-1.16.0-py2.py3-none-any.whl")
        .is_file());
    assert!(wheel.is_file(), "the source is never moved");
    // The index survives a new instance (persistence).
    assert_eq!(OfflineCache::new(&cache_root).list(), vec![entry.clone()]);
    // Importing the same file again replaces its entry instead of duplicating it.
    cache.import(&found, None).expect("again");
    assert_eq!(cache.list().len(), 1);

    let runtime = dir.path().join("node.zip");
    fs::write(&runtime, b"runtime").expect("write");
    let (sha, _) = sha256_file(&runtime).expect("hash");
    let known = KnownArtifact {
        runtime: "node".into(),
        display_name: "Node.js".into(),
        version: "1".into(),
        platform: "windows-x64".into(),
        sha256: sha,
    };
    let inspected = inspect(&runtime, &[known], "windows-x64").expect("inspect");
    let target = cache_root.join("downloads").join("abc-node.zip");
    cache
        .import(&inspected, Some(&target))
        .expect("runtime import");
    assert!(target.is_file());
    let outside = dir.path().join("elsewhere.zip");
    assert!(cache.import(&inspected, Some(&outside)).is_err());

    cache.remove(&entry.id).expect("remove");
    assert!(!cache
        .wheelhouse()
        .join("six-1.16.0-py2.py3-none-any.whl")
        .exists());
    assert_eq!(cache.list().len(), 1);
    cache.clear().expect("clear");
    assert!(cache.list().is_empty());
    assert!(!target.exists());
}

#[test]
fn a_damaged_index_reads_as_empty_and_bad_entries_never_leave_the_cache() {
    let dir = tempfile::tempdir().expect("tempdir");
    let cache = OfflineCache::new(dir.path());
    fs::create_dir_all(cache.folder()).expect("mkdir");
    fs::write(cache.folder().join("index.json"), "{not json").expect("write");
    assert!(cache.list().is_empty());
    let evil = CacheEntry {
        id: "x".into(),
        kind: PackageKind::Wheel,
        name: "x".into(),
        version: None,
        architecture: None,
        sha256: "0".repeat(64),
        size: 0,
        file: "../outside.txt".into(),
        imported_at: 0,
        source: "localImport".into(),
        runtime: None,
    };
    assert_eq!(cache.path_of(&evil), None);
}

#[test]
fn source_archives_extract_safely_into_an_empty_folder_only() {
    let dir = tempfile::tempdir().expect("tempdir");
    let archive = dir.path().join("repo.zip");
    zip_with(
        &archive,
        &[
            ("repo-main/src/lib.rs", "fn x() {}"),
            ("repo-main/README.md", "hi"),
        ],
    );
    let dest = dir.path().join("my project");
    assert_eq!(extract_source(&archive, &dest).expect("extract"), 2);
    assert!(dest.join("repo-main/src/lib.rs").is_file());
    assert!(matches!(
        extract_source(&archive, &dest),
        Err(OfflineError::Refused(_))
    ));

    let evil = dir.path().join("evil.zip");
    zip_with(&evil, &[("../escape.txt", "x")]);
    let target = dir.path().join("evil out");
    assert!(extract_source(&evil, &target).is_err());
    assert!(!dir.path().join("escape.txt").exists());
}
