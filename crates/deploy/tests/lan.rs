//! Deployment discovery over real UDP sockets on this computer: a responder on a free port is asked through the
//! loopback address (the same code path a LAN query takes; only the address differs). These are real sockets and real
//! threads — not a physical multi-computer test.

use std::net::{IpAddr, Ipv4Addr, SocketAddr, UdpSocket};
use std::time::{Duration, Instant};

use openmind_deploy::advert::{Advert, DeploymentKind};
use openmind_deploy::discover::{discover, Options, Outcome};
use openmind_deploy::packet::{decode, Decoded, Packet};
use openmind_deploy::registry::{DiscoveredSet, Observation, DEFAULT_TTL};
use openmind_deploy::responder::{Responder, ANSWERS_PER_SECOND};
use openmind_deploy::{random_hex, share_deployment_id, Arch, PROTOCOL};

const ANY: IpAddr = IpAddr::V4(Ipv4Addr::UNSPECIFIED);

fn advert(instance: &str) -> Advert {
    Advert {
        protocol: PROTOCOL,
        deployment_id: share_deployment_id(r"\\lab-server\apps\openmind studio"),
        instance: instance.into(),
        app_version: "1.0.3".into(),
        platform: "windows".into(),
        arch: Arch::X64,
        kind: DeploymentKind::NetworkShare,
        share_path: Some(r"\\lab-server\apps\OpenMind Studio".into()),
        http_port: 0,
        packages: 0,
        runtimes: 4,
    }
}

fn ask(port: u16) -> Options {
    Options {
        port,
        window: Duration::from_millis(900),
        rounds: 3,
        broadcast: false,
        targets: vec![SocketAddr::from((Ipv4Addr::LOCALHOST, port))],
    }
}

#[test]
fn a_deployment_answering_on_this_computer_is_found() {
    let responder = Responder::start(ANY, 0, advert(&random_hex(8))).expect("responder");
    let port = responder.address().port();
    let report = discover(&ask(port));
    assert_eq!(report.outcome(), Outcome::Found, "{report:?}");
    assert_eq!(
        report.found.len(),
        1,
        "duplicate answers of three rounds are one"
    );
    assert_eq!(
        report.found[0].advert,
        advert(&report.found[0].advert.instance)
    );
    assert!(report.sent >= 3);
}

#[test]
fn a_broadcast_search_also_reaches_it() {
    let responder = Responder::start(ANY, 0, advert(&random_hex(8))).expect("responder");
    let port = responder.address().port();
    let report = discover(&Options {
        broadcast: true,
        ..ask(port)
    });
    assert!(
        report.targets.len() > 1,
        "loopback + broadcast targets: {:?}",
        report.targets
    );
    assert_eq!(report.outcome(), Outcome::Found, "{report:?}");
}

#[test]
fn many_computers_searching_at_once_all_find_it() {
    let responder = Responder::start(ANY, 0, advert(&random_hex(8))).expect("responder");
    let port = responder.address().port();
    let clients: Vec<_> = (0..8)
        .map(|_| std::thread::spawn(move || discover(&ask(port))))
        .collect();
    for client in clients {
        let report = client.join().expect("client");
        assert_eq!(report.outcome(), Outcome::Found, "{report:?}");
        assert_eq!(report.found.len(), 1);
    }
}

#[test]
fn nothing_answering_is_reported_as_nothing_found() {
    // A port nobody listens on.
    let free = UdpSocket::bind("127.0.0.1:0").expect("probe");
    let port = free.local_addr().expect("addr").port();
    drop(free);
    let report = discover(&ask(port));
    assert_eq!(report.outcome(), Outcome::NothingFound, "{report:?}");
}

#[test]
fn a_query_that_cant_be_sent_anywhere_is_reported_as_blocked() {
    let report = discover(&Options {
        targets: vec![SocketAddr::from((Ipv4Addr::UNSPECIFIED, 0))],
        broadcast: false,
        window: Duration::from_millis(200),
        ..Options::default()
    });
    assert_eq!(report.outcome(), Outcome::NetworkBlocked, "{report:?}");
    assert!(!report.send_errors.is_empty());
}

#[test]
fn a_responder_that_cant_bind_says_why() {
    // An address this computer doesn't have (TEST-NET-1).
    let err = Responder::start(
        IpAddr::V4(Ipv4Addr::new(192, 0, 2, 1)),
        0,
        advert(&random_hex(8)),
    )
    .err()
    .expect("refused");
    assert_eq!(err.kind(), std::io::ErrorKind::AddrNotAvailable, "{err}");
}

/// A rogue on the network: answers every query with what `reply` builds from the query's nonce.
fn rogue(
    reply: impl Fn(&str) -> Vec<Vec<u8>> + Send + 'static,
) -> (u16, std::thread::JoinHandle<()>) {
    let socket = UdpSocket::bind("127.0.0.1:0").expect("rogue");
    socket
        .set_read_timeout(Some(Duration::from_millis(1500)))
        .expect("timeout");
    let port = socket.local_addr().expect("addr").port();
    let thread = std::thread::spawn(move || {
        let mut buf = [0u8; 2048];
        while let Ok((n, from)) = socket.recv_from(&mut buf) {
            if let Decoded::Packet(Packet::Query { nonce }) = decode(&buf[..n]) {
                for datagram in reply(&nonce) {
                    let _ = socket.send_to(&datagram, from);
                }
            }
        }
    });
    (port, thread)
}

#[test]
fn forged_replayed_and_broken_answers_are_never_taken_as_deployments() {
    let (port, rogue) = rogue(|_nonce| {
        let replay = Packet::Answer {
            nonce: "0000000000000000".into(),
            advert: advert("1111111111111111"),
        }
        .encode();
        let mut bad = serde_json::to_value(advert("1111111111111111")).expect("json");
        bad["sharePath"] = r"C:\Windows".into();
        let broken = serde_json::to_vec(&serde_json::json!({
            "m": "openmind-deploy", "v": 1, "t": "a", "nonce": "0000000000000000", "advert": bad
        }))
        .expect("bytes");
        vec![replay, broken, b"not json".to_vec()]
    });
    let report = discover(&ask(port));
    assert_eq!(report.outcome(), Outcome::NothingFound, "{report:?}");
    assert!(report.stale >= 1 && report.malformed >= 1, "{report:?}");
    drop(rogue);
}

#[test]
fn a_deployment_speaking_another_protocol_is_reported_as_incompatible() {
    let (port, _rogue) = rogue(|nonce| {
        vec![serde_json::to_vec(&serde_json::json!({
            "m": "openmind-deploy", "v": PROTOCOL + 1, "t": "a", "nonce": nonce,
            "advert": {"deploymentId": share_deployment_id("x"), "appVersion": "2.0.0"}
        }))
        .expect("bytes")]
    });
    let report = discover(&ask(port));
    assert_eq!(
        report.outcome(),
        Outcome::ProtocolIncompatible,
        "{report:?}"
    );
    assert_eq!(report.incompatible[0].app_version.as_deref(), Some("2.0.0"));
}

#[test]
fn a_responder_cant_be_used_to_flood_anyone() {
    let responder = Responder::start(ANY, 0, advert(&random_hex(8))).expect("responder");
    let target = SocketAddr::from((Ipv4Addr::LOCALHOST, responder.address().port()));
    let socket = UdpSocket::bind("127.0.0.1:0").expect("socket");
    socket
        .set_read_timeout(Some(Duration::from_millis(300)))
        .expect("timeout");
    let query = Packet::Query {
        nonce: random_hex(8),
    }
    .encode();
    for _ in 0..60 {
        socket.send_to(&query, target).expect("send");
    }
    let mut answers = 0;
    let mut buf = [0u8; 2048];
    let started = Instant::now();
    while socket.recv_from(&mut buf).is_ok() && started.elapsed() < Duration::from_millis(900) {
        answers += 1;
    }
    assert!(
        answers > 0 && answers <= ANSWERS_PER_SECOND as usize,
        "{answers}"
    );
}

#[test]
fn a_source_that_restarts_on_another_port_stays_the_same_deployment() {
    let mut known = DiscoveredSet::default();
    let first = Responder::start(ANY, 0, advert(&random_hex(8))).expect("first");
    let report = discover(&ask(first.address().port()));
    let found = &report.found[0];
    assert_eq!(
        known.observe(found.advert.clone(), found.from, Instant::now()),
        Observation::New
    );
    let id = found.advert.deployment_id.clone();

    // The computer's OpenMind Studio closes: nothing answers any more.
    let old_port = first.address().port();
    drop(first);
    assert_eq!(discover(&ask(old_port)).outcome(), Outcome::NothingFound);

    // It comes back (a new process: a new instance and, here, a new port).
    let second = Responder::start(ANY, 0, advert(&random_hex(8))).expect("second");
    let report = discover(&ask(second.address().port()));
    let found = &report.found[0];
    // On the LAN a restarted responder answers from the same discovery port (a restart); here the port is new, so it
    // is another source of the same deployment until the old one expires. Either way: one deployment.
    let seen = known.observe(found.advert.clone(), found.from, Instant::now());
    assert!(
        matches!(seen, Observation::NewSource | Observation::Restarted),
        "{seen:?}"
    );
    assert_eq!(known.len(), 1);
    let later = Instant::now() + DEFAULT_TTL / 2;
    known.observe(found.advert.clone(), found.from, later);
    assert!(known
        .prune(
            later + DEFAULT_TTL / 2 + Duration::from_secs(1),
            DEFAULT_TTL
        )
        .is_empty());
    assert_eq!(
        known.get(&id).expect("same id").sources.len(),
        1,
        "the old instance expired, the new one stays"
    );
    // Unheard-of for longer than the time-to-live: gone.
    assert_eq!(known.prune(later + DEFAULT_TTL * 2, DEFAULT_TTL), vec![id]);
}

#[test]
fn two_computers_announcing_one_share_are_one_deployment_with_two_sources() {
    let pc_a = Responder::start(ANY, 0, advert(&random_hex(8))).expect("a");
    let pc_b = Responder::start(ANY, 0, advert(&random_hex(8))).expect("b");
    let report = discover(&Options {
        targets: vec![
            SocketAddr::from((Ipv4Addr::LOCALHOST, pc_a.address().port())),
            SocketAddr::from((Ipv4Addr::LOCALHOST, pc_b.address().port())),
        ],
        ..ask(0)
    });
    assert_eq!(report.found.len(), 2);
    let mut known = DiscoveredSet::default();
    for found in &report.found {
        known.observe(found.advert.clone(), found.from, Instant::now());
    }
    assert_eq!(known.len(), 1);
    assert_eq!(known.list()[0].sources.len(), 2);
}

#[test]
fn a_changed_announcement_is_answered_from_then_on() {
    let responder = Responder::start(ANY, 0, advert(&random_hex(8))).expect("responder");
    let mut newer = advert(&random_hex(8));
    newer.app_version = "1.0.4".into();
    responder.set_advert(newer).expect("set");
    let report = discover(&ask(responder.address().port()));
    assert_eq!(report.found[0].advert.app_version, "1.0.4");
    let mut invalid = advert(&random_hex(8));
    invalid.app_version = "x".into();
    assert!(responder.set_advert(invalid).is_err());
}
