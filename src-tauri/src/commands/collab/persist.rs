//! Between the authority and the machine database: one authority [`Outcome`] is saved in one transaction (events,
//! chain end, room settings, rotated invite, changed members, sessions), and a hosted room is rebuilt from its rows.
//! Every value read back is validated by its `openmind_collab` type — a damaged row stops the load with a reason
//! instead of granting anything.

use std::collections::{BTreeMap, BTreeSet, HashMap};

use openmind_collab::audit::{AuditEvent, ChainHead, EventKind};
use openmind_collab::{
    Authority, FileId, Member, MemberStatus, Outcome, Overrides, PeerId, PeerIdentity,
    PermissionSet, PublicKey, RelPath, Role, RoomCode, RoomState, RoomUid, SessionId, Signature,
};
use openmind_db::collab::{
    logs, members, rooms, sessions, ActionLogRow, Connection, MemberRow, RoomRow, RoomSettings,
    SessionRow,
};
use openmind_db::Db;

use crate::secret;

fn db_err(err: openmind_db::DbError) -> String {
    format!("The collaboration history couldn't be saved or read: {err}")
}

fn to_i64(value: u64) -> i64 {
    i64::try_from(value).unwrap_or(i64::MAX)
}

pub fn member_row(room_id: i64, m: &Member) -> MemberRow {
    MemberRow {
        room_id,
        peer: m.peer.to_string(),
        public_key: m.public_key.to_text(),
        display_name: m.display_name.clone(),
        role: m.role.as_str().into(),
        status: m.status.as_str().into(),
        force_muted: m.force_muted,
        first_seen_at: m.first_seen_ms,
        last_seen_at: m.last_seen_ms,
    }
}

fn names(set: PermissionSet) -> String {
    serde_json::to_string(&set.names()).unwrap_or_else(|_| "[]".into())
}

pub fn log_row(room_id: i64, e: &AuditEvent) -> ActionLogRow {
    ActionLogRow {
        room_id,
        seq: to_i64(e.seq),
        event_id: e.event_id.to_string(),
        session_id: e.session.as_ref().map(ToString::to_string),
        actor_peer: e.actor.to_string(),
        actor_name: e.actor_name.clone(),
        actor_role: e.actor_role.as_str().into(),
        kind: e.kind.as_str().into(),
        file_id: e.file.as_ref().map(ToString::to_string),
        rel_path: e.path.as_ref().map(ToString::to_string),
        metadata: serde_json::to_string(&e.metadata).unwrap_or_else(|_| "{}".into()),
        at_ms: e.at_ms,
        prev_hash: e.prev_hash.clone(),
        hash: e.hash.clone(),
        signature: e.signature.as_ref().map(Signature::to_text),
    }
}

/// Reads a stored event of `room` back (for verification and history).
pub fn event_of(row: &ActionLogRow, room: &RoomUid) -> Result<AuditEvent, String> {
    let bad = |what: &str| format!("Stored event {} has an invalid {what}.", row.seq);
    Ok(AuditEvent {
        event_id: openmind_collab::MessageId::parse(&row.event_id).map_err(|_| bad("id"))?,
        room: room.clone(),
        seq: u64::try_from(row.seq).map_err(|_| bad("sequence"))?,
        at_ms: row.at_ms,
        session: row
            .session_id
            .as_deref()
            .map(SessionId::parse)
            .transpose()
            .map_err(|_| bad("session"))?,
        actor: PeerId::parse(&row.actor_peer).map_err(|_| bad("actor"))?,
        actor_name: row.actor_name.clone(),
        actor_role: Role::parse(&row.actor_role).map_err(|_| bad("role"))?,
        kind: EventKind::parse(&row.kind).map_err(|_| bad("kind"))?,
        file: row
            .file_id
            .as_deref()
            .map(FileId::parse)
            .transpose()
            .map_err(|_| bad("file"))?,
        path: row
            .rel_path
            .as_deref()
            .map(RelPath::parse)
            .transpose()
            .map_err(|_| bad("path"))?,
        metadata: serde_json::from_str::<BTreeMap<String, String>>(&row.metadata)
            .map_err(|_| bad("metadata"))?,
        prev_hash: row.prev_hash.clone(),
        hash: row.hash.clone(),
        signature: row
            .signature
            .as_deref()
            .map(Signature::parse)
            .transpose()
            .map_err(|_| bad("signature"))?,
    })
}

async fn save_settings(
    conn: &mut Connection,
    room_id: i64,
    authority: &Authority,
) -> Result<(), String> {
    let room = authority.room();
    let local_role = room
        .member(&authority.host_identity().peer_id())
        .map_or(Role::Viewer, |m| m.role);
    let owner_key = room
        .member(&room.owner)
        .map(|m| m.public_key.to_text())
        .unwrap_or_default();
    let settings = RoomSettings {
        name: &room.name,
        local_role: local_role.as_str(),
        owner_peer: room.owner.as_str(),
        owner_public_key: &owner_key,
        locked: room.locked,
        approval_required: room.approval_required,
        default_role: room.default_role.as_str(),
        closed: room.closed,
    };
    rooms::update_settings(conn, room_id, &settings)
        .await
        .map_err(db_err)
}

fn end_reason(outcome: &Outcome) -> &'static str {
    outcome
        .events
        .iter()
        .rev()
        .map(|e| e.kind)
        .find(|k| {
            matches!(
                k,
                EventKind::MemberKicked
                    | EventKind::MemberRemoved
                    | EventKind::MemberBanned
                    | EventKind::RoomClosed
                    | EventKind::SessionEnded
            )
        })
        .map_or("superseded by a new connection", EventKind::as_str)
}

/// Saves everything `outcome` changed for the room stored as `room_id` (inside the caller's transaction).
pub async fn save_outcome(
    conn: &mut Connection,
    room_id: i64,
    authority: &Authority,
    outcome: &Outcome,
    now: i64,
) -> Result<(), String> {
    for event in &outcome.events {
        logs::append(&mut *conn, &log_row(room_id, event))
            .await
            .map_err(db_err)?;
    }
    let head = authority.chain_head();
    rooms::set_chain_head(&mut *conn, room_id, to_i64(head.next_seq), &head.last_hash)
        .await
        .map_err(db_err)?;
    if outcome.room_changed {
        save_settings(&mut *conn, room_id, authority).await?;
    }
    if let Some(code) = &outcome.new_invite {
        let protected = secret::protect(&code.display()).map_err(|err| err.to_string())?;
        let generation = i64::from(authority.room().invite_generation);
        rooms::set_invite(
            &mut *conn,
            room_id,
            &code.invite_hash(),
            &protected,
            generation,
        )
        .await
        .map_err(db_err)?;
    }
    let mut saved = BTreeSet::new();
    for peer in &outcome.changed_members {
        let Some(member) = authority
            .room()
            .member(peer)
            .filter(|_| saved.insert(peer.clone()))
        else {
            continue;
        };
        members::upsert(&mut *conn, &member_row(room_id, member))
            .await
            .map_err(db_err)?;
        let (grant, deny) = (names(member.overrides.grant), names(member.overrides.deny));
        members::set_permissions(&mut *conn, room_id, peer.as_str(), &grant, &deny, now)
            .await
            .map_err(db_err)?;
    }
    for (peer, session, role) in &outcome.started_sessions {
        let row = SessionRow {
            session_id: session.to_string(),
            room_id,
            peer: peer.to_string(),
            role: role.as_str().into(),
            epoch: 0,
            started_at: now,
            connected_at: Some(now),
            ended_at: None,
            end_reason: None,
            last_event_seq: to_i64(head.next_seq.saturating_sub(1)),
            manifest_version: 0,
        };
        sessions::insert(&mut *conn, &row).await.map_err(db_err)?;
    }
    for (_, session) in &outcome.ended_sessions {
        sessions::end(&mut *conn, session.as_str(), now, end_reason(outcome))
            .await
            .map_err(db_err)?;
    }
    Ok(())
}

fn member_of(row: &MemberRow, overrides: Overrides) -> Result<Member, String> {
    let bad = |what: &str| format!("A stored member of this room has an invalid {what}.");
    Ok(Member {
        peer: PeerId::parse(&row.peer).map_err(|_| bad("id"))?,
        public_key: PublicKey::parse(&row.public_key).map_err(|_| bad("key"))?,
        display_name: row.display_name.clone(),
        role: Role::parse(&row.role).map_err(|_| bad("role"))?,
        overrides,
        status: MemberStatus::parse(&row.status).map_err(|_| bad("status"))?,
        force_muted: row.force_muted,
        first_seen_ms: row.first_seen_at,
        last_seen_ms: row.last_seen_at,
    })
}

/// The stored members of a room with their overrides.
pub async fn load_members(db: &Db, room_id: i64) -> Result<Vec<Member>, String> {
    let rows = members::list(db.pool(), room_id).await.map_err(db_err)?;
    let permissions = members::list_permissions(db.pool(), room_id)
        .await
        .map_err(db_err)?;
    members_from(&rows, &permissions)
}

/// The members from their stored rows and permission overrides.
fn members_from(
    rows: &[MemberRow],
    permissions: &[openmind_db::collab::PermissionRow],
) -> Result<Vec<Member>, String> {
    let mut overrides: HashMap<String, Overrides> = HashMap::new();
    for p in permissions {
        let parse = |text: &str| {
            serde_json::from_str::<PermissionSet>(text)
                .map_err(|_| "A stored permission override is invalid.".to_string())
        };
        overrides.insert(
            p.peer.clone(),
            Overrides {
                grant: parse(&p.grant_list)?,
                deny: parse(&p.deny_list)?,
            },
        );
    }
    rows.iter()
        .map(|row| member_of(row, overrides.get(&row.peer).copied().unwrap_or_default()))
        .collect()
}

/// Rebuilds the authority of a room this machine hosts. Sessions never survive a restart: open ones are closed.
pub async fn load_hosted(
    db: &Db,
    row: &RoomRow,
    host: PeerIdentity,
    now: i64,
) -> Result<Authority, String> {
    // The room row, its members and the log's last entry from one snapshot (openmind_db::collab::snapshot). The `row` a
    // caller passes may be older than an event another writer recorded since (a restart whose old tasks are still
    // finishing, a second app instance on this computer): checked against the log it refused a consistent database as
    // "changed outside OpenMind", and restored from it the chain would have continued from an older end.
    let snapshot = openmind_db::collab::snapshot::hosted_room(db.pool(), &row.room_uid)
        .await
        .map_err(db_err)?
        .ok_or("This room isn't stored on this computer.")?;
    let row = &snapshot.room;
    let members = members_from(&snapshot.members, &snapshot.permissions)?;
    let protected = row
        .invite_secret
        .as_deref()
        .ok_or("This room has no stored Room Code.")?;
    let code = secret::unprotect(protected).map_err(|err| err.to_string())?;
    let invite = RoomCode::parse(&code).map_err(|err| err.to_string())?;
    let room = RoomState {
        room_uid: RoomUid::parse(&row.room_uid).map_err(|err| err.to_string())?,
        name: row.name.clone(),
        owner: PeerId::parse(&row.owner_peer).map_err(|err| err.to_string())?,
        locked: row.locked,
        approval_required: row.approval_required,
        default_role: Role::parse(&row.default_role).map_err(|err| err.to_string())?,
        closed: row.closed,
        invite_generation: u32::try_from(row.invite_generation).unwrap_or(u32::MAX),
        invite_hash: row.invite_hash.clone().unwrap_or_default(),
        members: members.into_iter().map(|m| (m.peer.clone(), m)).collect(),
    };
    let head = ChainHead {
        next_seq: u64::try_from(row.chain_next_seq).unwrap_or(1),
        last_hash: row.chain_last_hash.clone(),
    };
    let consistent = match &snapshot.last_log {
        Some((seq, hash)) => seq + 1 == row.chain_next_seq && *hash == row.chain_last_hash,
        None => head == ChainHead::genesis(),
    };
    if !consistent {
        return Err("This room's stored history doesn't match its chain end; it was changed outside OpenMind.".into());
    }
    let authority = Authority::restore(host, room, invite, head).map_err(|err| err.to_string())?;
    sessions::end_dangling(db.pool(), row.id, now, "app restarted")
        .await
        .map_err(db_err)?;
    Ok(authority)
}
