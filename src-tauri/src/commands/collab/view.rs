//! The `Collaboration` canonical domain: the rooms this machine created or joined, with their members, as every
//! window shows them. Read from the database (the truth) plus who is connected right now. It never contains a Room
//! Code, a key or a local folder path (only the folder's name).

use openmind_collab::permission::effective;
use openmind_db::collab::rooms;
use serde::Serialize;

use super::persist;
use crate::app_state::AppState;

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CollabSnapshot {
    pub rooms: Vec<RoomView>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RoomView {
    pub room_uid: String,
    pub name: String,
    /// "created" (hosted here) or "joined".
    pub relation: String,
    pub local_role: String,
    pub owner_peer: String,
    pub locked: bool,
    pub approval_required: bool,
    pub default_role: String,
    pub closed: bool,
    pub archived: bool,
    pub workspace_name: Option<String>,
    pub invite_generation: i64,
    pub created_at: i64,
    pub last_joined_at: Option<i64>,
    pub last_seen_at: Option<i64>,
    pub members: Vec<MemberView>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MemberView {
    pub peer: String,
    pub fingerprint: String,
    pub display_name: String,
    pub role: String,
    pub status: String,
    pub force_muted: bool,
    /// What the member may do now (role defaults with their overrides applied).
    pub permissions: Vec<&'static str>,
    pub granted: Vec<&'static str>,
    pub denied: Vec<&'static str>,
    pub online: bool,
    pub last_seen_at: i64,
}

/// The domain's current value.
pub async fn snapshot(state: &AppState) -> Result<CollabSnapshot, String> {
    let rows = rooms::list(state.db.pool(), true)
        .await
        .map_err(|err| err.to_string())?;
    let online = state.collab.online().await;
    let mut out = Vec::with_capacity(rows.len());
    for row in rows {
        let connected = online.get(&row.room_uid);
        let members = persist::load_members(&state.db, row.id)
            .await?
            .into_iter()
            .map(|m| MemberView {
                fingerprint: m.peer.fingerprint(),
                online: connected.is_some_and(|peers| peers.iter().any(|p| p == m.peer.as_str())),
                peer: m.peer.to_string(),
                display_name: m.display_name.clone(),
                role: m.role.as_str().into(),
                status: m.status.as_str().into(),
                force_muted: m.force_muted,
                permissions: effective(m.role, &m.overrides).names(),
                granted: m.overrides.grant.names(),
                denied: m.overrides.deny.names(),
                last_seen_at: m.last_seen_ms,
            })
            .collect();
        out.push(RoomView {
            room_uid: row.room_uid,
            name: row.name,
            relation: row.relation,
            local_role: row.local_role,
            owner_peer: row.owner_peer,
            locked: row.locked,
            approval_required: row.approval_required,
            default_role: row.default_role,
            closed: row.closed,
            archived: row.archived,
            workspace_name: row.workspace_name,
            invite_generation: row.invite_generation,
            created_at: row.created_at,
            last_joined_at: row.last_joined_at,
            last_seen_at: row.last_seen_at,
            members,
        });
    }
    Ok(CollabSnapshot { rooms: out })
}
