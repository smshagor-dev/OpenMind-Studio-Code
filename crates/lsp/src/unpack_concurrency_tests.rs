//! Several processes — on one computer or on several sharing `language-servers/` — preparing one language server at
//! the same moment.

use super::tests::{bundle_with, first_pack};
use super::*;
use crate::install::is_installed;
use crate::registry::{package_by_id, server_by_id};

const SERVER_FILE: (&str, &str) = ("node_modules/pyright/langserver.index.js", "// server");

fn leftovers(base: &Path) -> Vec<String> {
    fs::read_dir(base)
        .map(|entries| {
            entries
                .flatten()
                .map(|e| e.file_name().to_string_lossy().into_owned())
                .filter(|name| name.starts_with(".unpacking") || name.starts_with(".retired-"))
                .collect()
        })
        .unwrap_or_default()
}

#[test]
fn many_unpacks_of_one_package_at_once_all_succeed_and_extract_once() {
    let root = tempfile::tempdir().expect("tempdir");
    let app = root.path().join("Shared App");
    let bundle = bundle_with(&app, &[SERVER_FILE], None);
    let pack = first_pack(&bundle);
    let package = package_by_id("python").expect("package");
    let results: Vec<Result<(), String>> = std::thread::scope(|scope| {
        let handles: Vec<_> = (0..6)
            .map(|_| {
                scope.spawn(|| unpack(&app, &bundle, &pack, package).map_err(|e| e.to_string()))
            })
            .collect();
        handles
            .into_iter()
            .map(|h| h.join().expect("thread"))
            .collect()
    });
    assert!(results.iter().all(Result::is_ok), "{results:?}");
    assert!(is_installed(
        &app,
        server_by_id("python").expect("server"),
        package
    ));
    let base = app.join("language-servers").join(package.id);
    assert!(leftovers(&base).is_empty(), "{:?}", leftovers(&base));
    let folders: Vec<String> = fs::read_dir(&base)
        .expect("dir")
        .flatten()
        .filter(|e| e.path().is_dir())
        .map(|e| e.file_name().to_string_lossy().into_owned())
        .collect();
    assert_eq!(folders, vec![package.revision.to_string()]);
}

#[test]
fn a_waiting_unpack_uses_what_the_holder_finished_instead_of_extracting_again() {
    let root = tempfile::tempdir().expect("tempdir");
    let app = root.path().join("Shared App");
    let bundle = bundle_with(&app, &[SERVER_FILE], None);
    let pack = first_pack(&bundle);
    let package = package_by_id("python").expect("package");
    let base = app.join("language-servers").join(package.id);
    // Another computer holds the lock and is half-way.
    let other = PackageLock::acquire(&base, std::time::Duration::from_secs(1)).expect("lock");
    std::thread::scope(|scope| {
        let waiter = scope.spawn(|| unpack(&app, &bundle, &pack, package));
        std::thread::sleep(std::time::Duration::from_millis(600));
        assert!(!waiter.is_finished(), "it waits, it doesn't fail");
        // The other computer finishes: the pack is in place, then it lets go.
        unpack_unlocked_for_test(&app, &bundle, &pack, package);
        let finished = package_dir(&app, package);
        let marker_before = fs::metadata(finished.join(MARKER))
            .expect("marker")
            .modified()
            .expect("mtime");
        drop(other);
        waiter.join().expect("thread").expect("ok");
        let marker_after = fs::metadata(finished.join(MARKER))
            .expect("marker")
            .modified()
            .expect("mtime");
        assert_eq!(marker_before, marker_after, "not extracted a second time");
    });
}

/// What the lock holder does, without taking the lock again (the test holds it).
fn unpack_unlocked_for_test(app: &Path, bundle: &Bundle, pack: &PackEntry, package: &Package) {
    let base = app.join("language-servers").join(package.id);
    let staging = base.join(".unpacking-other-pc");
    fs::create_dir_all(&staging).expect("staging");
    extract(&bundle.pack_path(pack), &staging).expect("extract");
    fs::write(staging.join(MARKER), format!("{}\n", pack.sha256)).expect("marker");
    publish(&staging, &package_dir(app, package)).expect("publish");
}

#[test]
fn leftovers_of_an_interrupted_unpack_are_cleared_by_the_next_one() {
    let root = tempfile::tempdir().expect("tempdir");
    let app = root.path().join("Shared App");
    let bundle = bundle_with(&app, &[SERVER_FILE], None);
    let package = package_by_id("python").expect("package");
    let base = app.join("language-servers").join(package.id);
    for name in [".unpacking", ".unpacking-4242-1", ".retired-4242-2"] {
        fs::create_dir_all(base.join(name).join("node_modules")).expect("leftover");
    }
    unpack(&app, &bundle, &first_pack(&bundle), package).expect("unpack");
    assert!(leftovers(&base).is_empty(), "{:?}", leftovers(&base));
    assert!(
        base.join(".lock").is_file(),
        "the lock file stays (it is never a lock by itself)"
    );
}

#[cfg(windows)]
#[test]
fn a_copy_in_use_somewhere_is_never_replaced_or_deleted() {
    use std::os::windows::fs::OpenOptionsExt;
    let root = tempfile::tempdir().expect("tempdir");
    let app = root.path().join("Shared App");
    let package = package_by_id("python").expect("package");
    // An older pack is unpacked and a server started from it is running (its file is open without delete sharing).
    let old = bundle_with(&app, &[SERVER_FILE, ("old.txt", "old")], None);
    unpack(&app, &old, &first_pack(&old), package).expect("old");
    let running = fs::OpenOptions::new()
        .read(true)
        .share_mode(1)
        .open(package_dir(&app, package).join(SERVER_FILE.0))
        .expect("open");
    let new = bundle_with(&app, &[SERVER_FILE, ("new.txt", "new")], None);
    let err = unpack(&app, &new, &first_pack(&new), package).expect_err("in use");
    assert!(err.to_string().contains("in use"), "{err}");
    let dir = package_dir(&app, package);
    assert!(
        dir.join("old.txt").is_file(),
        "the copy in use is untouched"
    );
    assert!(dir.join(SERVER_FILE.0).is_file());
    drop(running);
    unpack(&app, &new, &first_pack(&new), package).expect("now it is replaced");
    assert!(dir.join("new.txt").is_file());
    assert_eq!(
        unpacked_from(&app, package),
        Some(first_pack(&new).sha256.to_ascii_lowercase())
    );
    assert!(leftovers(dir.parent().expect("base")).is_empty());
}
