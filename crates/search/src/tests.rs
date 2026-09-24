use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::AtomicBool;

use crate::*;

fn write(root: &Path, relative: &str, contents: impl AsRef<[u8]>) {
    let path = root.join(relative);
    fs::create_dir_all(path.parent().expect("parent")).expect("dirs");
    fs::write(path, contents).expect("write");
}

fn query(root: &Path, text: &str) -> SearchQuery {
    SearchQuery {
        root: root.to_path_buf(),
        text: text.into(),
        case_sensitive: false,
        whole_word: false,
        use_regex: false,
        include: vec![],
        exclude: vec![],
        max_results: 10_000,
    }
}

fn run(query: &SearchQuery) -> SearchOutcome {
    search(query, &AtomicBool::new(false)).expect("search")
}

fn found_files(outcome: &SearchOutcome) -> Vec<&str> {
    outcome
        .files
        .iter()
        .map(|f| f.relative_path.as_str())
        .collect()
}

fn project() -> tempfile::TempDir {
    let dir = tempfile::tempdir().expect("tempdir");
    write(
        dir.path(),
        "src/main.rs",
        "fn main() {\n    println!(\"needle\");\n}\n",
    );
    write(dir.path(), "src/lib.rs", "// no match here\n");
    write(dir.path(), "README.md", "The Needle is documented.\n");
    dir
}

#[test]
fn finds_text_and_reports_line_column_and_a_root_relative_path() {
    let dir = project();

    let outcome = run(&query(dir.path(), "needle"));

    assert_eq!(found_files(&outcome), ["README.md", "src/main.rs"]);
    let main = &outcome.files[1];
    assert_eq!((main.matches[0].line, main.matches[0].column), (2, 15));
    assert_eq!(outcome.total_matches, 2);
    assert_eq!(outcome.files_searched, 3);
}

#[test]
fn case_sensitivity_is_respected() {
    let dir = project();
    let mut q = query(dir.path(), "Needle");
    q.case_sensitive = true;

    assert_eq!(found_files(&run(&q)), ["README.md"]);
}

#[test]
fn regex_and_whole_word_searches_work() {
    let dir = project();
    let mut q = query(dir.path(), r"n\w+dle");
    q.use_regex = true;
    assert_eq!(run(&q).total_matches, 2);

    let mut q = query(dir.path(), "need");
    q.whole_word = true;
    assert_eq!(run(&q).total_matches, 0);
}

#[test]
fn heavy_folders_are_never_searched() {
    let dir = project();
    for folder in ["node_modules", ".git", "target", "dist", "build", "vendor"] {
        write(dir.path(), &format!("{folder}/hidden.js"), "needle");
        write(dir.path(), &format!("src/{folder}/nested.js"), "needle");
    }

    let outcome = run(&query(dir.path(), "needle"));

    assert_eq!(found_files(&outcome), ["README.md", "src/main.rs"]);
}

#[test]
fn binary_files_are_skipped_and_counted() {
    let dir = project();
    write(dir.path(), "logo.png", b"\x89PNG\0\0needle\0");

    let outcome = run(&query(dir.path(), "needle"));

    assert_eq!(found_files(&outcome), ["README.md", "src/main.rs"]);
    assert_eq!(outcome.skipped_binary, 1);
}

#[test]
fn utf16_text_with_a_bom_is_searched_not_mistaken_for_binary() {
    let dir = tempfile::tempdir().expect("tempdir");
    let mut bytes = vec![0xFF, 0xFE];
    for unit in "hello needle\n".encode_utf16() {
        bytes.extend_from_slice(&unit.to_le_bytes());
    }
    write(dir.path(), "wide.txt", bytes);

    let outcome = run(&query(dir.path(), "needle"));

    assert_eq!(found_files(&outcome), ["wide.txt"]);
    assert_eq!(outcome.skipped_binary, 0);
}

#[test]
fn oversized_files_are_skipped_and_counted() {
    let dir = project();
    let big = "needle\n".repeat(usize::try_from(MAX_FILE_BYTES).expect("size") / 6);
    write(dir.path(), "huge.log", big);

    let outcome = run(&query(dir.path(), "needle"));

    assert!(!found_files(&outcome).contains(&"huge.log"));
    assert_eq!(outcome.skipped_large, 1);
}

#[test]
fn include_and_exclude_patterns_narrow_the_search() {
    let dir = project();
    let mut q = query(dir.path(), "needle");
    q.include = vec!["*.rs".into()];
    assert_eq!(found_files(&run(&q)), ["src/main.rs"]);

    let mut q = query(dir.path(), "needle");
    q.exclude = vec!["src".into()];
    assert_eq!(found_files(&run(&q)), ["README.md"]);
}

#[test]
fn every_result_path_is_inside_the_searched_root() {
    let dir = project();
    // A pattern that tries to climb out only ever sees root-relative names.
    let mut q = query(dir.path(), "needle");
    q.include = vec!["../*".into(), "../../**".into()];
    let escaped = run(&q);
    assert!(escaped.files.is_empty());

    let outcome = run(&query(dir.path(), "needle"));
    for file in &outcome.files {
        assert!(
            Path::new(&file.path).starts_with(dir.path()),
            "{}",
            file.path
        );
        assert!(!file.relative_path.contains(".."));
    }
}

#[test]
fn a_missing_or_file_root_is_a_clear_error() {
    let dir = project();
    let missing = query(&dir.path().join("nope"), "x");
    let file = query(&dir.path().join("README.md"), "x");

    assert!(matches!(
        search(&missing, &AtomicBool::new(false)),
        Err(SearchError::InvalidRoot(_))
    ));
    assert!(matches!(
        search(&file, &AtomicBool::new(false)),
        Err(SearchError::InvalidRoot(_))
    ));
}

#[test]
fn max_results_truncates_and_says_so() {
    let dir = tempfile::tempdir().expect("tempdir");
    write(dir.path(), "a.txt", "x\nx\nx\nx\nx\n");
    let mut q = query(dir.path(), "x");
    q.max_results = 3;

    let outcome = run(&q);

    assert!(outcome.truncated);
    assert_eq!(outcome.total_matches, 3);
}

#[test]
fn a_cancelled_search_stops_and_reports_it() {
    let dir = project();
    let cancel = AtomicBool::new(true);

    let outcome = search(&query(dir.path(), "needle"), &cancel).expect("search");

    assert!(outcome.cancelled);
    assert!(outcome.files.is_empty());
}

#[cfg(unix)]
#[test]
fn symbolic_links_are_not_followed() {
    let dir = project();
    let outside = tempfile::tempdir().expect("outside");
    write(outside.path(), "secret.txt", "needle");
    std::os::unix::fs::symlink(outside.path(), dir.path().join("link")).expect("symlink");

    let outcome = run(&query(dir.path(), "needle"));

    assert!(!found_files(&outcome).iter().any(|p| p.starts_with("link")));
}

#[test]
fn results_come_in_a_stable_path_order() {
    let dir = tempfile::tempdir().expect("tempdir");
    for name in ["b.txt", "a.txt", "sub/c.txt", "sub/a.txt"] {
        write(dir.path(), name, "x");
    }

    let outcome = run(&query(dir.path(), "x"));

    let paths: Vec<PathBuf> = outcome
        .files
        .iter()
        .map(|f| PathBuf::from(&f.relative_path))
        .collect();
    assert_eq!(
        paths,
        ["a.txt", "b.txt", "sub/a.txt", "sub/c.txt"].map(PathBuf::from)
    );
}
