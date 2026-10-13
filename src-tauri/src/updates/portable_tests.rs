//! The portable update: signature checks with a throwaway test key (fixtures/), feed parsing, the all-or-nothing swap.

use super::*;

const PAYLOAD: &[u8] = include_bytes!("fixtures/payload.bin");
const SIG_V123: &str = include_str!("fixtures/payload.v1.2.3.sig");
const SIG_UNVERSIONED: &str = include_str!("fixtures/payload.unversioned.sig");
const TEST_KEY: &str = include_str!("fixtures/test.key.pub");
/// OpenMind's real release key (tauri.conf.json): a file signed with the test key must fail against it.
const RELEASE_KEY: &str = "dW50cnVzdGVkIGNvbW1lbnQ6IG1pbmlzaWduIHB1YmxpYyBrZXk6IDdBNTkwQzRFNzE0MkYyQ0YKUldUUDhrSnhUZ3haZXNDZ09MU2dHVGlwTTI5U2dyZEFNSFdKUnpaKyt0Z1ZTZWVOampCZFhpOXQK";

#[test]
fn a_correctly_signed_archive_for_the_announced_version_is_accepted() {
    verify(PAYLOAD, SIG_V123, TEST_KEY, "1.2.3").expect("valid");
    verify(PAYLOAD, SIG_V123, TEST_KEY, "v1.2.3").expect("a leading v is the same version");
}

#[test]
fn tampered_unsigned_foreign_or_replayed_archives_are_refused() {
    let mut tampered = PAYLOAD.to_vec();
    tampered[0] ^= 0x20;
    assert!(
        verify(&tampered, SIG_V123, TEST_KEY, "1.2.3").is_err(),
        "a changed byte"
    );
    assert!(
        verify(PAYLOAD, SIG_V123, RELEASE_KEY, "1.2.3").is_err(),
        "signed with another key"
    );
    let replay = verify(PAYLOAD, SIG_V123, TEST_KEY, "1.2.4")
        .expect_err("an old archive under a new number");
    assert!(replay.contains("1.2.3"), "{replay}");
    let unbound = verify(PAYLOAD, SIG_UNVERSIONED, TEST_KEY, "1.2.3")
        .expect_err("no version in the signature");
    assert!(unbound.contains("version"), "{unbound}");
    assert!(
        verify(PAYLOAD, "not base64!", TEST_KEY, "1.2.3").is_err(),
        "a broken signature"
    );
    assert!(
        verify(PAYLOAD, "", TEST_KEY, "1.2.3").is_err(),
        "a missing signature"
    );
}

fn feed(url: &str) -> serde_json::Value {
    serde_json::json!({
        "version": "1.2.3",
        "platforms": {},
        "openmind": { "portable": { target(): { "url": url, "signature": SIG_V123 } } }
    })
}

#[test]
fn the_portable_package_comes_from_the_feed_for_this_architecture_only() {
    let root = PathBuf::from("C:/app");
    let request = Request::from_feed(
        &feed("https://github.com/o/r/releases/download/v1.2.3/OpenMind-Studio-1.2.3-x64-portable.zip"),
        "1.2.3",
        root.clone(),
        root.join("temp/update"),
        TEST_KEY.into(),
    )
    .expect("request");
    assert_eq!(request.signature, SIG_V123);
    assert!(Request::from_feed(
        &feed("http://example.com/p.zip"),
        "1.2.3",
        root.clone(),
        root.clone(),
        TEST_KEY.into()
    )
    .is_err());
    let other_arch = serde_json::json!({ "openmind": { "portable": { "windows-not-this": { "url": "https://x/p.zip", "signature": "s" } } } });
    let err = Request::from_feed(
        &other_arch,
        "1.2.3",
        root.clone(),
        root.clone(),
        TEST_KEY.into(),
    )
    .expect_err("none");
    assert!(err.contains(target()), "{err}");
    assert!(Request::from_feed(
        &serde_json::json!({}),
        "1.2.3",
        root.clone(),
        root,
        TEST_KEY.into()
    )
    .is_err());
}

/// A portable copy with user data, and a staged new version.
fn copy_with_update() -> (tempfile::TempDir, Staged) {
    let dir = tempfile::tempdir().expect("tmp");
    let root = dir.path().join("OpenMind Studio");
    for (path, text) in [
        ("OpenMindStudio.exe", "old program"),
        ("lsp/bundle.json", "old bundle"),
        ("data/openmind-studio.db", "user database"),
        ("settings/settings.json", "{\"editor.fontSize\": 15}"),
        ("runtimes/python/versions/3.14.7/python.exe", "python"),
    ] {
        let file = root.join(path);
        std::fs::create_dir_all(file.parent().expect("parent")).expect("dir");
        std::fs::write(file, text).expect("write");
    }
    let files = root.join(STAGED_DIR).join("1.2.3").join(ZIP_ROOT);
    for (path, text) in [
        ("OpenMindStudio.exe", "new program"),
        ("lsp/bundle.json", "new bundle"),
        ("README.txt", "new readme"),
        // Never taken from a package, even if one held it.
        ("data/openmind-studio.db", "EMPTY"),
    ] {
        let file = files.join(path);
        std::fs::create_dir_all(file.parent().expect("parent")).expect("dir");
        std::fs::write(file, text).expect("write");
    }
    let staged = stage_from(files.parent().expect("staged"), &root, "1.2.3").expect("staged");
    (dir, staged)
}

fn read(root: &Path, path: &str) -> String {
    std::fs::read_to_string(root.join(path)).expect("read")
}

#[test]
fn a_portable_update_replaces_only_the_program_and_keeps_every_user_file() {
    let (_dir, staged) = copy_with_update();
    let root = staged.root.clone();
    apply(&staged).expect("apply");
    assert_eq!(read(&root, "OpenMindStudio.exe"), "new program");
    assert_eq!(read(&root, "lsp/bundle.json"), "new bundle");
    assert_eq!(read(&root, "README.txt"), "new readme");
    assert_eq!(read(&root, "data/openmind-studio.db"), "user database");
    assert_eq!(
        read(&root, "settings/settings.json"),
        "{\"editor.fontSize\": 15}"
    );
    assert_eq!(
        read(&root, "runtimes/python/versions/3.14.7/python.exe"),
        "python"
    );
    assert!(!root.join(STAGED_DIR).exists());
    // The next start removes what was set aside.
    let aside = std::fs::read_dir(&root)
        .expect("dir")
        .flatten()
        .filter(|e| e.file_name().to_string_lossy().contains(OLD_MARK))
        .count();
    assert_eq!(aside, 2, "the old program and the old lsp folder");
    finish_previous_update(&root);
    let left = std::fs::read_dir(&root)
        .expect("dir")
        .flatten()
        .filter(|e| e.file_name().to_string_lossy().contains(OLD_MARK))
        .count();
    assert_eq!(left, 0);
}

#[cfg(windows)]
#[test]
fn a_copy_in_use_is_left_exactly_as_it_was() {
    use std::os::windows::fs::OpenOptionsExt;
    let (_dir, staged) = copy_with_update();
    let root = staged.root.clone();
    // Another computer runs a language server from lsp/: its file is open without delete sharing.
    let held = std::fs::OpenOptions::new()
        .read(true)
        .share_mode(1)
        .open(root.join("lsp/bundle.json"))
        .expect("open");
    let err = apply(&staged).expect_err("in use");
    assert!(err.contains("unchanged"), "{err}");
    drop(held);
    assert_eq!(
        read(&root, "OpenMindStudio.exe"),
        "old program",
        "the program was put back"
    );
    assert_eq!(read(&root, "lsp/bundle.json"), "old bundle");
    assert!(!root.join("README.txt").exists());
    assert_eq!(read(&root, "data/openmind-studio.db"), "user database");
    let aside = std::fs::read_dir(&root)
        .expect("dir")
        .flatten()
        .filter(|e| e.file_name().to_string_lossy().contains(OLD_MARK))
        .count();
    assert_eq!(aside, 0);
}

#[test]
fn a_package_without_the_program_is_not_staged() {
    let dir = tempfile::tempdir().expect("tmp");
    let staged = dir.path().join("staged");
    std::fs::create_dir_all(staged.join("other")).expect("dir");
    assert!(stage_from(&staged, dir.path(), "1.2.3").is_err());
    assert!(!staged.exists(), "removed");
}

/// The release check: `OPENMIND_RELEASE_DIR=<project>/release/v<version> cargo test -p openmind-studio --bin
/// openmind-studio real_release -- --ignored`. Every release file with a `.sig` passes this program's own update check
/// (the real key, the version from tauri.conf.json), a changed byte or another version is refused, and latest.json names
/// only files that exist, with exactly their `.sig`, in a form `Request::from_feed` accepts.
#[test]
#[ignore = "needs OPENMIND_RELEASE_DIR (a built release folder)"]
fn real_release_files_pass_the_update_check_and_tampered_ones_fail() {
    let dir = PathBuf::from(std::env::var("OPENMIND_RELEASE_DIR").expect("OPENMIND_RELEASE_DIR"));
    let conf: serde_json::Value =
        serde_json::from_str(include_str!("../../tauri.conf.json")).expect("tauri.conf.json");
    assert_eq!(
        conf["plugins"]["updater"]["pubkey"].as_str(),
        Some(RELEASE_KEY),
        "the constant above is the configured key"
    );
    let version = conf["version"].as_str().expect("version");
    // The release folder's per-architecture folders (scripts/releaseTools.mjs RELEASE_ARCHES); macOS only once built.
    let folders = [
        "windows/x64",
        "windows/x86",
        "linux/x64",
        "linux/x86",
        "macos/arm64",
        "macos/x64",
    ];
    let mut checked = 0;
    let mut macos = 0;
    for folder in folders {
        let Ok(entries) = std::fs::read_dir(dir.join(folder)) else {
            assert!(folder.starts_with("macos/"), "{folder} is missing");
            continue;
        };
        for entry in entries {
            let path = entry.expect("entry").path();
            if path.extension().is_some_and(|ext| ext == "sig") {
                continue;
            }
            let sig = std::fs::read_to_string(path.with_file_name(format!(
                "{}.sig",
                path.file_name().expect("name").to_string_lossy()
            )))
            .unwrap_or_else(|err| panic!("{}: no .sig ({err})", path.display()));
            let mut data = std::fs::read(&path).expect("read");
            verify(&data, sig.trim(), RELEASE_KEY, version)
                .unwrap_or_else(|err| panic!("{}: {err}", path.display()));
            assert!(
                verify(&data, sig.trim(), RELEASE_KEY, "0.0.1").is_err(),
                "{}: another version",
                path.display()
            );
            let middle = data.len() / 2;
            data[middle] ^= 0x01;
            assert!(
                verify(&data, sig.trim(), RELEASE_KEY, version).is_err(),
                "{}: one changed byte",
                path.display()
            );
            checked += 1;
            if folder.starts_with("macos/") {
                macos += 1;
            }
        }
    }
    assert_eq!(
        checked - macos,
        12,
        "six Windows and six Linux files (plus the macOS ones once built)"
    );

    let feed: serde_json::Value = serde_json::from_str(
        &std::fs::read_to_string(dir.join("metadata").join("latest.json")).expect("latest.json"),
    )
    .expect("valid JSON");
    assert_eq!(feed["version"].as_str(), Some(version));
    let mut entries: Vec<(String, &serde_json::Value)> = Vec::new();
    for (map, label) in [
        (&feed["platforms"], "platforms"),
        (&feed["openmind"]["portable"], "portable"),
    ] {
        for (key, value) in map.as_object().expect(label) {
            entries.push((format!("{label}.{key}"), value));
        }
    }
    let darwin = if macos > 0 { 2 } else { 0 };
    assert_eq!(
        entries.len(),
        14 + darwin,
        "Windows x64/x86 × (plain, -nsis, -msi), Linux x64/x86 × (plain, -deb, -appimage), two portable entries \
         (and darwin-aarch64/x86_64 once macOS is built)"
    );
    for (key, value) in entries {
        let url = value["url"].as_str().expect("url");
        let prefix = format!(
            "https://github.com/smshagor-dev/OpenMind-Studio/releases/download/v{version}/"
        );
        let name = url
            .strip_prefix(&prefix)
            .unwrap_or_else(|| panic!("{key}: {url}"));
        let file = folders
            .iter()
            .map(|folder| dir.join(folder).join(name))
            .find(|file| file.is_file())
            .unwrap_or_else(|| panic!("{key}: {name} is not in the release folder"));
        let sig = std::fs::read_to_string(format!("{}.sig", file.display()))
            .unwrap_or_else(|err| panic!("{key}: {name} has no .sig ({err})"));
        assert_eq!(value["signature"].as_str(), Some(sig.trim()), "{key}");
    }
    let request = Request::from_feed(&feed, version, dir.clone(), dir.clone(), RELEASE_KEY.into())
        .expect("the portable updater accepts the feed");
    assert!(request.url.ends_with(&format!(
        "_windows_{}_portable.zip",
        if target() == "windows-i686" {
            "x86"
        } else {
            "x64"
        }
    )));
}

#[test]
fn a_fresh_staging_folder_is_kept_at_start_up() {
    let dir = tempfile::tempdir().expect("tmp");
    let staged = dir.path().join(STAGED_DIR).join("1.2.3");
    std::fs::create_dir_all(&staged).expect("dir");
    finish_previous_update(dir.path());
    assert!(
        staged.exists(),
        "it may be another computer's update in progress"
    );
}
