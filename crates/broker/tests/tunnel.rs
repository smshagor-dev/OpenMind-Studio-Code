//! The CONNECT tunnel through an upstream HTTP proxy on this computer (like Px or CNTLM): it must use the proxy in force
//! with OpenMind's saved credentials, relay bytes both ways, and report a proxy that refuses the credentials.
//! One test per file: the proxy in force is process-wide.

use std::io::{BufRead, BufReader, Read, Write};
use std::net::{TcpListener, TcpStream};
use std::sync::{Arc, Mutex};

use openmind_broker::gateway::tunnel::base64;
use openmind_broker::gateway::UreqUpstream;
use openmind_broker::{Broker, Gateway, GatewayConfig, Staging};
use openmind_network::http::{set_current, HttpProxy};
use openmind_network::proxy::{resolve_manual, Credentials, ProxySettings};
use openmind_runtime_manager::UreqClient;

/// A proxy that accepts `CONNECT` only with `ivan:s3cr3t`, then answers every line with it upper-cased.
fn fake_proxy(seen: Arc<Mutex<Vec<String>>>) -> u16 {
    let listener = TcpListener::bind(("127.0.0.1", 0)).expect("bind");
    let port = listener.local_addr().expect("addr").port();
    std::thread::spawn(move || {
        for stream in listener.incoming().flatten() {
            let seen = Arc::clone(&seen);
            std::thread::spawn(move || {
                let mut writer = stream.try_clone().expect("clone");
                let mut reader = BufReader::new(stream);
                let mut head = Vec::new();
                loop {
                    let mut line = String::new();
                    if reader.read_line(&mut line).unwrap_or(0) == 0 || line.trim().is_empty() {
                        break;
                    }
                    head.push(line.trim().to_string());
                }
                seen.lock().expect("lock").extend(head.clone());
                let expected = format!("Proxy-Authorization: Basic {}", base64(b"ivan:s3cr3t"));
                if !head.contains(&expected) {
                    let _ = writer.write_all(
                        b"HTTP/1.1 407 Proxy Authentication Required\r\nContent-Length: 0\r\n\r\n",
                    );
                    return;
                }
                let _ = writer.write_all(b"HTTP/1.1 200 Connection established\r\n\r\n");
                let mut line = String::new();
                while reader.read_line(&mut line).unwrap_or(0) > 0 {
                    let _ = writer.write_all(line.to_uppercase().as_bytes());
                    line.clear();
                }
            });
        }
    });
    port
}

fn use_proxy(port: u16, password: &str) {
    set_current(Some(HttpProxy {
        resolved: resolve_manual(&ProxySettings {
            http: format!("127.0.0.1:{port}"),
            ..ProxySettings::default()
        }),
        credentials: Some(Credentials {
            username: "ivan".into(),
            password: password.into(),
        }),
    }));
}

fn connect_through(gateway: &Gateway) -> (BufReader<TcpStream>, TcpStream, String) {
    let stream = TcpStream::connect(("127.0.0.1", gateway.port())).expect("connect");
    let mut writer = stream.try_clone().expect("clone");
    let auth = base64(format!("cargo:{}", gateway.token()).as_bytes());
    // The first line for the server is sent together with CONNECT, as TLS clients do.
    writer
        .write_all(format!("CONNECT index.crates.io:443 HTTP/1.1\r\nHost: index.crates.io:443\r\nProxy-Authorization: Basic {auth}\r\n\r\nearly line\n").as_bytes())
        .expect("send");
    let mut reader = BufReader::new(stream);
    let mut status = String::new();
    reader.read_line(&mut status).expect("status");
    let mut line = String::new();
    while reader.read_line(&mut line).expect("head") > 2 {
        line.clear();
    }
    (reader, writer, status)
}

#[test]
fn the_tunnel_uses_the_proxy_in_force_with_its_credentials() {
    let seen = Arc::new(Mutex::new(Vec::new()));
    let port = fake_proxy(Arc::clone(&seen));
    let tmp = tempfile::tempdir().expect("tmp");
    let broker = Broker::new(
        Staging::new(tmp.path()),
        Arc::new(UreqClient::new()),
        Arc::new(|_| {}),
    );
    let gateway = Gateway::start(
        Arc::new(broker),
        Arc::new(UreqUpstream),
        GatewayConfig::default(),
    )
    .expect("gateway");

    use_proxy(port, "s3cr3t");
    let (mut reader, mut writer, status) = connect_through(&gateway);
    assert!(status.starts_with("HTTP/1.1 200"), "{status}");
    let mut echoed = String::new();
    reader.read_line(&mut echoed).expect("early echo");
    assert_eq!(
        echoed, "EARLY LINE\n",
        "bytes sent with CONNECT reach the server"
    );
    writer.write_all(b"second\n").expect("send");
    echoed.clear();
    reader.read_line(&mut echoed).expect("echo");
    assert_eq!(echoed, "SECOND\n");
    drop(writer);
    let head = seen.lock().expect("lock").clone();
    assert!(
        head.iter()
            .any(|l| l == "CONNECT index.crates.io:443 HTTP/1.1"),
        "{head:?}"
    );

    // Wrong saved password: the proxy says 407 and the tool is told why.
    use_proxy(port, "wrong");
    let (mut reader, _writer, status) = connect_through(&gateway);
    assert!(status.starts_with("HTTP/1.1 502"), "{status}");
    let mut rest = String::new();
    let _ = reader.read_to_string(&mut rest);
    assert!(rest.contains("proxy authentication required"), "{rest}");
    set_current(None);
}
