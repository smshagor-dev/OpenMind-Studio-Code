use super::*;
use crate::snapshot::tests::{count, live_wal_db};

struct Layout {
    _dir: tempfile::TempDir,
    legacy: PathBuf,
    target: PathBuf,
}

/// `data/openmind-studio.db` (the one-profile database, 10 rows) and an empty profile folder.
fn layout() -> Layout {
    let dir = tempfile::tempdir().expect("tempdir");
    let legacy = dir.path().join("data").join("openmind-studio.db");
    std::fs::create_dir_all(legacy.parent().expect("parent")).expect("dir");
    drop(live_wal_db(&legacy, 10));
    let target = dir
        .path()
        .join("data")
        .join("machines")
        .join("abcdef123456")
        .join("openmind-studio.db");
    Layout {
        _dir: dir,
        legacy,
        target,
    }
}

/// A valid database with `rows` rows (the profile's own, newer data).
fn database(path: &Path, rows: i64) {
    std::fs::create_dir_all(path.parent().expect("parent")).expect("dir");
    drop(live_wal_db(path, rows));
}

fn names(dir: &Path) -> Vec<String> {
    let mut names: Vec<String> = std::fs::read_dir(dir)
        .expect("dir")
        .filter_map(Result::ok)
        .map(|e| e.file_name().to_string_lossy().into_owned())
        .collect();
    names.sort();
    names
}

#[test]
fn case_d_imports_the_legacy_database_and_leaves_it_untouched() {
    let l = layout();
    let before = std::fs::read(&l.legacy).expect("read");
    assert_eq!(
        prepare(&l.target, Some(&l.legacy), 1).expect("prepare"),
        Prepared::Imported
    );
    assert_eq!(count(&l.target, "a"), 10);
    assert!(!migrating_path(&l.target).exists());
    assert_eq!(
        std::fs::read(&l.legacy).expect("read"),
        before,
        "legacy byte for byte"
    );
}

#[test]
fn a_wal_mode_legacy_database_with_a_live_writer_imports_its_committed_rows() {
    let l = layout();
    let open = l.legacy.with_file_name("open.db");
    let writer = live_wal_db(&open, 7); // still open: its rows are only in open.db-wal
    let wal = PathBuf::from(format!("{}-wal", open.display()));
    let (db_before, wal_before) = (
        std::fs::read(&open).expect("read"),
        std::fs::read(&wal).expect("read"),
    );
    assert_eq!(
        prepare(&l.target, Some(&open), 1).expect("prepare"),
        Prepared::Imported
    );
    assert_eq!(
        count(&l.target, "a"),
        7,
        "rows still only in the -wal are imported"
    );
    assert_eq!(
        std::fs::read(&open).expect("read"),
        db_before,
        "no checkpoint"
    );
    assert_eq!(
        std::fs::read(&wal).expect("read"),
        wal_before,
        "the WAL is untouched"
    );
    drop(writer);
}

#[test]
fn the_import_runs_once_and_never_again() {
    let l = layout();
    assert_eq!(
        prepare(&l.target, Some(&l.legacy), 1).expect("first"),
        Prepared::Imported
    );
    // The profile is used: it now has newer data than the legacy database.
    std::fs::remove_file(&l.target).expect("rm");
    database(&l.target, 33);
    for stamp in 2..5 {
        assert_eq!(
            prepare(&l.target, Some(&l.legacy), stamp).expect("again"),
            Prepared::Existing
        );
    }
    assert_eq!(
        count(&l.target, "a"),
        33,
        "case H: the legacy database never overwrites the profile"
    );
    // SQLite's own -wal/-shm files aside, the folder holds the database alone: no copies pile up.
    let folder: Vec<String> = names(l.target.parent().expect("parent"))
        .into_iter()
        .filter(|name| !name.ends_with("-wal") && !name.ends_with("-shm"))
        .collect();
    assert_eq!(
        folder,
        ["openmind-studio.db"],
        "no backup-1, backup-2 ...: {folder:?}"
    );
}

#[test]
fn case_g_a_crash_after_the_rename_but_before_the_marker_is_not_imported_twice() {
    let l = layout();
    database(&l.target, 5); // the rename happened; the pending import was never cleared
    assert_eq!(
        prepare(&l.target, Some(&l.legacy), 1).expect("prepare"),
        Prepared::Existing
    );
    assert_eq!(count(&l.target, "a"), 5);
}

#[test]
fn case_b_a_verified_snapshot_left_by_a_crash_before_the_rename_is_put_in_place() {
    let l = layout();
    let snapshot = migrating_path(&l.target);
    std::fs::create_dir_all(snapshot.parent().expect("parent")).expect("dir");
    crate::snapshot::snapshot_to(&l.legacy, &snapshot).expect("snapshot");
    assert_eq!(
        prepare(&l.target, Some(&l.legacy), 1).expect("prepare"),
        Prepared::Recovered
    );
    assert_eq!(count(&l.target, "a"), 10);
    assert!(!snapshot.exists());
}

#[test]
fn case_c_a_snapshot_cut_short_by_a_crash_is_set_aside_and_rebuilt() {
    let l = layout();
    let snapshot = migrating_path(&l.target);
    std::fs::create_dir_all(snapshot.parent().expect("parent")).expect("dir");
    let bytes = std::fs::read(&l.legacy).expect("read");
    std::fs::write(&snapshot, &bytes[..bytes.len() / 3]).expect("partial");
    let before = bytes.clone();
    assert_eq!(
        prepare(&l.target, Some(&l.legacy), 7).expect("prepare"),
        Prepared::Imported
    );
    assert_eq!(count(&l.target, "a"), 10);
    let folder = names(l.target.parent().expect("parent"));
    assert!(
        folder.contains(&"openmind-studio.db.migrating-invalid-7".to_string()),
        "{folder:?}"
    );
    assert_eq!(std::fs::read(&l.legacy).expect("read"), before);
}

#[test]
fn case_a_a_stale_snapshot_next_to_a_valid_database_never_replaces_it() {
    for valid_snapshot in [true, false] {
        let l = layout();
        database(&l.target, 4);
        let snapshot = migrating_path(&l.target);
        if valid_snapshot {
            crate::snapshot::snapshot_to(&l.legacy, &snapshot).expect("snapshot");
        } else {
            std::fs::write(&snapshot, b"garbage").expect("write");
        }
        assert_eq!(
            prepare(&l.target, None, 9).expect("prepare"),
            Prepared::Existing
        );
        assert_eq!(count(&l.target, "a"), 4);
        assert!(!snapshot.exists());
        assert!(l
            .target
            .with_file_name("openmind-studio.db.migrating-stale-9")
            .exists());
    }
}

#[test]
fn cases_e_and_f_a_damaged_database_is_never_overwritten() {
    let l = layout();
    std::fs::create_dir_all(l.target.parent().expect("parent")).expect("dir");
    std::fs::write(&l.target, b"damaged database, maybe with newer data").expect("write");
    let snapshot = migrating_path(&l.target);
    crate::snapshot::snapshot_to(&l.legacy, &snapshot).expect("snapshot");
    let legacy = std::fs::read(&l.legacy).expect("read");

    let err = prepare(&l.target, Some(&l.legacy), 1).expect_err("refused");
    assert!(err.to_string().contains("integrity check"), "{err}");
    assert_eq!(
        std::fs::read(&l.target).expect("read"),
        b"damaged database, maybe with newer data"
    );
    assert!(
        crate::snapshot::quick_check(&snapshot),
        "the valid snapshot is kept"
    );
    assert_eq!(std::fs::read(&l.legacy).expect("read"), legacy);

    // Without a snapshot (case E) the same.
    std::fs::remove_file(&snapshot).expect("rm");
    assert!(prepare(&l.target, Some(&l.legacy), 2).is_err());
    assert_eq!(
        std::fs::read(&l.target).expect("read"),
        b"damaged database, maybe with newer data"
    );
}

#[test]
fn without_an_import_a_leftover_snapshot_is_never_promoted() {
    let l = layout();
    let snapshot = migrating_path(&l.target);
    std::fs::create_dir_all(snapshot.parent().expect("parent")).expect("dir");
    crate::snapshot::snapshot_to(&l.legacy, &snapshot).expect("snapshot");
    assert_eq!(
        prepare(&l.target, None, 3).expect("prepare"),
        Prepared::Fresh
    );
    assert!(!l.target.exists(), "the app creates its own database");
    assert!(l
        .target
        .with_file_name("openmind-studio.db.migrating-orphan-3")
        .exists());
}

#[test]
fn the_everyday_start_touches_nothing() {
    let l = layout();
    database(&l.target, 2);
    let before = std::fs::read(&l.target).expect("read");
    assert_eq!(
        prepare(&l.target, None, 1).expect("prepare"),
        Prepared::Existing
    );
    assert_eq!(std::fs::read(&l.target).expect("read"), before);
    assert_eq!(
        prepare(&l.target.with_file_name("none.db"), None, 1).expect("fresh"),
        Prepared::Fresh
    );
}

#[test]
fn a_missing_source_imports_nothing_and_a_source_equal_to_the_target_is_refused() {
    let l = layout();
    let missing = l.legacy.with_file_name("gone.db");
    assert_eq!(
        prepare(&l.target, Some(&missing), 1).expect("prepare"),
        Prepared::Fresh
    );
    assert!(prepare(&l.legacy, Some(&l.legacy), 1).is_err());
}

#[test]
fn a_failed_snapshot_leaves_no_snapshot_and_the_source_as_it_was() {
    let l = layout();
    let broken = l.legacy.with_file_name("broken.db");
    std::fs::write(&broken, b"not a database, just text").expect("write");
    assert!(prepare(&l.target, Some(&broken), 4).is_err());
    assert!(!l.target.exists());
    assert!(!migrating_path(&l.target).exists());
    assert_eq!(
        std::fs::read(&broken).expect("read"),
        b"not a database, just text"
    );
}
