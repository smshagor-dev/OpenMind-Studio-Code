//! The index end to end: crawl, store, queries, incremental updates, clearing, limits.

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::AtomicBool;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use crate::index::manager::{IndexEvents, IndexManager, IndexStatus};
use crate::index::query::{file_symbols, search_files, search_symbols, search_text};
use crate::index::settings::IndexSettings;
use crate::index::store::IndexStore;
use crate::index::sync::{apply_changes, sync_workspace, Change};
use crate::query::SearchQuery;

fn write(root: &Path, rel: &str, text: &str) {
    let path = root.join(rel);
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).expect("mkdir");
    }
    fs::write(path, text).expect("write");
}

/// A workspace like a real project: source in several languages, heavy folders, a big file, a binary file.
fn project(dir: &Path) -> PathBuf {
    let root = dir.join("My Project");
    write(&root, "src/app.ts", "export function startServer(port: number) {\n  return listen(port);\n}\nclass Router {\n  handle(req) {\n    return req;\n  }\n}\n");
    write(
        &root,
        "src/routes/controller.php",
        "<?php\nclass UserController {\n    public function index() { return 'Hello'; }\n}\n",
    );
    write(
        &root,
        "scripts/tool.py",
        "class Tool:\n    def run(self):\n        return 'hello world'\n\ndef main():\n    pass\n",
    );
    write(
        &root,
        "core/lib.rs",
        "pub struct Engine;\nimpl Engine {\n    pub fn start(&self) {}\n}\n",
    );
    write(
        &root,
        "docs/readme.md",
        "# Guide\n\n## Install\n\nRun startServer to begin.\n",
    );
    write(
        &root,
        "data/config.json",
        "{\n  \"name\": \"demo\",\n  \"scripts\": {}\n}\n",
    );
    write(
        &root,
        "node_modules/pkg/index.js",
        "function startServer() {}\n",
    );
    write(&root, ".git/HEAD", "ref: refs/heads/main\n");
    write(&root, "target/debug/out.rs", "fn startServer() {}\n");
    fs::write(root.join("blob.bin"), [0u8, 1, 2, 3, 0, 0, 255]).expect("bin");
    fs::write(root.join("big.txt"), "x".repeat(2 * 1024 * 1024)).expect("big");
    root
}

fn synced(dir: &Path, settings: &IndexSettings) -> (PathBuf, IndexStore, Mutex<()>) {
    let root = project(dir);
    let store = IndexStore::open(&dir.join("idx.sqlite")).expect("open");
    let lock = Mutex::new(());
    sync_workspace(
        &root,
        &store,
        settings,
        &AtomicBool::new(false),
        &lock,
        &mut |_| (),
    )
    .expect("sync");
    (root, store, lock)
}

fn text_query(root: &Path, text: &str) -> SearchQuery {
    SearchQuery {
        root: root.to_path_buf(),
        text: text.into(),
        case_sensitive: false,
        whole_word: false,
        use_regex: false,
        include: vec![],
        exclude: vec![],
        max_results: 1000,
    }
}

fn paths(outcome: &crate::walk::SearchOutcome) -> Vec<String> {
    outcome
        .files
        .iter()
        .map(|f| f.relative_path.clone())
        .collect()
}

#[test]
fn a_sync_indexes_text_skips_heavy_folders_and_records_binary_and_large_files() {
    let dir = tempfile::tempdir().expect("tempdir");
    let (_, store, _) = synced(dir.path(), &IndexSettings::default());
    let known = store.known_files().expect("known");
    assert!(known.contains_key("src/app.ts") && known.contains_key("docs/readme.md"));
    assert!(!known.keys().any(|p| p.starts_with("node_modules/")
        || p.starts_with(".git/")
        || p.starts_with("target/")));
    assert_eq!(known["blob.bin"].2, "binary");
    assert_eq!(known["big.txt"].2, "large");
    let stats = store.stats().expect("stats");
    assert_eq!(stats.skipped, 2);
    assert!(stats.symbols > 5);
    // Binary and large files are listed (so their names are searchable) but hold no text.
    let text = search_text(
        &store,
        Path::new("C:/x"),
        &text_query(Path::new("C:/x"), "xxxxxxxx"),
        &AtomicBool::new(false),
    )
    .expect("search");
    assert_eq!(text.total_matches, 0);
    assert_eq!((text.skipped_binary, text.skipped_large), (1, 1));
}

#[test]
fn text_search_finds_substrings_respects_case_words_regex_and_globs() {
    let dir = tempfile::tempdir().expect("tempdir");
    let (root, store, _) = synced(dir.path(), &IndexSettings::default());
    let cancel = AtomicBool::new(false);

    let found =
        search_text(&store, &root, &text_query(&root, "startserver"), &cancel).expect("search");
    assert_eq!(paths(&found), vec!["docs/readme.md", "src/app.ts"]);
    let first = &found.files[1].matches[0];
    assert_eq!((first.line, first.column, first.length), (1, 17, 11));
    assert!(found.files[1].path.ends_with("app.ts") && found.files[1].path.contains("My Project"));

    let mut sensitive = text_query(&root, "startserver");
    sensitive.case_sensitive = true;
    assert!(search_text(&store, &root, &sensitive, &cancel)
        .expect("s")
        .files
        .is_empty());

    // A substring of a longer word, then only as a whole word.
    let mut word = text_query(&root, "Server");
    assert_eq!(
        search_text(&store, &root, &word, &cancel)
            .expect("s")
            .total_matches,
        2
    );
    word.whole_word = true;
    assert_eq!(
        search_text(&store, &root, &word, &cancel)
            .expect("s")
            .total_matches,
        0
    );

    let mut regex = text_query(&root, r"class\s+(\w+)");
    regex.use_regex = true;
    let classes = search_text(&store, &root, &regex, &cancel).expect("regex");
    assert_eq!(
        paths(&classes),
        vec!["scripts/tool.py", "src/app.ts", "src/routes/controller.php"]
    );

    // Short queries (below the trigram size) still work, and include/exclude globs narrow the files.
    assert!(
        search_text(&store, &root, &text_query(&root, "st"), &cancel)
            .expect("short")
            .total_matches
            > 3
    );
    let mut only_ts = text_query(&root, "return");
    only_ts.include = vec!["*.ts".into()];
    assert_eq!(
        paths(&search_text(&store, &root, &only_ts, &cancel).expect("s")),
        vec!["src/app.ts"]
    );
    let mut not_ts = text_query(&root, "return");
    not_ts.exclude = vec!["src".into()];
    assert!(
        !paths(&search_text(&store, &root, &not_ts, &cancel).expect("s"))
            .iter()
            .any(|p| p.starts_with("src/"))
    );

    assert!(search_text(&store, &root, &text_query(&root, ""), &cancel).is_err());
    let mut broken = text_query(&root, "(");
    broken.use_regex = true;
    assert!(search_text(&store, &root, &broken, &cancel).is_err());
    // Text that looks like FTS syntax is only text.
    assert!(search_text(&store, &root, &text_query(&root, "\" OR \"x"), &cancel).is_ok());
}

#[test]
fn a_result_limit_and_cancellation_stop_the_search() {
    let dir = tempfile::tempdir().expect("tempdir");
    let (root, store, _) = synced(dir.path(), &IndexSettings::default());
    let mut limited = text_query(&root, "e");
    limited.max_results = 3;
    let outcome = search_text(&store, &root, &limited, &AtomicBool::new(false)).expect("s");
    assert_eq!(outcome.total_matches, 3);
    assert!(outcome.truncated);
    let cancelled = search_text(
        &store,
        &root,
        &text_query(&root, "return"),
        &AtomicBool::new(true),
    )
    .expect("s");
    assert!(cancelled.cancelled);
    assert!(cancelled.files.is_empty());
}

#[test]
fn file_name_search_ranks_exact_prefix_substring_path_and_fuzzy_and_supports_globs() {
    let dir = tempfile::tempdir().expect("tempdir");
    let (root, store, _) = synced(dir.path(), &IndexSettings::default());
    let names = |q: &str| -> Vec<String> {
        search_files(&store, &root, q, None, 50)
            .expect("files")
            .into_iter()
            .map(|h| h.relative_path)
            .collect()
    };
    assert_eq!(names("app.ts")[0], "src/app.ts");
    assert_eq!(names("controller")[0], "src/routes/controller.php");
    // Path segments and fuzzy letters in order.
    assert_eq!(names("routes")[0], "src/routes/controller.php");
    assert_eq!(names("ctrl")[0], "src/routes/controller.php");
    assert_eq!(names("*.php"), vec!["src/routes/controller.php"]);
    assert_eq!(names("src/*.ts"), vec!["src/app.ts"]);
    assert!(names("zzzzqq").is_empty());
    let hit = &search_files(&store, &root, "app", None, 5).expect("files")[0];
    assert_eq!(hit.highlights, vec![[4, 7]]);
    let only_md = search_files(&store, &root, "", Some(".md"), 10).expect("ext");
    assert_eq!(only_md.len(), 1);
    assert_eq!(only_md[0].name, "readme.md");
    assert!(search_files(&store, &root, "[", None, 5).is_ok());
}

#[test]
fn symbols_are_searchable_by_name_kind_and_file() {
    let dir = tempfile::tempdir().expect("tempdir");
    let (root, store, _) = synced(dir.path(), &IndexSettings::default());
    let hits = search_symbols(&store, &root, "startServer", None, 20).expect("symbols");
    assert_eq!(hits[0].name, "startServer");
    assert_eq!(
        (hits[0].kind.as_str(), hits[0].line, hits[0].column),
        ("function", 1, 17)
    );
    assert_eq!(hits[0].relative_path, "src/app.ts");
    let classes = search_symbols(&store, &root, "", Some("class"), 50).expect("classes");
    let names: Vec<&str> = classes.iter().map(|s| s.name.as_str()).collect();
    assert!(
        names.contains(&"Router") && names.contains(&"UserController") && names.contains(&"Tool")
    );
    let fuzzy = search_symbols(&store, &root, "usrctl", None, 5).expect("fuzzy");
    assert_eq!(fuzzy[0].name, "UserController");
    let methods = search_symbols(&store, &root, "handle", Some("method"), 5).expect("methods");
    assert_eq!(methods[0].container.as_deref(), Some("Router"));
    let in_file = file_symbols(&store, &root, "docs/readme.md").expect("file");
    assert_eq!(
        in_file.iter().map(|s| s.name.as_str()).collect::<Vec<_>>(),
        vec!["Guide", "Install"]
    );
    assert!(search_symbols(&store, &root, "nothingmatches", None, 5)
        .expect("none")
        .is_empty());
}

#[test]
fn incremental_changes_add_update_remove_files_and_folders_and_refuse_outside_paths() {
    let dir = tempfile::tempdir().expect("tempdir");
    let (root, store, lock) = synced(dir.path(), &IndexSettings::default());
    let settings = IndexSettings::default();
    let cancel = AtomicBool::new(false);
    let change = |p: &str| Change { path: root.join(p) };

    write(
        &root,
        "src/new file.ts",
        "export const brandNewThing = 1;\n",
    );
    apply_changes(
        &root,
        &store,
        &settings,
        &[change("src/new file.ts")],
        &lock,
    )
    .expect("add");
    assert_eq!(
        search_text(&store, &root, &text_query(&root, "brandNewThing"), &cancel)
            .expect("s")
            .total_matches,
        1
    );
    assert_eq!(
        search_files(&store, &root, "new file", None, 5).expect("f")[0].relative_path,
        "src/new file.ts"
    );

    write(
        &root,
        "src/new file.ts",
        "export const totallyDifferent = 2;\n",
    );
    apply_changes(
        &root,
        &store,
        &settings,
        &[change("src/new file.ts")],
        &lock,
    )
    .expect("update");
    assert!(
        search_text(&store, &root, &text_query(&root, "brandNewThing"), &cancel)
            .expect("s")
            .files
            .is_empty()
    );
    assert_eq!(
        search_text(
            &store,
            &root,
            &text_query(&root, "totallyDifferent"),
            &cancel
        )
        .expect("s")
        .total_matches,
        1
    );

    // A rename is the old path gone and the new one there.
    fs::rename(root.join("src/new file.ts"), root.join("src/renamed.ts")).expect("rename");
    apply_changes(
        &root,
        &store,
        &settings,
        &[change("src/new file.ts"), change("src/renamed.ts")],
        &lock,
    )
    .expect("rename");
    let known = store.known_files().expect("known");
    assert!(!known.contains_key("src/new file.ts") && known.contains_key("src/renamed.ts"));

    // A deleted folder takes its files out of the index.
    fs::remove_dir_all(root.join("src/routes")).expect("rm");
    apply_changes(&root, &store, &settings, &[change("src/routes")], &lock).expect("folder");
    assert!(!store
        .known_files()
        .expect("known")
        .keys()
        .any(|p| p.starts_with("src/routes/")));
    assert!(search_symbols(&store, &root, "UserController", None, 5)
        .expect("s")
        .is_empty());

    // Files that belong in an ignored place never enter, and paths outside the workspace are refused.
    write(&root, "node_modules/x/y.js", "brandNewThing");
    apply_changes(
        &root,
        &store,
        &settings,
        &[change("node_modules/x/y.js")],
        &lock,
    )
    .expect("ignored");
    assert!(!store
        .known_files()
        .expect("known")
        .contains_key("node_modules/x/y.js"));
    let outside = dir.path().join("elsewhere.txt");
    fs::write(&outside, "secret").expect("outside");
    assert!(apply_changes(&root, &store, &settings, &[Change { path: outside }], &lock).is_err());
    let traversal = Change {
        path: root.join("..").join("elsewhere.txt"),
    };
    assert!(apply_changes(&root, &store, &settings, &[traversal], &lock).is_err());
}

#[test]
fn a_second_pass_only_reads_what_changed_and_new_settings_re_examine_everything() {
    let dir = tempfile::tempdir().expect("tempdir");
    let settings = IndexSettings::default();
    let (root, store, lock) = synced(dir.path(), &settings);
    let pass = |settings: &IndexSettings| {
        sync_workspace(
            &root,
            &store,
            settings,
            &AtomicBool::new(false),
            &lock,
            &mut |_| (),
        )
        .expect("sync")
        .progress
    };
    let quiet = pass(&settings);
    assert_eq!((quiet.changed, quiet.removed), (0, 0));
    write(
        &root,
        "src/app.ts",
        "export function other() {}\n// longer than before\n",
    );
    fs::remove_file(root.join("scripts/tool.py")).expect("rm");
    let after = pass(&settings);
    assert_eq!((after.changed, after.removed), (1, 1));
    // A smaller size limit turns the 2 KB-plus files into "large" on the next pass.
    let strict = IndexSettings {
        max_file_bytes: 20,
        ..IndexSettings::default()
    };
    let redo = pass(&strict);
    assert!(redo.changed > 3);
    assert!(
        store
            .known_files()
            .expect("known")
            .values()
            .filter(|v| v.2 == "large")
            .count()
            >= 3
    );
}

#[test]
fn the_total_size_limit_lists_files_without_indexing_their_text() {
    let dir = tempfile::tempdir().expect("tempdir");
    let tiny = IndexSettings {
        max_total_bytes: 200,
        ..IndexSettings::default()
    };
    let (_, store, _) = synced(dir.path(), &tiny);
    let known = store.known_files().expect("known");
    assert!(known.values().any(|v| v.2 == "limit"));
    assert!(store.stats().expect("s").content_bytes <= 400);
}

struct Recorder(Mutex<Vec<IndexStatus>>);

impl IndexEvents for Recorder {
    fn status(&self, status: &IndexStatus) {
        self.0.lock().expect("lock").push(status.clone());
    }
}

fn wait_idle(manager: &IndexManager, root: &Path) -> IndexStatus {
    let deadline = Instant::now() + Duration::from_secs(20);
    loop {
        let status = manager.status(root);
        if status.state != "indexing" && !manager.is_running(root) {
            return status;
        }
        assert!(Instant::now() < deadline, "indexing didn't finish");
        std::thread::sleep(Duration::from_millis(20));
    }
}

#[test]
fn the_manager_indexes_in_the_background_persists_clears_rebuilds_and_can_be_disabled() {
    let dir = tempfile::tempdir().expect("tempdir");
    let root = project(dir.path());
    let recorder = Arc::new(Recorder(Mutex::new(Vec::new())));
    let index_dir = dir.path().join("data").join("search-index");
    let manager = Arc::new(IndexManager::new(index_dir.clone(), recorder.clone()));
    assert_eq!(manager.status(&root).state, "none");

    manager.start(&root, IndexSettings::default());
    let status = wait_idle(&manager, &root);
    assert_eq!(status.state, "idle");
    assert!(status.indexed >= 6 && status.skipped == 2 && status.symbols > 5);
    assert!(status.last_indexed_ms.is_some() && status.db_bytes > 0);
    let seen = recorder.0.lock().expect("lock");
    assert_eq!(seen.first().map(|s| s.state.as_str()), Some("indexing"));
    assert_eq!(seen.last().map(|s| s.state.as_str()), Some("idle"));
    drop(seen);
    assert!(
        fs::read_dir(&index_dir).expect("dir").count() >= 1,
        "the index lives in the app's own folder"
    );

    // A new manager (the next launch) sees the persisted index at once.
    let again = Arc::new(IndexManager::new(index_dir, recorder.clone()));
    let persisted = again.status(&root);
    assert_eq!(
        (persisted.state.as_str(), persisted.indexed),
        ("idle", status.indexed)
    );
    let store = again.open_store(&root).expect("store");
    assert!(!search_files(&store, &root, "app.ts", None, 3)
        .expect("f")
        .is_empty());

    // Watcher changes go through the manager; an outside path is an error.
    write(&root, "src/late.ts", "export const lateArrival = 1;\n");
    manager
        .apply_changes(&root, &[root.join("src/late.ts")])
        .expect("apply");
    let store = manager.open_store(&root).expect("store");
    assert_eq!(
        search_text(
            &store,
            &root,
            &text_query(&root, "lateArrival"),
            &AtomicBool::new(false)
        )
        .expect("s")
        .total_matches,
        1
    );
    assert!(manager
        .apply_changes(&root, &[dir.path().join("elsewhere.txt")])
        .is_err());

    manager.clear(&root).expect("clear");
    assert_eq!(manager.status(&root).state, "none");
    assert_eq!(
        manager
            .open_store(&root)
            .expect("store")
            .stats()
            .expect("s")
            .files,
        0
    );

    manager
        .rebuild(&root, IndexSettings::default())
        .expect("rebuild");
    assert_eq!(wait_idle(&manager, &root).state, "idle");
    assert!(
        manager
            .open_store(&root)
            .expect("store")
            .stats()
            .expect("s")
            .files
            > 6
    );

    manager.start(
        &root,
        IndexSettings {
            enabled: false,
            ..IndexSettings::default()
        },
    );
    assert_eq!(manager.status(&root).state, "disabled");
}

#[test]
fn a_missing_workspace_is_an_error_status_not_a_crash() {
    let dir = tempfile::tempdir().expect("tempdir");
    let recorder = Arc::new(Recorder(Mutex::new(Vec::new())));
    let manager = Arc::new(IndexManager::new(dir.path().join("idx"), recorder));
    let missing = dir.path().join("nope");
    manager.start(&missing, IndexSettings::default());
    let status = wait_idle(&manager, &missing);
    assert_eq!(status.state, "error");
    assert!(status.error.is_some());
}

#[test]
fn references_fall_back_to_whole_word_case_sensitive_text_matches() {
    let dir = tempfile::tempdir().expect("tempdir");
    let (root, store, _) = synced(dir.path(), &IndexSettings::default());
    write(
        &root,
        "src/other.ts",
        "const startServerNow = 1;\nstartServer();\n// startserver in a comment\n",
    );
    let lock = Mutex::new(());
    apply_changes(
        &root,
        &store,
        &IndexSettings::default(),
        &[Change {
            path: root.join("src/other.ts"),
        }],
        &lock,
    )
    .expect("add");
    let mut refs = text_query(&root, "startServer");
    refs.case_sensitive = true;
    refs.whole_word = true;
    let outcome = search_text(&store, &root, &refs, &AtomicBool::new(false)).expect("refs");
    // The identifier itself (definition, call, prose), not `startServerNow` and not the lower-case comment.
    assert_eq!(
        paths(&outcome),
        vec!["docs/readme.md", "src/app.ts", "src/other.ts"]
    );
    assert_eq!(outcome.total_matches, 3);
    let other = outcome
        .files
        .iter()
        .find(|f| f.relative_path == "src/other.ts")
        .expect("other");
    assert_eq!((other.matches[0].line, other.matches[0].column), (2, 1));
}
