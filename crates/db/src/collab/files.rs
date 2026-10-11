//! `collab_files`: the Owner's stable file id <-> relative path map.

use serde::Serialize;
use sqlx::{Executor, Sqlite};

use super::query_error;
use crate::DbError;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, sqlx::FromRow)]
#[serde(rename_all = "camelCase")]
pub struct CollabFileRow {
    pub file_id: String,
    pub rel_path: String,
    pub kind: String,
}

/// Inserts or moves an entry (`path_key` is the case-folded path the table is unique on).
pub async fn upsert<'e, E: Executor<'e, Database = Sqlite>>(
    executor: E,
    room_id: i64,
    file: &CollabFileRow,
    path_key: &str,
) -> Result<(), DbError> {
    sqlx::query(
        "INSERT INTO collab_files (room_id, file_id, rel_path, path_key, kind) VALUES (?1, ?2, ?3, ?4, ?5) \
         ON CONFLICT(room_id, file_id) DO UPDATE SET rel_path = excluded.rel_path, path_key = excluded.path_key",
    )
    .bind(room_id)
    .bind(&file.file_id)
    .bind(&file.rel_path)
    .bind(path_key)
    .bind(&file.kind)
    .execute(executor)
    .await
    .map_err(query_error)?;
    Ok(())
}

pub async fn delete<'e, E: Executor<'e, Database = Sqlite>>(
    executor: E,
    room_id: i64,
    file_id: &str,
) -> Result<(), DbError> {
    sqlx::query("DELETE FROM collab_files WHERE room_id = ?1 AND file_id = ?2")
        .bind(room_id)
        .bind(file_id)
        .execute(executor)
        .await
        .map_err(query_error)?;
    Ok(())
}

pub async fn list<'e, E: Executor<'e, Database = Sqlite>>(
    executor: E,
    room_id: i64,
) -> Result<Vec<CollabFileRow>, DbError> {
    sqlx::query_as::<_, CollabFileRow>(
        "SELECT file_id, rel_path, kind FROM collab_files WHERE room_id = ?1 ORDER BY rel_path",
    )
    .bind(room_id)
    .fetch_all(executor)
    .await
    .map_err(query_error)
}
