//! Real `notify` watchers on temp folders (paths with spaces): changes made "outside the app" become coalesced live-sync
//! topics, and nothing is reported once a watcher is dropped.

use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use openmind_file_watch::{ChangeBatch, FileWatcher, SyncTopic, SystemWatcher, TOPIC_QUIET};

type Seen = Arc<Mutex<Vec<SyncTopic>>>;

fn sink(seen: &Seen) -> openmind_file_watch::TopicSink {
    let seen = seen.clone();
    Arc::new(move |topic, _burst| {
        if let Ok(mut list) = seen.lock() {
            list.push(topic);
        }
    })
}

fn seen_now(seen: &Seen) -> Vec<SyncTopic> {
    seen.lock().map(|list| list.clone()).unwrap_or_default()
}

/// Waits until `topic` was announced (or fails after 15 s).
fn wait_for(seen: &Seen, topic: SyncTopic) {
    let deadline = Instant::now() + Duration::from_secs(15);
    while !seen_now(seen).contains(&topic) {
        assert!(
            Instant::now() < deadline,
            "{topic:?} was never announced: {:?}",
            seen_now(seen)
        );
        std::thread::sleep(Duration::from_millis(50));
    }
}

/// Long enough for any burst to settle and be announced.
fn settle() {
    std::thread::sleep(TOPIC_QUIET * 2 + Duration::from_millis(500));
}

fn write(path: &Path, text: &str) {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).unwrap();
    }
    std::fs::write(path, text).unwrap();
}

fn app_root() -> (tempfile::TempDir, PathBuf) {
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path().join("OpenMind Studio");
    std::fs::create_dir_all(&root).unwrap();
    (temp, root)
}

#[test]
fn an_external_runtime_change_is_announced_as_runtimes() {
    let (_temp, root) = app_root();
    std::fs::create_dir_all(root.join("runtimes")).unwrap();
    let seen = Seen::default();
    let _watcher = SystemWatcher::start(&root, sink(&seen)).unwrap();
    write(
        &root
            .join("runtimes")
            .join("node")
            .join("versions")
            .join("24.1.0")
            .join("node.exe"),
        "x",
    );
    wait_for(&seen, SyncTopic::Runtimes);
    settle();
    assert_eq!(seen_now(&seen), vec![SyncTopic::Runtimes]);
}

#[test]
fn a_tools_folder_created_after_start_is_watched_and_announced_as_tools() {
    let (_temp, root) = app_root();
    let seen = Seen::default();
    let _watcher = SystemWatcher::start(&root, sink(&seen)).unwrap();
    std::fs::create_dir_all(root.join("tools")).unwrap();
    wait_for(&seen, SyncTopic::Tools);
    settle();
    seen.lock().unwrap().clear();
    // Something copied into the new folder later is seen through its own (recursive) watch.
    write(
        &root
            .join("tools")
            .join("ruff")
            .join("0.6.0")
            .join("ruff.exe"),
        "x",
    );
    wait_for(&seen, SyncTopic::Tools);
}

#[test]
fn an_external_language_server_change_is_announced_as_language_servers() {
    let (_temp, root) = app_root();
    std::fs::create_dir_all(root.join("language-servers").join("pyright")).unwrap();
    let seen = Seen::default();
    let _watcher = SystemWatcher::start(&root, sink(&seen)).unwrap();
    std::fs::remove_dir_all(root.join("language-servers").join("pyright")).unwrap();
    wait_for(&seen, SyncTopic::LanguageServers);
}

#[test]
fn an_extension_copied_in_is_announced_and_extension_storage_is_not() {
    let (_temp, root) = app_root();
    std::fs::create_dir_all(root.join("extensions").join("installed")).unwrap();
    std::fs::create_dir_all(root.join("extensions").join("storage")).unwrap();
    let seen = Seen::default();
    let _watcher = SystemWatcher::start(&root, sink(&seen)).unwrap();
    write(
        &root
            .join("extensions")
            .join("storage")
            .join("a.b")
            .join("state.json"),
        "{}",
    );
    write(
        &root
            .join("extensions")
            .join("logs")
            .join("extension-host.log"),
        "line",
    );
    settle();
    assert_eq!(seen_now(&seen), Vec::<SyncTopic>::new());
    write(
        &root
            .join("extensions")
            .join("installed")
            .join("a.b-1.0.0")
            .join("package.json"),
        "{}",
    );
    wait_for(&seen, SyncTopic::Extensions);
}

#[test]
fn missing_folders_do_not_stop_the_watcher_and_a_missing_app_folder_is_an_error() {
    let (temp, root) = app_root();
    let seen = Seen::default();
    let watcher = SystemWatcher::start(&root, sink(&seen));
    assert!(watcher.is_ok());
    let missing = SystemWatcher::start(&temp.path().join("not here"), sink(&seen));
    assert!(missing.is_err());
}

#[test]
fn a_burst_of_hundreds_of_files_is_one_announcement() {
    let (_temp, root) = app_root();
    std::fs::create_dir_all(root.join("runtimes")).unwrap();
    let seen = Seen::default();
    let _watcher = SystemWatcher::start(&root, sink(&seen)).unwrap();
    for index in 0..300 {
        write(
            &root
                .join("runtimes")
                .join("python")
                .join("Lib")
                .join(format!("m{index}.py")),
            "x",
        );
    }
    wait_for(&seen, SyncTopic::Runtimes);
    settle();
    assert_eq!(seen_now(&seen), vec![SyncTopic::Runtimes]);
}

#[test]
fn nothing_is_announced_after_the_watcher_is_dropped() {
    let (_temp, root) = app_root();
    std::fs::create_dir_all(root.join("tools")).unwrap();
    let seen = Seen::default();
    let watcher = SystemWatcher::start(&root, sink(&seen)).unwrap();
    drop(watcher); // joins its thread
    write(&root.join("tools").join("x").join("x.exe"), "x");
    settle();
    assert_eq!(seen_now(&seen), Vec::<SyncTopic>::new());
}

// --- project folders (the project's own FileWatcher) ---

fn project() -> (tempfile::TempDir, PathBuf) {
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path().join("My Project");
    std::fs::create_dir_all(&root).unwrap();
    (temp, root)
}

type Batches = Arc<Mutex<Vec<ChangeBatch>>>;

fn project_watcher(root: &Path, seen: &Seen, batches: &Batches) -> FileWatcher {
    let batches = batches.clone();
    FileWatcher::start_with_topics(
        root,
        Arc::new(move |batch| {
            if let Ok(mut list) = batches.lock() {
                list.push(batch);
            }
        }),
        Some(sink(seen)),
    )
    .unwrap()
}

#[test]
fn a_venv_created_after_the_folder_was_opened_is_announced_as_packages() {
    let (_temp, root) = project();
    let seen = Seen::default();
    let _watcher = project_watcher(&root, &seen, &Batches::default());
    write(&root.join(".venv").join("pyvenv.cfg"), "home = C:/Python");
    wait_for(&seen, SyncTopic::Packages);
}

#[test]
fn a_package_installed_into_the_venv_is_packages_and_byte_code_is_not() {
    let (_temp, root) = project();
    std::fs::create_dir_all(root.join(".venv").join("Lib").join("site-packages")).unwrap();
    let seen = Seen::default();
    let _watcher = project_watcher(&root, &seen, &Batches::default());
    write(
        &root
            .join(".venv")
            .join("Lib")
            .join("__pycache__")
            .join("os.cpython-314.pyc"),
        "x",
    );
    settle();
    assert_eq!(seen_now(&seen), Vec::<SyncTopic>::new());
    write(
        &root
            .join(".venv")
            .join("Lib")
            .join("site-packages")
            .join("six.py"),
        "x",
    );
    wait_for(&seen, SyncTopic::Packages);
}

#[test]
fn an_npm_install_is_one_packages_announcement_and_never_reaches_the_explorer() {
    let (_temp, root) = project();
    let seen = Seen::default();
    let batches = Batches::default();
    let _watcher = project_watcher(&root, &seen, &batches);
    for index in 0..200 {
        write(
            &root
                .join("node_modules")
                .join(format!("pkg{index}"))
                .join("index.js"),
            "x",
        );
    }
    write(&root.join("src").join("app.ts"), "export {}");
    wait_for(&seen, SyncTopic::Packages);
    settle();
    assert_eq!(seen_now(&seen), vec![SyncTopic::Packages]);
    let paths: Vec<String> = batches
        .lock()
        .unwrap()
        .iter()
        .flat_map(|batch| batch.changes.iter().map(|change| change.path.clone()))
        .collect();
    assert!(
        paths.iter().any(|path| path.ends_with("app.ts")),
        "{paths:?}"
    );
    assert!(
        !paths.iter().any(|path| path.contains("node_modules")),
        "{paths:?}"
    );
}

#[test]
fn switching_folders_stops_the_old_folders_package_watch() {
    let (_temp_a, first) = project();
    let (_temp_b, second) = project();
    let seen_first = Seen::default();
    let seen_second = Seen::default();
    let old = project_watcher(&first, &seen_first, &Batches::default());
    // The window opens another folder: its watcher is replaced (the old one dropped).
    drop(old);
    let _new = project_watcher(&second, &seen_second, &Batches::default());
    write(&first.join("node_modules").join("a").join("index.js"), "x");
    write(&second.join("node_modules").join("b").join("index.js"), "x");
    wait_for(&seen_second, SyncTopic::Packages);
    settle();
    assert_eq!(seen_now(&seen_first), Vec::<SyncTopic>::new());
}
