//! Serving helpers shared by the providers, and the explicit download endpoint `<base>/fetch?url=<https URL>[&sha256=]`
//! that `openmind-fetch` uses: the file is downloaded by the broker (resume, retries, checksum when given, staging) and
//! passed on to the caller while it arrives (see `live`), so a large file never runs into the tool's read timeout.

use std::io::{self, Write};
use std::sync::{mpsc, Arc};
use std::time::Duration;

use super::http1::{write_error, write_stream, Request};
use super::live::{wait_for_start, LiveRead, Start};
use super::server::Shared;
use super::upstream::{request_headers, UpRequest};
use crate::broker::ArtifactRequest;
use crate::staging::{safe_file_name, Provider};

/// How long the answer waits for the first downloaded bytes before it starts anyway (headers out, body to follow).
const FIRST_BYTE_WAIT: Duration = Duration::from_secs(8);

/// Downloads `artifact` through the broker and passes it on: a file that is already there (or arrives at once) with
/// its length as before; otherwise its bytes as they arrive, the answer completing only once the broker has verified
/// the whole file. A failure before any byte is answered with a status the tool understands and the precise reason.
pub(crate) fn serve_artifact(
    shared: &Shared,
    artifact: &ArtifactRequest,
    out: &mut dyn Write,
) -> io::Result<()> {
    let (done, outcome) = mpsc::channel();
    let broker = Arc::clone(&shared.broker);
    let request = artifact.clone();
    // The download runs on its own: a tool that gives up doesn't cancel a download other requests may share.
    std::thread::spawn(move || {
        let _ = done.send(broker.fetch(&request));
    });
    let name = safe_file_name(&artifact.url);
    let part = shared
        .broker
        .staging()
        .part_file(artifact.provider, &artifact.url, &artifact.url);
    let finished = match wait_for_start(&part, &outcome, FIRST_BYTE_WAIT) {
        Start::Finished(result) => result,
        Start::Streaming => {
            let mut body = LiveRead::new(part, outcome);
            return write_stream(out, 200, &download_headers(&name), &mut body, None).map(|_| ());
        }
    };
    let lease = match finished {
        Ok(lease) => lease,
        Err(error) => {
            let status = error.kind.gateway_status(error.status);
            return write_error(
                out,
                status,
                &format!("{}: {}", error.kind.label(), error.detail),
            );
        }
    };
    let mut file = lease.open()?;
    write_stream(
        out,
        200,
        &download_headers(&name),
        &mut file,
        Some(lease.len()),
    )
    .map(|_| ())
}

fn download_headers(name: &str) -> Vec<(String, String)> {
    vec![
        (
            "Content-Type".to_string(),
            "application/octet-stream".to_string(),
        ),
        (
            "Content-Disposition".to_string(),
            format!("attachment; filename=\"{name}\""),
        ),
    ]
}

/// Passes one GET on to `url` and streams the answer back (status and allowed headers kept).
pub(crate) fn pass_through(
    shared: &Shared,
    request: &Request,
    url: &str,
    with_auth: bool,
    out: &mut dyn Write,
) -> io::Result<()> {
    let headers = request_headers(&request.headers)
        .into_iter()
        .filter(|(name, _)| with_auth || !name.eq_ignore_ascii_case("authorization"))
        .collect();
    match shared.upstream.send(UpRequest {
        method: "GET".into(),
        url: url.to_string(),
        headers,
        body: Vec::new(),
        follow_redirects: true,
    }) {
        Ok(mut response) => {
            let headers = response.headers.clone();
            write_stream(out, response.status, &headers, &mut response.body, None).map(|_| ())
        }
        Err(error) => {
            tracing::warn!(%url, kind = ?error.kind, detail = %error.detail, "gateway request failed");
            write_error(
                out,
                error.kind.gateway_status(error.status),
                &format!("{}: {}", error.kind.label(), error.detail),
            )
        }
    }
}

/// An address `openmind-fetch` may download: https, a host, no user name or password in it, no spaces or controls.
pub fn valid_download_url(url: &str) -> bool {
    let Some(rest) = url.strip_prefix("https://") else {
        return false;
    };
    let authority = rest.split(['/', '?', '#']).next().unwrap_or_default();
    let host = if let Some(inner) = authority.strip_prefix('[') {
        inner
            .split(']')
            .next()
            .unwrap_or_default()
            .to_ascii_lowercase()
    } else {
        authority
            .split(':')
            .next()
            .unwrap_or_default()
            .to_ascii_lowercase()
    };
    // Never this computer: the gateway can't be pointed back at itself or at a local service.
    let local = host == "localhost"
        || host.ends_with(".localhost")
        || host
            .parse::<std::net::IpAddr>()
            .is_ok_and(|ip| ip.is_loopback() || ip.is_unspecified())
        || host
            .parse::<std::net::Ipv4Addr>()
            .is_ok_and(|ip| ip.is_link_local());
    url.len() <= 4096
        && !authority.is_empty()
        && !authority.contains('@')
        && !local
        && !url.chars().any(|c| c.is_whitespace() || c.is_control())
}

pub(crate) fn handle(shared: &Shared, request: &Request, out: &mut dyn Write) -> io::Result<()> {
    if request.method != "GET" {
        return write_error(out, 405, "only GET is served");
    }
    let Some(url) = request.param("url").filter(|url| valid_download_url(url)) else {
        return write_error(
            out,
            400,
            "give an https:// address without a user name or password",
        );
    };
    let sha256 = request.param("sha256").filter(|s| !s.is_empty());
    if sha256
        .as_deref()
        .is_some_and(|s| s.len() != 64 || !s.chars().all(|c| c.is_ascii_hexdigit()))
    {
        return write_error(out, 400, "sha256 must be 64 hexadecimal characters");
    }
    let artifact = ArtifactRequest {
        provider: Provider::Download,
        url,
        mirrors: Vec::new(),
        sha256,
        size: None,
    };
    serve_artifact(shared, &artifact, out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_plain_https_addresses_can_be_fetched() {
        assert!(valid_download_url("https://example.org/a/b.zip?x=1"));
        assert!(!valid_download_url("http://example.org/a.zip"));
        assert!(!valid_download_url("https://user:pw@example.org/a.zip"));
        assert!(!valid_download_url("https:///a.zip"));
        assert!(!valid_download_url("https://example.org/a b.zip"));
        assert!(!valid_download_url("file:///C:/Windows/win.ini"));
        for local in [
            "https://localhost/a",
            "https://127.0.0.1:4000/tok/fetch",
            "https://[::1]/a",
            "https://0.0.0.0/a",
            "https://169.254.169.254/latest/meta-data",
            "https://x.localhost/a",
        ] {
            assert!(!valid_download_url(local), "{local}");
        }
    }
}
