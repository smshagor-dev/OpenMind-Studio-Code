//! Upgrading a database made before Milestone 24 (collaboration): migrations 0001-0003 only, with user data in it, the
//! way an installed 1.0.x copy leaves it. The current build adds the collaboration tables once and keeps everything.

use std::borrow::Cow;
use std::path::Path;

use sqlx::migrate::Migrator;
use sqlx::sqlite::{SqliteConnectOptions, SqlitePoolOptions};
use sqlx::SqlitePool;

use crate::migrations::MIGRATOR;
use crate::Db;

/// The last migration before collaboration.
const PRE_COLLABORATION: i64 = 3;

async fn raw(path: &Path, create: bool) -> SqlitePool {
    SqlitePoolOptions::new()
        .max_connections(1)
        .connect_with(
            SqliteConnectOptions::new()
                .filename(path)
                .create_if_missing(create)
                .foreign_keys(true),
        )
        .await
        .expect("raw pool")
}

/// A database exactly as a pre-Milestone-24 build left it: the real migrations up to 0003, plus user data.
async fn pre_collaboration_database(path: &Path) {
    let pool = raw(path, true).await;
    let older = Migrator {
        migrations: Cow::Owned(
            MIGRATOR
                .iter()
                .filter(|m| m.version <= PRE_COLLABORATION)
                .cloned()
                .collect(),
        ),
        ignore_missing: false,
        locking: true,
        no_tx: false,
    };
    older.run(&pool).await.expect("old migrations");
    for (key, value) in [("workbench.colorTheme", "light"), ("user.data", "kept")] {
        sqlx::query("INSERT INTO editor_settings (key, value) VALUES (?1, ?2)")
            .bind(key)
            .bind(value)
            .execute(&pool)
            .await
            .expect("setting");
    }
    sqlx::query("INSERT INTO recent_files (path) VALUES ('C:/work/a.ts')")
        .execute(&pool)
        .await
        .expect("recent file");
    pool.close().await;
}

async fn versions(pool: &SqlitePool) -> Vec<i64> {
    sqlx::query_scalar("SELECT version FROM _sqlx_migrations ORDER BY version")
        .fetch_all(pool)
        .await
        .expect("versions")
}

#[tokio::test]
async fn a_pre_collaboration_database_is_upgraded_once_and_keeps_its_data() {
    let dir = tempfile::tempdir().expect("dir");
    let path = dir.path().join("openmind-studio.db");
    pre_collaboration_database(&path).await;
    let before = raw(&path, false).await;
    assert_eq!(versions(&before).await, [1, 2, 3]);
    before.close().await;

    for start in 0..2 {
        // Two starts of the new build: the migrations run on the first and never again.
        let db = Db::connect(&path).await.expect("upgraded");
        assert_eq!(versions(db.pool()).await, [1, 2, 3, 4, 5], "start {start}");
        let kept: Vec<(String, String)> =
            sqlx::query_as("SELECT key, value FROM editor_settings ORDER BY key")
                .fetch_all(db.pool())
                .await
                .expect("settings");
        assert_eq!(
            kept,
            [
                ("user.data".to_string(), "kept".to_string()),
                ("workbench.colorTheme".to_string(), "light".to_string())
            ]
        );
        let recent: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM recent_files")
            .fetch_one(db.pool())
            .await
            .expect("recent");
        assert_eq!(recent, 1);
        let tables: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name LIKE 'collab_%'",
        )
        .fetch_one(db.pool())
        .await
        .expect("tables");
        assert!(tables >= 10, "the collaboration tables exist ({tables})");
        let integrity: String = sqlx::query_scalar("PRAGMA integrity_check")
            .fetch_one(db.pool())
            .await
            .expect("integrity");
        assert_eq!(integrity, "ok");
        let broken: Vec<(String,)> = sqlx::query_as("PRAGMA foreign_key_check")
            .fetch_all(db.pool())
            .await
            .expect("fk check");
        assert!(broken.is_empty());
        db.pool().close().await;
    }
}

#[tokio::test]
async fn deleting_a_room_removes_everything_that_belongs_to_it_and_nothing_else() {
    let dir = tempfile::tempdir().expect("dir");
    let db = Db::connect(&dir.path().join("openmind-studio.db"))
        .await
        .expect("db");
    let pool = db.pool();
    for (id, uid) in [(1, "a"), (2, "b")] {
        sqlx::query(
            "INSERT INTO collab_rooms (id, room_uid, relation, name, local_role, owner_peer, owner_public_key, \
             created_at) VALUES (?1, ?2, 'created', 'Room', 'owner', 'p', 'k', 0)",
        )
        .bind(id)
        .bind(uid)
        .execute(pool)
        .await
        .expect("room");
        sqlx::query("INSERT INTO collab_doc_baselines (room_id, file_id, disk_sha256, updated_at) VALUES (?1, 'f', 'x', 0)")
            .bind(id)
            .execute(pool)
            .await
            .expect("baseline");
    }
    sqlx::query("DELETE FROM collab_rooms WHERE id = 1")
        .execute(pool)
        .await
        .expect("delete");
    let left: Vec<i64> = sqlx::query_scalar("SELECT room_id FROM collab_doc_baselines")
        .fetch_all(pool)
        .await
        .expect("left");
    assert_eq!(left, [2], "cascaded for the deleted room only");
}

/// Writes a pre-Milestone-24 database for a manual upgrade test of the real app: `OPENMIND_TEST_PRE_M24_DB=<file>`.
#[tokio::test]
#[ignore = "manual: writes a database to OPENMIND_TEST_PRE_M24_DB"]
async fn write_a_pre_collaboration_database_for_a_manual_upgrade() {
    let Ok(target) = std::env::var("OPENMIND_TEST_PRE_M24_DB") else {
        return;
    };
    pre_collaboration_database(Path::new(&target)).await;
}
