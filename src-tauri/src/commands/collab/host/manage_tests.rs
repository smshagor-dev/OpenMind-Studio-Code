//! Every accepted management action reaches the room's durable, signed history (the audit log the app stores).

use openmind_collab::permission::{Overrides, Permission, PermissionSet, Role};
use openmind_collab::{Actor, Command};
use openmind_db::collab::{logs, rooms};

use super::super::docs::tests::{block, world};

#[test]
fn every_accepted_management_action_is_stored_in_the_rooms_history() {
    let w = world(&[("a.txt", b"x")]);
    let peer = |a: &Actor| match a {
        Actor::Remote { peer, .. } | Actor::Host(peer) => peer.clone(),
    };
    let (a, b, c) = (
        w.member(Role::Viewer),
        w.member(Role::Viewer),
        w.member(Role::Viewer),
    );
    let run = |command: Command| {
        block(w.runtime.run_command(&w.db, &w.room, command, 50)).expect("accepted");
    };
    run(Command::SetLocked { locked: true });
    run(Command::SetLocked { locked: false });
    run(Command::RotateInvite);
    run(Command::ChangeRole {
        target: peer(&a),
        role: Role::Admin,
    });
    let overrides = Overrides {
        grant: PermissionSet::of(&[Permission::FileDelete]),
        deny: PermissionSet::EMPTY,
    };
    run(Command::SetOverrides {
        target: peer(&b),
        overrides,
    });
    run(Command::Kick { target: peer(&b) });
    run(Command::Remove { target: peer(&b) });
    run(Command::Ban { target: peer(&c) });
    run(Command::Unban { target: peer(&c) });
    run(Command::TransferOwnership { target: peer(&a) });
    // The hosting user is an Admin now: closing the room is the new Owner's (refused here, and not recorded).
    assert!(block(
        w.runtime
            .run_command(&w.db, &w.room, Command::CloseRoom, 51)
    )
    .is_err());
    let row = block(rooms::get_by_uid(w.db.pool(), &w.room))
        .expect("get")
        .expect("row");
    let kinds: Vec<String> = block(logs::list_after(w.db.pool(), row.id, 0, 500))
        .expect("logs")
        .into_iter()
        .map(|l| l.kind)
        .collect();
    for kind in [
        "room.locked",
        "room.unlocked",
        "room.inviteRotated",
        "member.roleChanged",
        "member.permissionsChanged",
        "member.kicked",
        "member.removed",
        "member.banned",
        "member.unbanned",
        "room.ownershipTransferred",
    ] {
        assert!(
            kinds.iter().any(|k| k == kind),
            "{kind} missing from {kinds:?}"
        );
    }
    assert!(!kinds.iter().any(|k| k == "room.closed"));
}
