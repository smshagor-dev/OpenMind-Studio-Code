//! Git over smart HTTP: `<base>/git/https/<host>/<repository path>`. Git in OpenMind's terminals gets a process-local
//! `url.<base>/git/https/.insteadOf=https://`, which leaves `origin` in `.git/config` as the real `https://` address.
//! The gateway passes Git's discovery request and the `git-upload-pack` (fetch) and `git-receive-pack` (push) exchanges
//! to the real host through the Download Manager's route and streams the answers back; Git still verifies every object
//! and writes the real repository. Nothing is staged.
//!
//! Authentication: a `401` from the host is answered by the gateway itself with the user's credential helper for the
//! **real** host (see [`super::credentials`]); Git never sees a `401`, so it never asks for credentials for
//! `127.0.0.1`. When no credentials can be had, Git gets a `403` and the Downloads view says why. A push body is
//! streamed once and never resent.

use std::io::{self, Read, Write};
use std::sync::Arc;
use std::time::{Duration, Instant};

use super::credentials::{Credential, CredentialRequest};
use super::http1::{write_error, write_stream, Request};
use super::server::Shared;
use super::upstream::{request_headers, UpRequest, UpResponse};
use crate::error::FailureKind;
use crate::events::{Phase, Reporter};
use crate::staging::Provider;

/// `host[:port]` of a Git server: a DNS name or an IPv4 address, never this computer.
pub(crate) fn valid_host(host: &str) -> bool {
    let (name, port) = host.split_once(':').unwrap_or((host, ""));
    !name.is_empty()
        && name.len() <= 253
        && !name.starts_with(['.', '-'])
        && name
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '-'))
        && !name.eq_ignore_ascii_case("localhost")
        && name
            .parse::<std::net::Ipv4Addr>()
            .map_or(true, |ip| !(ip.is_loopback() || ip.is_unspecified()))
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

/// The repository part of a smart-HTTP path (`user/repo.git/info/refs` -> `user/repo.git`).
fn repository(path: &str) -> &str {
    for suffix in ["/info/refs", "/git-upload-pack", "/git-receive-pack"] {
        if let Some(repo) = path.strip_suffix(suffix) {
            return repo;
        }
    }
    path
}

/// The remote a request is for, or why it can't be served.
pub(crate) struct Target {
    pub host: String,
    pub path: String,
}

pub(crate) fn target(rest: &str) -> Result<Target, (u16, &'static str)> {
    let Some(remote) = rest.strip_prefix("https/") else {
        return Err((404, "only https:// Git remotes are served"));
    };
    let (host, path) = remote.split_once('/').unwrap_or((remote, ""));
    if !valid_host(host) || !valid_repo_path(path) {
        return Err((400, "not a Git repository address"));
    }
    Ok(Target {
        host: host.to_ascii_lowercase(),
        path: path.to_string(),
    })
}

/// A request body: in memory (can be sent again after the helper answered) or streamed (a push: sent once).
enum Body<'a> {
    Bytes(&'a [u8]),
    Stream(&'a mut dyn Read),
}

/// Why a Git request could not be authenticated (never a secret).
struct AuthFailure(String);

/// The request headers Git sent, without any `Authorization` (it could only be meant for 127.0.0.1).
fn headers_of(request: &Request, credential: Option<&Credential>) -> Vec<(String, String)> {
    let mut headers: Vec<(String, String)> = request_headers(&request.headers)
        .into_iter()
        .filter(|(name, _)| !name.eq_ignore_ascii_case("authorization"))
        .collect();
    if let Some(credential) = credential {
        headers.push(("Authorization".into(), credential.basic()));
    }
    headers
}

fn send(
    shared: &Shared,
    request: &Request,
    url: &str,
    credential: Option<&Credential>,
    body: &mut Body<'_>,
) -> Result<UpResponse, crate::error::BrokerError> {
    let up = UpRequest {
        method: request.method.clone(),
        url: url.to_string(),
        headers: headers_of(request, credential),
        body: Vec::new(),
        follow_redirects: false,
    };
    match body {
        Body::Bytes(bytes) => shared.upstream.send(UpRequest {
            body: bytes.to_vec(),
            ..up
        }),
        Body::Stream(reader) => shared.upstream.send_stream(up, *reader),
    }
}

/// Sends the request; on a `401` asks the credential helper for the real host and tries once more. A streamed body
/// (a push) can't be sent twice: its credentials must already be known from the discovery request before it.
fn send_with_auth(
    shared: &Shared,
    request: &Request,
    target: &Target,
    url: &str,
    mut body: Body<'_>,
) -> Result<Result<UpResponse, AuthFailure>, crate::error::BrokerError> {
    let asked = CredentialRequest {
        protocol: "https".into(),
        host: target.host.clone(),
        path: repository(&target.path).to_string(),
    };
    let cached = shared.git_credentials.get(&target.host);
    let first = send(shared, request, url, cached.as_ref(), &mut body)?;
    if first.status != 401 {
        return Ok(Ok(first));
    }
    shared.git_credentials.forget(&target.host);
    if let Some(stale) = &cached {
        shared.credentials.reject(&asked, stale);
    }
    if matches!(body, Body::Stream(_)) {
        return Ok(Err(AuthFailure(format!(
            "{} refused the credentials during the push; nothing was retried. Push again to sign in",
            target.host
        ))));
    }
    tracing::info!(host = %target.host, "git remote asks for credentials; asking the credential helper");
    let credential = match shared.credentials.fill(&asked) {
        Ok(credential) => credential,
        Err(reason) => return Ok(Err(AuthFailure(reason))),
    };
    let second = send(shared, request, url, Some(&credential), &mut body)?;
    if second.status == 401 {
        shared.credentials.reject(&asked, &credential);
        return Ok(Err(AuthFailure(format!(
            "{} refused the credentials the credential helper gave (wrong, expired or revoked); they were removed \
             from the helper — run the command again to sign in",
            target.host
        ))));
    }
    shared.credentials.approve(&asked, &credential);
    shared.git_credentials.put(&target.host, credential);
    Ok(Ok(second))
}

fn fail(
    shared: &Shared,
    target: &Target,
    kind: FailureKind,
    detail: &str,
    out: &mut dyn Write,
) -> io::Result<()> {
    let mut reporter = Reporter::new(
        Arc::clone(shared.broker.events()),
        shared.broker.next_id(),
        Provider::Git,
        &format!("{}/{}", target.host, repository(&target.path)),
    );
    reporter.failed(kind, detail);
    tracing::warn!(host = %target.host, kind = ?kind, "git request failed");
    write_error(out, 403, &format!("{}: {detail}", kind.label()))
}

/// Serves discovery (`GET .../info/refs`) and fetch (`POST .../git-upload-pack`), bodies in memory.
pub(crate) fn handle(
    shared: &Shared,
    request: &Request,
    rest: &str,
    out: &mut dyn Write,
) -> io::Result<()> {
    let target = match target(rest) {
        Ok(target) => target,
        Err((status, message)) => return write_error(out, status, message),
    };
    let posting = request.method == "POST";
    if posting && !target.path.ends_with("git-upload-pack") {
        return write_error(out, 405, "a push body is streamed, not sent this way");
    }
    if !posting && request.method != "GET" {
        return write_error(out, 405, "only GET and POST are served for Git");
    }
    let body = request.body.clone();
    exchange(shared, request, &target, Body::Bytes(&body), out)
}

/// Serves a push (`POST .../git-receive-pack`), its body streamed from `body` as it arrives.
pub(crate) fn handle_push(
    shared: &Shared,
    request: &Request,
    rest: &str,
    body: &mut dyn Read,
    out: &mut dyn Write,
) -> io::Result<()> {
    let target = match target(rest) {
        Ok(target) => target,
        Err((status, message)) => return write_error(out, status, message),
    };
    if request.method != "POST" || !target.path.ends_with("git-receive-pack") {
        return write_error(out, 405, "not a push");
    }
    let mut sent = 0u64;
    let mut counted = CountRead {
        inner: body,
        count: &mut sent,
    };
    exchange(shared, request, &target, Body::Stream(&mut counted), out)
}

fn exchange(
    shared: &Shared,
    request: &Request,
    target: &Target,
    body: Body<'_>,
    out: &mut dyn Write,
) -> io::Result<()> {
    let query = request.query().map(|q| format!("?{q}")).unwrap_or_default();
    let url = format!("https://{}/{}{query}", target.host, target.path);
    let response = match send_with_auth(shared, request, target, &url, body) {
        Ok(Ok(response)) => response,
        Ok(Err(AuthFailure(reason))) => {
            return fail(shared, target, FailureKind::Authentication, &reason, out)
        }
        Err(error) => {
            return fail(shared, target, error.kind, &error.detail, out);
        }
    };
    let status = response.status;
    let mut headers: Vec<(String, String)> = response
        .headers
        .iter()
        // A challenge is the gateway's business (Git must not ask for 127.0.0.1 credentials).
        .filter(|(name, _)| !name.eq_ignore_ascii_case("www-authenticate"))
        .cloned()
        .collect();
    if !sanitize_redirect(shared, &mut headers) {
        return fail(
            shared,
            target,
            FailureKind::Refused,
            "the remote redirected to an address that isn't https",
            out,
        );
    }
    if status == 403 {
        tracing::warn!(host = %target.host, "git remote refused the request (403: no permission)");
    } else if status >= 400 {
        tracing::warn!(host = %target.host, status, "git remote answered with an error");
    }
    let mut body = response.body;
    let pack = request.method == "POST" && status == 200;
    if !pack {
        return write_stream(out, status, &headers, &mut body, None).map(|_| ());
    }
    let pushing = target.path.ends_with("git-receive-pack");
    let mut reporter = Reporter::new(
        Arc::clone(shared.broker.events()),
        shared.broker.next_id(),
        Provider::Git,
        &format!(
            "{}{}/{}",
            if pushing { "push " } else { "" },
            target.host,
            repository(&target.path)
        ),
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
        Err(err) => reporter.failed(FailureKind::Connection, &err.to_string()),
    }
    result.map(|_| ())
}

/// A redirect to another https address stays on the gateway; anything else is refused (`false`).
fn sanitize_redirect(shared: &Shared, headers: &mut [(String, String)]) -> bool {
    for (name, value) in headers.iter_mut() {
        if name.eq_ignore_ascii_case("location") {
            let Some(target) = value.strip_prefix("https://") else {
                return value.starts_with('/');
            };
            let host = target.split('/').next().unwrap_or_default();
            if !valid_host(host) {
                return false;
            }
            *value = format!("{}/git/https/{target}", shared.base());
        }
    }
    true
}

/// Counts the bytes of a streamed push body.
struct CountRead<'a> {
    inner: &'a mut dyn Read,
    count: &'a mut u64,
}

impl Read for CountRead<'_> {
    fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
        let read = self.inner.read(buf)?;
        *self.count += read as u64;
        Ok(read)
    }
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
        assert!(!valid_host("127.0.0.1"));
        assert!(!valid_host("user@github.com"));
        assert!(!valid_host("github.com:0"));
        assert!(!valid_host("-x.org"));
        assert!(valid_repo_path("octocat/Hello-World.git/info/refs"));
        assert!(!valid_repo_path("a/../b"));
        assert!(!valid_repo_path(""));
        assert!(!valid_repo_path("a b"));
    }

    #[test]
    fn the_repository_is_found_in_every_smart_http_path() {
        assert_eq!(repository("u/r.git/info/refs"), "u/r.git");
        assert_eq!(repository("u/r.git/git-upload-pack"), "u/r.git");
        assert_eq!(repository("u/r.git/git-receive-pack"), "u/r.git");
    }
}
