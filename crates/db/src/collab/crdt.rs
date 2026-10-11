//! `collab_crdt_updates` and `collab_document_snapshots`: the exact accepted CRDT updates and full-state snapshots.
//! Recovery of a document = its latest snapshot + the updates after the update it covers.

use sqlx::{Executor, Sqlite};

use super::query_error;
use crate::DbError;

#[derive(Debug, Clone, PartialEq, Eq, sqlx::FromRow)]
pub struct CrdtUpdateRow {
    pub id: i64,
    pub file_id: String,
    pub message_id: String,
    pub origin_peer: String,
    pub update_data: Vec<u8>,
    pub received_at: i64,
}

#[derive(Debug, Clone, PartialEq, Eq, sqlx::FromRow)]
pub struct DocumentSnapshotRow {
    pub id: i64,
    pub file_id: String,
    pub state_data: Vec<u8>,
    pub state_vector: Vec<u8>,
    pub covers_update_id: i64,
    pub created_at: i64,
}

/// Stores an accepted update. Returns its id, or `None` when this message was already stored (a resend).
pub async fn insert_update<'e, E: Executor<'e, Database = Sqlite>>(
    executor: E,
    room_id: i64,
    file_id: &str,
    message_id: &str,
    origin_peer: &str,
    update: &[u8],
    received_at: i64,
) -> Result<Option<i64>, DbError> {
    let result = sqlx::query(
        "INSERT INTO collab_crdt_updates (room_id, file_id, message_id, origin_peer, update_data, received_at) \
         VALUES (?1, ?2, ?3, ?4, ?5, ?6) ON CONFLICT(room_id, message_id) DO NOTHING",
    )
    .bind(room_id)
    .bind(file_id)
    .bind(message_id)
    .bind(origin_peer)
    .bind(update)
    .bind(received_at)
    .execute(executor)
    .await
    .map_err(query_error)?;
    Ok((result.rows_affected() == 1).then(|| result.last_insert_rowid()))
}

/// A document's updates with an id above `after_id`, in acceptance order.
pub async fn updates_after<'e, E: Executor<'e, Database = Sqlite>>(
    executor: E,
    room_id: i64,
    file_id: &str,
    after_id: i64,
) -> Result<Vec<CrdtUpdateRow>, DbError> {
    sqlx::query_as::<_, CrdtUpdateRow>(
        "SELECT id, file_id, message_id, origin_peer, update_data, received_at FROM collab_crdt_updates \
         WHERE room_id = ?1 AND file_id = ?2 AND id > ?3 ORDER BY id",
    )
    .bind(room_id)
    .bind(file_id)
    .bind(after_id)
    .fetch_all(executor)
    .await
    .map_err(query_error)
}

/// Saves a snapshot covering every update of the document up to `covers_update_id`. Returns its id.
pub async fn save_snapshot<'e, E: Executor<'e, Database = Sqlite>>(
    executor: E,
    room_id: i64,
    file_id: &str,
    state: &[u8],
    state_vector: &[u8],
    covers_update_id: i64,
    created_at: i64,
) -> Result<i64, DbError> {
    let result = sqlx::query(
        "INSERT INTO collab_document_snapshots (room_id, file_id, state_data, state_vector, covers_update_id, \
         created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
    )
    .bind(room_id)
    .bind(file_id)
    .bind(state)
    .bind(state_vector)
    .bind(covers_update_id)
    .bind(created_at)
    .execute(executor)
    .await
    .map_err(query_error)?;
    Ok(result.last_insert_rowid())
}

/// The newest snapshot of a document.
pub async fn latest_snapshot<'e, E: Executor<'e, Database = Sqlite>>(
    executor: E,
    room_id: i64,
    file_id: &str,
) -> Result<Option<DocumentSnapshotRow>, DbError> {
    sqlx::query_as::<_, DocumentSnapshotRow>(
        "SELECT id, file_id, state_data, state_vector, covers_update_id, created_at FROM collab_document_snapshots \
         WHERE room_id = ?1 AND file_id = ?2 ORDER BY covers_update_id DESC, id DESC LIMIT 1",
    )
    .bind(room_id)
    .bind(file_id)
    .fetch_optional(executor)
    .await
    .map_err(query_error)
}

/// The documents of a room that have a baseline, i.e. that were loaded as collaborative documents at least once.
pub async fn baseline_files<'e, E: Executor<'e, Database = Sqlite>>(
    executor: E,
    room_id: i64,
) -> Result<Vec<String>, DbError> {
    sqlx::query_scalar::<_, String>(
        "SELECT file_id FROM collab_doc_baselines WHERE room_id = ?1 ORDER BY file_id",
    )
    .bind(room_id)
    .fetch_all(executor)
    .await
    .map_err(query_error)
}

/// The disk hash the document last matched (`collab_doc_baselines`).
pub async fn baseline<'e, E: Executor<'e, Database = Sqlite>>(
    executor: E,
    room_id: i64,
    file_id: &str,
) -> Result<Option<String>, DbError> {
    sqlx::query_scalar::<_, String>(
        "SELECT disk_sha256 FROM collab_doc_baselines WHERE room_id = ?1 AND file_id = ?2",
    )
    .bind(room_id)
    .bind(file_id)
    .fetch_optional(executor)
    .await
    .map_err(query_error)
}

pub async fn set_baseline<'e, E: Executor<'e, Database = Sqlite>>(
    executor: E,
    room_id: i64,
    file_id: &str,
    disk_sha256: &str,
    at: i64,
) -> Result<(), DbError> {
    sqlx::query(
        "INSERT INTO collab_doc_baselines (room_id, file_id, disk_sha256, updated_at) VALUES (?1, ?2, ?3, ?4) \
         ON CONFLICT(room_id, file_id) DO UPDATE SET disk_sha256 = excluded.disk_sha256, updated_at = excluded.updated_at",
    )
    .bind(room_id)
    .bind(file_id)
    .bind(disk_sha256)
    .bind(at)
    .execute(executor)
    .await
    .map_err(query_error)?;
    Ok(())
}
