//! `collab_members` and `collab_permissions`: who is in a room and their per-member overrides.

use serde::Serialize;
use sqlx::{Executor, Sqlite};

use super::query_error;
use crate::DbError;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, sqlx::FromRow)]
#[serde(rename_all = "camelCase")]
pub struct MemberRow {
    pub room_id: i64,
    pub peer: String,
    pub public_key: String,
    pub display_name: String,
    pub role: String,
    pub status: String,
    pub force_muted: bool,
    pub first_seen_at: i64,
    pub last_seen_at: i64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, sqlx::FromRow)]
#[serde(rename_all = "camelCase")]
pub struct PermissionRow {
    pub room_id: i64,
    pub peer: String,
    /// JSON array of permission names.
    pub grant_list: String,
    pub deny_list: String,
    pub updated_at: i64,
}

/// Inserts or replaces a member (keeps `first_seen_at` of an existing row).
pub async fn upsert<'e, E: Executor<'e, Database = Sqlite>>(
    executor: E,
    m: &MemberRow,
) -> Result<(), DbError> {
    sqlx::query(
        "INSERT INTO collab_members (room_id, peer, public_key, display_name, role, status, force_muted, \
         first_seen_at, last_seen_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9) \
         ON CONFLICT(room_id, peer) DO UPDATE SET public_key = excluded.public_key, \
         display_name = excluded.display_name, role = excluded.role, status = excluded.status, \
         force_muted = excluded.force_muted, last_seen_at = excluded.last_seen_at",
    )
    .bind(m.room_id)
    .bind(&m.peer)
    .bind(&m.public_key)
    .bind(&m.display_name)
    .bind(&m.role)
    .bind(&m.status)
    .bind(m.force_muted)
    .bind(m.first_seen_at)
    .bind(m.last_seen_at)
    .execute(executor)
    .await
    .map_err(query_error)?;
    Ok(())
}

pub async fn list<'e, E: Executor<'e, Database = Sqlite>>(
    executor: E,
    room_id: i64,
) -> Result<Vec<MemberRow>, DbError> {
    sqlx::query_as::<_, MemberRow>(
        "SELECT room_id, peer, public_key, display_name, role, status, force_muted, first_seen_at, last_seen_at \
         FROM collab_members WHERE room_id = ?1 ORDER BY first_seen_at, peer",
    )
    .bind(room_id)
    .fetch_all(executor)
    .await
    .map_err(query_error)
}

/// Stores a member's overrides; empty lists remove the row.
pub async fn set_permissions<'e, E: Executor<'e, Database = Sqlite>>(
    executor: E,
    room_id: i64,
    peer: &str,
    grant_list: &str,
    deny_list: &str,
    at: i64,
) -> Result<(), DbError> {
    let empty = grant_list == "[]" && deny_list == "[]";
    let query = if empty {
        sqlx::query("DELETE FROM collab_permissions WHERE room_id = ?1 AND peer = ?2")
            .bind(room_id)
            .bind(peer)
    } else {
        sqlx::query(
            "INSERT INTO collab_permissions (room_id, peer, grant_list, deny_list, updated_at) \
             VALUES (?1, ?2, ?3, ?4, ?5) ON CONFLICT(room_id, peer) DO UPDATE SET \
             grant_list = excluded.grant_list, deny_list = excluded.deny_list, updated_at = excluded.updated_at",
        )
        .bind(room_id)
        .bind(peer)
        .bind(grant_list)
        .bind(deny_list)
        .bind(at)
    };
    query.execute(executor).await.map_err(query_error)?;
    Ok(())
}

pub async fn list_permissions<'e, E: Executor<'e, Database = Sqlite>>(
    executor: E,
    room_id: i64,
) -> Result<Vec<PermissionRow>, DbError> {
    sqlx::query_as::<_, PermissionRow>(
        "SELECT room_id, peer, grant_list, deny_list, updated_at FROM collab_permissions WHERE room_id = ?1",
    )
    .bind(room_id)
    .fetch_all(executor)
    .await
    .map_err(query_error)
}
