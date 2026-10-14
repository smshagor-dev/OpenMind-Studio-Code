//! Hosting rooms against a real machine database: creation, persisted changes, restart, admissions and tampering.

use super::*;
use openmind_collab::audit::{verify_chain, ChainHead};
use openmind_collab::{JoinOutcome, JoinRequest, Role, RoomUid};
use openmind_db::collab::{logs, members, sessions};

fn block<F: std::future::Future>(f: F) -> F::Output {
    tauri::async_runtime::block_on(f)
}

fn db(dir: &tempfile::TempDir) -> Db {
    block(Db::connect(&dir.path().join("openmind-studio.db"))).expect("connect")
}

fn new_room() -> NewHostedRoom<'static> {
    NewHostedRoom {
        name: "Physics",
        display_name: "Teacher",
        workspace_path: "C:/work/My Project",
        workspace_name: "My Project",
    }
}

#[test]
fn a_created_room_is_stored_with_its_owner_history_and_protected_code() {
    let dir = tempfile::tempdir().expect("tempdir");
    let db = db(&dir);
    let runtime = CollabRuntime::default();
    let created = block(runtime.create_room(&db, &new_room(), 100)).expect("create");
    assert!(created.code.starts_with("OM-"));
    let row = block(rooms::get_by_uid(db.pool(), &created.room_uid))
        .expect("get")
        .expect("row");
    assert_eq!(
        (
            row.relation.as_str(),
            row.local_role.as_str(),
            row.chain_next_seq
        ),
        ("created", "owner", 2)
    );
    let stored = row.invite_secret.clone().expect("secret");
    assert!(
        !stored.contains(&created.code[3..]),
        "the code is never stored in clear"
    );
    #[cfg(windows)]
    assert!(stored.starts_with("dpapi1:"));
    let people = block(members::list(db.pool(), row.id)).expect("members");
    assert_eq!(people.len(), 1);
    assert_eq!(people[0].role, "owner");
    let history = block(logs::list_after(db.pool(), row.id, 0, 10)).expect("logs");
    assert_eq!(history[0].kind, "room.created");
}

#[test]
fn changes_survive_a_restart_and_the_chain_continues() {
    let dir = tempfile::tempdir().expect("tempdir");
    let db = db(&dir);
    let runtime = CollabRuntime::default();
    let created = block(runtime.create_room(&db, &new_room(), 100)).expect("create");
    block(runtime.run_command(
        &db,
        &created.room_uid,
        Command::SetLocked { locked: true },
        110,
    ))
    .expect("lock");
    block(runtime.run_command(&db, &created.room_uid, Command::RotateInvite, 120)).expect("rotate");
    // A fresh runtime on the same database (an app restart).
    let restarted = CollabRuntime::default();
    let code = block(restarted.invite_code(&db, &created.room_uid, 130)).expect("code");
    assert_ne!(code, created.code, "the rotated code was stored");
    block(restarted.run_command(
        &db,
        &created.room_uid,
        Command::SetLocked { locked: false },
        140,
    ))
    .expect("unlock");
    let row = block(rooms::get_by_uid(db.pool(), &created.room_uid))
        .expect("get")
        .expect("row");
    assert_eq!(
        (row.locked, row.invite_generation, row.chain_next_seq),
        (false, 2, 5)
    );
    let identity = block(restarted.identity(&db)).expect("identity");
    assert_eq!(
        identity.peer_id(),
        block(runtime.identity(&db)).expect("identity").peer_id(),
        "the identity persists"
    );
    let room = RoomUid::parse(&created.room_uid).expect("uid");
    let events: Vec<_> = block(logs::list_after(db.pool(), row.id, 0, 100))
        .expect("logs")
        .iter()
        .map(|r| persist::event_of(r, &room).expect("event"))
        .collect();
    assert_eq!(events.len(), 4);
    assert!(verify_chain(&events, &ChainHead::genesis(), Some(&identity.public_key())).is_ok());
}

#[test]
fn a_command_the_rules_refuse_changes_nothing_stored() {
    let dir = tempfile::tempdir().expect("tempdir");
    let db = db(&dir);
    let runtime = CollabRuntime::default();
    let created = block(runtime.create_room(&db, &new_room(), 100)).expect("create");
    let me = block(runtime.identity(&db)).expect("identity").peer_id();
    let refused =
        block(runtime.run_command(&db, &created.room_uid, Command::Kick { target: me }, 110));
    assert!(refused.expect_err("refused").contains("yourself"));
    let row = block(rooms::get_by_uid(db.pool(), &created.room_uid))
        .expect("get")
        .expect("row");
    assert_eq!(row.chain_next_seq, 2);
    assert!(block(runtime.run_command(
        &db,
        "0123456789abcdef0123456789abcdef",
        Command::RotateInvite,
        1
    ))
    .is_err());
}

#[test]
fn admissions_and_kicks_are_recorded_as_sessions_and_members() {
    let dir = tempfile::tempdir().expect("tempdir");
    let db = db(&dir);
    let runtime = CollabRuntime::default();
    let created = block(runtime.create_room(&db, &new_room(), 100)).expect("create");
    let row = block(rooms::get_by_uid(db.pool(), &created.room_uid))
        .expect("get")
        .expect("row");
    let host = block(runtime.identity(&db)).expect("identity");
    let mut authority = block(persist::load_hosted(&db, &row, host.clone(), 100)).expect("load");
    let student = openmind_collab::PeerIdentity::generate().expect("identity");
    let challenge = Authority::new_challenge().expect("challenge");
    let request = JoinRequest::create(
        &student,
        authority.invite(),
        &authority.room().room_uid,
        &challenge,
        "Student",
    );
    let (outcome, saved) = authority.join(&request, &challenge, 200).expect("join");
    assert!(matches!(outcome, JoinOutcome::Admitted(_)));
    save(&db, row.id, &authority, &saved, 200);
    let kick = Command::Kick {
        target: student.peer_id(),
    };
    let kicked = authority
        .execute(&Actor::Host(host.peer_id()), kick, 300)
        .expect("kick");
    save(&db, row.id, &authority, &kicked, 300);
    let list = block(sessions::list(db.pool(), row.id, 10)).expect("sessions");
    assert_eq!(list.len(), 1);
    assert_eq!(
        (list[0].role.as_str(), list[0].end_reason.as_deref()),
        ("viewer", Some("member.kicked"))
    );
    let people = block(members::list(db.pool(), row.id)).expect("members");
    let student_row = people
        .iter()
        .find(|m| m.peer == student.peer_id().as_str())
        .expect("student");
    assert_eq!(
        (student_row.status.as_str(), student_row.role.as_str()),
        ("kicked", Role::Viewer.as_str())
    );
}

fn save(db: &Db, row_id: i64, authority: &Authority, outcome: &Outcome, now: i64) {
    block(async {
        let mut tx = repo::begin(db).await.expect("begin");
        persist::save_outcome(&mut tx, row_id, authority, outcome, now)
            .await
            .expect("save");
        repo::commit(tx).await.expect("commit");
    });
}

#[test]
fn history_changed_outside_the_app_is_refused_on_load() {
    let dir = tempfile::tempdir().expect("tempdir");
    let db = db(&dir);
    let runtime = CollabRuntime::default();
    let created = block(runtime.create_room(&db, &new_room(), 100)).expect("create");
    block(runtime.run_command(
        &db,
        &created.room_uid,
        Command::SetLocked { locked: true },
        110,
    ))
    .expect("lock");
    let row = block(rooms::get_by_uid(db.pool(), &created.room_uid))
        .expect("get")
        .expect("row");
    block(
        sqlx::query("DELETE FROM collab_action_logs WHERE room_id = ?1 AND seq = 2")
            .bind(row.id)
            .execute(db.pool()),
    )
    .expect("tamper");
    let fresh = CollabRuntime::default();
    let refused = block(fresh.invite_code(&db, &created.room_uid, 120)).expect_err("refused");
    assert!(refused.contains("changed outside OpenMind"), "{refused}");
}

/// A second runtime on the same database (an app restart whose old tasks are still finishing, or a second app instance
/// on this computer) records an event between the moment a room row is read and the moment the room is loaded. The
/// database is consistent: it must load, from the chain end that is really stored, and the next event must continue that
/// chain — not be refused as "changed outside OpenMind", and not fork the chain from the older end.
#[test]
fn a_room_loaded_right_after_another_writer_recorded_an_event_continues_its_real_chain() {
    let dir = tempfile::tempdir().expect("tempdir");
    let db = db(&dir);
    let runtime = CollabRuntime::default();
    let created = block(runtime.create_room(&db, &new_room(), 100)).expect("create");
    let host = block(runtime.identity(&db)).expect("identity");
    // The reader's view of the room, taken first ...
    let stale = block(rooms::get_by_uid(db.pool(), &created.room_uid))
        .expect("get")
        .expect("row");
    // ... then another writer records an event (in its own transaction, as every save does).
    let mut writer = block(persist::load_hosted(&db, &stale, host.clone(), 100)).expect("writer");
    let locked = writer
        .execute(
            &Actor::Host(host.peer_id()),
            Command::SetLocked { locked: true },
            150,
        )
        .expect("lock");
    save(&db, stale.id, &writer, &locked, 150);
    let stored = block(rooms::get_by_uid(db.pool(), &created.room_uid))
        .expect("get")
        .expect("row");
    assert_eq!(
        stored.chain_next_seq,
        stale.chain_next_seq + 1,
        "one event more"
    );

    let mut loaded = block(persist::load_hosted(&db, &stale, host.clone(), 160))
        .expect("a consistent database loads");
    assert_eq!(
        loaded.chain_head().next_seq,
        u64::try_from(stored.chain_next_seq).expect("seq")
    );
    assert_eq!(loaded.chain_head().last_hash, stored.chain_last_hash);
    let unlocked = loaded
        .execute(
            &Actor::Host(host.peer_id()),
            Command::SetLocked { locked: false },
            170,
        )
        .expect("unlock");
    save(&db, stale.id, &loaded, &unlocked, 170);
    let room = RoomUid::parse(&created.room_uid).expect("uid");
    let events: Vec<_> = block(logs::list_after(db.pool(), stale.id, 0, 100))
        .expect("logs")
        .iter()
        .map(|r| persist::event_of(r, &room).expect("event"))
        .collect();
    assert!(
        verify_chain(&events, &ChainHead::genesis(), Some(&host.public_key())).is_ok(),
        "one unbroken chain"
    );
}
