//! Git over smart HTTP: `<base>/git/https/<host>/<repository path>`. Git in OpenMind's terminals gets a process-local
//! `url.<base>/git/https/.insteadOf=https://` (and an identity `pushInsteadOf`, so pushes keep Git's own connection),
//! which leaves `origin` in `.git/config` as the real `https://` address. The gateway passes Git's discovery request and
//! the `git-upload-pack` exchange to the real host through the Download Manager's route and streams the pack back; Git
//! still verifies every object and writes the real repository (`.git`, history, refs, remotes). Nothing is staged:
//! Git's own temporary pack files are Git's. Pushing (`git-receive-pack`) is not served.

use std::io::{self, Read, Write};
use std::sync::Arc;
use std::time::{Duration, Instant};

use super::http1::{write_error, write_stream, Request};
use super::server::Shared;
use super::upstream::{request_headers, UpRequest};
use crate::events::{Phase, Reporter};
use crate::staging::Provider;

/// `host[:port]` of a Git server: a DNS name or an IPv4 address.
fn valid_host(host: &str) -> bool {
    let (name, port) = host.split_once(':').unwrap_or((host, ""));
    !name.is_empty()
        && name.len() <= 253
        && !name.starts_with(['.', '-'])
        && name
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '-'))
        && !name.eq_ignore_ascii_case("localhost")
        && (port.is_empty() || port.parse::<u16>().is_ok_and(|p| p > 0))
}

fn valid_repo_path(path: &str) -> bool {
    !path.is_empty()
        && path.len() <= 2048
        && !path.split('/').any(|part| part == "." || part == "..")
        && path.chars().all(|c| {
            c.is_ascii_alphanumeric()
                || matches!(c, '/' | '.' | '_' | '-' | '~' | '%' | '+' | '@' | ':')
        })
}

/// The service a smart-HTTP request is for, if any (`upload-pack` is fetching, `receive-pack` pushing).
fn service(request: &Request, path: &str) -> Option<&'static str> {
    let asked = request.param("service");
    if path.ends_with("git-receive-pack") || asked.as_deref() == Some("git-receive-pack") {
        Some("receive-pack")
    } else if path.ends_with("git-upload-pack") || asked.as_deref() == Some("git-upload-pack") {
        Some("upload-pack")
    } else {
        None
    }
}

pub(crate) fn handle(
    shared: &Shared,
    request: &Request,
    rest: &str,
    out: &mut dyn Write,
) -> io::Result<()> {
    let Some(remote) = rest.strip_prefix("https/") else {
        return write_error(out, 404, "only https:// Git remotes are served");
    };
    let (host, path) = remote.split_once('/').unwrap_or((remote, ""));
    if !valid_host(host) || !valid_repo_path(path) {
        return write_error(out, 400, "not a Git repository address");
    }
    if service(request, path) == Some("receive-pack") {
        return write_error(
            out,
            403,
            "pushing uses Git's own connection, not OpenMind's gateway",
        );
    }
    let posting = request.method == "POST";
    if posting && !path.ends_with("git-upload-pack") {
        return write_error(out, 405, "only git-upload-pack is posted");
    }
    if !posting && request.method != "GET" {
        return write_error(out, 405, "only GET and POST are served for Git");
    }
    let query = request.query().map(|q| format!("?{q}")).unwrap_or_default();
    let url = format!("https://{host}/{path}{query}");
    let response = match shared.upstream.send(UpRequest {
        method: request.method.clone(),
        url: url.clone(),
        headers: request_headers(&request.headers),
        body: request.body.clone(),
        follow_redirects: false,
    }) {
        Ok(response) => response,
        Err(error) => {
            tracing::warn!(%url, kind = ?error.kind, detail = %error.detail, "git request failed");
            return write_error(
                out,
                error.kind.gateway_status(error.status),
                &format!("{}: {}", error.kind.label(), error.detail),
            );
        }
    };
    let status = response.status;
    let mut headers = response.headers.clone();
    // A redirect to another https address stays on the gateway.
    for (name, value) in headers.iter_mut() {
        if name.eq_ignore_ascii_case("location") {
            if let Some(target) = value.strip_prefix("https://") {
                *value = format!("{}/git/https/{target}", shared.base());
            }
        }
    }
    if status >= 400 {
        tracing::warn!(%url, status, "git remote refused the request");
    }
    let mut body = response.body;
    if posting && status == 200 {
        let name = path.trim_end_matches("/git-upload-pack").to_string();
        let mut reporter = Reporter::new(
            Arc::clone(shared.broker.events()),
            shared.broker.next_id(),
            Provider::Git,
            &format!("{host}/{name}"),
        );
        reporter.phase(Phase::Downloading);
        let mut counted = Counting {
            inner: &mut body,
            reporter: &mut reporter,
            done: 0,
            last: Instant::now(),
        };
        let result = write_stream(out, status, &headers, &mut counted, None);
        let done = counted.done;
        match &result {
            Ok(_) => {
                reporter.bytes(done, Some(done));
                reporter.phase(Phase::Complete);
            }
            Err(err) => reporter.failed(crate::error::FailureKind::Connection, &err.to_string()),
        }
        return result.map(|_| ());
    }
    write_stream(out, status, &headers, &mut body, None).map(|_| ())
}

/// Counts the bytes of a pass-through body and reports them now and then.
struct Counting<'a> {
    inner: &'a mut dyn Read,
    reporter: &'a mut Reporter,
    done: u64,
    last: Instant,
}

impl Read for Counting<'_> {
    fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
        let read = self.inner.read(buf)?;
        self.done += read as u64;
        if self.last.elapsed() >= Duration::from_millis(250) {
            self.reporter.bytes(self.done, None);
            self.last = Instant::now();
        }
        Ok(read)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hosts_and_paths_are_validated() {
        assert!(valid_host("github.com"));
        assert!(valid_host("git.example.org:8443"));
        assert!(!valid_host("localhost"));
        assert!(!valid_host("user@github.com"));
        assert!(!valid_host("github.com:0"));
        assert!(!valid_host("-x.org"));
        assert!(valid_repo_path("octocat/Hello-World.git/info/refs"));
        assert!(!valid_repo_path("a/../b"));
        assert!(!valid_repo_path(""));
        assert!(!valid_repo_path("a b"));
    }
}
