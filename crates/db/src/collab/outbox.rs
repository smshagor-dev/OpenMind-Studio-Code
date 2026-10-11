//! `collab_outbox`: what this machine sent and keeps until the Owner settles it. Flow: enqueue (persisted before it
//! is sent) -> attempts -> acked or rejected. After a crash the pending rows are read back and resent under their
//! original message ids, which the Owner recognises, so a resend is idempotent.

use sqlx::{Executor, Sqlite};

use super::query_error;
use crate::DbError;

#[derive(Debug, Clone, PartialEq, Eq, sqlx::FromRow)]
pub struct OutboxRow {
    pub id: i64,
    pub room_id: i64,
    pub message_id: String,
    pub channel: String,
    pub payload: Vec<u8>,
    pub state: String,
    pub attempts: i64,
    pub created_at: i64,
    pub last_attempt_at: Option<i64>,
    pub settled_at: Option<i64>,
    pub reject_reason: Option<String>,
}

/// Persists an outgoing message before it is sent. Enqueueing the same message id again changes nothing.
pub async fn enqueue<'e, E: Executor<'e, Database = Sqlite>>(
    executor: E,
    room_id: i64,
    message_id: &str,
    channel: &str,
    payload: &[u8],
    at: i64,
) -> Result<bool, DbError> {
    let result = sqlx::query(
        "INSERT INTO collab_outbox (room_id, message_id, channel, payload, created_at) VALUES (?1, ?2, ?3, ?4, ?5) \
         ON CONFLICT(message_id) DO NOTHING",
    )
    .bind(room_id)
    .bind(message_id)
    .bind(channel)
    .bind(payload)
    .bind(at)
    .execute(executor)
    .await
    .map_err(query_error)?;
    Ok(result.rows_affected() == 1)
}

/// Unsettled messages of a room, oldest first.
pub async fn pending<'e, E: Executor<'e, Database = Sqlite>>(
    executor: E,
    room_id: i64,
    limit: i64,
) -> Result<Vec<OutboxRow>, DbError> {
    sqlx::query_as::<_, OutboxRow>(
        "SELECT id, room_id, message_id, channel, payload, state, attempts, created_at, last_attempt_at, settled_at, \
         reject_reason FROM collab_outbox WHERE room_id = ?1 AND state = 'pending' ORDER BY id LIMIT ?2",
    )
    .bind(room_id)
    .bind(limit)
    .fetch_all(executor)
    .await
    .map_err(query_error)
}

pub async fn mark_attempt<'e, E: Executor<'e, Database = Sqlite>>(
    executor: E,
    message_id: &str,
    at: i64,
) -> Result<(), DbError> {
    sqlx::query(
        "UPDATE collab_outbox SET attempts = attempts + 1, last_attempt_at = ?2 WHERE message_id = ?1 AND state = 'pending'",
    )
    .bind(message_id)
    .bind(at)
    .execute(executor)
    .await
    .map_err(query_error)?;
    Ok(())
}

/// The Owner accepted (and persisted) the message. Returns whether a pending row was settled.
pub async fn ack<'e, E: Executor<'e, Database = Sqlite>>(
    executor: E,
    message_id: &str,
    at: i64,
) -> Result<bool, DbError> {
    settle(executor, message_id, "acked", None, at).await
}

/// The Owner refused the message (it is kept, with the reason, and never resent).
pub async fn reject<'e, E: Executor<'e, Database = Sqlite>>(
    executor: E,
    message_id: &str,
    reason: &str,
    at: i64,
) -> Result<bool, DbError> {
    settle(executor, message_id, "rejected", Some(reason), at).await
}

async fn settle<'e, E: Executor<'e, Database = Sqlite>>(
    executor: E,
    message_id: &str,
    state: &str,
    reason: Option<&str>,
    at: i64,
) -> Result<bool, DbError> {
    let result = sqlx::query(
        "UPDATE collab_outbox SET state = ?2, reject_reason = ?3, settled_at = ?4 \
         WHERE message_id = ?1 AND state = 'pending'",
    )
    .bind(message_id)
    .bind(state)
    .bind(reason)
    .bind(at)
    .execute(executor)
    .await
    .map_err(query_error)?;
    Ok(result.rows_affected() == 1)
}
