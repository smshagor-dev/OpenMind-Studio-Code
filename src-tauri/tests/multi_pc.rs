//! **Multi-PC isolation on one computer.** Three logical computers — PC-A, PC-B, PC-C — each with the Windows user
//! `Student` and an identical-looking profile path (`C:\Users\Student\AppData\Local\...`), run one shared network
//! installation. Each logical computer gets its own "disk" (a folder standing for its C: drive); the installation's
//! folder is common to all three.
//!
//! What is real here: the app's own path rules (`AppPaths::network`, `install::local_install_dir_in`), SQLite databases
//! written concurrently in WAL mode, the database's cross-computer lock (`session_guard`), ConPTY terminal sessions,
//! processes of one shared binary with their own stdin/stdout/stderr, working folders, environments and Job Objects.
//! What is simulated: that the three are different machines (different disks and computer tokens on one machine). This
//! is not the physical university test; it is everything that can be checked before it.

use std::path::{Path, PathBuf};
use std::sync::Arc;

use openmind_core::install::{install_key, local_install_dir_in};
use openmind_core::{AppPaths, MachineDataPaths};

const PCS: [&str; 3] = ["PC-A", "PC-B", "PC-C"];
/// What every computer's `%LOCALAPPDATA%` looks like (the same user name everywhere).
const PROFILE: &str = r"Users\Student\AppData\Local";

struct Lab {
    _dir: tempfile::TempDir,
    root: PathBuf,
    share: PathBuf,
}

impl Lab {
    fn new() -> Self {
        let dir = tempfile::tempdir().expect("lab");
        let root = dir.path().to_path_buf();
        let share = root.join("lab-server").join("apps").join("OpenMind Studio");
        std::fs::create_dir_all(share.join("runtimes")).expect("share");
        Self {
            _dir: dir,
            root,
            share,
        }
    }

    /// One computer's `%LOCALAPPDATA%\OpenMind\Studio\Installations` on its own disk.
    fn installations_root(&self, pc: &str) -> PathBuf {
        self.root
            .join(pc)
            .join("C")
            .join(PROFILE)
            .join("OpenMind")
            .join("Studio")
            .join("Installations")
    }

    /// The paths the app computes on that computer for the shared installation (the network layout's own rule).
    fn paths(&self, pc: &str) -> AppPaths {
        let local = local_install_dir_in(&self.installations_root(pc), &self.share);
        AppPaths::network(
            self.share.clone(),
            MachineDataPaths::local(&local, &install_key(&self.share)),
        )
    }
}

fn mutable_dirs(paths: &AppPaths) -> Vec<(&'static str, PathBuf)> {
    vec![
        ("database", paths.db_path.clone()),
        ("logs", paths.logs_dir.clone()),
        ("temp", paths.temp_dir.clone()),
        ("cache", paths.machine_cache_dir.clone()),
        ("webview", paths.webview_dir.clone()),
        ("search index", paths.search_index_dir.clone()),
        ("ai", paths.ai_dir.clone()),
        ("settings", paths.settings_file.clone()),
        ("mariadb data", paths.mariadb_data_dir.clone()),
        ("mariadb config", paths.mariadb_config_dir.clone()),
        ("extension logs", paths.extension_logs_dir.clone()),
    ]
}

#[test]
fn three_student_computers_share_the_program_and_runtimes_and_keep_all_mutable_state_apart() {
    let lab = Lab::new();
    let all: Vec<AppPaths> = PCS.iter().map(|pc| lab.paths(pc)).collect();
    // The profile paths look identical on every computer ...
    let looks: Vec<PathBuf> = PCS
        .iter()
        .zip(&all)
        .map(|(pc, paths)| {
            paths
                .db_path
                .strip_prefix(lab.root.join(pc).join("C"))
                .expect("on its own disk")
                .to_path_buf()
        })
        .collect();
    assert!(looks.windows(2).all(|w| w[0] == w[1]), "{looks:?}");
    assert!(looks[0].starts_with(PROFILE));
    for (pc, paths) in PCS.iter().zip(&all) {
        // ... the shared things are the installation's ...
        assert_eq!(paths.runtimes_dir, lab.share.join("runtimes"), "{pc}");
        assert_eq!(paths.extensions_dir, lab.share.join("extensions"), "{pc}");
        // ... and nothing that changes while the app runs is in the share.
        for (what, dir) in mutable_dirs(paths) {
            assert!(
                !dir.starts_with(&lab.share),
                "{pc}: {what} {} is in the share",
                dir.display()
            );
            assert!(
                dir.starts_with(lab.root.join(pc)),
                "{pc}: {what} {} is not on its own disk",
                dir.display()
            );
        }
    }
    // Every mutable folder is different on every computer.
    for (a, b) in [(0, 1), (0, 2), (1, 2)] {
        for ((what, x), (_, y)) in mutable_dirs(&all[a]).into_iter().zip(mutable_dirs(&all[b])) {
            assert_ne!(x, y, "{what} is shared by {} and {}", PCS[a], PCS[b]);
        }
    }
}

#[test]
fn two_spellings_of_one_shared_folder_give_one_profile_on_a_computer() {
    let lab = Lab::new();
    let root = lab.installations_root("PC-A");
    let unc = local_install_dir_in(&root, &lab.share);
    // A second spelling of the same folder (another case: Windows paths are case-insensitive).
    let other_spelling = PathBuf::from(lab.share.to_string_lossy().to_uppercase());
    if other_spelling.is_dir() {
        assert_eq!(local_install_dir_in(&root, &other_spelling), unc);
    }
}

fn runtime() -> tokio::runtime::Runtime {
    tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .expect("runtime")
}

#[test]
fn three_computers_writing_their_databases_at_once_never_see_each_others_rows() {
    let lab = Lab::new();
    let all: Vec<AppPaths> = PCS.iter().map(|pc| lab.paths(pc)).collect();
    for paths in &all {
        std::fs::create_dir_all(paths.db_path.parent().expect("dir")).expect("data dir");
    }
    // Three computers write at the same moment: one thread (and runtime) each.
    let barrier = Arc::new(std::sync::Barrier::new(PCS.len()));
    let writers: Vec<_> = PCS
        .iter()
        .zip(&all)
        .map(|(pc, paths)| {
            let (pc, db_path, barrier) = (pc.to_string(), paths.db_path.clone(), barrier.clone());
            std::thread::spawn(move || {
                runtime().block_on(async {
                    let db = openmind_db::Db::connect(&db_path).await.expect("connect");
                    barrier.wait();
                    let repo = openmind_db::EditorSettingsRepository::new(db.pool());
                    for i in 0..200 {
                        repo.set(&format!("{pc}.key.{i}"), &format!("{pc}-{i}"))
                            .await
                            .expect("write");
                    }
                    let keys: Vec<(String,)> =
                        sqlx::query_as("SELECT key FROM editor_settings WHERE key LIKE 'PC-%'")
                            .fetch_all(db.pool())
                            .await
                            .expect("rows");
                    assert_eq!(keys.len(), 200, "{pc}");
                    assert!(
                        keys.iter().all(|(key,)| key.starts_with(&pc)),
                        "{pc} sees another computer's rows"
                    );
                    db.pool().close().await;
                });
            })
        })
        .collect();
    for writer in writers {
        writer.join().expect("writer");
    }
    // SQLite's WAL and shared-memory files live next to each computer's own database, never in the share.
    for (pc, paths) in PCS.iter().zip(&all) {
        let dir = paths.db_path.parent().expect("dir");
        let names: Vec<String> = std::fs::read_dir(dir)
            .expect("dir")
            .filter_map(Result::ok)
            .map(|e| e.file_name().to_string_lossy().into_owned())
            .collect();
        assert!(names.iter().any(|n| n.ends_with(".db")), "{pc}: {names:?}");
    }
    let in_share: Vec<PathBuf> = walk(&lab.share)
        .into_iter()
        .filter(|p| {
            let name = p.to_string_lossy();
            name.ends_with(".db") || name.ends_with("-wal") || name.ends_with("-shm")
        })
        .collect();
    assert!(in_share.is_empty(), "{in_share:?}");
}

fn walk(dir: &Path) -> Vec<PathBuf> {
    let mut found = Vec::new();
    if let Ok(entries) = std::fs::read_dir(dir) {
        for entry in entries.filter_map(Result::ok) {
            let path = entry.path();
            if path.is_dir() {
                found.extend(walk(&path));
            } else {
                found.push(path);
            }
        }
    }
    found
}

#[test]
fn a_database_in_a_shared_folder_is_opened_by_one_computer_at_a_time() {
    use openmind_core::session_guard::{claim_as, Claim};
    let lab = Lab::new();
    // A portable copy set up "only for me" on the share: one database folder, three computers starting it.
    let profile = lab.share.join("data");
    let first = claim_as(&profile, "token-pc-a");
    assert!(matches!(first, Claim::Owner(_)), "{first:?}");
    assert!(matches!(
        claim_as(&profile, "token-pc-b"),
        Claim::OtherComputer
    ));
    assert!(matches!(
        claim_as(&profile, "token-pc-c"),
        Claim::OtherComputer
    ));
    assert!(matches!(
        claim_as(&profile, "token-pc-a"),
        Claim::SameComputer
    ));
    // PC-A closes (or crashes): its lock goes with its process, and the next computer may start.
    drop(first);
    assert!(matches!(claim_as(&profile, "token-pc-b"), Claim::Owner(_)));
}

#[path = "multi_pc/exec.rs"]
mod exec;
