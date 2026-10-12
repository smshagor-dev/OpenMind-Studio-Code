//! The installer-managed layouts: each computer (and Windows user) gets its own local database, earlier data comes along
//! once, and nothing shared is ever written.

use super::*;
use crate::data_scope::tests::{lab_pc, set_value, value};

const UUID_A: &str = "4c4c4544-0042-3510-8051-b3c04f4d3432";
const UUID_B: &str = "4c4c4544-0057-4810-8031-c2c04f4e3432";

fn start(paths: &AppPaths, earlier: Option<&AppPaths>) -> Prepared {
    paths.ensure_dirs().expect("dirs");
    let outcome = prepare(paths, earlier, 1).expect("prepare");
    crate::data_scope::tests::block(async {
        let db = openmind_db::Db::connect(&paths.db_path)
            .await
            .expect("open");
        db.pool().close().await;
    });
    outcome
}

fn bytes_of(dir: &Path) -> Vec<(PathBuf, Vec<u8>)> {
    let mut all = Vec::new();
    let mut stack = vec![dir.to_path_buf()];
    while let Some(next) = stack.pop() {
        for entry in std::fs::read_dir(&next)
            .expect("dir")
            .filter_map(Result::ok)
        {
            let path = entry.path();
            if path.is_dir() {
                stack.push(path);
            } else {
                all.push((path.clone(), std::fs::read(&path).expect("read")));
            }
        }
    }
    all.sort();
    all
}

#[test]
fn two_computers_on_one_network_installation_get_separate_local_databases() {
    let share = tempfile::tempdir().expect("share");
    let program = share.path().join("OpenMind Studio");
    std::fs::create_dir_all(program.join("runtimes/python/versions/3.14.7")).expect("runtime");
    let (pc_a, pc_b) = (
        tempfile::tempdir().expect("a"),
        tempfile::tempdir().expect("b"),
    );
    let a = paths_for(InstallLayout::Network, &program, pc_a.path());
    let b = paths_for(InstallLayout::Network, &program, pc_b.path());
    assert_eq!(start(&a, None), Prepared::Fresh);
    assert_eq!(start(&b, None), Prepared::Fresh);
    set_value(&a.db_path, "who", "A");
    set_value(&b.db_path, "who", "B");
    assert_eq!(value(&a.db_path, "who").as_deref(), Some("A"));
    assert_eq!(value(&b.db_path, "who").as_deref(), Some("B"));
    // Both see the one shared runtime folder; neither database (nor its WAL) is on the share.
    assert_eq!(a.runtimes_dir, b.runtimes_dir);
    assert!(a.db_path.starts_with(pc_a.path()) && b.db_path.starts_with(pc_b.path()));
    assert!(!program.join("data").join("openmind-studio.db").exists());
    // Ten more starts: nothing is initialised again, the data stays.
    for _ in 0..10 {
        assert_eq!(start(&a, None), Prepared::Existing);
    }
    assert_eq!(value(&a.db_path, "who").as_deref(), Some("A"));
}

#[test]
fn a_shared_portable_copy_turned_into_a_network_installation_brings_each_computers_own_profile_once(
) {
    let share = tempfile::tempdir().expect("share");
    let program = share.path().join("OpenMind Studio");
    let pc_a = lab_pc(UUID_A, &program);
    let pc_b = lab_pc(UUID_B, &program);
    // Before: a portable copy in the per-computer scope, each computer's profile in data/machines/<id>/.
    for (pc, owner) in [(&pc_a, "A's history"), (&pc_b, "B's history")] {
        let machine = openmind_core::machine_paths::select_profile(&program, pc).expect("profile");
        let before = AppPaths::per_machine(program.clone(), machine);
        before.ensure_dirs().expect("dirs");
        set_value(&before.db_path, "owner", owner);
    }
    let shared_before = bytes_of(&program);
    let local_a = tempfile::tempdir().expect("local a");
    let paths = paths_for(InstallLayout::Network, &program, local_a.path());
    let earlier = earlier_profile(InstallLayout::Network, &program, &pc_a).expect("A's profile");
    assert_eq!(start(&paths, Some(&earlier)), Prepared::Imported);
    assert_eq!(
        value(&paths.db_path, "owner").as_deref(),
        Some("A's history"),
        "A got its own, never B's"
    );
    // A later start finds its local database and imports nothing again.
    assert_eq!(start(&paths, Some(&earlier)), Prepared::Existing);
    set_value(&paths.db_path, "owner", "A, later");
    assert_eq!(start(&paths, Some(&earlier)), Prepared::Existing);
    assert_eq!(value(&paths.db_path, "owner").as_deref(), Some("A, later"));
    // The shared folder was only read: no file added or removed (SQLite may fold A's own WAL into its database when the
    // read-only copy closes — the same content), both profiles' content as it was.
    let after = bytes_of(&program);
    let names = |all: &[(PathBuf, Vec<u8>)]| -> Vec<PathBuf> {
        all.iter()
            .map(|(path, _)| path.clone())
            .filter(|path| {
                !path.to_string_lossy().ends_with("-wal")
                    && !path.to_string_lossy().ends_with("-shm")
            })
            .collect()
    };
    assert_eq!(names(&after), names(&shared_before));
    let b = earlier_profile(InstallLayout::Network, &program, &pc_b).expect("B");
    assert_eq!(value(&b.db_path, "owner").as_deref(), Some("B's history"));
    assert_eq!(
        value(&earlier.db_path, "owner").as_deref(),
        Some("A's history")
    );
}

#[test]
fn a_per_machine_install_copies_a_database_left_next_to_the_program_once_and_leaves_it() {
    let program_files = tempfile::tempdir().expect("pf");
    let program = program_files.path().join("OpenMind Studio");
    let legacy = AppPaths::from_root(program.clone());
    std::fs::create_dir_all(&legacy.data_dir).expect("dir");
    set_value(&legacy.db_path, "theme", "light");
    let identity = lab_pc(UUID_A, &program);
    let user = tempfile::tempdir().expect("user");
    let paths = paths_for(InstallLayout::PerMachine, &program, user.path());
    assert_eq!(paths.root_dir, user.path());
    assert_eq!(paths.install_dir, program);
    let earlier = earlier_profile(InstallLayout::PerMachine, &program, &identity);
    assert_eq!(start(&paths, earlier.as_ref()), Prepared::Imported);
    assert_eq!(value(&paths.db_path, "theme").as_deref(), Some("light"));
    assert!(
        legacy.db_path.is_file(),
        "the old database stays where it was"
    );
    assert_eq!(start(&paths, earlier.as_ref()), Prepared::Existing);
    // Without an old database there is nothing to bring.
    let clean = tempfile::tempdir().expect("clean");
    assert!(earlier_profile(InstallLayout::PerMachine, clean.path(), &identity).is_none());
}

#[test]
fn an_earlier_database_that_cant_be_copied_never_blocks_the_start_and_stays_untouched() {
    let program_files = tempfile::tempdir().expect("pf");
    let program = program_files.path().join("OpenMind Studio");
    let legacy = AppPaths::from_root(program.clone());
    std::fs::create_dir_all(&legacy.data_dir).expect("dir");
    std::fs::write(&legacy.db_path, b"this is not a database").expect("write");
    let identity = lab_pc(UUID_A, &program);
    let user = tempfile::tempdir().expect("user");
    let paths = paths_for(InstallLayout::PerMachine, &program, user.path());
    let earlier = earlier_profile(InstallLayout::PerMachine, &program, &identity);
    assert_eq!(start(&paths, earlier.as_ref()), Prepared::Fresh);
    assert_eq!(
        std::fs::read(&legacy.db_path).expect("read"),
        b"this is not a database"
    );
}

#[test]
fn a_managed_layout_without_a_local_folder_fails_clearly_and_never_asks() {
    let program = tempfile::tempdir().expect("program");
    let identity = lab_pc(UUID_A, program.path());
    let runtime = resolve(
        InstallLayout::Network,
        program.path().to_path_buf(),
        identity,
        None,
    );
    assert!(!runtime.needs_setup);
    let failure = runtime.failure.expect("failure").to_string();
    assert!(failure.contains("LOCALAPPDATA"), "{failure}");
}

#[test]
fn a_managed_layout_resolves_without_setup_and_records_its_start() {
    let program = tempfile::tempdir().expect("program");
    let local = tempfile::tempdir().expect("local");
    let identity = lab_pc(UUID_A, program.path());
    let runtime = resolve(
        InstallLayout::Network,
        program.path().to_path_buf(),
        identity,
        Some(local.path().to_path_buf()),
    );
    assert!(runtime.failure.is_none(), "{:?}", runtime.failure);
    assert!(!runtime.needs_setup);
    assert_eq!(runtime.paths.layout, InstallLayout::Network);
    let state = install::read_state(local.path()).expect("recorded");
    assert_eq!(state.layout, InstallLayout::Network);
    let status = crate::data_scope::status(&runtime);
    assert!(status.managed);
    assert_eq!(
        status.local_folder.as_deref(),
        Some(local.path().to_string_lossy().as_ref())
    );
}
