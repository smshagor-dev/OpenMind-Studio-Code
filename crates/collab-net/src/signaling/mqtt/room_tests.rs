use super::*;
use openmind_collab_signal::proto::{NegotiationId, SignalKind, SIGNAL_VERSION};

fn topic() -> Topic {
    Topic::parse(&"ab".repeat(32)).expect("topic")
}

fn signal(seq: u64) -> Signal {
    Signal {
        negotiation: NegotiationId::random().expect("id"),
        seq,
        kind: SignalKind::Candidate {
            candidate: "candidate:1 1 udp 1 192.168.1.5 9 typ host".into(),
        },
    }
}

/// Delivers every publish in `actions` to the rooms subscribed to its topic; returns the events they raised.
fn deliver(actions: Vec<Action>, rooms: &mut [&mut Room]) -> Vec<RelayMessage> {
    let mut events = Vec::new();
    let mut queue = actions;
    while !queue.is_empty() {
        let mut next = Vec::new();
        for action in queue {
            match action {
                Action::Publish(inbox, payload) => {
                    for room in rooms.iter_mut() {
                        next.extend(room.inbound(&inbox, &payload));
                    }
                }
                Action::Event(message) => events.push(message),
                Action::Subscribe(_) => {}
            }
        }
        queue = next;
    }
    events
}

fn hosted() -> Room {
    let mut owner = Room::new(Slot::random().expect("slot"));
    let now = Instant::now();
    let subscribe = owner.client(
        ClientMessage::Host {
            v: SIGNAL_VERSION,
            topic: topic(),
        },
        now,
    );
    assert!(matches!(&subscribe[..], [Action::Subscribe(t)] if t.ends_with("/h")));
    assert!(matches!(
        &owner.subscribed(now)[..],
        [Action::Event(RelayMessage::Hosted { .. })]
    ));
    owner
}

fn joining(now: Instant) -> (Room, Vec<Action>) {
    let mut student = Room::new(Slot::random().expect("slot"));
    let subscribe = student.client(
        ClientMessage::Join {
            v: SIGNAL_VERSION,
            topic: topic(),
        },
        now,
    );
    assert!(matches!(&subscribe[..], [Action::Subscribe(t)] if t.contains("/p/")));
    let join = student.subscribed(now);
    (student, join)
}

#[test]
fn a_participant_meets_its_owner_and_signals_both_ways() {
    let mut owner = hosted();
    let now = Instant::now();
    let (mut student, join) = joining(now);
    let events = deliver(join, &mut [&mut owner, &mut student]);
    let host = match &events[..] {
        [RelayMessage::PeerArrived { .. }, RelayMessage::Joined { host, .. }] => host.clone(),
        other => panic!("{other:?}"),
    };
    let up = signal(1);
    let events = deliver(
        student.client(
            ClientMessage::Signal {
                to: host.clone(),
                signal: up.clone(),
            },
            now,
        ),
        &mut [&mut owner, &mut student],
    );
    let from = match &events[..] {
        [RelayMessage::Signal { from, signal }] if *signal == up => from.clone(),
        other => panic!("{other:?}"),
    };
    let down = signal(2);
    let events = deliver(
        owner.client(
            ClientMessage::Signal {
                to: from.clone(),
                signal: down.clone(),
            },
            now,
        ),
        &mut [&mut owner, &mut student],
    );
    assert_eq!(
        events,
        vec![RelayMessage::Signal {
            from: host,
            signal: down
        }]
    );
    let events = deliver(student.leave(), &mut [&mut owner, &mut student]);
    assert_eq!(events, vec![RelayMessage::PeerLeft { slot: from }]);
}

#[test]
fn nothing_readable_reaches_the_broker() {
    let now = Instant::now();
    let (student, join) = joining(now);
    let [Action::Publish(inbox, payload)] = &join[..] else {
        panic!("{join:?}");
    };
    let text = String::from_utf8_lossy(payload);
    assert!(
        !inbox.contains(&"ab".repeat(8)),
        "the signaling topic is hashed"
    );
    assert!(
        !text.contains("\"join\"") && !text.contains(student.slot.as_str()),
        "sealed"
    );
    // Moved to another inbox, the same bytes don't open (the inbox is authenticated).
    let mut owner = hosted();
    assert!(owner.inbound(&format!("{inbox}x"), payload).is_empty());
    let mut tampered = payload.clone();
    if let Some(last) = tampered.last_mut() {
        *last ^= 1;
    }
    assert!(owner.inbound(inbox, &tampered).is_empty());
}

#[test]
fn a_participant_asks_again_then_reports_no_host_once() {
    let now = Instant::now();
    let (mut student, first) = joining(now);
    assert_eq!(first.len(), 1);
    assert!(student.tick(now + Duration::from_millis(500)).is_empty());
    assert_eq!(student.tick(now + JOIN_RESEND).len(), 1);
    assert_eq!(
        student.tick(now + NO_HOST_AFTER),
        vec![Action::Event(RelayMessage::Error {
            code: ErrorCode::NoHost
        })]
    );
    assert!(student.tick(now + NO_HOST_AFTER * 2).is_empty());
}

#[test]
fn strangers_and_other_rooms_are_ignored() {
    let mut owner = hosted();
    let now = Instant::now();
    // A signal from a slot that never joined.
    let mut stranger = Room::new(Slot::random().expect("slot"));
    stranger.client(
        ClientMessage::Join {
            v: SIGNAL_VERSION,
            topic: topic(),
        },
        now,
    );
    stranger.subscribed(now);
    assert_eq!(
        stranger.client(
            ClientMessage::Signal {
                to: Slot::random().expect("s"),
                signal: signal(1)
            },
            now
        ),
        vec![Action::Event(RelayMessage::Error {
            code: ErrorCode::UnknownPeer
        })]
    );
    // Another room's participant: different topics, different key.
    let mut other = Room::new(Slot::random().expect("slot"));
    let other_topic = Topic::parse(&"cd".repeat(32)).expect("topic");
    other.client(
        ClientMessage::Join {
            v: SIGNAL_VERSION,
            topic: other_topic,
        },
        now,
    );
    let join = other.subscribed(now);
    assert!(deliver(join, &mut [&mut owner]).is_empty());
    assert_eq!(
        owner.client(
            ClientMessage::Host {
                v: SIGNAL_VERSION,
                topic: topic()
            },
            now
        ),
        vec![Action::Event(RelayMessage::Error {
            code: ErrorCode::AlreadyRegistered
        })]
    );
}
