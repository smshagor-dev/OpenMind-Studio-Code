use super::*;

use openmind_runtime_manager::RuntimeRegistry;

const OFFICIAL_SHA: &str = "256eb56fa904e4ac99a1d4c867594a945dcfce8bcb7680e623c20477f3c5754f";
const OFFICIAL_SIZE: u64 = 10_631_071;

fn record(dir: &Path, sha: &str, size: u64, file: &str) {
    let json = serde_json::json!({
        "format": "openmind-pascalabc-bundle",
        "version": 1,
        "compilerVersion": "4.0.0.3883",
        "file": file,
        "sha256": sha,
        "size": size,
        "source": "https://pascalabc.net/downloads/PABCNETC.zip",
        "licenses": ["License_en.txt"],
    });
    std::fs::write(dir.join("bundle.json"), json.to_string()).expect("record");
}

#[test]
fn no_bundle_is_not_an_error() {
    let dir = tempfile::tempdir().expect("tempdir");
    assert_eq!(load_bundle(dir.path()), Ok(None));
}

#[test]
fn a_bundle_is_read_when_its_archive_matches_the_record() {
    let dir = tempfile::tempdir().expect("tempdir");
    std::fs::write(dir.path().join("PABCNETC.zip"), b"12345").expect("zip");
    record(dir.path(), &"a".repeat(64), 5, "PABCNETC.zip");
    let bundle = load_bundle(dir.path()).expect("ok").expect("present");
    assert_eq!(bundle.compiler_version, "4.0.0.3883");
    assert_eq!(bundle.size, 5);
    assert_eq!(bundle.archive, dir.path().join("PABCNETC.zip"));
}

#[test]
fn a_damaged_or_foreign_bundle_is_reported_never_used() {
    let dir = tempfile::tempdir().expect("tempdir");
    std::fs::write(dir.path().join("PABCNETC.zip"), b"12345").expect("zip");

    record(dir.path(), &"a".repeat(64), 6, "PABCNETC.zip");
    assert!(load_bundle(dir.path())
        .expect_err("size")
        .contains("size differs"));

    record(dir.path(), &"a".repeat(64), 5, "../PABCNETC.zip");
    assert!(load_bundle(dir.path())
        .expect_err("path")
        .contains("outside its folder"));

    record(dir.path(), "not-a-hash", 5, "PABCNETC.zip");
    assert!(load_bundle(dir.path())
        .expect_err("hash")
        .contains("SHA-256"));

    record(dir.path(), &"a".repeat(64), 5, "missing.zip");
    assert!(load_bundle(dir.path())
        .expect_err("missing")
        .contains("missing"));

    std::fs::write(dir.path().join("bundle.json"), "{ not json").expect("damaged");
    assert!(load_bundle(dir.path())
        .expect_err("json")
        .contains("damaged"));

    std::fs::write(
        dir.path().join("bundle.json"),
        r#"{"format":"other","version":1,"compilerVersion":"4","file":"PABCNETC.zip","sha256":"x","size":5,"source":"https://x"}"#,
    )
    .expect("foreign");
    assert!(load_bundle(dir.path())
        .expect_err("format")
        .contains("another version"));
}

#[test]
fn only_the_official_archive_the_manifest_pins_stands_in_for_the_download() {
    let registry = RuntimeRegistry::builtin();
    let manifest = registry.get(KIND).expect("manifest");
    let official = Bundle {
        compiler_version: "4.0.0.3883".into(),
        archive: PathBuf::from("PABCNETC.zip"),
        sha256: OFFICIAL_SHA.into(),
        size: OFFICIAL_SIZE,
    };
    let artifact = bundle_artifact(&official, manifest, "windows-x64").expect("official");
    assert_eq!(artifact.url, "https://pascalabc.net/downloads/PABCNETC.zip");

    let changed = Bundle {
        sha256: "b".repeat(64),
        ..official.clone()
    };
    assert!(bundle_artifact(&changed, manifest, "windows-x64").is_err());
    let unknown = Bundle {
        compiler_version: "9.9".into(),
        ..official.clone()
    };
    assert!(bundle_artifact(&unknown, manifest, "windows-x64").is_err());
    assert!(
        bundle_artifact(&official, manifest, "linux-x64").is_err(),
        "Windows only"
    );
}

#[test]
fn the_bundled_version_is_installed_once_and_never_after_the_user_removed_it() {
    assert!(wanted("4.0.0.3883", &[], None), "fresh install");
    assert!(
        wanted("4.0.0.3883", &["3.11.0".into()], None),
        "an update ships a newer one"
    );
    assert!(
        !wanted("4.0.0.3883", &["4.0.0.3883".into()], None),
        "already there"
    );
    assert!(
        !wanted("4.0.0.3883", &[], Some("4.0.0.3883")),
        "the user removed it"
    );
    assert!(
        wanted("4.1.0.4000", &[], Some("4.0.0.3883")),
        "a newer bundle after a removal"
    );
}

#[test]
fn the_dotnet_framework_status_names_the_version_and_whether_it_is_enough() {
    assert_eq!(
        dotnet_status(Some(533_509)),
        DotnetFrameworkStatus {
            version: Some("4.8.1".into()),
            satisfied: true
        }
    );
    assert_eq!(
        dotnet_status(Some(461_308)),
        DotnetFrameworkStatus {
            version: Some("4.7.1".into()),
            satisfied: false
        }
    );
    assert_eq!(
        dotnet_status(None),
        DotnetFrameworkStatus {
            version: None,
            satisfied: false
        }
    );
}
