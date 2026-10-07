use super::*;
use std::path::PathBuf;

/// A WAL database whose rows live only in its `-wal` file (automatic checkpoints off, the writer kept open).
pub(crate) fn live_wal_db(path: &Path, rows: i64) -> Connection {
    let conn = Connection::open(path).expect("open");
    conn.pragma_update(None, "journal_mode", "WAL")
        .expect("wal");
    conn.pragma_update(None, "wal_autocheckpoint", 0)
        .expect("no checkpoint");
    conn.execute_batch("CREATE TABLE a(n INTEGER); CREATE TABLE b(n INTEGER);")
        .expect("tables");
    for n in 0..rows {
        conn.execute_batch(&format!(
            "BEGIN; INSERT INTO a VALUES({n}); INSERT INTO b VALUES({n}); COMMIT;"
        ))
        .expect("insert");
    }
    conn
}

pub(crate) fn count(path: &Path, table: &str) -> i64 {
    let conn = Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_ONLY).expect("open");
    conn.query_row(&format!("SELECT COUNT(*) FROM {table}"), [], |row| {
        row.get(0)
    })
    .expect("count")
}

#[test]
fn a_snapshot_holds_rows_that_are_only_in_the_wal_and_leaves_the_source_as_it_was() {
    let dir = tempfile::tempdir().expect("tempdir");
    let source = dir.path().join("openmind-studio.db");
    let writer = live_wal_db(&source, 25);
    let wal = PathBuf::from(format!("{}-wal", source.display()));
    assert!(wal.is_file() && std::fs::metadata(&wal).expect("meta").len() > 0);
    let db_before = std::fs::read(&source).expect("read");
    let wal_before = std::fs::read(&wal).expect("read");

    let dest = dir.path().join("copy.db.migrating");
    snapshot_to(&source, &dest).expect("snapshot");

    assert_eq!(
        count(&dest, "a"),
        25,
        "committed WAL transactions are in the copy"
    );
    assert!(quick_check(&dest));
    assert_eq!(
        std::fs::read(&source).expect("read"),
        db_before,
        "main file untouched"
    );
    assert_eq!(
        std::fs::read(&wal).expect("read"),
        wal_before,
        "WAL untouched"
    );
    drop(writer);
}

#[test]
fn a_snapshot_of_a_database_being_written_is_one_consistent_state() {
    let dir = tempfile::tempdir().expect("tempdir");
    let source = dir.path().join("live.db");
    let writer = live_wal_db(&source, 200);
    let stop = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
    let flag = stop.clone();
    let path = source.clone();
    let busy = std::thread::spawn(move || {
        let conn = Connection::open(&path).expect("open");
        conn.busy_timeout(Duration::from_secs(5)).expect("timeout");
        let mut n = 1000;
        while !flag.load(std::sync::atomic::Ordering::Relaxed) {
            // a and b always change together.
            let _ = conn.execute_batch(&format!(
                "BEGIN IMMEDIATE; INSERT INTO a VALUES({n}); INSERT INTO b VALUES({n}); COMMIT;"
            ));
            n += 1;
        }
    });
    std::thread::sleep(Duration::from_millis(50));
    let dest = dir.path().join("snap.db.migrating");
    snapshot_to(&source, &dest).expect("snapshot");
    stop.store(true, std::sync::atomic::Ordering::Relaxed);
    busy.join().expect("writer");
    assert!(quick_check(&dest));
    let (a, b) = (count(&dest, "a"), count(&dest, "b"));
    assert_eq!(a, b, "no half transaction in the copy");
    assert!(a >= 200);
    drop(writer);
}

#[test]
fn an_existing_destination_is_never_overwritten() {
    let dir = tempfile::tempdir().expect("tempdir");
    let source = dir.path().join("a.db");
    let _writer = live_wal_db(&source, 1);
    let dest = dir.path().join("b.db");
    std::fs::write(&dest, b"keep me").expect("write");
    assert!(snapshot_to(&source, &dest).is_err());
    assert_eq!(std::fs::read(&dest).expect("read"), b"keep me");
}

#[test]
fn quick_check_refuses_anything_that_is_not_a_sound_database() {
    let dir = tempfile::tempdir().expect("tempdir");
    let text = dir.path().join("text.db");
    std::fs::write(&text, b"this is not a database at all, just some text").expect("write");
    assert!(!quick_check(&text));
    assert!(!quick_check(&dir.path().join("missing.db")));
    let source = dir.path().join("real.db");
    drop(live_wal_db(&source, 3));
    let bytes = std::fs::read(&source).expect("read");
    let half = dir.path().join("half.db");
    std::fs::write(&half, &bytes[..bytes.len() / 2]).expect("write");
    assert!(!quick_check(&half), "a copy cut short is not valid");
    assert!(quick_check(&source));
}

#[test]
fn checking_a_source_never_checkpoints_its_wal_into_the_main_file() {
    let dir = tempfile::tempdir().expect("tempdir");
    let live = dir.path().join("live.db");
    let writer = live_wal_db(&live, 20);
    // A source left with rows only in its `-wal` (the app that wrote it ended without a checkpoint).
    let source = dir.path().join("conversations.sqlite");
    let wal = PathBuf::from(format!("{}-wal", source.display()));
    std::fs::copy(&live, &source).expect("copy");
    std::fs::copy(format!("{}-wal", live.display()), &wal).expect("copy wal");
    drop(writer);
    let main_before = std::fs::read(&source).expect("read");
    let wal_before = std::fs::read(&wal).expect("read");

    assert!(quick_check_source(&source));
    assert_eq!(
        std::fs::read(&source).expect("read"),
        main_before,
        "main file unchanged"
    );
    assert_eq!(
        std::fs::read(&wal).expect("read"),
        wal_before,
        "the -wal is kept"
    );
    assert_eq!(
        count(&source, "a"),
        20,
        "the rows are still only in the -wal"
    );
}
