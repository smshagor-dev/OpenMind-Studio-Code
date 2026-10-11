//! The STUN codec and the gatherer against a local STUN responder.

use super::*;

/// A Binding success with an XOR-MAPPED-ADDRESS for `mapped` (what a STUN server sends).
fn success(transaction: &TransactionId, mapped: SocketAddr) -> Vec<u8> {
    let mut value = vec![0, 0];
    let port = mapped.port() ^ (MAGIC >> 16) as u16;
    match mapped.ip() {
        IpAddr::V4(ip) => {
            value[1] = 1;
            value.extend_from_slice(&port.to_be_bytes());
            value.extend(
                ip.octets()
                    .iter()
                    .zip(MAGIC.to_be_bytes())
                    .map(|(b, k)| b ^ k),
            );
        }
        IpAddr::V6(ip) => {
            value[1] = 2;
            value.extend_from_slice(&port.to_be_bytes());
            let mut key = MAGIC.to_be_bytes().to_vec();
            key.extend_from_slice(transaction);
            value.extend(ip.octets().iter().zip(key).map(|(b, k)| b ^ k));
        }
    }
    let mut out = Vec::new();
    out.extend_from_slice(&BINDING_SUCCESS.to_be_bytes());
    out.extend_from_slice(&((4 + value.len()) as u16).to_be_bytes());
    out.extend_from_slice(&MAGIC.to_be_bytes());
    out.extend_from_slice(transaction);
    out.extend_from_slice(&XOR_MAPPED_ADDRESS.to_be_bytes());
    out.extend_from_slice(&(value.len() as u16).to_be_bytes());
    out.extend_from_slice(&value);
    out
}

#[test]
fn requests_and_responses_round_trip_for_both_families() {
    let transaction = [7u8; 12];
    let request = binding_request(&transaction);
    assert!(is_stun(&request));
    for mapped in ["203.0.113.9:40000", "[2001:db8::7]:5000"] {
        let mapped: SocketAddr = mapped.parse().expect("addr");
        assert_eq!(
            parse_binding_response(&success(&transaction, mapped), &transaction),
            Some(mapped)
        );
    }
}

#[test]
fn foreign_truncated_and_non_stun_packets_are_ignored() {
    let transaction = [1u8; 12];
    let packet = success(&transaction, "198.51.100.1:1".parse().expect("addr"));
    assert_eq!(
        parse_binding_response(&packet, &[2u8; 12]),
        None,
        "another transaction"
    );
    assert_eq!(
        parse_binding_response(&packet[..25], &transaction),
        None,
        "truncated"
    );
    assert_eq!(
        parse_binding_response(b"\x16\xfe\xfd not stun at all", &transaction),
        None
    );
    assert!(!is_stun(&[0u8; 10]));
}

#[tokio::test]
async fn the_gatherer_adds_a_reflexive_candidate_from_a_stun_server() {
    let server = UdpSocket::bind("127.0.0.1:0").await.expect("bind");
    let server_addr = server.local_addr().expect("addr");
    let public: SocketAddr = "203.0.113.20:50000".parse().expect("addr");
    tokio::spawn(async move {
        let mut buf = [0u8; 1500];
        while let Ok((n, from)) = server.recv_from(&mut buf).await {
            if n >= 20 {
                let mut transaction = [0u8; 12];
                transaction.copy_from_slice(&buf[8..20]);
                let _ = server.send_to(&success(&transaction, public), from).await;
            }
        }
    });
    let socket = UdpSocket::bind("127.0.0.1:0").await.expect("bind");
    let gatherer = StunGatherer::new(vec![StunServer {
        host: "127.0.0.1".into(),
        port: server_addr.port(),
    }]);
    let candidates = gatherer.gather(&socket).await;
    assert_eq!(candidates.len(), 2);
    assert_eq!(candidates[0].kind, CandidateKind::Host);
    assert_eq!(
        (candidates[1].kind, candidates[1].addr),
        (CandidateKind::ServerReflexive, public)
    );
    assert_eq!(candidates[1].base, socket.local_addr().expect("addr"));
}

#[tokio::test]
async fn a_silent_stun_server_leaves_only_the_host_candidate() {
    let silent = UdpSocket::bind("127.0.0.1:0").await.expect("bind");
    let port = silent.local_addr().expect("addr").port();
    let socket = UdpSocket::bind("127.0.0.1:0").await.expect("bind");
    let gatherer = StunGatherer::new(vec![StunServer {
        host: "127.0.0.1".into(),
        port,
    }])
    .with_timeout(Duration::from_millis(300));
    let candidates = gatherer.gather(&socket).await;
    assert_eq!(candidates.len(), 1);
    drop(silent);
}
