//! `collab_action_logs`: the human-readable, hash-chained room history. `UNIQUE (room_id, seq)` means a second
//! writer can't fork the chain: inserting an already used sequence number fails.

use serde::Serialize;
use sqlx::{Executor, Sqlite};

use super::query_error;
use crate::DbError;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, sqlx::FromRow)]
#[serde(rename_all = "camelCase")]
pub struct ActionLogRow {
    pub room_id: i64,
    pub seq: i64,
    pub event_id: String,
    pub session_id: Option<String>,
    pub actor_peer: String,
    pub actor_name: String,
    pub actor_role: String,
    pub kind: String,
    pub file_id: Option<String>,
    pub rel_path: Option<String>,
    /// JSON object of string values.
    pub metadata: String,
    pub at_ms: i64,
    pub prev_hash: String,
    pub hash: String,
    pub signature: Option<String>,
}

pub async fn append<'e, E: Executor<'e, Database = Sqlite>>(
    executor: E,
    e: &ActionLogRow,
) -> Result<(), DbError> {
    sqlx::query(
        "INSERT INTO collab_action_logs (room_id, seq, event_id, session_id, actor_peer, actor_name, actor_role, kind, \
         file_id, rel_path, metadata, at_ms, prev_hash, hash, signature) \
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15)",
    )
    .bind(e.room_id)
    .bind(e.seq)
    .bind(&e.event_id)
    .bind(&e.session_id)
    .bind(&e.actor_peer)
    .bind(&e.actor_name)
    .bind(&e.actor_role)
    .bind(&e.kind)
    .bind(&e.file_id)
    .bind(&e.rel_path)
    .bind(&e.metadata)
    .bind(e.at_ms)
    .bind(&e.prev_hash)
    .bind(&e.hash)
    .bind(&e.signature)
    .execute(executor)
    .await
    .map_err(query_error)?;
    Ok(())
}

/// Events after `after_seq`, oldest first, at most `limit`.
pub async fn list_after<'e, E: Executor<'e, Database = Sqlite>>(
    executor: E,
    room_id: i64,
    after_seq: i64,
    limit: i64,
) -> Result<Vec<ActionLogRow>, DbError> {
    sqlx::query_as::<_, ActionLogRow>(
        "SELECT room_id, seq, event_id, session_id, actor_peer, actor_name, actor_role, kind, file_id, rel_path, \
         metadata, at_ms, prev_hash, hash, signature FROM collab_action_logs \
         WHERE room_id = ?1 AND seq > ?2 ORDER BY seq LIMIT ?3",
    )
    .bind(room_id)
    .bind(after_seq)
    .bind(limit)
    .fetch_all(executor)
    .await
    .map_err(query_error)
}

/// The newest event's sequence number and hash.
pub async fn last<'e, E: Executor<'e, Database = Sqlite>>(
    executor: E,
    room_id: i64,
) -> Result<Option<(i64, String)>, DbError> {
    sqlx::query_as::<_, (i64, String)>(
        "SELECT seq, hash FROM collab_action_logs WHERE room_id = ?1 ORDER BY seq DESC LIMIT 1",
    )
    .bind(room_id)
    .fetch_optional(executor)
    .await
    .map_err(query_error)
}
