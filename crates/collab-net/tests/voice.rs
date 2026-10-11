//! Voice signaling over real WebRTC on the **local network only** (phase 9): no Internet relay, no STUN, no TURN —
//! the room found and joined over the LAN route, the call's state and negotiation on the same authenticated control
//! channel. Media itself is the WebViews' (not exercised here: this is the signaling test).

mod common;

use std::time::{Duration, Instant};

use common::lan::*;
use common::*;
use openmind_collab::protocol::Body;
use openmind_collab::voice::{VoiceSelf, VoiceSignal, MAX_SDP_BYTES};
use openmind_collab::{PeerId, PeerIdentity};
use openmind_collab_net::participant::{JoinMode, Participant, ParticipantEvent};
use openmind_collab_net::ConnectionRoute;

fn joined() -> VoiceSelf {
    VoiceSelf {
        joined: true,
        muted: true,
        speaking: false,
        hand_raised: false,
    }
}

/// Every voice negotiation message `participant` receives within `window`.
async fn signals(participant: &mut Participant, window: Duration) -> Vec<(PeerId, VoiceSignal)> {
    let mut got = Vec::new();
    let deadline = tokio::time::Instant::now() + window;
    while let Ok(Some(event)) = tokio::time::timeout_at(deadline, participant.next_event()).await {
        if let ParticipantEvent::Frame(frame) = event {
            if let Body::VoicePeerSignal { from, signal } = frame.body {
                got.push((from, signal));
            }
        }
    }
    got
}

async fn voice(participant: &mut Participant, state: VoiceSelf) -> Result<(), String> {
    let id = participant.send(Body::VoiceState { state }).expect("send");
    answer(participant, &id).await
}

async fn three_on_the_lan() -> (LanWorld, Vec<PeerIdentity>, Vec<Participant>) {
    let world = lan_world(free_udp_port()).await;
    let ids: Vec<_> = (0..3)
        .map(|_| PeerIdentity::generate().expect("id"))
        .collect();
    let mut people = Vec::new();
    for id in &ids {
        let routed = lan_join(&world, id, JoinMode::Join, lan_only(world.discovery_port))
            .await
            .expect("joined");
        assert_eq!(
            routed.route,
            ConnectionRoute::LocalLan,
            "found and joined over the local network"
        );
        people.push(routed.participant);
    }
    (world, ids, people)
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn offers_answers_and_candidates_go_between_call_members_with_no_internet_stun_or_turn() {
    let (_world, ids, mut people) = three_on_the_lan().await;
    voice(&mut people[0], joined()).await.expect("a joins");
    voice(&mut people[1], joined()).await.expect("b joins");
    let b = ids[1].peer_id();
    let offer = VoiceSignal::Offer {
        sdp: "v=0 offer".into(),
    };
    let candidate = VoiceSignal::Candidate {
        candidate: "candidate:1 1 udp 2122260223 192.168.1.20 50000 typ host".into(),
        sdp_mid: Some("0".into()),
        sdp_m_line_index: Some(0),
    };
    for signal in [offer.clone(), candidate.clone(), VoiceSignal::Close] {
        people[0]
            .send(Body::VoiceSignal {
                to: b.clone(),
                signal,
            })
            .expect("send");
    }
    let got = signals(&mut people[1], Duration::from_millis(1500)).await;
    let a = ids[0].peer_id();
    assert_eq!(
        got,
        vec![
            (a.clone(), offer),
            (a.clone(), candidate),
            (a, VoiceSignal::Close)
        ]
    );
    let answer_back = VoiceSignal::Answer {
        sdp: "v=0 answer".into(),
    };
    people[1]
        .send(Body::VoiceSignal {
            to: ids[0].peer_id(),
            signal: answer_back.clone(),
        })
        .expect("send");
    let back = signals(&mut people[0], Duration::from_millis(1500)).await;
    assert_eq!(
        back,
        vec![(ids[1].peer_id(), answer_back)],
        "named by the Owner as the real sender"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn nobody_outside_the_call_is_reached_and_an_oversized_signal_is_never_relayed() {
    let (_world, ids, mut people) = three_on_the_lan().await;
    voice(&mut people[0], joined()).await.expect("a joins");
    voice(&mut people[1], joined()).await.expect("b joins");
    // C isn't in the call: it can't signal into it, and nobody can signal to it.
    let offer = VoiceSignal::Offer { sdp: "v=0".into() };
    people[2]
        .send(Body::VoiceSignal {
            to: ids[0].peer_id(),
            signal: offer.clone(),
        })
        .expect("send");
    people[0]
        .send(Body::VoiceSignal {
            to: ids[2].peer_id(),
            signal: offer.clone(),
        })
        .expect("send");
    let stranger = PeerIdentity::generate().expect("id").peer_id();
    people[0]
        .send(Body::VoiceSignal {
            to: stranger,
            signal: offer,
        })
        .expect("send");
    assert!(signals(&mut people[0], Duration::from_millis(800))
        .await
        .is_empty());
    assert!(signals(&mut people[2], Duration::from_millis(300))
        .await
        .is_empty());
    // An oversized SDP never reaches anyone (the Owner's gate validates every frame; the app also checks before
    // sending).
    let huge = VoiceSignal::Offer {
        sdp: "x".repeat(MAX_SDP_BYTES + 1),
    };
    let _ = people[0].send(Body::VoiceSignal {
        to: ids[1].peer_id(),
        signal: huge,
    });
    assert!(signals(&mut people[1], Duration::from_millis(800))
        .await
        .is_empty());
    ping(&mut people[0], 3).await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_signaling_flood_is_cut_to_the_voice_budget_and_code_traffic_still_flows() {
    let (_world, ids, mut people) = three_on_the_lan().await;
    voice(&mut people[0], joined()).await.expect("a joins");
    voice(&mut people[1], joined()).await.expect("b joins");
    let started = Instant::now();
    for i in 0..500 {
        let candidate = VoiceSignal::Candidate {
            candidate: format!("candidate:{i}"),
            sdp_mid: None,
            sdp_m_line_index: Some(0),
        };
        people[0]
            .send(Body::VoiceSignal {
                to: ids[1].peer_id(),
                signal: candidate,
            })
            .expect("send");
    }
    let got = signals(&mut people[1], Duration::from_millis(1500)).await;
    let elapsed = started.elapsed().as_secs_f64();
    assert!(!got.is_empty());
    assert!(
        (got.len() as f64) <= 80.0 + 20.0 * elapsed + 5.0,
        "{} relayed in {elapsed:.2}s",
        got.len()
    );
    // The control channel itself is fine (the flood had its own budget).
    ping(&mut people[0], 7).await;
    ping(&mut people[1], 8).await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_listen_only_member_cannot_unmute_and_leaving_ends_its_negotiation() {
    let (world, ids, mut people) = three_on_the_lan().await;
    // Members join as Viewers here: voice.join yes, voice.speak no.
    voice(&mut people[0], joined())
        .await
        .expect("listen-only join");
    let unmute = VoiceSelf {
        muted: false,
        ..joined()
    };
    assert!(voice(&mut people[0], unmute)
        .await
        .expect_err("listen-only")
        .contains("may not speak"));
    voice(&mut people[1], joined()).await.expect("b joins");
    voice(&mut people[0], VoiceSelf::default())
        .await
        .expect("a leaves");
    people[1]
        .send(Body::VoiceSignal {
            to: ids[0].peer_id(),
            signal: VoiceSignal::Close,
        })
        .expect("send");
    assert!(signals(&mut people[0], Duration::from_millis(600))
        .await
        .is_empty());
    drop(world);
}
