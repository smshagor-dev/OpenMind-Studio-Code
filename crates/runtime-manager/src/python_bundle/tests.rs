use std::io::Write;

use super::*;

fn manifest(format: &str, wheels_file: &str, import: &str) -> String {
    serde_json::json!({
        "format": format,
        "version": 1,
        "python": "3.14",
        "runtimeVersion": "3.14.7",
        "platform": "win_amd64",
        "stdlib": ["os", "sqlite3", "tkinter"],
        "packages": [{ "name": "requests", "import": import }, { "name": "pillow", "import": "PIL" }],
        "wheels": { "file": wheels_file, "sha256": "00", "size": 1, "count": 1 },
        "requirements": "requirements.txt",
        "addon": { "id": "tcltk", "file": "tcltk.msi", "sha256": "ab", "url": "https://www.python.org/x/tcltk.msi" }
    })
    .to_string()
}

fn bundle_dir(text: &str) -> tempfile::TempDir {
    let dir = tempfile::tempdir().expect("tmp");
    fs::write(dir.path().join("bundle.json"), text).expect("write");
    dir
}

fn zip_with(dir: &Path, entries: &[(&str, &[u8])]) -> PathBuf {
    let path = dir.join("packages.zip");
    let mut writer = zip::ZipWriter::new(File::create(&path).expect("create"));
    let options =
        zip::write::SimpleFileOptions::default().compression_method(zip::CompressionMethod::Stored);
    for (name, data) in entries {
        writer.start_file(*name, options).expect("start");
        writer.write_all(data).expect("data");
    }
    writer.finish().expect("finish");
    path
}

#[test]
fn a_missing_bundle_is_none_and_a_valid_one_loads() {
    let empty = tempfile::tempdir().expect("tmp");
    assert!(PythonBundle::load(empty.path()).expect("ok").is_none());
    let dir = bundle_dir(&manifest(BUNDLE_FORMAT, "packages.zip", "requests"));
    let bundle = PythonBundle::load(dir.path()).expect("ok").expect("bundle");
    assert_eq!(bundle.python, "3.14");
    assert_eq!(bundle.packages[1].import_name, "PIL");
    assert_eq!(bundle.addon.as_ref().map(|a| a.id.as_str()), Some("tcltk"));
}

#[test]
fn a_foreign_or_unsafe_bundle_is_refused() {
    for text in [
        manifest("something-else", "packages.zip", "requests"),
        manifest(BUNDLE_FORMAT, "../packages.zip", "requests"),
        manifest(BUNDLE_FORMAT, "C:packages.zip", "requests"),
        manifest(BUNDLE_FORMAT, "packages.zip", "requests; import os"),
    ] {
        let dir = bundle_dir(&text);
        assert!(PythonBundle::load(dir.path()).is_err(), "{text}");
    }
    let damaged = bundle_dir("{ not json");
    assert!(PythonBundle::load(damaged.path()).is_err());
}

#[test]
fn the_wheels_fit_only_their_python_line() {
    let dir = bundle_dir(&manifest(BUNDLE_FORMAT, "packages.zip", "requests"));
    let bundle = PythonBundle::load(dir.path()).expect("ok").expect("bundle");
    assert!(bundle.fits("3.14.7"));
    assert!(bundle.fits("3.14"));
    assert!(!bundle.fits("3.13.13"));
    assert!(!bundle.fits("3.140.1"));
    assert_eq!(
        bundle.modules(true),
        ["os", "sqlite3", "tkinter", "requests", "PIL"]
    );
    assert_eq!(bundle.modules(false), ["os", "sqlite3", "requests", "PIL"]);
}

#[test]
fn only_plain_wheel_names_are_unpacked() {
    let tmp = tempfile::tempdir().expect("tmp");
    let good = zip_with(
        tmp.path(),
        &[
            ("a-1.0-py3-none-any.whl", b"x"),
            ("b-2.0-py3-none-any.whl", b"y"),
        ],
    );
    let dest = tmp.path().join("out");
    assert_eq!(unpack_wheels(&good, &dest).expect("unpack"), 2);
    assert!(dest.join("a-1.0-py3-none-any.whl").is_file());
    for bad in [
        "../evil.whl",
        "sub/a.whl",
        "notes.txt",
        ".hidden.whl",
        "C:x.whl",
    ] {
        let dir = tempfile::tempdir().expect("tmp");
        let zip = zip_with(dir.path(), &[(bad, b"x")]);
        let result = unpack_wheels(&zip, &dir.path().join("out"));
        assert!(
            matches!(result, Err(RuntimeError::UnsafeArchive(_))),
            "{bad}: {result:?}"
        );
        assert!(!dir.path().join("evil.whl").exists());
    }
}

#[test]
fn a_zip_that_does_not_match_its_hash_is_refused_and_kept() {
    let tmp = tempfile::tempdir().expect("tmp");
    fs::write(
        tmp.path().join("bundle.json"),
        manifest(BUNDLE_FORMAT, "packages.zip", "requests"),
    )
    .expect("write");
    let zip = zip_with(tmp.path(), &[("a-1.0-py3-none-any.whl", b"x")]);
    let bundle = PythonBundle::load(tmp.path()).expect("ok").expect("bundle");
    let python = tmp.path().join("python");
    let result = install_packages(
        &bundle,
        tmp.path(),
        &python,
        &tmp.path().join("work"),
        &BTreeMap::new(),
    );
    assert!(
        matches!(result, Err(RuntimeError::ChecksumMismatch { .. })),
        "{result:?}"
    );
    assert!(zip.is_file(), "a shipped file is never deleted");
    assert!(installed_record(&python).is_none());
}

#[test]
fn the_record_round_trips_and_the_add_on_is_checked() {
    let tmp = tempfile::tempdir().expect("tmp");
    let record = PackagesRecord {
        python: "3.14".into(),
        packages: vec!["requests".into()],
        bundle_sha256: "ab".into(),
    };
    fs::write(
        tmp.path().join(RECORD_FILE),
        serde_json::to_string(&record).expect("json"),
    )
    .expect("write");
    assert_eq!(installed_record(tmp.path()), Some(record));
    let dir = bundle_dir(&manifest(BUNDLE_FORMAT, "packages.zip", "requests"));
    let bundle = PythonBundle::load(dir.path()).expect("ok").expect("bundle");
    assert!(bundle.addon_archive(dir.path()).is_none(), "missing");
    fs::write(dir.path().join("tcltk.msi"), b"not the recorded bytes").expect("write");
    assert!(bundle.addon_archive(dir.path()).is_none(), "wrong hash");
    assert_eq!(
        file_sha256(&dir.path().join("tcltk.msi"))
            .expect("sha")
            .len(),
        64
    );
}
