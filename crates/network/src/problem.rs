//! What went wrong on the network, in categories the UI can explain and act on — from an HTTP client error, an HTTP
//! status, or the text a tool (git, pip, npm, composer, cargo, go, curl) printed.

use serde::Serialize;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum NetProblem {
    /// The name couldn't be resolved (no DNS, or DNS only through the proxy).
    Dns,
    Timeout,
    /// Nothing answered at the address.
    ConnectionFailed,
    /// The network has no route to the address (no network, or the network doesn't let it through).
    Unreachable,
    /// The proxy couldn't be reached or refused the tunnel.
    ProxyUnavailable,
    /// The proxy wants a user name and password (HTTP 407).
    ProxyAuthRequired,
    /// Certificate or TLS failure (often a network that inspects HTTPS).
    Tls,
    /// The network or server refused the address (403/451).
    Blocked,
    NotFound,
    /// Another HTTP status.
    Http,
    /// The file arrived but isn't the expected one.
    Checksum,
    /// Only https:// is allowed for downloads.
    InsecureUrl,
    Cancelled,
    Io,
    Other,
}

impl NetProblem {
    /// Worth trying the same address again after a pause.
    pub fn retryable(self) -> bool {
        matches!(
            self,
            NetProblem::Timeout | NetProblem::ConnectionFailed | NetProblem::Io | NetProblem::Http
        )
    }

    /// No other address will do better (the user must act first).
    pub fn fatal(self) -> bool {
        matches!(
            self,
            NetProblem::ProxyAuthRequired | NetProblem::Cancelled | NetProblem::InsecureUrl
        )
    }

    /// A short English label, used in error text (and recognized again by [`diagnose`]).
    pub fn label(self) -> &'static str {
        match self {
            NetProblem::Dns => "DNS lookup failed",
            NetProblem::Timeout => "timed out",
            NetProblem::ConnectionFailed => "connection failed",
            NetProblem::Unreachable => "network unreachable",
            NetProblem::ProxyUnavailable => "proxy unavailable",
            NetProblem::ProxyAuthRequired => "proxy authentication required",
            NetProblem::Tls => "TLS/certificate error",
            NetProblem::Blocked => "blocked by the network or server",
            NetProblem::NotFound => "not found",
            NetProblem::Http => "HTTP error",
            NetProblem::Checksum => "checksum mismatch",
            NetProblem::InsecureUrl => "insecure address",
            NetProblem::Cancelled => "cancelled",
            NetProblem::Io => "network read/write error",
            NetProblem::Other => "network error",
        }
    }

    /// The category of an HTTP status that isn't a success.
    pub fn from_status(status: u16) -> NetProblem {
        match status {
            407 => NetProblem::ProxyAuthRequired,
            403 | 451 => NetProblem::Blocked,
            404 | 410 => NetProblem::NotFound,
            _ => NetProblem::Http,
        }
    }
}

/// A network failure: its category and a detail line (already free of credentials).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, thiserror::Error)]
#[serde(rename_all = "camelCase")]
#[error("{detail}")]
pub struct NetError {
    pub problem: NetProblem,
    pub detail: String,
    pub status: Option<u16>,
}

impl NetError {
    pub fn new(problem: NetProblem, detail: impl Into<String>) -> Self {
        NetError {
            problem,
            detail: detail.into(),
            status: None,
        }
    }

    pub fn status(status: u16, url: &str) -> Self {
        NetError {
            problem: NetProblem::from_status(status),
            detail: format!("HTTP {status} from {url}"),
            status: Some(status),
        }
    }
}

/// Classifies an error of the HTTP client.
pub fn classify(error: &ureq::Error) -> NetProblem {
    use ureq::Error as E;
    match error {
        E::StatusCode(status) => NetProblem::from_status(*status),
        E::HostNotFound => NetProblem::Dns,
        E::Timeout(_) | E::BodyStalled => NetProblem::Timeout,
        E::ConnectionFailed => NetProblem::ConnectionFailed,
        E::ConnectProxyFailed(message) => {
            if message.contains("407") {
                NetProblem::ProxyAuthRequired
            } else {
                NetProblem::ProxyUnavailable
            }
        }
        E::InvalidProxyUrl => NetProblem::ProxyUnavailable,
        E::Tls(_) | E::Pem(_) | E::Rustls(_) | E::TlsRequired => NetProblem::Tls,
        E::RequireHttpsOnly(_) => NetProblem::InsecureUrl,
        E::Io(io) => classify_io(io),
        _ => {
            let text = error.to_string().to_ascii_lowercase();
            diagnose(&text).unwrap_or(NetProblem::Other)
        }
    }
}

/// Windows Sockets errors of a failed name lookup: host not found, try again, no recovery, no data.
const WSA_DNS_ERRORS: [i32; 4] = [11001, 11002, 11003, 11004];

/// Classifies an I/O error. Name lookups and TLS handshakes fail as I/O errors (ureq resolves with the standard
/// library, rustls reports a bad certificate through the stream), so the error code and the message decide before
/// falling back to "network read/write error".
pub fn classify_io(error: &std::io::Error) -> NetProblem {
    use std::io::ErrorKind as K;
    if error
        .raw_os_error()
        .is_some_and(|code| WSA_DNS_ERRORS.contains(&code))
    {
        return NetProblem::Dns;
    }
    match error.kind() {
        K::TimedOut => return NetProblem::Timeout,
        K::ConnectionRefused | K::ConnectionReset | K::ConnectionAborted => {
            return NetProblem::ConnectionFailed
        }
        K::NetworkUnreachable | K::HostUnreachable | K::NetworkDown => {
            return NetProblem::Unreachable
        }
        _ => {}
    }
    diagnose(&error.to_string()).unwrap_or(NetProblem::Io)
}

/// [`classify`] for a request that went through a proxy: failing to reach anything then means the proxy itself
/// is unreachable (a refused connection, or the proxy's name doesn't resolve).
pub fn classify_via(error: &ureq::Error, through_proxy: bool) -> NetProblem {
    match classify(error) {
        NetProblem::ConnectionFailed | NetProblem::Dns if through_proxy => {
            NetProblem::ProxyUnavailable
        }
        other => other,
    }
}

/// Recognizes a network failure in what a tool printed. `None` when the text shows no network problem it knows.
/// The order matters: an authentication answer from a proxy is more specific than "could not connect".
pub fn diagnose(output: &str) -> Option<NetProblem> {
    let text = output.to_ascii_lowercase();
    let any = |needles: &[&str]| needles.iter().any(|needle| text.contains(needle));
    if any(&[
        "407 proxy authentication",
        "proxy authentication required",
        "http 407",
        "status code 407",
        "received http code 407",
        "response 407",
        "e407",
        "proxyauthenticationrequired",
        "proxy requires authentication",
    ]) {
        return Some(NetProblem::ProxyAuthRequired);
    }
    if any(&[
        "could not resolve proxy",
        "proxy unavailable",
        "proxyerror",
        "cannot connect to proxy",
        "unable to connect to proxy",
        "proxy connect aborted",
        "failed to connect to proxy",
        "proxy connection refused",
        "tunnel connection failed",
    ]) {
        return Some(NetProblem::ProxyUnavailable);
    }
    if any(&[
        "tls/certificate error",
        "ssl certificate problem",
        "certificate_verify_failed",
        "unable_to_get_issuer_cert",
        "unable to get local issuer certificate",
        "self signed certificate",
        "self-signed certificate",
        "certificate verify failed",
        "ssl: ",
        "sslerror",
        "invalid peer certificate",
        "schannel",
        "x509: certificate",
        "unknownissuer",
        "invalid certificate",
        "certificate verification failed",
        "received fatal alert",
        "corrupt message",
    ]) {
        return Some(NetProblem::Tls);
    }
    if any(&[
        "dns lookup failed",
        "could not resolve host",
        "getaddrinfo",
        "enotfound",
        "name or service not known",
        "no such host is known",
        "temporary failure in name resolution",
        "errno 11001",
        "failed to resolve",
        "dns error",
        "no such host",
        "failed to lookup address",
        "nodename nor servname",
        "no address associated",
        "host not found",
    ]) {
        return Some(NetProblem::Dns);
    }
    if any(&[
        "timed out",
        "etimedout",
        "timeout was reached",
        "operation timed out",
        "i/o timeout",
        "read timed out",
    ]) {
        return Some(NetProblem::Timeout);
    }
    if any(&[
        "network is unreachable",
        "no route to host",
        "enetunreach",
        "ehostunreach",
        "network unreachable",
    ]) {
        return Some(NetProblem::Unreachable);
    }
    if any(&[
        "connection refused",
        "connection failed",
        "econnrefused",
        "failed to connect to",
        "could not connect to server",
        "econnreset",
        "connection reset",
    ]) {
        return Some(NetProblem::ConnectionFailed);
    }
    if any(&[
        "blocked by the network",
        "403 forbidden",
        "http 403",
        "status code 403",
        "e403",
        "451 unavailable",
    ]) {
        return Some(NetProblem::Blocked);
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tool_output_from_every_supported_tool_is_recognized() {
        let cases: &[(&str, NetProblem)] = &[
            // git (curl underneath)
            ("fatal: unable to access 'https://github.com/x/y.git/': Received HTTP code 407 from proxy after CONNECT", NetProblem::ProxyAuthRequired),
            ("fatal: unable to access '...': Could not resolve host: github.com", NetProblem::Dns),
            ("fatal: unable to access '...': SSL certificate problem: unable to get local issuer certificate", NetProblem::Tls),
            ("fatal: unable to access '...': Failed to connect to proxy.lab port 3128 after 2000 ms: Timed out", NetProblem::ProxyUnavailable),
            // pip
            ("WARNING: Retrying (Retry(total=4)) after connection broken by 'ProxyError('Cannot connect to proxy.'", NetProblem::ProxyUnavailable),
            ("ERROR: Could not install packages due to an OSError: HTTPSConnectionPool: Max retries exceeded (Caused by NewConnectionError: Failed to establish a new connection: [Errno 11001] getaddrinfo failed))", NetProblem::Dns),
            ("pip._vendor.urllib3.exceptions.SSLError: [SSL: CERTIFICATE_VERIFY_FAILED]", NetProblem::Tls),
            // npm
            ("npm ERR! code E407\nnpm ERR! 407 Proxy Authentication Required", NetProblem::ProxyAuthRequired),
            ("npm ERR! code ENOTFOUND\nnpm ERR! getaddrinfo ENOTFOUND registry.npmjs.org", NetProblem::Dns),
            ("npm ERR! code UNABLE_TO_GET_ISSUER_CERT_LOCALLY", NetProblem::Tls),
            ("npm ERR! code ETIMEDOUT", NetProblem::Timeout),
            // composer
            ("curl error 7 while downloading https://repo.packagist.org/packages.json: Failed to connect to repo.packagist.org port 443: Connection refused", NetProblem::ConnectionFailed),
            // cargo
            ("error: failed to get `serde` ... [6] Couldn't resolve host name (Could not resolve host: index.crates.io)", NetProblem::Dns),
            // go
            ("go: github.com/x/y@v1: Get \"https://proxy.golang.org/...\": dial tcp: lookup proxy.golang.org: no such host", NetProblem::Dns),
            ("go: ... x509: certificate signed by unknown authority", NetProblem::Tls),
            // curl
            ("curl: (56) CONNECT tunnel failed, response 407", NetProblem::ProxyAuthRequired),
            ("curl: (28) Operation timed out after 30000 milliseconds", NetProblem::Timeout),
            ("curl: (22) The requested URL returned error: 403 Forbidden", NetProblem::Blocked),
        ];
        for (text, expected) in cases {
            assert_eq!(diagnose(text), Some(*expected), "{text}");
        }
        for problem in [
            NetProblem::Dns,
            NetProblem::Timeout,
            NetProblem::ConnectionFailed,
            NetProblem::ProxyUnavailable,
            NetProblem::ProxyAuthRequired,
            NetProblem::Tls,
            NetProblem::Blocked,
            NetProblem::Unreachable,
        ] {
            let text = format!("download failed ({}): x", problem.label());
            assert_eq!(diagnose(&text), Some(problem), "{text}");
        }
        // The real university case: pip ends with "No matching distribution found", but the cause is the proxy.
        let university = "WARNING: Retrying (Retry(total=4, connect=None, read=None, redirect=None, status=None)) after \
            connection broken by 'ProxyError('Unable to connect to proxy', OSError('Tunnel connection failed: 407 Proxy \
            Authentication Required'))': /simple/requests/\n\
            ERROR: Could not find a version that satisfies the requirement requests (from versions: none)\n\
            ERROR: No matching distribution found for requests";
        assert_eq!(diagnose(university), Some(NetProblem::ProxyAuthRequired));
        // Without a network cause, a missing package is not a network problem at all.
        assert_eq!(
            diagnose("ERROR: No matching distribution found for nosuchpkg"),
            None
        );
        assert_eq!(diagnose("Successfully installed six-1.16.0"), None);
        assert_eq!(diagnose(""), None);
    }

    #[test]
    fn statuses_and_retry_rules() {
        assert_eq!(NetProblem::from_status(407), NetProblem::ProxyAuthRequired);
        assert_eq!(NetProblem::from_status(403), NetProblem::Blocked);
        assert_eq!(NetProblem::from_status(404), NetProblem::NotFound);
        assert_eq!(NetProblem::from_status(502), NetProblem::Http);
        assert!(NetProblem::Timeout.retryable());
        assert!(!NetProblem::Checksum.retryable());
        assert!(NetProblem::ProxyAuthRequired.fatal());
        assert!(!NetProblem::Dns.fatal());
        assert_eq!(classify(&ureq::Error::HostNotFound), NetProblem::Dns);
        assert_eq!(
            classify_via(&ureq::Error::HostNotFound, true),
            NetProblem::ProxyUnavailable
        );
        assert_eq!(
            classify_via(&ureq::Error::ConnectionFailed, true),
            NetProblem::ProxyUnavailable
        );
        assert_eq!(
            classify_via(&ureq::Error::ConnectionFailed, false),
            NetProblem::ConnectionFailed
        );
        assert_eq!(
            classify_via(&ureq::Error::StatusCode(407), true),
            NetProblem::ProxyAuthRequired
        );
        assert_eq!(
            classify(&ureq::Error::StatusCode(407)),
            NetProblem::ProxyAuthRequired
        );
        assert_eq!(
            classify(&ureq::Error::ConnectProxyFailed("CONNECT 407".into())),
            NetProblem::ProxyAuthRequired
        );
        assert_eq!(
            classify(&ureq::Error::ConnectProxyFailed("refused".into())),
            NetProblem::ProxyUnavailable
        );
    }
    #[test]
    fn io_errors_of_name_lookups_and_certificates_are_not_a_generic_read_error() {
        use std::io::{Error, ErrorKind};
        // What ureq returns when Windows can't resolve a name (to_socket_addrs): "No such host is known. (os error 11001)".
        for code in [11001, 11002, 11004] {
            assert_eq!(
                classify_io(&Error::from_raw_os_error(code)),
                NetProblem::Dns,
                "{code}"
            );
            assert_eq!(
                classify(&ureq::Error::Io(Error::from_raw_os_error(code))),
                NetProblem::Dns
            );
        }
        // Other systems word it differently.
        let unix = Error::other("failed to lookup address information: Name or service not known");
        assert_eq!(classify_io(&unix), NetProblem::Dns);
        // rustls reports a certificate it doesn't trust through the stream as InvalidData.
        for text in [
            "invalid peer certificate: UnknownIssuer",
            "invalid peer certificate: certificate expired",
            "received fatal alert: HandshakeFailure",
            "received corrupt message of type InvalidContentType",
        ] {
            let error = ureq::Error::Io(Error::new(ErrorKind::InvalidData, text));
            assert_eq!(classify(&error), NetProblem::Tls, "{text}");
        }
        assert_eq!(
            classify_io(&Error::from(ErrorKind::NetworkUnreachable)),
            NetProblem::Unreachable
        );
        assert_eq!(
            classify_io(&Error::from(ErrorKind::HostUnreachable)),
            NetProblem::Unreachable
        );
        assert_eq!(
            classify_io(&Error::from(ErrorKind::ConnectionAborted)),
            NetProblem::ConnectionFailed
        );
        assert_eq!(
            classify_io(&Error::from(ErrorKind::TimedOut)),
            NetProblem::Timeout
        );
        // Only something truly unknown stays a read/write error.
        assert_eq!(
            classify_io(&Error::other("unexpected end of file")),
            NetProblem::Io
        );
    }

    #[test]
    fn pip_output_with_a_proxy_cause_is_never_a_missing_package() {
        // Every indicator of an authenticating proxy wins over pip's closing "No matching distribution".
        let causes = [
            "OSError('Tunnel connection failed: 407 Proxy Authentication Required')",
            "ProxyError('Cannot connect to proxy.', OSError('Tunnel connection failed: 407 Proxy Authentication Required'))",
            "urllib3 ... Proxy Authentication Required",
            "the proxy requires authentication",
        ];
        for package in ["django", "pandas"] {
            for cause in causes {
                let output = format!(
                    "WARNING: Retrying (Retry(total=4, connect=None, read=None, redirect=None, status=None)) after \
                     connection broken by '{cause}': /simple/{package}/\n\
                     ERROR: Could not find a version that satisfies the requirement {package} (from versions: none)\n\
                     ERROR: No matching distribution found for {package}"
                );
                assert_eq!(
                    diagnose(&output),
                    Some(NetProblem::ProxyAuthRequired),
                    "{output}"
                );
            }
        }
        // A tunnel failure without 407 is a proxy that doesn't work: still not a missing package.
        let unavailable =
            "after connection broken by 'ProxyError('Unable to connect to proxy', OSError('Tunnel \
            connection failed: 503 Service Unavailable'))': /simple/django/\n\
            ERROR: No matching distribution found for django";
        assert_eq!(diagnose(unavailable), Some(NetProblem::ProxyUnavailable));
        // A really missing package, with no network cause, isn't a network problem.
        assert_eq!(
            diagnose(
                "ERROR: Could not find a version that satisfies the requirement djangoo (from versions: none)\n\
                 ERROR: No matching distribution found for djangoo"
            ),
            None
        );
    }
}
