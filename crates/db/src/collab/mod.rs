//! Collaboration rooms (Milestone 24), in this machine's own database. Every function takes any sqlx executor —
//! the pool for a single statement, or `&mut *transaction` — so the app can save one authority outcome (events,
//! members, room settings and the chain's end) atomically. Rows use plain strings: this crate doesn't depend on
//! `openmind-collab`; the app converts and validates on the way in and out.
//!
//! Snapshot compaction (thresholds, pruning replayed updates) is deliberately not here yet: it belongs to the
//! recovery phase, once real CRDT traffic exists.

pub mod crdt;
pub mod files;
pub mod logs;
pub mod members;
pub mod outbox;
pub mod rooms;
pub mod sessions;

pub use crdt::{CrdtUpdateRow, DocumentSnapshotRow};
pub use files::CollabFileRow;
pub use logs::ActionLogRow;
pub use members::{MemberRow, PermissionRow};
pub use outbox::OutboxRow;
pub use rooms::{NewRoom, RoomRow, RoomSettings};
pub use sessions::SessionRow;

pub(crate) fn query_error(err: sqlx::Error) -> crate::DbError {
    crate::DbError::Query(err)
}

/// A connection the repositories accept (`&mut *tx` of a [`Tx`]).
pub type Connection = sqlx::SqliteConnection;
/// A transaction over the machine database; dropped without [`commit`] it rolls back.
pub type Tx<'a> = sqlx::Transaction<'a, sqlx::Sqlite>;

pub async fn begin(db: &crate::Db) -> Result<Tx<'static>, crate::DbError> {
    db.pool().begin().await.map_err(query_error)
}

pub async fn commit(tx: Tx<'_>) -> Result<(), crate::DbError> {
    tx.commit().await.map_err(query_error)
}

#[cfg(test)]
#[path = "tests.rs"]
mod tests;
