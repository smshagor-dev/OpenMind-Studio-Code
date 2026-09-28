use std::path::Path;

use openmind_db::{Db, DbError, FailureKind};
use sqlx::migrate::MigrateError;

use super::{describe, move_database_aside};

const PREFIXES: [&str; 6] = [
    "OpenMind Studio could not open its local database.",
    "Version: ",
    "Category: ",
    "Database: ",
    "Error: ",
    "Your data was not deleted.",
];

fn mismatch() -> DbError {
    DbError::Migrate(MigrateError::VersionMismatch(3))
}

#[test]
fn a_checksum_mismatch_reads_as_a_sentence_with_the_database_path() {
    let dir = tempfile::tempdir().expect("tempdir");
    let db = dir.path().join("openmind-studio.db");
    std::fs::write(&db, "kept").expect("write");

    let failure = describe(&mismatch(), &db, dir.path());

    assert_eq!(
        failure.failure,
        FailureKind::ChecksumMismatch { version: 3 }
    );
    assert_eq!(failure.category, "Migration checksum mismatch");
    assert!(failure.explanation.starts_with(
        "OpenMind Studio could not open the local database because migration 3's checksum does not match this build."
    ));
    assert!(failure
        .explanation
        .contains("different SQL file line endings"));
    assert!(failure.explanation.ends_with("Your data was not deleted."));
    assert!(failure.can_back_up);
    assert_eq!(failure.db_path, db.display().to_string());
    assert!(failure
        .details
        .contains(&format!("Database: {}", db.display())));
    assert!(failure
        .details
        .contains("Category: Migration checksum mismatch"));
    assert!(failure
        .details
        .contains("Error: failed to run database migrations: migration 3 was previously applied but has been modified"));
    assert!(!failure.details.contains("panicked"));
    assert_eq!(
        std::fs::read_to_string(&db).expect("read"),
        "kept",
        "describing changes nothing"
    );
}

#[test]
fn every_category_has_a_title_an_explanation_and_a_next_step() {
    let kinds = [
        FailureKind::ChecksumMismatch { version: 1 },
        FailureKind::UnknownMigration { version: 9 },
        FailureKind::PartialMigration { version: 2 },
        FailureKind::MigrationFailed { version: Some(2) },
        FailureKind::MigrationFailed { version: None },
        FailureKind::Locked,
        FailureKind::Corrupt,
        FailureKind::ReadOnly,
        FailureKind::CannotOpen,
        FailureKind::DiskFull,
        FailureKind::CreateFolder,
        FailureKind::Other,
    ];
    for kind in kinds {
        let (category, title, explanation, steps) = super::explain(kind);
        assert!(!category.is_empty() && !title.is_empty(), "{kind:?}");
        assert!(
            explanation.ends_with("Your data was not deleted."),
            "{kind:?}"
        );
        assert!(!steps.is_empty(), "{kind:?}");
    }
}

#[test]
fn the_copied_details_hold_only_the_listed_fields() {
    let dir = tempfile::tempdir().expect("tempdir");
    let failure = describe(&mismatch(), &dir.path().join("missing.db"), dir.path());
    for line in failure.details.lines() {
        assert!(
            PREFIXES.iter().any(|p| line.starts_with(p)),
            "unexpected line: {line}"
        );
    }
    assert!(!failure.can_back_up, "no file, nothing to back up");
}

#[test]
fn a_real_open_failure_is_an_error_value_not_a_panic() {
    let dir = tempfile::tempdir().expect("tempdir");
    let path = dir.path().join("openmind-studio.db");
    std::fs::write(&path, b"not a database".repeat(200)).expect("write");

    let err = tauri::async_runtime::block_on(Db::connect(&path))
        .err()
        .expect("a damaged file is refused");
    let failure = describe(&err, &path, dir.path());

    assert_eq!(failure.failure, FailureKind::Corrupt);
    assert_eq!(failure.title, "The local database file is damaged");
    assert!(path.is_file(), "the file stays where it was");
}

fn write(path: &Path, text: &str) {
    std::fs::write(path, text).expect("write");
}

#[test]
fn back_up_moves_the_database_files_and_deletes_nothing() {
    let dir = tempfile::tempdir().expect("tempdir");
    let db = dir.path().join("openmind-studio.db");
    write(&db, "main");
    write(&dir.path().join("openmind-studio.db-wal"), "wal");
    write(&dir.path().join("openmind-studio.db-shm"), "shm");
    write(&dir.path().join("other.txt"), "not ours");

    let backup = move_database_aside(&db, dir.path(), 42).expect("moved");

    assert_eq!(backup, dir.path().join("db-backup-42"));
    assert!(!db.exists());
    for (name, text) in [
        ("openmind-studio.db", "main"),
        ("openmind-studio.db-wal", "wal"),
        ("openmind-studio.db-shm", "shm"),
    ] {
        assert_eq!(
            std::fs::read_to_string(backup.join(name)).expect(name),
            text
        );
    }
    assert_eq!(
        std::fs::read_to_string(dir.path().join("other.txt")).expect("other"),
        "not ours"
    );
}

#[test]
fn back_up_never_overwrites_an_existing_backup() {
    let dir = tempfile::tempdir().expect("tempdir");
    let db = dir.path().join("openmind-studio.db");
    write(&db, "main");
    std::fs::create_dir(dir.path().join("db-backup-7")).expect("mkdir");

    let err = move_database_aside(&db, dir.path(), 7).expect_err("refused");

    assert!(err.contains("nothing was moved"));
    assert_eq!(std::fs::read_to_string(&db).expect("read"), "main");
}

/// The page's text per kind (src/startupError/failureText.ts) and English in the UI catalog.
fn catalog() -> serde_json::Map<String, serde_json::Value> {
    let path = Path::new(env!("CARGO_MANIFEST_DIR")).join("../src/i18n/locales/en.json");
    let text = std::fs::read_to_string(path).expect("the UI's English catalog");
    match serde_json::from_str(&text).expect("valid JSON") {
        serde_json::Value::Object(map) => map,
        _ => panic!("en.json must be an object"),
    }
}

#[test]
fn the_ui_catalog_says_exactly_what_the_backend_says_for_every_kind() {
    let en = catalog();
    let text = |key: &str| {
        en.get(key)
            .and_then(serde_json::Value::as_str)
            .unwrap_or("<missing>")
            .to_string()
    };
    // (kind, the text key the page uses, the step keys it shows)
    let cases: [(FailureKind, &str, &[&str]); 12] = [
        (
            FailureKind::ChecksumMismatch { version: 7 },
            "checksumMismatch",
            &["exitAndUse", "backUp"],
        ),
        (
            FailureKind::UnknownMigration { version: 7 },
            "unknownMigration",
            &["useNewer", "backUp"],
        ),
        (
            FailureKind::PartialMigration { version: 7 },
            "partialMigration",
            &["backUp", "reportKept"],
        ),
        (
            FailureKind::MigrationFailed { version: Some(7) },
            "migrationFailed",
            &["exitAndUse", "backUp"],
        ),
        (
            FailureKind::MigrationFailed { version: None },
            "migrationFailed",
            &["exitAndUse", "backUp"],
        ),
        (FailureKind::Locked, "locked", &["closeOther"]),
        (
            FailureKind::Corrupt,
            "corrupt",
            &["backUp", "restoreBackup"],
        ),
        (FailureKind::ReadOnly, "readOnly", &["checkWritable"]),
        (FailureKind::CannotOpen, "readOnly", &["checkWritable"]),
        (FailureKind::CreateFolder, "readOnly", &["checkWritable"]),
        (FailureKind::DiskFull, "diskFull", &["freeSpace"]),
        (FailureKind::Other, "other", &["report", "backUp"]),
    ];
    for (kind, key, steps) in cases {
        let (category, title, explanation, next_steps) = super::explain(kind);
        let base = format!("databaseError.kind.{key}");
        assert_eq!(text(&format!("{base}.category")), category, "{kind:?}");
        assert_eq!(text(&format!("{base}.title")), title, "{kind:?}");
        let explanation_key = if kind == (FailureKind::MigrationFailed { version: None }) {
            format!("{base}.explanationNoVersion")
        } else {
            format!("{base}.explanation")
        };
        assert_eq!(
            text(&explanation_key).replace("{version}", "7"),
            explanation,
            "{kind:?}"
        );
        let english_steps: Vec<String> = steps
            .iter()
            .map(|s| text(&format!("databaseError.step.{s}")))
            .collect();
        assert_eq!(english_steps, next_steps, "{kind:?}");
    }
}

#[test]
fn the_payload_carries_a_stable_code_and_only_fixed_fields() {
    let dir = tempfile::tempdir().expect("tempdir");
    let failure = describe(
        &mismatch(),
        &dir.path().join("openmind-studio.db"),
        dir.path(),
    );
    let json = serde_json::to_value(&failure).expect("serializes");
    assert_eq!(
        json["failure"],
        serde_json::json!({ "kind": "checksumMismatch", "version": 3 })
    );
    let fields: Vec<&str> = json
        .as_object()
        .expect("object")
        .keys()
        .map(String::as_str)
        .collect();
    assert_eq!(
        fields,
        [
            "failure",
            "category",
            "title",
            "explanation",
            "nextSteps",
            "dbPath",
            "dataDir",
            "errorChain",
            "details",
            "canBackUp"
        ]
    );
}
