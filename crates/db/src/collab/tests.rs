//! The collaboration repositories against a real migrated database.

use super::*;
use crate::Db;

async fn db() -> (tempfile::TempDir, Db) {
    let dir = tempfile::tempdir().expect("tempdir");
    let db = Db::connect(&dir.path().join("openmind-studio.db"))
        .await
        .expect("connect");
    (dir, db)
}

async fn room(db: &Db, uid: &str) -> i64 {
    rooms::insert(
        db.pool(),
        &NewRoom {
            room_uid: uid,
            relation: "created",
            name: "Physics",
            local_role: "owner",
            owner_peer: "peer-owner",
            owner_public_key: "key",
            workspace_path: Some("C:/work/My Project"),
            workspace_name: Some("My Project"),
            created_at: 10,
        },
    )
    .await
    .expect("insert room")
}

fn member(room_id: i64, peer: &str, role: &str) -> MemberRow {
    MemberRow {
        room_id,
        peer: peer.into(),
        public_key: format!("key-{peer}"),
        display_name: peer.to_uppercase(),
        role: role.into(),
        status: "active".into(),
        force_muted: false,
        first_seen_at: 10,
        last_seen_at: 10,
    }
}

#[tokio::test]
async fn every_collaboration_table_exists_in_the_machine_database() {
    let (_dir, db) = db().await;
    for table in [
        "collab_rooms",
        "collab_sessions",
        "collab_members",
        "collab_permissions",
        "collab_files",
        "collab_action_logs",
        "collab_crdt_updates",
        "collab_document_snapshots",
        "collab_outbox",
    ] {
        let found: Option<String> =
            sqlx::query_scalar("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?1")
                .bind(table)
                .fetch_optional(db.pool())
                .await
                .expect("query");
        assert!(found.is_some(), "{table}");
    }
}

#[tokio::test]
async fn rooms_store_settings_invite_chain_and_history_times() {
    let (_dir, db) = db().await;
    let id = room(&db, "uid-1").await;
    assert!(
        rooms::insert(
            db.pool(),
            &NewRoom {
                room_uid: "uid-1",
                relation: "joined",
                name: "x",
                local_role: "viewer",
                owner_peer: "o",
                owner_public_key: "k",
                workspace_path: None,
                workspace_name: None,
                created_at: 1
            }
        )
        .await
        .is_err(),
        "room uid is unique"
    );
    rooms::set_invite(db.pool(), id, "hash", "dpapi1:abc", 2)
        .await
        .expect("invite");
    rooms::set_chain_head(db.pool(), id, 7, "h6")
        .await
        .expect("head");
    rooms::touch_joined(db.pool(), id, 100).await.expect("join");
    rooms::touch_joined(db.pool(), id, 200).await.expect("join");
    let settings = RoomSettings {
        name: "Physics 101",
        local_role: "owner",
        owner_peer: "peer-owner",
        owner_public_key: "key",
        locked: true,
        approval_required: true,
        default_role: "editor",
        closed: false,
    };
    rooms::update_settings(db.pool(), id, &settings)
        .await
        .expect("settings");
    let row = rooms::get_by_uid(db.pool(), "uid-1")
        .await
        .expect("get")
        .expect("row");
    assert_eq!(
        (row.name.as_str(), row.locked, row.approval_required),
        ("Physics 101", true, true)
    );
    assert_eq!(
        (
            row.invite_generation,
            row.chain_next_seq,
            row.chain_last_hash.as_str()
        ),
        (2, 7, "h6")
    );
    assert_eq!(
        (row.first_joined_at, row.last_joined_at),
        (Some(100), Some(200))
    );
    let json = serde_json::to_string(&row).expect("json");
    assert!(
        !json.contains("dpapi1") && !json.contains("C:/work"),
        "secrets and local paths never serialize"
    );
    rooms::set_archived(db.pool(), id, true)
        .await
        .expect("archive");
    assert!(rooms::list(db.pool(), false)
        .await
        .expect("list")
        .is_empty());
    assert_eq!(rooms::list(db.pool(), true).await.expect("list").len(), 1);
}

#[tokio::test]
async fn members_and_overrides_round_trip_and_go_with_the_room() {
    let (_dir, db) = db().await;
    let id = room(&db, "uid-1").await;
    members::upsert(db.pool(), &member(id, "a", "editor"))
        .await
        .expect("member");
    let mut changed = member(id, "a", "viewer");
    changed.first_seen_at = 999;
    changed.status = "kicked".into();
    members::upsert(db.pool(), &changed).await.expect("update");
    let list = members::list(db.pool(), id).await.expect("list");
    assert_eq!(list.len(), 1);
    assert_eq!(
        (
            list[0].role.as_str(),
            list[0].status.as_str(),
            list[0].first_seen_at
        ),
        ("viewer", "kicked", 10)
    );
    let mut bad = member(id, "b", "editor");
    bad.status = "superuser".into();
    assert!(
        members::upsert(db.pool(), &bad).await.is_err(),
        "status is checked"
    );

    members::set_permissions(db.pool(), id, "a", r#"["file.delete"]"#, "[]", 5)
        .await
        .expect("grant");
    assert_eq!(
        members::list_permissions(db.pool(), id)
            .await
            .expect("list")
            .len(),
        1
    );
    members::set_permissions(db.pool(), id, "a", "[]", "[]", 6)
        .await
        .expect("clear");
    assert!(members::list_permissions(db.pool(), id)
        .await
        .expect("list")
        .is_empty());

    sqlx::query("DELETE FROM collab_rooms WHERE id = ?1")
        .bind(id)
        .execute(db.pool())
        .await
        .expect("delete");
    assert!(
        members::list(db.pool(), id).await.expect("list").is_empty(),
        "cascade"
    );
}

#[tokio::test]
async fn sessions_end_once_and_dangling_ones_are_closed() {
    let (_dir, db) = db().await;
    let id = room(&db, "uid-1").await;
    for (session, started) in [("s1", 1), ("s2", 2)] {
        let row = SessionRow {
            session_id: session.into(),
            room_id: id,
            peer: "a".into(),
            role: "viewer".into(),
            epoch: 0,
            started_at: started,
            connected_at: Some(started),
            ended_at: None,
            end_reason: None,
            last_event_seq: 0,
            manifest_version: 0,
        };
        sessions::insert(db.pool(), &row).await.expect("insert");
    }
    sessions::end(db.pool(), "s1", 5, "kicked")
        .await
        .expect("end");
    sessions::end(db.pool(), "s1", 6, "again")
        .await
        .expect("end");
    sessions::set_progress(db.pool(), "s2", 12, 3)
        .await
        .expect("progress");
    assert_eq!(
        sessions::end_dangling(db.pool(), id, 9, "app restarted")
            .await
            .expect("dangling"),
        1
    );
    let list = sessions::list(db.pool(), id, 10).await.expect("list");
    assert_eq!(list[0].session_id, "s2");
    assert_eq!(
        (list[0].last_event_seq, list[0].end_reason.as_deref()),
        (12, Some("app restarted"))
    );
    assert_eq!(
        (list[1].ended_at, list[1].end_reason.as_deref()),
        (Some(5), Some("kicked"))
    );
}

#[tokio::test]
async fn files_are_unique_by_case_folded_path() {
    let (_dir, db) = db().await;
    let id = room(&db, "uid-1").await;
    let main = CollabFileRow {
        file_id: "f1".into(),
        rel_path: "src/Main.ts".into(),
        kind: "file".into(),
    };
    files::upsert(db.pool(), id, &main, "src/main.ts")
        .await
        .expect("insert");
    let clash = CollabFileRow {
        file_id: "f2".into(),
        rel_path: "SRC/main.ts".into(),
        kind: "file".into(),
    };
    assert!(files::upsert(db.pool(), id, &clash, "src/main.ts")
        .await
        .is_err());
    let moved = CollabFileRow {
        rel_path: "app/Main.ts".into(),
        ..main
    };
    files::upsert(db.pool(), id, &moved, "app/main.ts")
        .await
        .expect("rename");
    assert_eq!(files::list(db.pool(), id).await.expect("list"), vec![moved]);
    files::delete(db.pool(), id, "f1").await.expect("delete");
    assert!(files::list(db.pool(), id).await.expect("list").is_empty());
}

fn log(room_id: i64, seq: i64, prev: &str) -> ActionLogRow {
    ActionLogRow {
        room_id,
        seq,
        event_id: format!("e{seq}"),
        session_id: None,
        actor_peer: "o".into(),
        actor_name: "Owner".into(),
        actor_role: "owner".into(),
        kind: "room.created".into(),
        file_id: None,
        rel_path: None,
        metadata: "{}".into(),
        at_ms: seq,
        prev_hash: prev.into(),
        hash: format!("h{seq}"),
        signature: None,
    }
}

#[tokio::test]
async fn the_action_log_refuses_a_forked_sequence() {
    let (_dir, db) = db().await;
    let id = room(&db, "uid-1").await;
    logs::append(db.pool(), &log(id, 1, "0")).await.expect("1");
    logs::append(db.pool(), &log(id, 2, "h1")).await.expect("2");
    let mut fork = log(id, 2, "h1");
    fork.event_id = "other".into();
    assert!(logs::append(db.pool(), &fork).await.is_err());
    assert_eq!(
        logs::last(db.pool(), id).await.expect("last"),
        Some((2, "h2".into()))
    );
    assert_eq!(
        logs::list_after(db.pool(), id, 1, 10)
            .await
            .expect("list")
            .len(),
        1
    );
}

#[tokio::test]
async fn crdt_updates_are_idempotent_and_snapshots_plus_updates_recover_a_document() {
    let (_dir, db) = db().await;
    let id = room(&db, "uid-1").await;
    let first = crdt::insert_update(db.pool(), id, "f1", "m1", "a", &[1], 1)
        .await
        .expect("insert");
    assert!(first.is_some());
    assert_eq!(
        crdt::insert_update(db.pool(), id, "f1", "m1", "a", &[1], 2)
            .await
            .expect("resend"),
        None
    );
    let second = crdt::insert_update(db.pool(), id, "f1", "m2", "b", &[2], 3)
        .await
        .expect("insert")
        .expect("id");
    crdt::insert_update(db.pool(), id, "f2", "m3", "b", &[9], 3)
        .await
        .expect("other file");
    let snapshot = crdt::save_snapshot(db.pool(), id, "f1", &[1, 2], &[0], first.expect("id"), 4)
        .await
        .expect("snap");
    let latest = crdt::latest_snapshot(db.pool(), id, "f1")
        .await
        .expect("latest")
        .expect("row");
    assert_eq!(latest.id, snapshot);
    let rest = crdt::updates_after(db.pool(), id, "f1", latest.covers_update_id)
        .await
        .expect("after");
    assert_eq!(rest.iter().map(|u| u.id).collect::<Vec<_>>(), vec![second]);
    assert_eq!(rest[0].update_data, vec![2]);
}

#[tokio::test]
async fn the_outbox_keeps_messages_until_settled() {
    let (_dir, db) = db().await;
    let id = room(&db, "uid-1").await;
    assert!(outbox::enqueue(db.pool(), id, "m1", "sync", &[1], 1)
        .await
        .expect("enqueue"));
    assert!(!outbox::enqueue(db.pool(), id, "m1", "sync", &[1], 2)
        .await
        .expect("again"));
    outbox::enqueue(db.pool(), id, "m2", "files", &[2], 3)
        .await
        .expect("enqueue");
    outbox::mark_attempt(db.pool(), "m1", 4)
        .await
        .expect("attempt");
    let pending = outbox::pending(db.pool(), id, 10).await.expect("pending");
    assert_eq!(
        pending
            .iter()
            .map(|r| r.message_id.as_str())
            .collect::<Vec<_>>(),
        ["m1", "m2"]
    );
    assert_eq!(pending[0].attempts, 1);
    assert!(outbox::ack(db.pool(), "m1", 5).await.expect("ack"));
    assert!(
        !outbox::ack(db.pool(), "m1", 6).await.expect("ack again"),
        "a duplicate ack changes nothing"
    );
    assert!(outbox::reject(
        db.pool(),
        "m2",
        "the permission \"file.write\" is required",
        7
    )
    .await
    .expect("reject"));
    assert!(outbox::pending(db.pool(), id, 10)
        .await
        .expect("pending")
        .is_empty());
}

#[tokio::test]
async fn one_outcome_is_saved_atomically_in_a_transaction() {
    let (_dir, db) = db().await;
    let id = room(&db, "uid-1").await;
    let mut tx = db.pool().begin().await.expect("begin");
    members::upsert(&mut *tx, &member(id, "a", "viewer"))
        .await
        .expect("member");
    logs::append(&mut *tx, &log(id, 1, "0")).await.expect("log");
    rooms::set_chain_head(&mut *tx, id, 2, "h1")
        .await
        .expect("head");
    drop(tx); // rolled back
    assert!(members::list(db.pool(), id).await.expect("list").is_empty());
    assert_eq!(logs::last(db.pool(), id).await.expect("last"), None);
}
