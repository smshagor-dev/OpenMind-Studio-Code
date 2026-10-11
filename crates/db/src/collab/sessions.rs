//! `collab_sessions`: authenticated connections, kept as history.

use serde::Serialize;
use sqlx::{Executor, Sqlite};

use super::query_error;
use crate::DbError;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, sqlx::FromRow)]
#[serde(rename_all = "camelCase")]
pub struct SessionRow {
    pub session_id: String,
    pub room_id: i64,
    pub peer: String,
    pub role: String,
    pub epoch: i64,
    pub started_at: i64,
    pub connected_at: Option<i64>,
    pub ended_at: Option<i64>,
    pub end_reason: Option<String>,
    pub last_event_seq: i64,
    pub manifest_version: i64,
}

pub async fn insert<'e, E: Executor<'e, Database = Sqlite>>(
    executor: E,
    s: &SessionRow,
) -> Result<(), DbError> {
    sqlx::query(
        "INSERT INTO collab_sessions (session_id, room_id, peer, role, epoch, started_at, connected_at, ended_at, \
         end_reason, last_event_seq, manifest_version) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)",
    )
    .bind(&s.session_id)
    .bind(s.room_id)
    .bind(&s.peer)
    .bind(&s.role)
    .bind(s.epoch)
    .bind(s.started_at)
    .bind(s.connected_at)
    .bind(s.ended_at)
    .bind(&s.end_reason)
    .bind(s.last_event_seq)
    .bind(s.manifest_version)
    .execute(executor)
    .await
    .map_err(query_error)?;
    Ok(())
}

/// Ends a session (only once: an ended session keeps its first end).
pub async fn end<'e, E: Executor<'e, Database = Sqlite>>(
    executor: E,
    session_id: &str,
    at: i64,
    reason: &str,
) -> Result<(), DbError> {
    sqlx::query("UPDATE collab_sessions SET ended_at = ?2, end_reason = ?3 WHERE session_id = ?1 AND ended_at IS NULL")
        .bind(session_id)
        .bind(at)
        .bind(reason)
        .execute(executor)
        .await
        .map_err(query_error)?;
    Ok(())
}

/// Ends every session of a room still marked open (none survives an app restart). Returns how many.
pub async fn end_dangling<'e, E: Executor<'e, Database = Sqlite>>(
    executor: E,
    room_id: i64,
    at: i64,
    reason: &str,
) -> Result<u64, DbError> {
    let result = sqlx::query(
        "UPDATE collab_sessions SET ended_at = ?2, end_reason = ?3 WHERE room_id = ?1 AND ended_at IS NULL",
    )
    .bind(room_id)
    .bind(at)
    .bind(reason)
    .execute(executor)
    .await
    .map_err(query_error)?;
    Ok(result.rows_affected())
}

pub async fn set_progress<'e, E: Executor<'e, Database = Sqlite>>(
    executor: E,
    session_id: &str,
    last_event_seq: i64,
    manifest_version: i64,
) -> Result<(), DbError> {
    sqlx::query("UPDATE collab_sessions SET last_event_seq = ?2, manifest_version = ?3 WHERE session_id = ?1")
        .bind(session_id)
        .bind(last_event_seq)
        .bind(manifest_version)
        .execute(executor)
        .await
        .map_err(query_error)?;
    Ok(())
}

/// A room's sessions, newest first.
pub async fn list<'e, E: Executor<'e, Database = Sqlite>>(
    executor: E,
    room_id: i64,
    limit: i64,
) -> Result<Vec<SessionRow>, DbError> {
    sqlx::query_as::<_, SessionRow>(
        "SELECT session_id, room_id, peer, role, epoch, started_at, connected_at, ended_at, end_reason, \
         last_event_seq, manifest_version FROM collab_sessions WHERE room_id = ?1 \
         ORDER BY started_at DESC, rowid DESC LIMIT ?2",
    )
    .bind(room_id)
    .bind(limit)
    .fetch_all(executor)
    .await
    .map_err(query_error)
}
