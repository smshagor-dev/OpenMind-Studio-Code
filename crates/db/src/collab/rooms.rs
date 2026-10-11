//! `collab_rooms`: rooms this machine created or joined.

use serde::Serialize;
use sqlx::{Executor, Sqlite};

use super::query_error;
use crate::DbError;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, sqlx::FromRow)]
#[serde(rename_all = "camelCase")]
pub struct RoomRow {
    pub id: i64,
    pub room_uid: String,
    pub relation: String,
    pub name: String,
    pub local_role: String,
    pub owner_peer: String,
    pub owner_public_key: String,
    pub invite_hash: Option<String>,
    #[serde(skip)]
    pub invite_secret: Option<String>,
    pub invite_generation: i64,
    pub locked: bool,
    pub approval_required: bool,
    pub default_role: String,
    pub closed: bool,
    #[serde(skip)]
    pub workspace_path: Option<String>,
    pub workspace_name: Option<String>,
    pub chain_next_seq: i64,
    pub chain_last_hash: String,
    pub created_at: i64,
    pub first_joined_at: Option<i64>,
    pub last_joined_at: Option<i64>,
    pub last_seen_at: Option<i64>,
    pub archived: bool,
}

/// What a new room row starts with.
#[derive(Debug, Clone)]
pub struct NewRoom<'a> {
    pub room_uid: &'a str,
    pub relation: &'a str,
    pub name: &'a str,
    pub local_role: &'a str,
    pub owner_peer: &'a str,
    pub owner_public_key: &'a str,
    pub workspace_path: Option<&'a str>,
    pub workspace_name: Option<&'a str>,
    pub created_at: i64,
}

/// The room's settings as the authority last decided them.
#[derive(Debug, Clone)]
pub struct RoomSettings<'a> {
    pub name: &'a str,
    pub local_role: &'a str,
    pub owner_peer: &'a str,
    pub owner_public_key: &'a str,
    pub locked: bool,
    pub approval_required: bool,
    pub default_role: &'a str,
    pub closed: bool,
}

const COLUMNS: &str = "id, room_uid, relation, name, local_role, owner_peer, owner_public_key, invite_hash, \
    invite_secret, invite_generation, locked, approval_required, default_role, closed, workspace_path, workspace_name, \
    chain_next_seq, chain_last_hash, created_at, first_joined_at, last_joined_at, last_seen_at, archived";

/// Adds a room; returns its row id.
pub async fn insert<'e, E: Executor<'e, Database = Sqlite>>(
    executor: E,
    room: &NewRoom<'_>,
) -> Result<i64, DbError> {
    let result = sqlx::query(
        "INSERT INTO collab_rooms (room_uid, relation, name, local_role, owner_peer, owner_public_key, \
         workspace_path, workspace_name, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
    )
    .bind(room.room_uid)
    .bind(room.relation)
    .bind(room.name)
    .bind(room.local_role)
    .bind(room.owner_peer)
    .bind(room.owner_public_key)
    .bind(room.workspace_path)
    .bind(room.workspace_name)
    .bind(room.created_at)
    .execute(executor)
    .await
    .map_err(query_error)?;
    Ok(result.last_insert_rowid())
}

pub async fn get_by_uid<'e, E: Executor<'e, Database = Sqlite>>(
    executor: E,
    room_uid: &str,
) -> Result<Option<RoomRow>, DbError> {
    sqlx::query_as::<_, RoomRow>(&format!(
        "SELECT {COLUMNS} FROM collab_rooms WHERE room_uid = ?1"
    ))
    .bind(room_uid)
    .fetch_optional(executor)
    .await
    .map_err(query_error)
}

/// Rooms, most recently used first (archived ones only when asked).
pub async fn list<'e, E: Executor<'e, Database = Sqlite>>(
    executor: E,
    include_archived: bool,
) -> Result<Vec<RoomRow>, DbError> {
    sqlx::query_as::<_, RoomRow>(&format!(
        "SELECT {COLUMNS} FROM collab_rooms WHERE archived = 0 OR ?1 \
         ORDER BY COALESCE(last_joined_at, created_at) DESC, id DESC"
    ))
    .bind(include_archived)
    .fetch_all(executor)
    .await
    .map_err(query_error)
}

pub async fn update_settings<'e, E: Executor<'e, Database = Sqlite>>(
    executor: E,
    id: i64,
    s: &RoomSettings<'_>,
) -> Result<(), DbError> {
    sqlx::query(
        "UPDATE collab_rooms SET name = ?2, local_role = ?3, owner_peer = ?4, owner_public_key = ?5, locked = ?6, \
         approval_required = ?7, default_role = ?8, closed = ?9 WHERE id = ?1",
    )
    .bind(id)
    .bind(s.name)
    .bind(s.local_role)
    .bind(s.owner_peer)
    .bind(s.owner_public_key)
    .bind(s.locked)
    .bind(s.approval_required)
    .bind(s.default_role)
    .bind(s.closed)
    .execute(executor)
    .await
    .map_err(query_error)?;
    Ok(())
}

/// Stores the Owner's current invite: its hash, the protected code and the generation.
pub async fn set_invite<'e, E: Executor<'e, Database = Sqlite>>(
    executor: E,
    id: i64,
    hash: &str,
    protected_code: &str,
    generation: i64,
) -> Result<(), DbError> {
    sqlx::query("UPDATE collab_rooms SET invite_hash = ?2, invite_secret = ?3, invite_generation = ?4 WHERE id = ?1")
        .bind(id)
        .bind(hash)
        .bind(protected_code)
        .bind(generation)
        .execute(executor)
        .await
        .map_err(query_error)?;
    Ok(())
}

pub async fn set_chain_head<'e, E: Executor<'e, Database = Sqlite>>(
    executor: E,
    id: i64,
    next_seq: i64,
    last_hash: &str,
) -> Result<(), DbError> {
    sqlx::query("UPDATE collab_rooms SET chain_next_seq = ?2, chain_last_hash = ?3 WHERE id = ?1")
        .bind(id)
        .bind(next_seq)
        .bind(last_hash)
        .execute(executor)
        .await
        .map_err(query_error)?;
    Ok(())
}

/// Records a join/host session start (first time sets `first_joined_at` too).
pub async fn touch_joined<'e, E: Executor<'e, Database = Sqlite>>(
    executor: E,
    id: i64,
    at: i64,
) -> Result<(), DbError> {
    sqlx::query(
        "UPDATE collab_rooms SET first_joined_at = COALESCE(first_joined_at, ?2), last_joined_at = ?2, \
         last_seen_at = ?2 WHERE id = ?1",
    )
    .bind(id)
    .bind(at)
    .execute(executor)
    .await
    .map_err(query_error)?;
    Ok(())
}

pub async fn touch_seen<'e, E: Executor<'e, Database = Sqlite>>(
    executor: E,
    id: i64,
    at: i64,
) -> Result<(), DbError> {
    sqlx::query("UPDATE collab_rooms SET last_seen_at = ?2 WHERE id = ?1")
        .bind(id)
        .bind(at)
        .execute(executor)
        .await
        .map_err(query_error)?;
    Ok(())
}

pub async fn set_archived<'e, E: Executor<'e, Database = Sqlite>>(
    executor: E,
    id: i64,
    archived: bool,
) -> Result<(), DbError> {
    sqlx::query("UPDATE collab_rooms SET archived = ?2 WHERE id = ?1")
        .bind(id)
        .bind(archived)
        .execute(executor)
        .await
        .map_err(query_error)?;
    Ok(())
}
