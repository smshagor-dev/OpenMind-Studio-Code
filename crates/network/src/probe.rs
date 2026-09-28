//! Settings > Network > Test Connection: one request to the address the user chose, through the proxy in force, and
//! what came back as a category. Runs only when the user presses Test; no retries.

use std::time::{Duration, Instant};

use serde::Serialize;

use crate::http::{route_with, HttpProxy, Route};
use crate::problem::{classify_via, NetProblem};
use crate::redact::redact;

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TestOutcome {
    pub ok: bool,
    pub problem: Option<NetProblem>,
    pub status: Option<u16>,
    /// `direct`, `proxy` or `unchanged` (OpenMind added no proxy).
    pub route: String,
    /// The proxy used, without credentials.
    pub proxy: Option<String>,
    pub elapsed_ms: u64,
    /// The error text, credentials removed.
    pub detail: Option<String>,
}

/// Tests `url` (http or https only).
pub fn test_connection(url: &str, proxy: Option<&HttpProxy>) -> TestOutcome {
    let started = Instant::now();
    let lower = url.trim().to_ascii_lowercase();
    let finish = |ok, problem, status, route: &str, via: Option<String>, detail: Option<String>| {
        TestOutcome {
            ok,
            problem,
            status,
            route: route.to_string(),
            proxy: via,
            elapsed_ms: started.elapsed().as_millis() as u64,
            detail,
        }
    };
    if !(lower.starts_with("https://") || lower.starts_with("http://")) {
        return finish(
            false,
            Some(NetProblem::InsecureUrl),
            None,
            "direct",
            None,
            Some("only http:// and https:// addresses can be tested".into()),
        );
    }
    let mut builder = ureq::Agent::config_builder()
        .http_status_as_error(false)
        .max_redirects(0)
        .timeout_connect(Some(Duration::from_secs(10)))
        .timeout_recv_response(Some(Duration::from_secs(15)));
    let (route, via) = match route_with(proxy, url) {
        Route::Unchanged => ("unchanged", None),
        Route::Direct => {
            builder = builder.proxy(None);
            ("direct", None)
        }
        Route::Proxy(p) => {
            let shown = format!("{}:{}", p.host(), p.port());
            builder = builder.proxy(Some(p));
            ("proxy", Some(shown))
        }
    };
    let agent: ureq::Agent = builder.build().into();
    let credentials = proxy.and_then(|p| p.credentials.as_ref());
    match agent.get(url.trim()).call() {
        Ok(response) => {
            let status = response.status().as_u16();
            if status < 400 {
                finish(true, None, Some(status), route, via, None)
            } else {
                finish(
                    false,
                    Some(NetProblem::from_status(status)),
                    Some(status),
                    route,
                    via,
                    None,
                )
            }
        }
        Err(error) => {
            let detail = redact(&error.to_string(), credentials);
            finish(
                false,
                Some(classify_via(&error, route == "proxy")),
                None,
                route,
                via,
                Some(detail),
            )
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{Read, Write};
    use std::net::TcpListener;

    /// A one-shot local HTTP server answering `status`.
    fn serve_once(status: &'static str) -> String {
        let listener = TcpListener::bind("127.0.0.1:0").expect("bind");
        let port = listener.local_addr().expect("addr").port();
        std::thread::spawn(move || {
            if let Ok((mut stream, _)) = listener.accept() {
                let mut buf = [0u8; 1024];
                let _ = stream.read(&mut buf);
                let _ = stream.write_all(
                    format!("HTTP/1.1 {status}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n")
                        .as_bytes(),
                );
            }
        });
        format!("http://127.0.0.1:{port}/")
    }

    #[test]
    fn statuses_become_categories() {
        assert!(test_connection(&serve_once("200 OK"), None).ok);
        let blocked = test_connection(&serve_once("403 Forbidden"), None);
        assert_eq!(
            (blocked.ok, blocked.problem, blocked.status),
            (false, Some(NetProblem::Blocked), Some(403))
        );
        let auth = test_connection(&serve_once("407 Proxy Authentication Required"), None);
        assert_eq!(auth.problem, Some(NetProblem::ProxyAuthRequired));
    }

    #[test]
    fn a_dead_address_and_a_bad_scheme_are_reported() {
        let listener = TcpListener::bind("127.0.0.1:0").expect("bind");
        let port = listener.local_addr().expect("addr").port();
        drop(listener);
        let dead = test_connection(&format!("http://127.0.0.1:{port}/"), None);
        assert!(!dead.ok);
        assert!(matches!(
            dead.problem,
            Some(NetProblem::ConnectionFailed | NetProblem::Io | NetProblem::Other)
        ));
        assert_eq!(
            test_connection("file:///C:/x", None).problem,
            Some(NetProblem::InsecureUrl)
        );
    }
}
