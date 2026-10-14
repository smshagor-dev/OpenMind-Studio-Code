//! One portable drive, several computers: each has its own database, all share `runtimes/`.

use super::*;

/// Another computer on the same drive: its own (new) database, the same `runtimes/` and `cache/` folders.
async fn other_pc(fx: &Fixture, name: &str) -> RuntimeManager {
    let db = Db::connect(&fx.root.join(format!("{name}.db")))
        .await
        .expect("db");
    RuntimeManager::new(
        db,
        RuntimePaths::new(fx.root.join("runtimes"), fx.root.join("cache")),
        fx.manager.registry.as_ref().clone(),
        fx.client.clone(),
        "windows-x64",
    )
}

fn files_under(dir: &Path) -> usize {
    fs::read_dir(dir).map_or(0, |entries| {
        entries
            .filter_map(Result::ok)
            .map(|e| {
                if e.path().is_dir() {
                    files_under(&e.path())
                } else {
                    1
                }
            })
            .sum()
    })
}

#[tokio::test]
async fn a_runtime_installed_on_pc_a_is_installed_on_pc_b_without_a_download() {
    let fx = fixture().await;
    fx.manager
        .install("demo", Some("1.0.0"), no_progress())
        .await
        .expect("install on PC-A");
    let downloads = fx.client.requests.lock().expect("lock").len();
    let files = files_under(&fx.root.join("runtimes"));

    let pc_b = other_pc(&fx, "pc-b").await;
    // Before anything listed the runtimes on PC-B, a terminal or run already gets it on PATH.
    let env = pc_b.environment().await.expect("env");
    assert!(
        env.path_prepend
            .iter()
            .any(|dir| dir.starts_with(versions_dir(&fx).join("1.0.0"))),
        "{:?}",
        env.path_prepend
    );
    let status = demo(pc_b.list().await.expect("list"));
    assert_eq!(status.installed.len(), 1);
    assert!(status.installed[0].active && status.installed[0].healthy);
    assert_eq!(
        fx.client.requests.lock().expect("lock").len(),
        downloads,
        "no download"
    );
    assert_eq!(
        files_under(&fx.root.join("runtimes")),
        files,
        "no second copy"
    );
    assert!(pc_b.installed_dir("demo").await.is_some());
}

#[tokio::test]
async fn an_update_or_removal_on_one_pc_is_seen_by_the_others() {
    let fx = fixture().await;
    fx.manager
        .install("demo", Some("1.0.0"), no_progress())
        .await
        .expect("install");
    let pc_b = other_pc(&fx, "pc-b").await;
    assert_eq!(demo(pc_b.list().await.expect("list")).installed.len(), 1);

    // PC-A installs 2.0.0 and removes 1.0.0.
    fx.manager
        .install("demo", Some("2.0.0"), no_progress())
        .await
        .expect("update");
    fx.manager.delete("demo", "1.0.0").await.expect("remove");

    let status = demo(pc_b.list().await.expect("list"));
    let versions: Vec<&str> = status
        .installed
        .iter()
        .map(|v| v.version.as_str())
        .collect();
    assert_eq!(
        versions,
        ["2.0.0"],
        "PC-B's stale record is dropped, the new version adopted"
    );
    assert_eq!(status.active_version.as_deref(), Some("2.0.0"));
    let env = pc_b.environment().await.expect("env");
    assert!(env
        .path_prepend
        .iter()
        .all(|dir| !dir.starts_with(versions_dir(&fx).join("1.0.0"))));
}

#[tokio::test]
async fn a_stale_record_can_never_put_a_missing_runtime_on_the_path() {
    let fx = fixture().await;
    fx.manager
        .install("demo", Some("1.0.0"), no_progress())
        .await
        .expect("install");
    // The folder disappears behind this computer's back (removed on another PC, or by hand).
    fs::remove_dir_all(versions_dir(&fx).join("1.0.0")).expect("rm");
    std::thread::sleep(std::time::Duration::from_millis(3100)); // past the reconcile window
    let env = fx.manager.environment().await.expect("env");
    assert!(env.path_prepend.is_empty(), "{:?}", env.path_prepend);
    assert!(demo(fx.manager.list().await.expect("list"))
        .installed
        .is_empty());
}

#[tokio::test]
async fn the_drive_moving_to_another_letter_keeps_every_runtime() {
    let fx = fixture().await;
    fx.manager
        .install("demo", Some("1.0.0"), no_progress())
        .await
        .expect("install");
    let moved = fx.root.join("moved drive");
    fs::create_dir_all(&moved).expect("dir");
    fs::rename(fx.root.join("runtimes"), moved.join("runtimes")).expect("move");
    let db = Db::connect(&fx.root.join("test.db")).await.expect("db");
    let after_move = RuntimeManager::new(
        db,
        RuntimePaths::new(moved.join("runtimes"), moved.join("cache")),
        fx.manager.registry.as_ref().clone(),
        fx.client.clone(),
        "windows-x64",
    );
    let status = demo(after_move.list().await.expect("list"));
    assert_eq!(status.installed.len(), 1);
    assert!(status.installed[0].healthy);
    assert!(status.installed[0]
        .path
        .starts_with(&moved.to_string_lossy().into_owned()));
}

fn requests(fx: &Fixture) -> usize {
    fx.client.requests.lock().expect("lock").len()
}

/// What another computer's install looks like from here: it holds the version's lock.
fn held_by_another_pc(fx: &Fixture, version: &str) -> version_lock::VersionLock {
    version_lock::VersionLock::try_acquire(&fx.manager.paths, "demo", version)
        .expect("lock file")
        .expect("free")
}

#[tokio::test]
async fn a_version_another_computer_is_installing_is_never_written_twice() {
    let fx = fixture().await;
    // No waiting: the refusal itself is what this test looks at.
    let pc_b = other_pc(&fx, "pc-b")
        .await
        .with_shared_wait(std::time::Duration::ZERO);
    let other = held_by_another_pc(&fx, "1.0.0");
    // PC-A is half-way: its staging folder exists.
    fs::create_dir_all(versions_dir(&fx).join("1.0.0.installing")).expect("staging");

    let refused = pc_b.install("demo", Some("1.0.0"), no_progress()).await;
    assert!(
        matches!(refused, Err(RuntimeError::BusyElsewhere { .. })),
        "{refused:?}"
    );
    assert_eq!(requests(&fx), 0, "nothing downloaded");
    // PC-B listing its runtimes (a terminal start does the same) leaves PC-A's install alone.
    pc_b.list().await.expect("list");
    assert!(versions_dir(&fx).join("1.0.0.installing").is_dir());
    // Another version is independent.
    pc_b.install("demo", Some("2.0.0"), no_progress())
        .await
        .expect("2.0.0");

    // PC-A crashed (its lock went with its process): the leftover is cleared and the install works.
    drop(other);
    pc_b.list().await.expect("list");
    assert!(!versions_dir(&fx).join("1.0.0.installing").exists());
    pc_b.install("demo", Some("1.0.0"), no_progress())
        .await
        .expect("now it installs");
}

#[tokio::test]
async fn installing_what_another_computer_installed_adopts_it_without_touching_its_files() {
    let fx = fixture().await;
    fx.manager
        .install("demo", Some("1.0.0"), no_progress())
        .await
        .expect("PC-A");
    let exe = versions_dir(&fx).join("1.0.0").join("demo.exe");
    let modified = fs::metadata(&exe).expect("meta").modified().expect("mtime");
    let downloads = requests(&fx);
    // PC-A has the program running: its files may not be replaced (before, PC-B deleted and unpacked again).
    let running = fs::File::open(&exe).expect("open");

    let pc_b = other_pc(&fx, "pc-b").await;
    let installed = pc_b
        .install("demo", Some("1.0.0"), no_progress())
        .await
        .expect("adopted");
    assert!(installed.healthy && installed.active);
    assert_eq!(requests(&fx), downloads, "no download");
    assert_eq!(
        fs::metadata(&exe).expect("meta").modified().expect("mtime"),
        modified
    );
    // Repair on a computer without a record is a check, not a reinstall.
    let pc_c = other_pc(&fx, "pc-c").await;
    assert!(!pc_c
        .repair("demo", "1.0.0", no_progress())
        .await
        .expect("repair"));
    assert!(demo(pc_c.list().await.expect("list")).installed[0].healthy);
    assert_eq!(
        fs::metadata(&exe).expect("meta").modified().expect("mtime"),
        modified
    );
    drop(running);
}

#[cfg(windows)]
#[tokio::test]
async fn a_runtime_in_use_somewhere_is_never_half_removed() {
    use std::os::windows::fs::OpenOptionsExt;
    let fx = fixture().await;
    fx.manager
        .install("demo", Some("1.0.0"), no_progress())
        .await
        .expect("install");
    let dir = versions_dir(&fx).join("1.0.0");
    let before = files_under(&dir);
    // A running program: Windows keeps its file open without sharing deletion (FILE_SHARE_READ only).
    let running = fs::OpenOptions::new()
        .read(true)
        .share_mode(1)
        .open(dir.join("bin").join("tool.exe"))
        .expect("open");

    let refused = fx.manager.delete("demo", "1.0.0").await;
    assert!(
        matches!(refused, Err(RuntimeError::InUse { .. })),
        "{refused:?}"
    );
    assert_eq!(files_under(&dir), before, "nothing was removed");
    let status = demo(fx.manager.list().await.expect("list"));
    assert!(status.installed[0].healthy, "it still works");

    drop(running);
    fx.manager
        .delete("demo", "1.0.0")
        .await
        .expect("closed: removed");
    assert!(!dir.exists());
    assert!(demo(fx.manager.list().await.expect("list"))
        .installed
        .is_empty());
}

#[tokio::test]
async fn a_removal_left_behind_is_cleared_but_not_while_another_computer_works_on_it() {
    let fx = fixture().await;
    let leftover = versions_dir(&fx).join("1.0.0.removing-4242");
    fs::create_dir_all(&leftover).expect("leftover");
    fs::write(leftover.join("demo.exe"), "x").expect("file");
    let other = held_by_another_pc(&fx, "1.0.0");
    fx.manager.list().await.expect("list");
    assert!(leftover.exists(), "another computer is still removing it");
    drop(other);
    let status = demo(fx.manager.list().await.expect("list"));
    assert!(!leftover.exists());
    assert!(
        status.installed.is_empty(),
        "a removal is never adopted as a version"
    );
}

/// Records the phases one computer's install reports.
fn phase_recorder() -> (ProgressSink, Arc<Mutex<Vec<InstallPhase>>>) {
    let phases: Arc<Mutex<Vec<InstallPhase>>> = Arc::default();
    let sink = phases.clone();
    (
        Arc::new(move |p: InstallProgress| sink.lock().expect("lock").push(p.phase)),
        phases,
    )
}

fn saw(phases: &Arc<Mutex<Vec<InstallPhase>>>, phase: InstallPhase) -> bool {
    phases.lock().expect("lock").contains(&phase)
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn three_computers_asking_for_one_runtime_at_once_get_one_install_and_all_use_it() {
    let fx = fixture().await;
    let pcs = [
        fx.manager.clone(),
        other_pc(&fx, "pc-b").await,
        other_pc(&fx, "pc-c").await,
    ];
    // A fourth computer is installing it right now: all three have to wait, then the work happens exactly once.
    let other = held_by_another_pc(&fx, "1.0.0");
    let mut runs = Vec::new();
    let mut recorders = Vec::new();
    for pc in &pcs {
        let (sink, phases) = phase_recorder();
        recorders.push(phases);
        let pc = pc.clone();
        runs.push(tokio::spawn(async move {
            pc.install("demo", Some("1.0.0"), sink).await
        }));
    }
    tokio::time::sleep(std::time::Duration::from_millis(600)).await;
    for phases in &recorders {
        assert!(saw(phases, InstallPhase::Waiting), "{phases:?}");
    }
    assert!(runs.iter().all(|run| !run.is_finished()), "nobody gave up");
    assert_eq!(requests(&fx), 0, "nothing downloaded while waiting");

    // That computer crashed (its lock went with its process): one of the three takes over.
    drop(other);
    let mut paths = Vec::new();
    for run in runs {
        let installed = run.await.expect("task").expect("install");
        assert!(installed.healthy);
        paths.push(installed.path);
    }
    assert!(paths.windows(2).all(|pair| pair[0] == pair[1]), "{paths:?}");
    let unpacked = recorders
        .iter()
        .filter(|phases| saw(phases, InstallPhase::Extract))
        .count();
    assert_eq!(unpacked, 1, "exactly one computer unpacked the runtime");
    assert_eq!(requests(&fx), 1, "one download for three computers");
    assert!(!versions_dir(&fx).join("1.0.0.installing").exists());
    for pc in &pcs {
        let status = demo(pc.list().await.expect("list"));
        assert_eq!(status.installed.len(), 1);
        assert!(status.installed[0].healthy);
        assert!(pc
            .environment()
            .await
            .expect("env")
            .path_prepend
            .iter()
            .any(|dir| dir.starts_with(versions_dir(&fx).join("1.0.0"))));
    }
}

#[tokio::test]
async fn a_waiting_install_takes_over_a_crashed_computers_half_install() {
    let fx = fixture().await;
    let pc_b = other_pc(&fx, "pc-b").await;
    let other = held_by_another_pc(&fx, "1.0.0");
    // The crashed computer left its half-unpacked staging folder behind.
    let staging = versions_dir(&fx).join("1.0.0.installing");
    fs::create_dir_all(&staging).expect("staging");
    fs::write(staging.join("half.bin"), b"partial").expect("partial");
    let (sink, phases) = phase_recorder();
    let run = tokio::spawn({
        let pc_b = pc_b.clone();
        async move { pc_b.install("demo", Some("1.0.0"), sink).await }
    });
    tokio::time::sleep(std::time::Duration::from_millis(400)).await;
    assert!(saw(&phases, InstallPhase::Waiting));
    assert!(
        !versions_dir(&fx).join("1.0.0").exists(),
        "a partial runtime is never published"
    );
    drop(other);
    let installed = run.await.expect("task").expect("install");
    assert!(installed.healthy);
    assert!(!versions_dir(&fx).join("1.0.0").join("half.bin").exists());
    assert!(!staging.exists());
}

#[tokio::test]
async fn a_wait_has_a_limit_and_then_says_who_is_busy() {
    let fx = fixture().await;
    let pc_b = other_pc(&fx, "pc-b")
        .await
        .with_shared_wait(std::time::Duration::from_millis(300));
    let _other = held_by_another_pc(&fx, "1.0.0");
    let started = std::time::Instant::now();
    let outcome = pc_b.install("demo", Some("1.0.0"), no_progress()).await;
    assert!(
        matches!(outcome, Err(RuntimeError::BusyElsewhere { .. })),
        "{outcome:?}"
    );
    assert!(started.elapsed() >= std::time::Duration::from_millis(300));
    assert_eq!(requests(&fx), 0);
}

#[tokio::test]
async fn different_runtimes_never_wait_for_each_other() {
    let fx = fixture().await;
    let pc_b = other_pc(&fx, "pc-b").await;
    // 1.0.0 is busy on another computer for as long as this test runs; 2.0.0 installs at once.
    let _other = held_by_another_pc(&fx, "1.0.0");
    let started = std::time::Instant::now();
    pc_b.install("demo", Some("2.0.0"), no_progress())
        .await
        .expect("2.0.0");
    assert!(started.elapsed() < std::time::Duration::from_secs(5));
}

#[tokio::test]
async fn a_complete_runtime_whose_launchers_cant_be_written_is_never_unpacked_again() {
    let phar = b"<?php echo 1;".to_vec();
    let hash = sha(&phar);
    let manifest = format!(
        r#"{{
        "id": "demo", "displayName": "Demo", "description": "d", "defaultVersion": "1.0.0",
        "versionCommand": {{ "executable": "demo.phar", "args": ["--version"] }},
        "binDirs": [], "verifyFiles": ["demo.phar"], "env": {{}},
        "shims": [{{ "name": "demo", "target": "demo.phar", "viaEnv": "DEMO_INTERPRETER" }}],
        "versions": [
          {{ "version": "1.0.0", "artifacts": [ {{ "platform": "windows-x64", "url": "{URL_1}", "sha256": "{hash}", "archive": "file", "installAs": "demo.phar" }} ] }}
        ]
    }}"#
    );
    let fx = fixture_with(vec![(URL_1, phar)], manifest, "windows-x64").await;
    fx.manager
        .install("demo", Some("1.0.0"), no_progress())
        .await
        .expect("PC-A");
    let exe = versions_dir(&fx).join("1.0.0").join("demo.phar");
    let before = fs::metadata(&exe).expect("meta").modified().expect("mtime");
    // PC-B sees no launchers, and their folder can't be created (a file stands where it should be).
    let shims = fx
        .root
        .join("runtimes")
        .join("demo")
        .join("shims")
        .join("1.0.0");
    fs::remove_dir_all(&shims).expect("rm shims");
    fs::write(&shims, b"in the way").expect("blocker");
    let downloads = requests(&fx);
    let pc_b = other_pc(&fx, "pc-b").await;
    let outcome = pc_b.install("demo", Some("1.0.0"), no_progress()).await;
    assert!(outcome.is_err(), "{outcome:?}");
    assert_eq!(requests(&fx), downloads, "nothing downloaded");
    let after = fs::metadata(&exe)
        .expect("still there")
        .modified()
        .expect("mtime");
    assert_eq!(before, after, "the complete runtime was left alone");
}
