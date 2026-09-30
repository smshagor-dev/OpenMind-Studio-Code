//! npm, pnpm and Yarn 1: a registry at the root of the gateway's second port (`NPM_CONFIG_REGISTRY=http://127.0.0.1:<n>/`).
//! Packuments pass through unchanged, so `package-lock.json` keeps `https://registry.npmjs.org/...` as `resolved`; npm's
//! default `replace-registry-host` then fetches those tarballs from the configured registry, i.e. the gateway, which
//! downloads each one through the broker. pnpm doesn't replace hosts, so for pnpm the tarball links are pointed at the
//! gateway (pnpm's lockfile records only the integrity for registry packages). npm/pnpm verify `integrity` themselves.
//! Publishing and other writes are not served.

use std::io::{self, Write};

use super::http1::{write_error, write_full, write_stream, Request};
use super::server::Shared;
use super::upstream::{request_headers, UpRequest};
use crate::broker::ArtifactRequest;
use crate::staging::Provider;

const MAX_PACKUMENT: usize = 128 * 1024 * 1024;

/// A registry path: package names (scoped or not, `/` or `%2f`), `/-/` tarball and API paths, never `..`.
pub(crate) fn valid_path(path: &str) -> bool {
    path.starts_with('/')
        && path.len() <= 1024
        && !path.split('/').any(|part| part == "." || part == "..")
        && path.chars().all(|c| {
            c.is_ascii_alphanumeric()
                || matches!(
                    c,
                    '/' | '@' | '%' | '.' | '_' | '-' | '~' | '!' | '*' | '(' | ')' | '+'
                )
        })
}

fn is_tarball(path: &str) -> bool {
    path.contains("/-/") && path.ends_with(".tgz") && !path.starts_with("/-/")
}

/// The request carries this run's token (`//127.0.0.1:<port>/:_authToken` in OpenMind's npm file, sent by npm and pnpm
/// as a bearer token to that address only). Without it the npm port serves nothing.
fn authorized(shared: &Shared, request: &Request) -> bool {
    request
        .header("authorization")
        .and_then(|value| value.strip_prefix("Bearer "))
        .is_some_and(|given| super::server::same(given.trim(), &shared.token))
}

/// Headers passed to the registry: never the gateway token (nor anything else meant for 127.0.0.1).
fn upstream_headers(request: &Request) -> Vec<(String, String)> {
    request_headers(&request.headers)
        .into_iter()
        .filter(|(name, _)| !name.eq_ignore_ascii_case("authorization"))
        .collect()
}

pub(crate) fn handle(shared: &Shared, request: &Request, out: &mut dyn Write) -> io::Result<()> {
    if !authorized(shared, request) {
        return write_error(
            out,
            403,
            "unknown session (this registry address only answers npm and pnpm started by OpenMind)",
        );
    }
    let path = request.path();
    if !valid_path(path) {
        return write_error(out, 400, "not a registry address");
    }
    let upstream = format!(
        "{}{}{}",
        shared.config.npm_registry.trim_end_matches('/'),
        path,
        request.query().map(|q| format!("?{q}")).unwrap_or_default()
    );
    match request.method.as_str() {
        "GET" if is_tarball(path) => {
            let artifact = ArtifactRequest {
                provider: Provider::Npm,
                url: upstream,
                mirrors: Vec::new(),
                sha256: None,
                size: None,
            };
            super::fetch::serve_artifact(shared, &artifact, out)
        }
        "GET" | "HEAD" => metadata(shared, request, &upstream, out),
        // npm audit posts the dependency list; nothing else is written through the gateway.
        "POST" if path.starts_with("/-/npm/v1/security/") => forward(shared, request, &upstream, out),
        _ => write_error(
            out,
            405,
            "publishing and other registry changes are not sent through OpenMind; use --registry https://registry.npmjs.org/ for them",
        ),
    }
}

fn pnpm(request: &Request) -> bool {
    request
        .header("user-agent")
        .is_some_and(|agent| agent.starts_with("pnpm/"))
}

fn metadata(
    shared: &Shared,
    request: &Request,
    upstream: &str,
    out: &mut dyn Write,
) -> io::Result<()> {
    let response = match shared.upstream.send(UpRequest {
        method: request.method.clone(),
        url: upstream.to_string(),
        headers: upstream_headers(request),
        body: Vec::new(),
        follow_redirects: true,
    }) {
        Ok(response) => response,
        Err(error) => {
            tracing::warn!(url = upstream, kind = ?error.kind, "npm metadata request failed");
            return write_error(
                out,
                error.kind.gateway_status(error.status),
                &format!("{}: {}", error.kind.label(), error.detail),
            );
        }
    };
    let status = response.status;
    let headers = response.headers.clone();
    if request.method == "HEAD" {
        return write_full(out, status, &headers, b"");
    }
    if status == 200 && pnpm(request) {
        let body = match response.read_all(MAX_PACKUMENT) {
            Ok(body) => body,
            Err(error) => return write_error(out, 502, &error.detail),
        };
        let registry = shared.config.npm_registry.trim_end_matches('/');
        let local = format!("http://127.0.0.1:{}", shared.npm_port);
        let text = String::from_utf8_lossy(&body).replace(
            &format!("\"tarball\":\"{registry}/"),
            &format!("\"tarball\":\"{local}/"),
        );
        return write_full(out, status, &headers, text.as_bytes());
    }
    let mut response = response;
    write_stream(out, status, &headers, &mut response.body, None).map(|_| ())
}

fn forward(
    shared: &Shared,
    request: &Request,
    upstream: &str,
    out: &mut dyn Write,
) -> io::Result<()> {
    match shared.upstream.send(UpRequest {
        method: request.method.clone(),
        url: upstream.to_string(),
        headers: upstream_headers(request),
        body: request.body.clone(),
        follow_redirects: false,
    }) {
        Ok(mut response) => {
            let headers = response.headers.clone();
            write_stream(out, response.status, &headers, &mut response.body, None).map(|_| ())
        }
        Err(error) => write_error(
            out,
            error.kind.gateway_status(error.status),
            &format!("{}: {}", error.kind.label(), error.detail),
        ),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn registry_paths_are_validated() {
        assert!(valid_path("/express"));
        assert!(valid_path("/@types%2fnode"));
        assert!(valid_path("/@types/node/-/node-22.0.0.tgz"));
        assert!(valid_path("/-/npm/v1/security/advisories/bulk"));
        assert!(!valid_path("/../etc/passwd"));
        assert!(!valid_path("express"));
        assert!(!valid_path("/a b"));
        assert!(is_tarball("/express/-/express-4.21.2.tgz"));
        assert!(is_tarball("/@types/node/-/node-22.0.0.tgz"));
        assert!(!is_tarball("/-/v1/search"));
        assert!(!is_tarball("/express"));
    }
}
