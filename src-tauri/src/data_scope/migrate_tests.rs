//! Scope switches: what is scheduled, what the next start does, and that nothing is lost or imported twice.

use super::super::tests::{lab_pc, set_value, value, walk};
use super::super::{prepare, ScopeRuntime};
use super::*;
use openmind_core::data_scope::read_pending_import;
use openmind_core::MachineIdentity;

const UUID_A: &str = "4c4c4544-0042-3510-8051-b3c04f4d3432";

fn runtime(
    root: &Path,
    identity: &MachineIdentity,
    scope: DataScope,
    needs_setup: bool,
) -> ScopeRuntime {
    let (paths, machine) = prepare(root, scope, identity, !needs_setup)
        .map_err(|e| format!("{e:?}"))
        .expect("prepare");
    ScopeRuntime {
        paths,
        machine,
        identity: identity.clone(),
        needs_setup,
        unreadable: None,
        single_computer: false,
        failure: None,
        local_dir: None,
        temporary_folder: false,
    }
}

/// Switch to `to` (scheduling it from a run in `from`), then start in `to`; the database the start opens.
fn switch(
    root: &Path,
    pc: &MachineIdentity,
    from: DataScope,
    to: DataScope,
    use_existing: bool,
) -> AppPaths {
    let now = runtime(root, pc, from, false);
    schedule(&now, to, use_existing).expect("schedule");
    let (paths, _) = prepare(root, to, pc, true)
        .map_err(|e| format!("{e:?}"))
        .expect("next start");
    paths
}

fn legacy_install(root: &Path) -> AppPaths {
    let legacy = AppPaths::from_root(root.to_path_buf());
    std::fs::create_dir_all(&legacy.data_dir).expect("dir");
    set_value(&legacy.db_path, "owner", "legacy");
    // sqlx's pool `close()` can return before the last connection's closing WAL checkpoint has reached the main file;
    // wait for it (the `-wal` file disappears), so a byte comparison of the source sees only what the import does.
    let wal = legacy.db_path.with_extension("db-wal");
    for _ in 0..100 {
        if !wal.exists() {
            break;
        }
        std::thread::sleep(std::time::Duration::from_millis(50));
    }
    assert!(!wal.exists(), "the legacy database was never checkpointed");
    legacy
}

#[test]
fn one_profile_to_multi_computer_copies_and_keeps_the_original() {
    let app = tempfile::tempdir().expect("tempdir");
    let legacy = legacy_install(app.path());
    let before = std::fs::read(&legacy.db_path).expect("read");
    let pc = lab_pc(UUID_A, app.path());
    let machine = switch(
        app.path(),
        &pc,
        DataScope::Personal,
        DataScope::PerMachine,
        true,
    );
    assert_eq!(value(&machine.db_path, "owner").as_deref(), Some("legacy"));
    assert_eq!(
        std::fs::read(&legacy.db_path).expect("read"),
        before,
        "original untouched"
    );
    assert_eq!(read_pending_import(app.path()), None);
}

#[test]
fn multi_computer_to_one_profile_copies_this_computers_profile_when_there_is_none() {
    let app = tempfile::tempdir().expect("tempdir");
    let pc = lab_pc(UUID_A, app.path());
    let now = runtime(app.path(), &pc, DataScope::PerMachine, false);
    set_value(&now.paths.db_path, "owner", "pc-a");
    let personal = switch(
        app.path(),
        &pc,
        DataScope::PerMachine,
        DataScope::Personal,
        true,
    );
    assert_eq!(personal.db_path, now.paths.shared_db_path);
    assert_eq!(value(&personal.db_path, "owner").as_deref(), Some("pc-a"));
    assert_eq!(
        value(&now.paths.db_path, "owner").as_deref(),
        Some("pc-a"),
        "source kept"
    );
}

#[test]
fn switching_back_and_forth_never_overwrites_or_duplicates() {
    let app = tempfile::tempdir().expect("tempdir");
    let legacy = legacy_install(app.path());
    let pc = lab_pc(UUID_A, app.path());
    let machine = switch(
        app.path(),
        &pc,
        DataScope::Personal,
        DataScope::PerMachine,
        true,
    );
    set_value(&machine.db_path, "owner", "newer on pc-a");
    // Back to one profile: data/openmind-studio.db exists, so it is used as it is (nothing copied over it).
    let back = switch(
        app.path(),
        &pc,
        DataScope::PerMachine,
        DataScope::Personal,
        true,
    );
    assert_eq!(back.db_path, legacy.db_path);
    assert_eq!(value(&back.db_path, "owner").as_deref(), Some("legacy"));
    // And again to multi-computer: PC-A's newer profile is kept, the old database isn't imported over it.
    let again = switch(
        app.path(),
        &pc,
        DataScope::Personal,
        DataScope::PerMachine,
        true,
    );
    assert_eq!(
        value(&again.db_path, "owner").as_deref(),
        Some("newer on pc-a")
    );
    let copies = walk(app.path())
        .into_iter()
        .filter(|p| {
            let name = p
                .file_name()
                .map(|n| n.to_string_lossy().into_owned())
                .unwrap_or_default();
            name.starts_with("openmind-studio.db")
                && !name.ends_with("-wal")
                && !name.ends_with("-shm")
        })
        .count();
    assert_eq!(copies, 2, "one database per profile, no extra copies");
}

#[test]
fn starting_fresh_copies_nothing() {
    let app = tempfile::tempdir().expect("tempdir");
    legacy_install(app.path());
    let pc = lab_pc(UUID_A, app.path());
    let machine = switch(
        app.path(),
        &pc,
        DataScope::Personal,
        DataScope::PerMachine,
        false,
    );
    assert!(
        !machine.db_path.exists(),
        "the app will create a new, empty database"
    );
}

#[test]
fn the_ai_history_and_mariadb_data_come_along_and_stay_in_the_source() {
    let app = tempfile::tempdir().expect("tempdir");
    let legacy = legacy_install(app.path());
    std::fs::create_dir_all(&legacy.ai_dir).expect("dir");
    std::fs::write(legacy.ai_dir.join("providers.json"), b"[]").expect("write");
    set_value(&legacy.ai_dir.join("conversations.sqlite"), "chat", "hello");
    std::fs::create_dir_all(legacy.mariadb_data_dir.join("mysql")).expect("dir");
    std::fs::write(legacy.mariadb_data_dir.join("ibdata1"), vec![7u8; 4096]).expect("write");
    let pc = lab_pc(UUID_A, app.path());
    let machine = switch(
        app.path(),
        &pc,
        DataScope::Personal,
        DataScope::PerMachine,
        true,
    );
    assert_eq!(
        std::fs::read(machine.ai_dir.join("providers.json")).expect("read"),
        b"[]"
    );
    assert_eq!(
        value(&machine.ai_dir.join("conversations.sqlite"), "chat").as_deref(),
        Some("hello")
    );
    assert_eq!(
        std::fs::read(machine.mariadb_data_dir.join("ibdata1"))
            .expect("read")
            .len(),
        4096
    );
    assert!(machine.mariadb_data_dir.join("mysql").is_dir());
    assert!(
        legacy.mariadb_data_dir.join("ibdata1").is_file(),
        "the source keeps its files"
    );
    assert_ne!(machine.mariadb_data_dir, legacy.mariadb_data_dir);
}

#[test]
fn an_interrupted_folder_copy_is_made_again() {
    let app = tempfile::tempdir().expect("tempdir");
    let source = app.path().join("src");
    std::fs::create_dir_all(&source).expect("dir");
    std::fs::write(source.join("a.txt"), b"abc").expect("write");
    let dest = app.path().join("dest");
    std::fs::create_dir_all(dest.with_extension("partial")).expect("dir");
    std::fs::write(dest.with_extension("partial").join("junk"), b"half").expect("write");
    copy_dir_verified(&source, &dest).expect("copy");
    assert_eq!(std::fs::read(dest.join("a.txt")).expect("read"), b"abc");
    assert!(!dest.join("junk").exists());
    assert!(
        copy_dir_verified(&source, &dest).is_err(),
        "an existing target is refused"
    );
}

#[cfg(windows)]
#[test]
fn mariadb_files_in_use_are_never_copied() {
    let app = tempfile::tempdir().expect("tempdir");
    let source = app.path().join("mariadb");
    std::fs::create_dir_all(&source).expect("dir");
    std::fs::write(source.join("ibdata1"), b"x").expect("write");
    let held = std::fs::File::open(source.join("ibdata1")).expect("open"); // a running mysqld
    let err = copy_dir_verified(&source, &app.path().join("copy")).expect_err("refused");
    assert!(err.contains("in use"), "{err}");
    drop(held);
    copy_dir_verified(&source, &app.path().join("copy")).expect("copied once free");
}
