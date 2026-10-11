//! Owner + participants over real WebRTC on loopback, through a real relay.

mod common;

use common::*;
use openmind_collab::authority::Command;
use openmind_collab::permission::Role;
use openmind_collab::protocol::{Body, Bytes, Channel, Frame};
use openmind_collab::{FileId, SessionId};
use openmind_collab_net::owner::OwnerEvent;
use openmind_collab_net::participant::JoinMode;
use openmind_collab_net::NetError;

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_participant_joins_and_its_control_frames_reach_the_authority() {
    let mut world = world().await;
    let (_identity, mut student) = join(&world).await;
    assert_eq!(student.admission().role, Role::Viewer);
    wait_for(&mut world.events, |e| {
        matches!(e, OwnerEvent::Admitted { .. })
    })
    .await;
    ping(&mut student, 1).await;
    // A Viewer can't lock the room: refused by the authority, not by the network.
    let id = student
        .send(Body::Command {
            command: Command::SetLocked { locked: true },
        })
        .expect("send");
    let refused = answer(&mut student, &id).await.expect_err("refused");
    assert!(refused.contains("room.lock"), "{refused}");
    // Promoted while connected, the same session may.
    world
        .authority
        .host_command(Command::ChangeRole {
            target: student.admission().peer.clone(),
            role: Role::Admin,
        })
        .await;
    let id = student
        .send(Body::Command {
            command: Command::SetLocked { locked: true },
        })
        .expect("send");
    assert_eq!(answer(&mut student, &id).await, Ok(()));
    assert!(world.authority.authority.lock().await.room().locked);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn all_four_channels_carry_frames_to_the_owner() {
    let world = world().await;
    let (_identity, mut student) = join(&world).await;
    let file = FileId::random().expect("file");
    for body in [
        Body::YjsStateRequest {
            file: file.clone(),
            state_vector: Bytes(vec![0]),
        },
        Body::FileCreate {
            path: openmind_collab::RelPath::parse("new.ts").expect("path"),
            kind: openmind_collab::FileKind::File,
        },
        Body::Awareness {
            state: Bytes(vec![1, 2, 3]),
        },
        Body::Ping { nonce: 9 },
    ] {
        let channel = body.channel();
        let id = student.send(body).expect("send");
        if channel == Channel::Control {
            frame(&mut student, |b| matches!(b, Body::Pong { nonce: 9 })).await;
        } else {
            // Refused by the authority — which proves they crossed their own channel. Collaborative documents are handled
            // since phase 6 (an unknown file is unavailable); the others are still reserved.
            let expected = if channel == Channel::Sync {
                "unavailable"
            } else {
                "reserved for a later phase"
            };
            assert_eq!(
                answer(&mut student, &id).await,
                Err(expected.into()),
                "{channel:?}"
            );
        }
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 6)]
async fn several_participants_connect_to_one_owner() {
    let world = world().await;
    let mut joins = Vec::new();
    for _ in 0..5 {
        joins.push(join(&world));
    }
    let mut students: Vec<_> = futures_join(joins).await;
    for (i, (_, student)) in students.iter_mut().enumerate() {
        ping(student, i as u64).await;
    }
    let authority = world.authority.authority.lock().await;
    assert_eq!(authority.room().members.len(), 6);
    let sessions: std::collections::HashSet<_> = students
        .iter()
        .map(|(_, s)| s.admission().session.clone())
        .collect();
    assert_eq!(sessions.len(), 5);
}

async fn futures_join<F: std::future::Future>(futures: Vec<F>) -> Vec<F::Output> {
    let mut out = Vec::new();
    let handles: Vec<_> = futures.into_iter().map(Box::pin).collect();
    for handle in handles {
        out.push(handle.await);
    }
    out
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn replayed_and_misrouted_frames_are_rejected() {
    let world = world().await;
    let (_identity, mut student) = join(&world).await;
    let session = student.admission().session.clone();
    let frame1 = Frame::new(
        session.clone(),
        50,
        Body::Command {
            command: Command::SetLocked { locked: true },
        },
    )
    .expect("frame");
    let bytes = frame1.encode().expect("bytes");
    student
        .send_raw(Channel::Control, bytes.clone())
        .expect("send");
    assert!(
        answer(&mut student, &frame1.id).await.is_err(),
        "refused by the authority (Viewer)"
    );
    student.send_raw(Channel::Control, bytes).expect("replay");
    let again = answer(&mut student, &frame1.id)
        .await
        .expect_err("replayed");
    assert!(again.contains("already received"), "{again}");
    // A control body on the sync channel.
    let misrouted = Frame::new(session.clone(), 51, Body::Ping { nonce: 4 }).expect("frame");
    student
        .send_raw(Channel::Sync, misrouted.encode().expect("bytes"))
        .expect("send");
    let wrong = answer(&mut student, &misrouted.id)
        .await
        .expect_err("wrong channel");
    assert!(wrong.contains("wrong data channel"), "{wrong}");
    // Another session's id on this connection.
    let stale =
        Frame::new(SessionId::random().expect("s"), 52, Body::Ping { nonce: 5 }).expect("frame");
    student
        .send_raw(Channel::Control, stale.encode().expect("bytes"))
        .expect("send");
    assert!(answer(&mut student, &stale.id)
        .await
        .expect_err("stale")
        .contains("another session"));
    // Garbage gets no answer and doesn't break the connection; oversized messages never leave.
    student
        .send_raw(Channel::Control, b"\x00\x01 not a frame".to_vec())
        .expect("send");
    assert!(matches!(
        student.send_raw(Channel::Files, vec![0; 300 * 1024]),
        Err(NetError::Protocol(_))
    ));
    ping(&mut student, 77).await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_disconnect_is_detected_and_a_reconnect_gets_a_fresh_session() {
    let mut world = world().await;
    let (identity, student) = join(&world).await;
    let peer = student.admission().peer.clone();
    let old = student.admission().session.clone();
    let owner_key = *student.owner_key();
    let room = student.room().clone();
    student.close();
    wait_for(
        &mut world.events,
        |e| matches!(e, OwnerEvent::Left { peer: p, .. } if *p == peer),
    )
    .await;
    assert_eq!(
        world.authority.session_of(&peer).await,
        None,
        "the authority ended the session"
    );
    let mut back = try_join(&world, &identity, JoinMode::Reconnect { room, owner_key })
        .await
        .expect("reconnect");
    let new = back.admission().session.clone();
    assert_ne!(new, old);
    assert_eq!(world.authority.session_of(&peer).await, Some(new));
    // Frames of the old session are refused on the new connection.
    let stale = Frame::new(old, 1, Body::Ping { nonce: 1 }).expect("frame");
    back.send_raw(Channel::Control, stale.encode().expect("bytes"))
        .expect("send");
    assert!(answer(&mut back, &stale.id)
        .await
        .expect_err("stale")
        .contains("another session"));
    ping(&mut back, 2).await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_reconnect_with_another_owner_key_is_refused() {
    let mut world = world().await;
    let (identity, student) = join(&world).await;
    let room = student.room().clone();
    student.close();
    wait_for(&mut world.events, |e| matches!(e, OwnerEvent::Left { .. })).await;
    let impostor_key = openmind_collab::PeerIdentity::generate()
        .expect("identity")
        .public_key();
    let refused = try_join(
        &world,
        &identity,
        JoinMode::Reconnect {
            room,
            owner_key: impostor_key,
        },
    )
    .await;
    assert!(matches!(refused, Err(NetError::Protocol(why)) if why.contains("key changed")));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_waiting_member_is_admitted_once_approved() {
    let mut world = world().await;
    world
        .authority
        .host_command(Command::SetApproval { required: true })
        .await;
    let identity = openmind_collab::PeerIdentity::generate().expect("identity");
    let joining = {
        let code = world.authority.code().await;
        let url = world.url.clone();
        let identity = identity.clone();
        tokio::spawn(async move {
            openmind_collab_net::participant::connect(
                identity,
                config(code, JoinMode::Join),
                std::sync::Arc::new(openmind_collab_net::signaling::WsSignaling::direct(&url)),
            )
            .await
        })
    };
    wait_for(&mut world.events, |e| {
        matches!(e, OwnerEvent::Pending { .. })
    })
    .await;
    world
        .authority
        .host_command(Command::Approve {
            target: identity.peer_id(),
        })
        .await;
    world.owner.approved(identity.peer_id());
    let mut student = joining.await.expect("task").expect("admitted");
    ping(&mut student, 3).await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_kick_closes_the_connection() {
    let mut world = world().await;
    let (_identity, mut student) = join(&world).await;
    let peer = student.admission().peer.clone();
    world
        .authority
        .host_command(Command::Kick {
            target: peer.clone(),
        })
        .await;
    world.owner.close_peer(peer.clone());
    wait_for(
        &mut world.events,
        |e| matches!(e, OwnerEvent::Link { state, .. } if state.is_finished()),
    )
    .await;
    let ended = tokio::time::timeout(WAIT, async {
        loop {
            match student.next_event().await {
                Some(openmind_collab_net::participant::ParticipantEvent::State(state))
                    if state.is_finished() =>
                {
                    return true
                }
                None => return true,
                _ => {}
            }
        }
    })
    .await;
    assert_eq!(ended, Ok(true));
}
