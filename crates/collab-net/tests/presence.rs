//! Presence over real WebRTC (phase 7): states on the `openmind-awareness` channel relayed by the Owner under the
//! sender's authenticated peer, on the local-network route and on the Internet-relay route; forged, foreign and flooded
//! states; an Owner with five participants.

mod common;

use std::time::{Duration, Instant};

use common::lan::*;
use common::*;
use openmind_collab::presence::{CursorState, PresenceState};
use openmind_collab::protocol::{Body, Bytes};
use openmind_collab::{FileId, PeerId, PeerIdentity};
use openmind_collab_net::participant::{JoinMode, Participant, ParticipantEvent};

fn state(seq: u64, file: &FileId) -> PresenceState {
    PresenceState {
        seq,
        active: Some(file.clone()),
        cursor: Some(CursorState {
            anchor: Bytes(vec![1, seq as u8]),
            head: Bytes(vec![2, seq as u8]),
        }),
        typing: seq.is_multiple_of(2),
    }
}

/// Every relayed presence `participant` receives within `window`.
async fn presences(
    participant: &mut Participant,
    window: Duration,
) -> Vec<(PeerId, PresenceState)> {
    let mut got = Vec::new();
    let deadline = tokio::time::Instant::now() + window;
    while let Ok(Some(event)) = tokio::time::timeout_at(deadline, participant.next_event()).await {
        if let ParticipantEvent::Frame(frame) = event {
            if let Body::PeerPresence { peer, state } = frame.body {
                got.push((peer, state));
            }
        }
    }
    got
}

async fn next_presence(participant: &mut Participant) -> (PeerId, PresenceState) {
    match frame(participant, |b| matches!(b, Body::PeerPresence { .. })).await {
        Body::PeerPresence { peer, state } => (peer, state),
        _ => unreachable!(),
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn presence_travels_over_the_local_network_under_the_senders_peer() {
    let world = lan_world(free_udp_port()).await;
    world
        .authority
        .put("src/main.ts", b"let x = 1;\n".to_vec())
        .await;
    let file = world.authority.workspace.lock().await.id("src/main.ts");
    let ids: Vec<_> = (0..3)
        .map(|_| PeerIdentity::generate().expect("id"))
        .collect();
    let mut people = Vec::new();
    for id in &ids {
        people.push(
            lan_join(&world, id, JoinMode::Join, lan_only(world.discovery_port))
                .await
                .expect("joined")
                .participant,
        );
    }
    people[0]
        .send(Body::Presence {
            state: state(1, &file),
        })
        .expect("send");
    for other in people.iter_mut().skip(1) {
        let (peer, got) = next_presence(other).await;
        assert_eq!(
            peer,
            ids[0].peer_id(),
            "named by the Owner, not by the sender"
        );
        assert_eq!(got, state(1, &file));
    }
    // The sender doesn't hear itself, and a newer state replaces the older one.
    people[0]
        .send(Body::Presence {
            state: state(2, &file),
        })
        .expect("send");
    let (_, got) = next_presence(&mut people[1]).await;
    assert_eq!(got.seq, 2);
    assert!(presences(&mut people[0], Duration::from_millis(400))
        .await
        .is_empty());
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn presence_travels_through_the_internet_relay_too() {
    let world = world().await;
    world.authority.put("notes.md", b"# notes\n".to_vec()).await;
    let file = world.authority.workspace.lock().await.id("notes.md");
    let (a_id, a) = join(&world).await;
    let (_, mut b) = join(&world).await;
    a.send(Body::Presence {
        state: state(1, &file),
    })
    .expect("send");
    let (peer, got) = next_presence(&mut b).await;
    assert_eq!(peer, a_id.peer_id());
    assert_eq!(got.active, Some(file));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn forged_foreign_and_stale_states_go_nowhere() {
    let world = lan_world(free_udp_port()).await;
    world.authority.put("a.txt", b"x".to_vec()).await;
    let file = world.authority.workspace.lock().await.id("a.txt");
    let (a_id, b_id) = (
        PeerIdentity::generate().expect("id"),
        PeerIdentity::generate().expect("id"),
    );
    let mut a = lan_join(
        &world,
        &a_id,
        JoinMode::Join,
        lan_only(world.discovery_port),
    )
    .await
    .expect("a")
    .participant;
    let mut b = lan_join(
        &world,
        &b_id,
        JoinMode::Join,
        lan_only(world.discovery_port),
    )
    .await
    .expect("b")
    .participant;
    // Speaking for someone else: a server-to-client message from a participant is refused.
    let forged = a
        .send(Body::PeerPresence {
            peer: b_id.peer_id(),
            state: state(1, &file),
        })
        .expect("send");
    assert!(answer(&mut a, &forged).await.is_err());
    // A file the room doesn't share, then an old sequence number: dropped silently.
    let foreign = FileId::random().expect("id");
    a.send(Body::Presence {
        state: state(7, &foreign),
    })
    .expect("send");
    a.send(Body::Presence {
        state: state(5, &file),
    })
    .expect("send");
    a.send(Body::Presence {
        state: state(4, &file),
    })
    .expect("send");
    let got = presences(&mut b, Duration::from_millis(800)).await;
    assert_eq!(got.len(), 1, "{got:?}");
    assert_eq!((got[0].0.clone(), got[0].1.seq), (a_id.peer_id(), 5));
    ping(&mut a, 1).await; // still connected
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_flood_is_cut_to_the_rate_limit_without_ending_the_connection() {
    let world = lan_world(free_udp_port()).await;
    world.authority.put("a.txt", b"x".to_vec()).await;
    let file = world.authority.workspace.lock().await.id("a.txt");
    let (a_id, b_id) = (
        PeerIdentity::generate().expect("id"),
        PeerIdentity::generate().expect("id"),
    );
    let mut a = lan_join(
        &world,
        &a_id,
        JoinMode::Join,
        lan_only(world.discovery_port),
    )
    .await
    .expect("a")
    .participant;
    let mut b = lan_join(
        &world,
        &b_id,
        JoinMode::Join,
        lan_only(world.discovery_port),
    )
    .await
    .expect("b")
    .participant;
    let started = Instant::now();
    for seq in 1..=400 {
        a.send(Body::Presence {
            state: state(seq, &file),
        })
        .expect("send");
    }
    let got = presences(&mut b, Duration::from_millis(1500)).await;
    let elapsed = started.elapsed().as_secs_f64();
    let ceiling = 40.0 + 30.0 * elapsed + 5.0;
    assert!(!got.is_empty());
    assert!(
        (got.len() as f64) <= ceiling,
        "{} relayed in {elapsed:.2}s",
        got.len()
    );
    assert!(
        got.windows(2).all(|w| w[0].1.seq < w[1].1.seq),
        "in order, never older"
    );
    ping(&mut a, 2).await;
    // Once the bucket refills, states flow again.
    tokio::time::sleep(Duration::from_millis(500)).await;
    a.send(Body::Presence {
        state: state(1000, &file),
    })
    .expect("send");
    let (_, last) = next_presence(&mut b).await;
    assert_eq!(last.seq, 1000);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn an_owner_with_five_participants_relays_everyones_presence() {
    let world = lan_world(free_udp_port()).await;
    world.authority.put("a.txt", b"x".to_vec()).await;
    let file = world.authority.workspace.lock().await.id("a.txt");
    let ids: Vec<_> = (0..5)
        .map(|_| PeerIdentity::generate().expect("id"))
        .collect();
    let mut people = Vec::new();
    for id in &ids {
        people.push(
            lan_join(&world, id, JoinMode::Join, lan_only(world.discovery_port))
                .await
                .expect("joined")
                .participant,
        );
    }
    let started = Instant::now();
    for person in &people {
        person
            .send(Body::Presence {
                state: state(1, &file),
            })
            .expect("send");
    }
    for (i, person) in people.iter_mut().enumerate() {
        let mut seen = std::collections::HashSet::new();
        while seen.len() < 4 {
            let (peer, _) = next_presence(person).await;
            assert_ne!(peer, ids[i].peer_id());
            seen.insert(peer);
        }
    }
    let elapsed = started.elapsed();
    println!("5 participants: 20 relayed presence states in {elapsed:?}");
    assert!(elapsed < Duration::from_secs(5));
}
