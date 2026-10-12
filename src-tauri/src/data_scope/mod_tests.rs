//! Start-up resolution: decisions, privacy, and the university-lab scenario on one simulated portable drive.

use super::*;
use openmind_core::data_scope::write_choice;
use openmind_core::machine_identity::{resolve_with, IdentityProbe, MachineSignals};
use openmind_db::{Db, EditorSettingsRepository};

const CLONED_GUID: &str = "6f1c2a4e-9b3d-4c21-8e57-0d2b9a6c1f34";
const UUID_A: &str = "4c4c4544-0042-3510-8051-b3c04f4d3432";
const UUID_B: &str = "4c4c4544-0057-4810-8031-c2c04f4e3432";

pub(super) struct Pc(MachineSignals);

impl IdentityProbe for Pc {
    fn signals(&self) -> MachineSignals {
        self.0.clone()
    }
    fn persisted_file(&self) -> Option<PathBuf> {
        None
    }
    fn generate(&self) -> Option<String> {
        None
    }
}

/// A lab PC cloned from one Windows image: same MachineGuid, its own SMBIOS UUID.
pub(super) fn lab_pc(uuid: &str, root: &std::path::Path) -> MachineIdentity {
    resolve_with(
        &Pc(MachineSignals {
            os_id: Some(CLONED_GUID.into()),
            hardware_uuid: Some(uuid.into()),
            hardware_serial: None,
        }),
        root,
    )
}

pub(super) fn block<T>(future: impl std::future::Future<Output = T>) -> T {
    tauri::async_runtime::block_on(future)
}

pub(super) fn set_value(path: &std::path::Path, key: &str, value: &str) {
    block(async {
        let db = Db::connect(path).await.expect("connect");
        EditorSettingsRepository::new(db.pool())
            .set(key, value)
            .await
            .expect("set");
        db.pool().close().await;
    });
}

pub(super) fn value(path: &std::path::Path, key: &str) -> Option<String> {
    block(async {
        let db = Db::connect(path).await.expect("connect");
        let value = EditorSettingsRepository::new(db.pool())
            .get(key)
            .await
            .expect("get");
        db.pool().close().await;
        value
    })
}

/// What `main` does with a resolved start: prepare, then open the database it was given.
fn start(root: &std::path::Path, scope: DataScope, identity: &MachineIdentity) -> AppPaths {
    let (paths, _) = prepare(root, scope, identity, true)
        .map_err(|e| format!("{e:?}"))
        .expect("prepare");
    block(async {
        let db = Db::connect(&paths.db_path).await.expect("open");
        db.pool().close().await;
    });
    paths
}

fn facts(choice: ScopeChoice, portable_root: bool, installed: bool) -> ScopeFacts {
    ScopeFacts {
        choice,
        portable_root,
        installed,
        remembered: None,
        own_profile: false,
    }
}

fn used(scope: DataScope, restore: bool) -> Decision {
    Decision::Use { scope, restore }
}

#[test]
fn a_saved_choice_always_wins() {
    for scope in [DataScope::Personal, DataScope::PerMachine] {
        for (portable, installed) in [(true, false), (false, false), (true, true)] {
            let mut f = facts(ScopeChoice::Chosen(scope), portable, installed);
            assert_eq!(decide(&f), used(scope, false));
            // This computer's older record never outranks the drive's own choice.
            f.remembered = Some(match scope {
                DataScope::Personal => DataScope::PerMachine,
                DataScope::PerMachine => DataScope::Personal,
            });
            assert_eq!(decide(&f), used(scope, false));
        }
    }
}

#[test]
fn a_portable_copy_without_a_choice_asks_and_installed_ones_keep_one_profile() {
    assert_eq!(
        decide(&facts(ScopeChoice::NotChosen, true, false)),
        Decision::Ask
    );
    assert_eq!(
        decide(&facts(ScopeChoice::Unreadable("x".into()), true, false)),
        Decision::Ask
    );
    assert_eq!(
        decide(&facts(ScopeChoice::NotChosen, true, true)),
        used(DataScope::Personal, false)
    );
    assert_eq!(
        decide(&facts(ScopeChoice::NotChosen, false, false)),
        used(DataScope::Personal, false)
    );
}

#[test]
fn a_completed_choice_is_never_asked_again_when_its_file_goes_missing() {
    // The drive's file is gone (a folder copied over, a cleaned data folder) but this computer remembers the choice.
    let mut f = facts(ScopeChoice::NotChosen, true, false);
    f.remembered = Some(DataScope::PerMachine);
    assert_eq!(decide(&f), used(DataScope::PerMachine, true));
    f.remembered = Some(DataScope::Personal);
    assert_eq!(decide(&f), used(DataScope::Personal, true));
    // No record on this computer (another Windows user), but its own per-computer profile is on the drive.
    let mut f = facts(ScopeChoice::NotChosen, true, false);
    f.own_profile = true;
    assert_eq!(decide(&f), used(DataScope::PerMachine, true));
}

#[test]
fn a_file_that_cant_be_read_for_a_moment_never_brings_the_setup_back() {
    let reason =
        ScopeChoice::Inaccessible("The network name is no longer available. (os error 64)".into());
    // What this computer knows decides, and the file (which may be fine) is not rewritten.
    let mut f = facts(reason.clone(), true, false);
    f.remembered = Some(DataScope::PerMachine);
    assert_eq!(decide(&f), used(DataScope::PerMachine, false));
    let mut f = facts(reason.clone(), true, false);
    f.own_profile = true;
    assert_eq!(decide(&f), used(DataScope::PerMachine, false));
    // Nothing to go on: start-up stops with the reason instead of asking (a second choice would overwrite the first).
    match decide(&facts(reason, true, false)) {
        Decision::Fail(text) => {
            assert!(text.contains("os error 64"), "{text}");
            assert!(text.contains("Nothing was changed"), "{text}");
        }
        other => panic!("expected a failure, got {other:?}"),
    }
    // A damaged file with a record: the record decides, the damaged file stays for the user to see.
    let mut f = facts(
        ScopeChoice::Unreadable("expected value".into()),
        true,
        false,
    );
    f.remembered = Some(DataScope::Personal);
    assert_eq!(decide(&f), used(DataScope::Personal, false));
}

#[test]
fn the_university_lab_scenario() {
    let drive = tempfile::tempdir().expect("tempdir");
    let g = drive.path().join("G").join("OpenMind-Studio");
    // An existing one-profile installation with a runtime installed on the drive.
    let legacy = AppPaths::from_root(g.clone());
    std::fs::create_dir_all(&legacy.data_dir).expect("dir");
    set_value(&legacy.db_path, "owner", "legacy");
    let node = g.join("runtimes/node/versions/24.21.0/node.exe");
    std::fs::create_dir_all(node.parent().expect("parent")).expect("dir");
    std::fs::write(&node, b"node").expect("node");

    // PC-A chooses Multi-computer and brings the existing profile along.
    let pc_a = lab_pc(UUID_A, &g);
    let runtime = ScopeRuntime {
        paths: AppPaths::from_root(g.clone()),
        machine: None,
        identity: pc_a.clone(),
        needs_setup: true,
        unreadable: None,
        single_computer: false,
        failure: None,
        local_dir: None,
        temporary_folder: false,
    };
    let scheduled = migrate::schedule(&runtime, DataScope::PerMachine, true).expect("schedule");
    assert!(scheduled.will_import);
    let a = start(&g, DataScope::PerMachine, &pc_a);
    assert_eq!(
        value(&a.db_path, "owner").as_deref(),
        Some("legacy"),
        "PC-A got the old profile"
    );
    set_value(&a.db_path, "window", "PC-A layout");

    // PC-B (same cloned MachineGuid, other SMBIOS UUID) gets its own, new profile.
    let pc_b = lab_pc(UUID_B, &g);
    let b = start(&g, DataScope::PerMachine, &pc_b);
    assert_ne!(a.db_path, b.db_path);
    assert_eq!(
        value(&b.db_path, "owner"),
        None,
        "PC-B never sees PC-A's or the old data"
    );
    for (left, right) in [
        (&a.webview_dir, &b.webview_dir),
        (&a.search_index_dir, &b.search_index_dir),
        (&a.ai_dir, &b.ai_dir),
        (&a.temp_dir, &b.temp_dir),
        (&a.logs_dir, &b.logs_dir),
        (&a.mariadb_data_dir, &b.mariadb_data_dir),
        (&a.machine_cache_dir, &b.machine_cache_dir),
    ] {
        assert_ne!(left, right);
    }
    assert_eq!(a.runtimes_dir, b.runtimes_dir, "one shared runtimes folder");
    assert!(b
        .runtimes_dir
        .join("node/versions/24.21.0/node.exe")
        .is_file());
    let runtime_copies = walk(&g)
        .into_iter()
        .filter(|path| path.ends_with("node.exe"))
        .count();
    assert_eq!(runtime_copies, 1, "no per-computer runtime copies");

    // Back on PC-A: its own profile again, not a third one.
    let a_again = start(&g, DataScope::PerMachine, &lab_pc(UUID_A, &g));
    assert_eq!(a_again.db_path, a.db_path);
    assert_eq!(
        value(&a_again.db_path, "window").as_deref(),
        Some("PC-A layout")
    );
    assert_eq!(list_profiles(&g).len(), 2);

    // The drive becomes H: (and PC-A is renamed: nothing about it is an input).
    let h = drive.path().join("H").join("OpenMind-Studio");
    std::fs::create_dir_all(h.parent().expect("parent")).expect("dir");
    // Windows' virus scanner/indexer holds just-written files for a moment, which makes a folder rename fail with
    // "Access is denied" (nothing of ours is open: every pool is closed). Retry for up to 10 s.
    let mut tries = 0;
    while let Err(err) = std::fs::rename(&g, &h) {
        tries += 1;
        assert!(tries < 100, "move: {err:?}");
        std::thread::sleep(std::time::Duration::from_millis(100));
    }
    let a_on_h = start(&h, DataScope::PerMachine, &lab_pc(UUID_A, &h));
    assert_eq!(
        a_on_h.db_path.strip_prefix(&h).expect("inside"),
        a.db_path.strip_prefix(&g).expect("inside")
    );
    assert_eq!(
        value(&a_on_h.db_path, "window").as_deref(),
        Some("PC-A layout")
    );
    assert!(a_on_h
        .runtimes_dir
        .join("node/versions/24.21.0/node.exe")
        .is_file());
    assert_eq!(
        list_profiles(&h).len(),
        2,
        "no new profile after the letter change"
    );

    // The old one-profile database is still there, unchanged.
    assert_eq!(
        value(&AppPaths::from_root(h.clone()).db_path, "owner").as_deref(),
        Some("legacy")
    );
}

#[test]
fn encrypted_secrets_stay_in_the_profile_that_saved_them() {
    let drive = tempfile::tempdir().expect("tempdir");
    let root = drive.path().join("OpenMind-Studio");
    std::fs::create_dir_all(root.join("data")).expect("dir");
    write_choice(&root, DataScope::PerMachine, None).expect("choice");
    let a = start(&root, DataScope::PerMachine, &lab_pc(UUID_A, &root));
    set_value(&a.db_path, "ai.key.claude", "dpapi1:AAAA-encrypted-on-pc-a");
    let b = start(&root, DataScope::PerMachine, &lab_pc(UUID_B, &root));
    assert_eq!(
        value(&b.db_path, "ai.key.claude"),
        None,
        "PC-B can't even see PC-A's encrypted key"
    );
}

#[test]
fn two_starts_at_once_on_one_computer_import_once() {
    let drive = tempfile::tempdir().expect("tempdir");
    let root = drive.path().join("OpenMind-Studio");
    let legacy = AppPaths::from_root(root.clone());
    std::fs::create_dir_all(&legacy.data_dir).expect("dir");
    set_value(&legacy.db_path, "owner", "legacy");
    let pc = lab_pc(UUID_A, &root);
    let runtime = ScopeRuntime {
        paths: legacy.clone(),
        machine: None,
        identity: pc.clone(),
        needs_setup: true,
        unreadable: None,
        single_computer: false,
        failure: None,
        local_dir: None,
        temporary_folder: false,
    };
    migrate::schedule(&runtime, DataScope::PerMachine, true).expect("schedule");
    let handles: Vec<_> = (0..4)
        .map(|_| {
            let root = root.clone();
            let pc = pc.clone();
            std::thread::spawn(move || {
                prepare(&root, DataScope::PerMachine, &pc, true)
                    .map(|(p, _)| p)
                    .map_err(|e| format!("{e:?}"))
            })
        })
        .collect();
    let results: Vec<AppPaths> = handles
        .into_iter()
        .map(|h| h.join().expect("thread").expect("prepare"))
        .collect();
    assert!(results.windows(2).all(|w| w[0].db_path == w[1].db_path));
    assert_eq!(
        value(&results[0].db_path, "owner").as_deref(),
        Some("legacy")
    );
    let folder = results[0].machine.as_ref().expect("machine").root.clone();
    let leftovers: Vec<String> = std::fs::read_dir(&folder)
        .expect("dir")
        .filter_map(Result::ok)
        .map(|e| e.file_name().to_string_lossy().into_owned())
        .filter(|name| name.contains("migrating") || name.ends_with(".tmp"))
        .collect();
    assert!(leftovers.is_empty(), "{leftovers:?}");
    assert_eq!(
        read_pending_import(&root),
        None,
        "the request is cleared once"
    );
}

#[test]
fn the_status_never_contains_raw_identifiers() {
    let app = tempfile::tempdir().expect("tempdir");
    let identity = lab_pc(UUID_A, app.path());
    let (paths, machine) = prepare(app.path(), DataScope::PerMachine, &identity, false)
        .map_err(|e| format!("{e:?}"))
        .expect("prepare");
    let runtime = ScopeRuntime {
        paths,
        machine,
        identity,
        needs_setup: true,
        unreadable: None,
        single_computer: false,
        failure: None,
        local_dir: None,
        temporary_folder: false,
    };
    let text = serde_json::to_string(&status(&runtime)).expect("json");
    let machine_json =
        std::fs::read_to_string(runtime.machine.as_ref().expect("machine").profile_file())
            .expect("read");
    for raw in [CLONED_GUID, UUID_A, "6f1c2a4e", "4c4c4544"] {
        assert!(!text.to_lowercase().contains(raw), "{raw} in {text}");
        assert!(
            !machine_json.to_lowercase().contains(raw),
            "{raw} in machine.json"
        );
        for path in walk(app.path()) {
            assert!(
                !path.to_string_lossy().to_lowercase().contains(raw),
                "{raw} in {path:?}"
            );
        }
    }
    assert!(text.contains("\"recommended\":\"perMachine\""), "{text}");
    assert!(text.contains("\"mode\":null"), "{text}");
}

pub(super) fn walk(dir: &std::path::Path) -> Vec<PathBuf> {
    let mut found = Vec::new();
    if let Ok(entries) = std::fs::read_dir(dir) {
        for entry in entries.filter_map(Result::ok) {
            let path = entry.path();
            if path.is_dir() {
                found.extend(walk(&path));
            }
            found.push(path);
        }
    }
    found
}
