//! TURN against a real server (phase 10). Ignored by default: they need a TURN server and its login, which are never
//! committed. Run with
//!
//! ```text
//! OPENMIND_TEST_TURN_HOST=<server IP> OPENMIND_TEST_TURN_USER=<user> OPENMIND_TEST_TURN_PASSWORD=<password>
//! OPENMIND_TEST_TURN_CA=<test CA, PEM> cargo test -p openmind-collab-net --test turn -- --ignored --test-threads=1
//! ```
//!
//! The server is expected to offer TURN over UDP and TCP on 3478 and TURN over TLS on 443 with a certificate for
//! the IP (signed by the test CA), plus a second TLS listener on 8443 whose certificate names another host (the
//! hostname-mismatch case). Rooms here run **relay-only**: no host or STUN candidate exists, so every packet of the
//! room provably crosses the TURN server.

mod common;

use std::net::SocketAddr;
use std::sync::Arc;
use std::time::{Duration, Instant};

use common::*;
use openmind_collab::authority::Command;
use openmind_collab::crdt::CollabDoc;
use openmind_collab::permission::Role;
use openmind_collab::presence::PresenceState;
use openmind_collab::protocol::Body;
use openmind_collab::{MessageId, PeerIdentity};
use openmind_collab_net::ice::{IcePolicy, IceSetup, TurnServer, TurnTransport};
use openmind_collab_net::owner::OwnerEvent;
use openmind_collab_net::participant::JoinMode;
use openmind_collab_net::relay::TurnRelay;
use openmind_collab_net::remote::{self, DocEvent, RemoteEvent, RemoteWorkspace};
use openmind_collab_net::transport::{IcePath, RelayEvent, RelayProtocol, RelayProvider};
use openmind_collab_net::turn::{StaticCredential, TurnFailureKind, TurnLogin};
use openmind_collab_net::NetError;
use rustls::pki_types::pem::PemObject;
use tokio::sync::mpsc;

struct Env {
    host: String,
    user: String,
    password: String,
    ca: rustls::RootCertStore,
}

fn env() -> Option<Env> {
    let get = |name: &str| std::env::var(name).ok().filter(|v| !v.is_empty());
    let (Some(host), Some(user), Some(password), Some(ca)) = (
        get("OPENMIND_TEST_TURN_HOST"),
        get("OPENMIND_TEST_TURN_USER"),
        get("OPENMIND_TEST_TURN_PASSWORD"),
        get("OPENMIND_TEST_TURN_CA"),
    ) else {
        eprintln!("skipped: set OPENMIND_TEST_TURN_HOST/USER/PASSWORD/CA to run the TURN tests");
        return None;
    };
    let mut roots = rustls::RootCertStore::empty();
    for cert in rustls::pki_types::CertificateDer::pem_file_iter(&ca).expect("CA file") {
        roots.add(cert.expect("CA cert")).expect("CA");
    }
    Some(Env {
        host,
        user,
        password,
        ca: roots,
    })
}

fn server(env: &Env, protocol: RelayProtocol, port: Option<u16>) -> TurnServer {
    let (secure, transport, default_port) = match protocol {
        RelayProtocol::Udp => (false, TurnTransport::Udp, 3478),
        RelayProtocol::Tcp => (false, TurnTransport::Tcp, 3478),
        RelayProtocol::Tls => (true, TurnTransport::Tcp, 443),
    };
    TurnServer {
        secure,
        host: env.host.clone(),
        port: port.unwrap_or(default_port),
        transport,
    }
}

fn relay_with(
    env: &Env,
    servers: Vec<TurnServer>,
    password: &str,
    trust_ca: bool,
) -> Arc<TurnRelay> {
    let login = TurnLogin {
        username: env.user.clone(),
        password: password.to_string(),
        expires_at: None,
        urls: None,
    };
    let relay = TurnRelay::new(servers).with_credentials(Arc::new(StaticCredential(Some(login))));
    Arc::new(if trust_ca {
        relay.with_tls_roots(env.ca.clone())
    } else {
        relay
    })
}

fn relay(env: &Env, protocol: RelayProtocol) -> Arc<TurnRelay> {
    relay_with(env, vec![server(env, protocol, None)], &env.password, true)
}

fn relay_only() -> IceSetup {
    IceSetup {
        policy: IcePolicy::RelayOnly,
        bind_ip: Some("127.0.0.1".parse().expect("ip")),
        ..IceSetup::default()
    }
}

/// Two allocations exchange packets through the server (Allocate, CreatePermission, ChannelBind, Send/Data).
async fn round_trip(env: &Env, protocol: RelayProtocol) {
    let relay = relay(env, protocol);
    let a = relay.allocate().await.expect("allocation a");
    let mut b = relay.allocate().await.expect("allocation b");
    assert_eq!((a.protocol, b.protocol), (protocol, protocol));
    assert_ne!(a.relayed, b.relayed);
    let deadline = Instant::now() + Duration::from_secs(8);
    let mut got = None;
    while got.is_none() && Instant::now() < deadline {
        // Each side's first packet installs its permission for the other's address.
        b.link.send(a.relayed, b"permission".to_vec());
        a.link.send(b.relayed, b"hello through TURN".to_vec());
        if let Ok(Some(RelayEvent::Data { peer, data })) =
            tokio::time::timeout(Duration::from_millis(300), b.link.recv()).await
        {
            got = Some((peer, data));
        }
    }
    let (peer, data) = got.expect("a packet through the relay");
    assert_eq!(
        (peer, data.as_slice()),
        (a.relayed, b"hello through TURN".as_slice())
    );
    // Many more packets (the channel is bound by now) all arrive in a burst.
    for i in 0..50u8 {
        a.link.send(b.relayed, vec![i; 1000]);
    }
    let mut count = 0;
    while let Ok(Some(event)) = tokio::time::timeout(Duration::from_secs(2), b.link.recv()).await {
        if matches!(event, RelayEvent::Data { ref data, .. } if data.len() == 1000) {
            count += 1;
            if count == 50 {
                break;
            }
        }
    }
    assert!(count >= 45, "{count} of 50 relayed packets arrived");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
#[ignore = "needs a TURN server (OPENMIND_TEST_TURN_*)"]
async fn allocations_relay_packets_over_udp_tcp_and_tls() {
    let Some(env) = env() else { return };
    for protocol in [RelayProtocol::Udp, RelayProtocol::Tcp, RelayProtocol::Tls] {
        round_trip(&env, protocol).await;
        eprintln!("{protocol:?}: allocate, permission, channel and data verified");
    }
}

struct Member {
    remote: Arc<RemoteWorkspace>,
    events: mpsc::UnboundedReceiver<RemoteEvent>,
}

impl Member {
    async fn until(&mut self, want: impl Fn(&RemoteEvent) -> bool) -> RemoteEvent {
        let mut seen = Vec::new();
        let found = tokio::time::timeout(WAIT, async {
            loop {
                let event = self.events.recv().await.expect("remote events");
                if want(&event) {
                    return event;
                }
                if !matches!(event, RemoteEvent::Progress { .. }) {
                    seen.push(format!("{event:?}").chars().take(120).collect::<String>());
                }
            }
        })
        .await;
        found.unwrap_or_else(|_| panic!("no matching remote event in time; saw {seen:?}"))
    }
}

async fn member(world: &World, ice: IceSetup, relay: Arc<TurnRelay>) -> (PeerIdentity, Member) {
    let identity = PeerIdentity::generate().expect("id");
    let code = world.authority.code().await;
    let mut config = config(code, JoinMode::Join);
    config.ice = ice;
    config.relay = relay;
    let participant = try_join_with(world, &identity, config)
        .await
        .expect("joined");
    let (tx, events) = mpsc::unbounded_channel();
    let (remote, _task) = remote::spawn(
        participant,
        Arc::new(move |e| {
            let _ = tx.send(e);
        }),
    );
    (identity, Member { remote, events })
}

/// A whole room over TURN only: handshake, control, a CRDT edit, a multi-chunk file and presence between two members.
async fn room_over(env: &Env, protocol: RelayProtocol) {
    let mut world = world_with(relay_only(), relay(env, protocol)).await;
    let big: Vec<u8> = (0..300_000).map(|i| (i * 7 % 251) as u8).collect();
    world
        .authority
        .put_many(&[
            ("notes.md", b"# notes\n".to_vec()),
            ("data.bin", big.clone()),
        ])
        .await;
    let (notes, data) = {
        let ws = world.authority.workspace.lock().await;
        (ws.id("notes.md"), ws.id("data.bin"))
    };
    let (a_id, mut a) = member(&world, relay_only(), relay(env, protocol)).await;
    let want = IcePath::relayed(protocol);
    assert!(
        matches!(a.until(|e| matches!(e, RemoteEvent::Path(_))).await, RemoteEvent::Path(p) if p == want)
    );
    let owner_path = wait_for(&mut world.events, |e| matches!(e, OwnerEvent::Path { .. })).await;
    assert!(matches!(owner_path, OwnerEvent::Path { path, .. } if path == want));
    world
        .authority
        .host_command(Command::ChangeRole {
            target: a_id.peer_id(),
            role: Role::Editor,
        })
        .await;
    // CRDT edit.
    let doc = CollabDoc::default();
    a.remote
        .subscribe(notes.clone(), doc.state_vector())
        .expect("subscribe");
    if let RemoteEvent::Doc(DocEvent::Sync { update, .. }) = a
        .until(|e| matches!(e, RemoteEvent::Doc(DocEvent::Sync { .. })))
        .await
    {
        doc.apply(&update).expect("sync");
    }
    let update = doc.set_text("# notes\nthrough TURN\n").expect("change");
    let sent = a
        .remote
        .send_update(notes.clone(), MessageId::random().expect("id"), update)
        .expect("send");
    let acked = a
        .until(|e| matches!(e, RemoteEvent::Doc(DocEvent::Acked { frame } | DocEvent::Rejected { frame, .. }) if *frame == sent))
        .await;
    assert!(
        matches!(acked, RemoteEvent::Doc(DocEvent::Acked { .. })),
        "{acked:?}"
    );
    assert_eq!(
        world.authority.docs.lock().await.text(&notes).expect("doc"),
        "# notes\nthrough TURN\n"
    );
    // A multi-chunk file.
    let received = a.remote.fetch(data).await.expect("file");
    assert_eq!(received.bytes, big);
    // Presence from a second member, also relay-only.
    let (_, mut b) = member(&world, relay_only(), relay(env, protocol)).await;
    b.until(|e| matches!(e, RemoteEvent::Path(p) if *p == want))
        .await;
    let state = PresenceState {
        seq: 1,
        active: Some(notes.clone()),
        cursor: None,
        typing: false,
    };
    b.remote
        .sender()
        .send(Body::Presence {
            state: state.clone(),
        })
        .expect("presence");
    let got = a.until(|e| matches!(e, RemoteEvent::Presence(_))).await;
    assert!(format!("{got:?}").contains("seq: 1"), "{got:?}");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
#[ignore = "needs a TURN server (OPENMIND_TEST_TURN_*)"]
async fn a_room_works_through_turn_only_over_udp_tcp_and_tls() {
    let Some(env) = env() else { return };
    for protocol in [RelayProtocol::Udp, RelayProtocol::Tcp, RelayProtocol::Tls] {
        room_over(&env, protocol).await;
        eprintln!("{protocol:?}: handshake, control, CRDT edit, file transfer and presence over TURN only");
    }
}

async fn failure(relay: Arc<TurnRelay>) -> (TurnFailureKind, Duration, String) {
    let started = Instant::now();
    let err = relay.allocate().await.expect_err("must fail");
    let text = err.to_string();
    match err {
        NetError::Turn(f) => (f.kind, started.elapsed(), text),
        other => panic!("not a TURN failure: {other}"),
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
#[ignore = "needs a TURN server (OPENMIND_TEST_TURN_*)"]
async fn failures_are_categorized_quickly_and_never_show_the_password() {
    let Some(env) = env() else { return };
    let wrong = "not-the-password";
    for protocol in [RelayProtocol::Udp, RelayProtocol::Tcp, RelayProtocol::Tls] {
        let (kind, took, text) = failure(relay_with(
            &env,
            vec![server(&env, protocol, None)],
            wrong,
            true,
        ))
        .await;
        assert_eq!(kind, TurnFailureKind::Unauthorized, "{protocol:?}: {text}");
        assert!(
            took < Duration::from_secs(5) && !text.contains(wrong) && !text.contains(&env.password)
        );
    }
    let tls = server(&env, RelayProtocol::Tls, None);
    let (kind, _, text) = failure(relay_with(&env, vec![tls.clone()], &env.password, false)).await;
    assert_eq!(kind, TurnFailureKind::Certificate, "an unknown CA: {text}");
    let mismatch = server(&env, RelayProtocol::Tls, Some(8443));
    let (kind, _, text) = failure(relay_with(&env, vec![mismatch], &env.password, true)).await;
    assert_eq!(kind, TurnFailureKind::HostnameMismatch, "{text}");
    // Nothing listens on these ports: UDP never answers, TCP is refused.
    let (kind, took, _) = failure(relay_with(
        &env,
        vec![server(&env, RelayProtocol::Udp, Some(3999))],
        &env.password,
        true,
    ))
    .await;
    assert_eq!(kind, TurnFailureKind::Timeout);
    assert!(took <= Duration::from_secs(11), "bounded: {took:?}");
    let (kind, _, _) = failure(relay_with(
        &env,
        vec![server(&env, RelayProtocol::Tcp, Some(3999))],
        &env.password,
        true,
    ))
    .await;
    assert!(
        matches!(
            kind,
            TurnFailureKind::Unreachable | TurnFailureKind::Timeout
        ),
        "{kind:?}"
    );
    // An expired short-lived credential is refused before anything is sent.
    let expired = TurnLogin {
        username: env.user.clone(),
        password: env.password.clone(),
        expires_at: Some(std::time::SystemTime::now() - Duration::from_secs(1)),
        urls: None,
    };
    let relay = TurnRelay::new(vec![server(&env, RelayProtocol::Udp, None)])
        .with_credentials(Arc::new(StaticCredential(Some(expired))));
    let (kind, _, _) = failure(Arc::new(relay)).await;
    assert_eq!(kind, TurnFailureKind::CredentialExpired);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
#[ignore = "needs a TURN server (OPENMIND_TEST_TURN_*)"]
async fn relay_only_with_a_bad_login_fails_the_join_clearly_without_hanging() {
    let Some(env) = env() else { return };
    let world = world_with(common::ice(), Arc::new(TurnRelay::new(Vec::new()))).await;
    let code = world.authority.code().await;
    let mut config = config(code, JoinMode::Join);
    config.ice = relay_only();
    config.relay = relay_with(
        &env,
        vec![server(&env, RelayProtocol::Udp, None)],
        "wrong",
        true,
    );
    let started = Instant::now();
    let err = try_join_with(&world, &PeerIdentity::generate().expect("id"), config)
        .await
        .err()
        .expect("relay-only can't join without a relay");
    assert!(
        matches!(err, NetError::Turn(f) if f.kind == TurnFailureKind::Unauthorized),
        "{err}"
    );
    assert!(started.elapsed() < Duration::from_secs(10));
    // The room is untouched: an ordinary member still joins.
    let (_, mut participant) = join(&world).await;
    ping(&mut participant, 7).await;
}

/// The address a working direct path would use is preferred over TURN, and a dead TURN server doesn't slow a join.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
#[ignore = "needs a TURN server (OPENMIND_TEST_TURN_*)"]
async fn direct_paths_stay_preferred_and_a_dead_turn_server_costs_nothing() {
    let Some(env) = env() else { return };
    // TURN available on both sides, all candidates: the direct (host) pair wins.
    let mut world = world_with(common::ice(), relay(&env, RelayProtocol::Udp)).await;
    let (_, mut m) = member(&world, common::ice(), relay(&env, RelayProtocol::Udp)).await;
    assert!(matches!(
        m.until(|e| matches!(e, RemoteEvent::Path(_))).await,
        RemoteEvent::Path(IcePath::Direct)
    ));
    tokio::time::sleep(Duration::from_secs(3)).await;
    while let Ok(event) = m.events.try_recv() {
        assert!(
            !matches!(event, RemoteEvent::Path(p) if p != IcePath::Direct),
            "switched away from direct: {event:?}"
        );
    }
    assert!(matches!(
        wait_for(&mut world.events, |e| matches!(e, OwnerEvent::Path { .. })).await,
        OwnerEvent::Path {
            path: IcePath::Direct,
            ..
        }
    ));
    // A TURN server that never answers: the direct join is as fast as with no TURN at all.
    let dead = |env: &Env| {
        relay_with(
            env,
            vec![server(env, RelayProtocol::Udp, Some(3999))],
            &env.password,
            true,
        )
    };
    let world = world_with(common::ice(), dead(&env)).await;
    let started = Instant::now();
    let (_, mut m) = member(&world, common::ice(), dead(&env)).await;
    let with_dead_turn = started.elapsed();
    assert!(matches!(
        m.until(|e| matches!(e, RemoteEvent::Path(_))).await,
        RemoteEvent::Path(IcePath::Direct)
    ));
    let plain = common::world().await;
    let started = Instant::now();
    let (_, _) = member(&plain, common::ice(), Arc::new(TurnRelay::new(Vec::new()))).await;
    let without = started.elapsed();
    eprintln!("join with a dead TURN server {with_dead_turn:?}, without TURN {without:?}");
    assert!(
        with_dead_turn < without + Duration::from_secs(2),
        "{with_dead_turn:?} vs {without:?}"
    );
}

/// A TCP forwarder between the client and the server, which the test can cut (the server "disappears").
async fn cuttable_forwarder(target: SocketAddr) -> (SocketAddr, tokio::sync::watch::Sender<bool>) {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .expect("bind");
    let addr = listener.local_addr().expect("addr");
    let (cut, watch) = tokio::sync::watch::channel(false);
    tokio::spawn(async move {
        while let Ok((mut inbound, _)) = listener.accept().await {
            let mut watch = watch.clone();
            tokio::spawn(async move {
                let Ok(mut outbound) = tokio::net::TcpStream::connect(target).await else {
                    return;
                };
                tokio::select! {
                    _ = tokio::io::copy_bidirectional(&mut inbound, &mut outbound) => {}
                    _ = watch.wait_for(|cut| *cut) => {}
                }
            });
        }
    });
    (addr, cut)
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
#[ignore = "needs a TURN server (OPENMIND_TEST_TURN_*)"]
async fn a_server_that_disappears_after_allocation_ends_the_relay_cleanly() {
    let Some(env) = env() else { return };
    let target: SocketAddr = format!("{}:3478", env.host).parse().expect("addr");
    let (proxy, cut) = cuttable_forwarder(target).await;
    let through = TurnServer {
        secure: false,
        host: proxy.ip().to_string(),
        port: proxy.port(),
        transport: TurnTransport::Tcp,
    };
    let relay = relay_with(&env, vec![through], &env.password, true);
    let mut allocation = relay
        .allocate()
        .await
        .expect("allocation through the forwarder");
    cut.send(true).expect("cut");
    let ended = tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            match allocation.link.recv().await {
                Some(RelayEvent::Ended(failure)) => return Some(failure.kind),
                None => return None,
                Some(_) => {}
            }
        }
    })
    .await
    .expect("noticed in time");
    assert_eq!(ended, Some(TurnFailureKind::Lost));
    // The relay task is gone (no refresh keeps running): its channel closes.
    let closed = tokio::time::timeout(Duration::from_secs(3), allocation.link.recv()).await;
    assert!(matches!(closed, Ok(None)), "{closed:?}");
    assert!(
        !allocation.link.send(target, vec![1]),
        "nothing is accepted after the relay ended"
    );
}

/// A UDP forwarder between a client and the server that can go silent (the server stops answering refreshes).
async fn silenceable_udp_forwarder(
    target: SocketAddr,
) -> (SocketAddr, tokio::sync::watch::Sender<bool>) {
    let front = Arc::new(
        tokio::net::UdpSocket::bind("127.0.0.1:0")
            .await
            .expect("bind"),
    );
    let back = Arc::new(
        tokio::net::UdpSocket::bind("0.0.0.0:0")
            .await
            .expect("bind"),
    );
    let addr = front.local_addr().expect("addr");
    let (silence, watch) = tokio::sync::watch::channel(false);
    let client = Arc::new(std::sync::Mutex::new(None::<SocketAddr>));
    let (f, b, c, w) = (front.clone(), back.clone(), client.clone(), watch.clone());
    tokio::spawn(async move {
        let mut buf = vec![0u8; 65_536];
        while let Ok((n, from)) = f.recv_from(&mut buf).await {
            *c.lock().expect("lock") = Some(from);
            let silent = *w.borrow();
            if !silent {
                let _ = b.send_to(&buf[..n], target).await;
            }
        }
    });
    tokio::spawn(async move {
        let mut buf = vec![0u8; 65_536];
        while let Ok((n, _)) = back.recv_from(&mut buf).await {
            let to = *client.lock().expect("lock");
            let silent = *watch.borrow();
            if let (Some(to), false) = (to, silent) {
                let _ = front.send_to(&buf[..n], to).await;
            }
        }
    });
    (addr, silence)
}

/// Runs past the 600 s allocation lifetime and the 300 s permission lifetime: a room on TURN keeps working, so
/// Refresh, permission refresh and channel refresh happened. Next to it, an allocation whose server goes silent
/// fails its refresh and ends with that category. Slow (about 11 minutes).
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
#[ignore = "needs a TURN server (OPENMIND_TEST_TURN_*); takes about 11 minutes"]
async fn a_relayed_room_outlives_the_allocation_lifetime() {
    let Some(env) = env() else { return };
    if std::env::var("OPENMIND_TEST_TURN_SLOW").is_err() {
        eprintln!("skipped: set OPENMIND_TEST_TURN_SLOW=1 for the 11-minute refresh test");
        return;
    }
    let target: SocketAddr = format!("{}:3478", env.host).parse().expect("addr");
    let (proxy, silence) = silenceable_udp_forwarder(target).await;
    let through = TurnServer {
        secure: false,
        host: proxy.ip().to_string(),
        port: proxy.port(),
        transport: TurnTransport::Udp,
    };
    let mut doomed = relay_with(&env, vec![through], &env.password, true)
        .allocate()
        .await
        .expect("allocation through the forwarder");
    silence.send(true).expect("silence");
    let refresh_failure = tokio::spawn(async move {
        loop {
            match doomed.link.recv().await {
                Some(RelayEvent::Ended(failure)) => return Some(failure.kind),
                None => return None,
                Some(_) => {}
            }
        }
    });

    let world = world_with(relay_only(), relay(&env, RelayProtocol::Udp)).await;
    let identity = PeerIdentity::generate().expect("id");
    let code = world.authority.code().await;
    let mut config = config(code, JoinMode::Join);
    config.ice = relay_only();
    config.relay = relay(&env, RelayProtocol::Udp);
    let mut participant = try_join_with(&world, &identity, config)
        .await
        .expect("joined");
    let started = Instant::now();
    let mut nonce = 0;
    while started.elapsed() < Duration::from_secs(660) {
        nonce += 1;
        ping(&mut participant, nonce).await;
        tokio::time::sleep(Duration::from_secs(20)).await;
    }
    ping(&mut participant, nonce + 1).await;
    eprintln!(
        "{} pings over {:?} through TURN",
        nonce + 1,
        started.elapsed()
    );
    let ended = tokio::time::timeout(Duration::from_secs(60), refresh_failure)
        .await
        .expect("the silent allocation ended by now")
        .expect("task");
    assert_eq!(ended, Some(TurnFailureKind::RefreshFailed));
}
