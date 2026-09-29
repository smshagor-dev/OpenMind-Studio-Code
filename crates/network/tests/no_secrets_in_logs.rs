//! A proxy password is used by OpenMind's own client (the Download Manager and the package gateway) and nothing else: not
//! a process environment (no proxy variables are set any more), not a log line, not an error text, not what the UI shows. This runs alone in its own process with one global subscriber, so every log
//! line the crate writes while it runs is captured.

use std::io::Write;
use std::net::TcpListener;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use openmind_network::http::HttpProxy;
use openmind_network::probe::test_connection;
use openmind_network::problem::{NetError, NetProblem};
use openmind_network::proxy::{resolve_manual, Credentials, ProxySettings};
use openmind_network::redact::{redact, redact_env};
use openmind_network::retry::{with_mirrors, RetryPolicy};

const PASSWORD: &str = "Pa$$w0rd!secret";

#[derive(Clone, Default)]
struct Captured(Arc<Mutex<Vec<u8>>>);

impl Write for Captured {
    fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
        if let Ok(mut all) = self.0.lock() {
            all.extend_from_slice(bytes);
        }
        Ok(bytes.len())
    }
    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}

impl<'a> tracing_subscriber::fmt::MakeWriter<'a> for Captured {
    type Writer = Captured;
    fn make_writer(&'a self) -> Self::Writer {
        self.clone()
    }
}

#[test]
fn the_proxy_password_never_reaches_a_log_or_an_error() {
    let captured = Captured::default();
    tracing::subscriber::set_global_default(
        tracing_subscriber::fmt()
            .with_max_level(tracing::Level::TRACE)
            .with_writer(captured.clone())
            .finish(),
    )
    .expect("the only subscriber of this process");

    // A proxy that is not there (a port nobody listens on), with credentials.
    let dead = TcpListener::bind("127.0.0.1:0").expect("bind");
    let port = dead.local_addr().expect("addr").port();
    drop(dead);
    let resolved = resolve_manual(&ProxySettings {
        http: format!("127.0.0.2:{port}"),
        ..ProxySettings::default()
    });
    let creds = Credentials {
        username: "ivan".into(),
        password: PASSWORD.into(),
    };
    let proxy = HttpProxy {
        resolved: resolved.clone(),
        credentials: Some(creds.clone()),
    };

    // A value that quotes the proxy address with the password (a tool's own message) is shown without it.
    let quoted = vec![(
        "MESSAGE".to_string(),
        format!("connect via http://ivan:{PASSWORD}@proxy failed (ivan:Pa%24%24w0rd%21secret)"),
    )];
    for (_, value) in redact_env(&quoted, Some(&creds)) {
        assert!(!value.contains("w0rd"), "{value}");
    }

    // A real request through the dead proxy, then a retried download that keeps failing.
    let outcome = test_connection("https://example.invalid/", Some(&proxy));
    assert!(!outcome.ok);
    assert!(!format!("{outcome:?}").contains("w0rd"));
    let mut attempts = 0;
    let result: Result<(), NetError> = with_mirrors(
        &["https://a.invalid/x.zip".to_string()],
        RetryPolicy {
            attempts: 2,
            first_delay: Duration::ZERO,
        },
        &mut |_| {},
        &|| false,
        &mut |url| {
            attempts += 1;
            Err(NetError::new(
                NetProblem::Timeout,
                redact(
                    &format!("{url} via http://ivan:{PASSWORD}@proxy"),
                    Some(&creds),
                ),
            ))
        },
    );
    assert_eq!(attempts, 2);
    assert!(!format!("{result:?}").contains("w0rd"));

    let logs = String::from_utf8(captured.0.lock().expect("lock").clone()).expect("utf8");
    assert!(
        logs.contains("download attempt failed"),
        "the retries are logged: {logs}"
    );
    assert!(
        !logs.contains("w0rd"),
        "a log line contains the password:\n{logs}"
    );
    assert!(
        !logs.contains("Pa%24%24"),
        "a log line contains the encoded password:\n{logs}"
    );
}
