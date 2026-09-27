use std::path::{Path, PathBuf};

use sha2::{Digest, Sha384};
use sqlx::sqlite::{SqliteConnectOptions, SqlitePoolOptions};
use sqlx::SqlitePool;

use super::MIGRATOR;
use crate::{Db, DbError, FailureKind};

#[path = "../migration_inputs.rs"]
mod migration_inputs;

fn crate_dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
}

fn migration_files() -> Vec<PathBuf> {
    let mut files: Vec<PathBuf> = std::fs::read_dir(crate_dir().join("migrations"))
        .expect("migrations folder")
        .map(|entry| entry.expect("entry").path())
        .filter(|path| path.extension().is_some_and(|ext| ext == "sql"))
        .collect();
    files.sort();
    files
}

/// A raw pool on the file, for tampering with `_sqlx_migrations` the way another build would have left it.
async fn raw(path: &Path) -> SqlitePool {
    SqlitePoolOptions::new()
        .max_connections(1)
        .connect_with(SqliteConnectOptions::new().filename(path))
        .await
        .expect("raw pool")
}

/// A migrated database with one row of user data in it.
async fn database_with_data(dir: &Path) -> PathBuf {
    let path = dir.join("openmind-studio.db");
    let db = Db::connect(&path).await.expect("connect");
    sqlx::query("INSERT INTO editor_settings (key, value) VALUES ('user.data', 'kept')")
        .execute(db.pool())
        .await
        .expect("insert");
    db.pool().close().await;
    path
}

async fn stored_checksum(path: &Path, version: i64) -> Vec<u8> {
    let pool = raw(path).await;
    let checksum: Vec<u8> =
        sqlx::query_scalar("SELECT checksum FROM _sqlx_migrations WHERE version = ?1")
            .bind(version)
            .fetch_one(&pool)
            .await
            .expect("checksum");
    pool.close().await;
    checksum
}

async fn set_checksum(path: &Path, version: i64, checksum: &[u8]) {
    let pool = raw(path).await;
    sqlx::query("UPDATE _sqlx_migrations SET checksum = ?1 WHERE version = ?2")
        .bind(checksum)
        .bind(version)
        .execute(&pool)
        .await
        .expect("update");
    pool.close().await;
}

async fn user_row_is_kept(path: &Path) -> bool {
    let pool = raw(path).await;
    let value: Option<String> =
        sqlx::query_scalar("SELECT value FROM editor_settings WHERE key = 'user.data'")
            .fetch_optional(&pool)
            .await
            .expect("select");
    pool.close().await;
    value.as_deref() == Some("kept")
}

fn latest() -> &'static sqlx::migrate::Migration {
    MIGRATOR.iter().last().expect("at least one migration")
}

fn crlf(sql: &str) -> String {
    sql.replace("\r\n", "\n").replace('\n', "\r\n")
}

#[test]
fn migration_files_and_embedded_sql_use_lf_only() {
    let files = migration_files();
    assert!(!files.is_empty());
    for file in files {
        let bytes = std::fs::read(&file).expect("read");
        assert!(
            !bytes.contains(&b'\r'),
            "{} has CR line endings; .gitattributes pins *.sql to LF",
            file.display()
        );
    }
    for migration in MIGRATOR.iter() {
        assert!(
            !migration.sql.contains('\r'),
            "migration {} was embedded with CR",
            migration.version
        );
    }
}

#[test]
fn gitattributes_pins_sql_to_lf() {
    let root = crate_dir().join("../..");
    let text = std::fs::read_to_string(root.join(".gitattributes")).expect(".gitattributes");
    assert!(text.lines().any(|l| l.trim() == "*.sql text eol=lf"));
    assert!(text
        .lines()
        .any(|l| l.trim() == "crates/db/migrations/*.sql text eol=lf"));
}

#[test]
fn every_embedded_checksum_is_the_sha384_of_its_sql() {
    // The repair relies on this: sqlx's checksum is the SHA-384 of exactly the embedded text.
    for migration in MIGRATOR.iter() {
        assert_eq!(
            Sha384::digest(migration.sql.as_bytes()).as_slice(),
            migration.checksum.as_ref()
        );
    }
    assert_eq!(MIGRATOR.iter().count(), migration_files().len());
}

#[test]
fn the_build_script_watches_the_folder_and_every_migration() {
    let lines = migration_inputs::rerun_if_changed_lines(&crate_dir());
    assert_eq!(lines[0], "cargo:rerun-if-changed=migrations");
    for file in migration_files() {
        let name = file
            .file_name()
            .expect("name")
            .to_string_lossy()
            .into_owned();
        assert!(
            lines.contains(&format!("cargo:rerun-if-changed=migrations/{name}")),
            "{name} is not watched"
        );
    }
    let build = std::fs::read_to_string(crate_dir().join("build.rs")).expect("build.rs");
    assert!(build.contains("include!(\"migration_inputs.rs\")"));
}

#[test]
fn a_new_migration_file_is_watched_too() {
    let dir = tempfile::tempdir().expect("tempdir");
    std::fs::create_dir(dir.path().join("migrations")).expect("mkdir");
    std::fs::write(dir.path().join("migrations/0009_new.sql"), "SELECT 1;\n").expect("write");
    std::fs::write(dir.path().join("migrations/notes.txt"), "not sql").expect("write");
    assert_eq!(
        migration_inputs::rerun_if_changed_lines(dir.path()),
        [
            "cargo:rerun-if-changed=migrations",
            "cargo:rerun-if-changed=migrations/0009_new.sql"
        ]
    );
}

#[tokio::test]
async fn a_fresh_database_needs_no_repair() {
    let dir = tempfile::tempdir().expect("tempdir");
    let db = Db::connect(&dir.path().join("fresh.db"))
        .await
        .expect("connect");
    assert!(db.checksum_repairs().is_empty());
}

#[tokio::test]
async fn an_existing_database_opens_again_unchanged() {
    let dir = tempfile::tempdir().expect("tempdir");
    let path = database_with_data(dir.path()).await;
    let before = stored_checksum(&path, latest().version).await;
    let db = Db::connect(&path).await.expect("reopen");
    assert!(db.checksum_repairs().is_empty());
    db.pool().close().await;
    assert_eq!(stored_checksum(&path, latest().version).await, before);
    assert!(user_row_is_kept(&path).await);
}

#[tokio::test]
async fn a_checksum_that_differs_only_by_line_endings_is_repaired_and_logged() {
    let dir = tempfile::tempdir().expect("tempdir");
    let path = database_with_data(dir.path()).await;
    let migration = latest();
    let crlf_checksum = Sha384::digest(crlf(&migration.sql).as_bytes()).to_vec();
    set_checksum(&path, migration.version, &crlf_checksum).await;

    let db = Db::connect(&path)
        .await
        .expect("a line-ending-only difference opens");
    let repairs = db.checksum_repairs().to_vec();
    db.pool().close().await;

    assert_eq!(repairs.len(), 1);
    assert_eq!(repairs[0].version, migration.version);
    assert_eq!(repairs[0].old_checksum.len(), 96);
    assert_ne!(repairs[0].old_checksum, repairs[0].new_checksum);
    assert_eq!(
        stored_checksum(&path, migration.version).await,
        migration.checksum.as_ref()
    );
    assert!(user_row_is_kept(&path).await);
}

#[tokio::test]
async fn a_real_sql_change_is_never_repaired_and_nothing_is_reset() {
    let dir = tempfile::tempdir().expect("tempdir");
    let path = database_with_data(dir.path()).await;
    let migration = latest();
    let edited = format!("{}\n-- edited\n", migration.sql);
    for other in [edited.clone(), crlf(&edited)] {
        let changed = Sha384::digest(other.as_bytes()).to_vec();
        set_checksum(&path, migration.version, &changed).await;

        let err = Db::connect(&path)
            .await
            .err()
            .expect("a real change is refused");
        assert!(matches!(err, DbError::Migrate(_)));
        assert_eq!(
            err.kind(),
            FailureKind::ChecksumMismatch {
                version: migration.version
            }
        );
        assert_eq!(stored_checksum(&path, migration.version).await, changed);
        assert!(
            user_row_is_kept(&path).await,
            "no reset after a refused start"
        );
    }
}

#[tokio::test]
async fn a_database_from_a_newer_build_is_reported_not_changed() {
    let dir = tempfile::tempdir().expect("tempdir");
    let path = database_with_data(dir.path()).await;
    let pool = raw(&path).await;
    sqlx::query(
        "INSERT INTO _sqlx_migrations (version, description, success, checksum, execution_time) \
         VALUES (9999, 'future', 1, x'00', 0)",
    )
    .execute(&pool)
    .await
    .expect("insert");
    pool.close().await;

    let err = Db::connect(&path).await.err().expect("refused");
    assert_eq!(err.kind(), FailureKind::UnknownMigration { version: 9999 });
    assert!(user_row_is_kept(&path).await);
}

#[tokio::test]
async fn a_half_applied_migration_is_reported() {
    let dir = tempfile::tempdir().expect("tempdir");
    let path = database_with_data(dir.path()).await;
    let pool = raw(&path).await;
    sqlx::query("UPDATE _sqlx_migrations SET success = 0 WHERE version = ?1")
        .bind(latest().version)
        .execute(&pool)
        .await
        .expect("update");
    pool.close().await;

    let err = Db::connect(&path).await.err().expect("refused");
    assert_eq!(
        err.kind(),
        FailureKind::PartialMigration {
            version: latest().version
        }
    );
}

#[tokio::test]
async fn a_file_that_is_not_a_database_is_reported_and_left_alone() {
    let dir = tempfile::tempdir().expect("tempdir");
    let path = dir.path().join("openmind-studio.db");
    let garbage = b"this is not a SQLite database, but it is someone's file".repeat(100);
    std::fs::write(&path, &garbage).expect("write");

    let err = Db::connect(&path).await.err().expect("refused");
    assert_eq!(err.kind(), FailureKind::Corrupt);
    assert_eq!(std::fs::read(&path).expect("read"), garbage);
}

#[tokio::test]
async fn a_folder_that_cannot_be_created_is_reported() {
    let dir = tempfile::tempdir().expect("tempdir");
    let blocker = dir.path().join("data");
    std::fs::write(&blocker, "a file where the data folder should be").expect("write");
    let err = Db::connect(&blocker.join("openmind-studio.db"))
        .await
        .err()
        .expect("refused");
    assert_eq!(err.kind(), FailureKind::CreateFolder);
}
