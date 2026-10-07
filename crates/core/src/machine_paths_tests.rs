use super::*;
use crate::machine_identity::IdentitySource;

fn identity(hash: &str) -> MachineIdentity {
    MachineIdentity::from_hash(hash.to_string(), IdentitySource::System).expect("hash")
}

const HASH_A: &str = "abcdef1234560000000000000000000000000000000000000000000000000001";
/// The same first 12 (and 16) characters as `HASH_A`: a synthetic prefix collision.
const HASH_B: &str = "abcdef1234560000ffff00000000000000000000000000000000000000000002";

#[test]
fn a_computers_folder_holds_its_database_logs_cache_state_and_temp() {
    let paths = MachineDataPaths::new(Path::new("G:/OpenMind-Studio"), "42f693bd91a7");
    let root = Path::new("G:/OpenMind-Studio/data/machines/42f693bd91a7");
    assert_eq!(paths.root, root);
    assert_eq!(paths.database, root.join("openmind-studio.db"));
    assert_eq!(paths.logs, root.join("logs"));
    assert_eq!(paths.cache, root.join("cache"));
    assert_eq!(paths.state, root.join("state"));
    assert_eq!(paths.temp, root.join("temp"));
}

#[test]
fn the_first_start_creates_the_folder_and_the_next_finds_it_again() {
    let app = tempfile::tempdir().expect("tempdir");
    let first = select_profile(app.path(), &identity(HASH_A)).expect("select");
    assert_eq!(first.machine_id, "abcdef123456");
    let profile = first.read_profile().expect("machine.json");
    assert_eq!(profile.identity_hash, HASH_A);
    assert_eq!(profile.identity_version, 1);
    assert_eq!(profile.schema_version, 1);
    for dir in [&first.logs, &first.cache, &first.state, &first.temp] {
        assert!(dir.is_dir(), "{dir:?}");
    }
    let again = select_profile(app.path(), &identity(HASH_A)).expect("select");
    assert_eq!(again, first);
    assert_eq!(
        again.read_profile().expect("json").created_at,
        profile.created_at
    );
}

#[test]
fn a_prefix_collision_never_reuses_another_computers_folder() {
    let app = tempfile::tempdir().expect("tempdir");
    let a = select_profile(app.path(), &identity(HASH_A)).expect("A");
    std::fs::write(&a.database, b"machine A's data").expect("write");
    let a_json = std::fs::read(a.profile_file()).expect("read");

    let b = select_profile(app.path(), &identity(HASH_B)).expect("B");
    assert_ne!(b.root, a.root);
    assert_eq!(
        b.machine_id,
        &HASH_B[..16],
        "the 12-character folder is taken; the next length is free"
    );
    assert_eq!(
        std::fs::read(&a.database).expect("read"),
        b"machine A's data"
    );
    assert_eq!(
        std::fs::read(a.profile_file()).expect("read"),
        a_json,
        "A untouched"
    );

    // Each comes back to its own folder.
    assert_eq!(
        select_profile(app.path(), &identity(HASH_A))
            .expect("A")
            .root,
        a.root
    );
    assert_eq!(
        select_profile(app.path(), &identity(HASH_B))
            .expect("B")
            .root,
        b.root
    );
}

#[test]
fn machine_json_can_reject_a_folder_but_never_choose_one() {
    let app = tempfile::tempdir().expect("tempdir");
    // A planted machine.json that claims HASH_A's identity, in a folder HASH_A's prefix doesn't name.
    let planted = MachineDataPaths::new(app.path(), "999999999999");
    std::fs::create_dir_all(&planted.root).expect("dir");
    std::fs::write(
        planted.profile_file(),
        format!(
            r#"{{"schemaVersion":1,"identityVersion":1,"profileId":"999999999999","identityHash":"{HASH_A}","platform":"windows","createdAt":"x","lastUsedAt":"x"}}"#
        ),
    )
    .expect("write");
    let chosen = select_profile(app.path(), &identity(HASH_A)).expect("select");
    assert_eq!(chosen.machine_id, "abcdef123456");
}

#[test]
fn a_folder_without_a_readable_machine_json_is_claimed_only_when_empty() {
    let app = tempfile::tempdir().expect("tempdir");
    // A start that stopped right after creating the folder (and a crashed machine.json write).
    let empty = MachineDataPaths::new(app.path(), "abcdef123456");
    std::fs::create_dir_all(&empty.root).expect("dir");
    std::fs::write(empty.root.join("machine.json.77.tmp"), "{ trunc").expect("write");
    assert_eq!(
        select_profile(app.path(), &identity(HASH_A))
            .expect("select")
            .root,
        empty.root
    );

    // A truncated machine.json next to a database: maybe another computer's, so it is left alone.
    let app = tempfile::tempdir().expect("tempdir");
    let damaged = MachineDataPaths::new(app.path(), "abcdef123456");
    std::fs::create_dir_all(&damaged.root).expect("dir");
    std::fs::write(damaged.profile_file(), "{ trunc").expect("write");
    std::fs::write(&damaged.database, b"someone's data").expect("write");
    let chosen = select_profile(app.path(), &identity(HASH_A)).expect("select");
    assert_ne!(chosen.root, damaged.root);
    assert_eq!(
        std::fs::read(&damaged.database).expect("read"),
        b"someone's data"
    );
    assert_eq!(
        std::fs::read_to_string(damaged.profile_file()).expect("read"),
        "{ trunc"
    );
}

#[test]
fn a_new_drive_letter_finds_the_same_folder() {
    let drive = tempfile::tempdir().expect("tempdir");
    let g = drive.path().join("G").join("OpenMind-Studio");
    let first = select_profile(&g, &identity(HASH_A)).expect("select");
    std::fs::write(&first.database, b"A").expect("write");
    // The whole folder moves to another drive letter.
    let h = drive.path().join("H").join("OpenMind-Studio");
    std::fs::create_dir_all(h.parent().expect("parent")).expect("dir");
    std::fs::rename(&g, &h).expect("move");
    let moved = select_profile(&h, &identity(HASH_A)).expect("select");
    assert_eq!(moved.machine_id, first.machine_id);
    assert_eq!(std::fs::read(&moved.database).expect("read"), b"A");
}

#[test]
fn machine_json_holds_derived_values_only() {
    let app = tempfile::tempdir().expect("tempdir");
    let paths = select_profile(app.path(), &identity(HASH_A)).expect("select");
    let text = std::fs::read_to_string(paths.profile_file()).expect("read");
    let value: serde_json::Value = serde_json::from_str(&text).expect("json");
    let mut keys: Vec<&str> = value
        .as_object()
        .expect("object")
        .keys()
        .map(String::as_str)
        .collect();
    keys.sort_unstable();
    assert_eq!(
        keys,
        [
            "createdAt",
            "identityHash",
            "identityVersion",
            "lastUsedAt",
            "platform",
            "profileId",
            "schemaVersion"
        ]
    );
}

#[test]
fn listing_skips_folders_that_are_not_profile_ids() {
    let app = tempfile::tempdir().expect("tempdir");
    select_profile(app.path(), &identity(HASH_A)).expect("select");
    std::fs::create_dir_all(machines_dir(app.path()).join("not-a-profile")).expect("dir");
    let found = list_profiles(app.path());
    assert_eq!(found.len(), 1);
    assert_eq!(found[0].profile_id, "abcdef123456");
    assert!(!found[0].has_database);
    assert!(found[0].last_used_at.is_some());
}
