//! Against a real LiveKit server (ignored by default): `OPENMIND_TEST_LIVEKIT=<folder with livekit-server.exe>`.
//! Proves the tokens OpenMind signs are the ones the server accepts (and refuses the rest), that the admin token works
//! on the management API, and that the local server starts on one address and is gone after Stop.

use std::net::{IpAddr, SocketAddr, TcpStream};
use std::time::Duration;

use openmind_collab::sfu::{media_identity, member_token, ApiKey};
use openmind_collab::PeerId;

use super::local::{LocalSfu, HTTP_PORT};
use super::twirp;

fn server_dir() -> Option<std::path::PathBuf> {
    std::env::var("OPENMIND_TEST_LIVEKIT").ok().map(Into::into)
}

/// A LAN address of this computer (the media port doesn't listen on loopback with an address filter).
fn bind() -> IpAddr {
    openmind_collab_net::lan::netif::current()
        .iter()
        .flat_map(|i| i.ipv4.iter().map(|(ip, _)| IpAddr::V4(*ip)))
        .next()
        .unwrap_or_else(|| "127.0.0.1".parse().expect("ip"))
}

/// The server's own check of a token (the endpoint its clients use): the HTTP status.
fn validate(url: &str, token: &str) -> u16 {
    let base = twirp::http_base(url).expect("base");
    let agent: ureq::Agent = ureq::Agent::config_builder()
        .http_status_as_error(false)
        .proxy(None)
        .build()
        .into();
    agent
        .get(&format!("{base}/rtc/validate?access_token={token}"))
        .call()
        .map(|r| r.status().as_u16())
        .unwrap_or(0)
}

fn peer(n: u8) -> PeerId {
    PeerId::parse(&format!("{:064x}", n)).expect("peer")
}

#[test]
#[ignore = "needs a LiveKit server binary (OPENMIND_TEST_LIVEKIT)"]
fn the_real_server_accepts_owner_signed_tokens_and_refuses_bad_ones() {
    let Some(dir) = server_dir() else {
        eprintln!("skipped: set OPENMIND_TEST_LIVEKIT");
        return;
    };
    let work = tempfile::tempdir().expect("dir");
    let ip = bind();
    let folder = work.path().join("classroom-voice");
    let server = LocalSfu::start(&dir, &folder, &work.path().join("lk.log"), ip).expect("started");
    let url = server.url();
    let now = super::now_secs();
    let room = "0123456789abcdef0123456789abcdef";

    let speaker = member_token(&server.api, room, &peer(1), true, now).expect("token");
    let listener = member_token(&server.api, room, &peer(2), false, now).expect("token");
    assert_eq!(validate(&url, &speaker), 200, "a speaker's token");
    assert_eq!(validate(&url, &listener), 200, "a listener's token");

    let expired = member_token(&server.api, room, &peer(1), true, now - 3600).expect("token");
    assert_eq!(validate(&url, &expired), 401, "an expired token");
    let forged_key = ApiKey {
        key: server.api.key.clone(),
        secret: "not-the-servers-secret-at-all-0000".into(),
    };
    let forged = member_token(&forged_key, room, &peer(3), true, now).expect("token");
    assert_eq!(validate(&url, &forged), 401, "signed with another secret");
    let unknown_key = ApiKey {
        key: "OMunknownkey".into(),
        secret: server.api.secret.clone(),
    };
    assert_eq!(
        validate(
            &url,
            &member_token(&unknown_key, room, &peer(3), true, now).expect("t")
        ),
        401
    );

    // The admin token on the management API: an empty room lists nobody; removing someone absent is not an error.
    assert_eq!(
        twirp::participants(&url, &server.api, room).expect("list"),
        Vec::new()
    );
    twirp::remove(&url, &server.api, room, &media_identity(room, &peer(1))).expect("remove absent");
    // A forged admin token is refused.
    assert!(twirp::participants(&url, &forged_key, room).is_err());

    drop(server);
    std::thread::sleep(Duration::from_millis(300));
    let gone =
        TcpStream::connect_timeout(&SocketAddr::new(ip, HTTP_PORT), Duration::from_millis(300))
            .is_err();
    assert!(gone, "nothing listens after Stop");
    assert!(
        !folder.exists(),
        "the run's configuration is removed with it"
    );
}
