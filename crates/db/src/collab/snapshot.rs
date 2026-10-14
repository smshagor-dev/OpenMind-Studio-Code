//! What hosting a room needs, read from one snapshot of the database.

use sqlx::SqlitePool;

use super::members::{self, MemberRow, PermissionRow};
use super::{logs, query_error, rooms};
use crate::DbError;

/// A hosted room as stored: its row (settings and chain end), its members, their permission overrides and the last
/// entry of its action log (`(seq, hash)`), all from the same moment.
#[derive(Debug, Clone)]
pub struct HostedRoomSnapshot {
    pub room: rooms::RoomRow,
    pub members: Vec<MemberRow>,
    pub permissions: Vec<PermissionRow>,
    pub last_log: Option<(i64, String)>,
}

/// Reads [`HostedRoomSnapshot`] in one transaction. Every save writes a room's events and its chain end in one
/// transaction, so the snapshot is consistent even while another writer (a restart whose old tasks are still finishing,
/// a second app instance on this computer) records events: separate reads could see the chain end from before such a
/// write and the log from after it. `None` when the room isn't stored.
pub async fn hosted_room(
    pool: &SqlitePool,
    room_uid: &str,
) -> Result<Option<HostedRoomSnapshot>, DbError> {
    let mut tx = pool.begin().await.map_err(query_error)?;
    let Some(room) = rooms::get_by_uid(&mut *tx, room_uid).await? else {
        tx.rollback().await.map_err(query_error)?;
        return Ok(None);
    };
    let members = members::list(&mut *tx, room.id).await?;
    let permissions = members::list_permissions(&mut *tx, room.id).await?;
    let last_log = logs::last(&mut *tx, room.id).await?;
    tx.rollback().await.map_err(query_error)?;
    Ok(Some(HostedRoomSnapshot {
        room,
        members,
        permissions,
        last_log,
    }))
}
