//! Go: a module proxy at `<base>/go` (`GOPROXY`). `list`, `.info`, `.mod` and `@latest` pass through to the configured
//! module proxy (proxy.golang.org, or the user's own); module `.zip`s are downloaded by the broker. The checksum
//! database is reached through the proxy's documented `sumdb/<name>/` paths, so `go` keeps verifying every module
//! against `sum.golang.org` (GOSUMDB is not changed); only that database is served.

use std::io::{self, Write};

use super::http1::{write_error, write_full, Request};
use super::server::Shared;
use crate::broker::ArtifactRequest;
use crate::staging::Provider;

const SUMDBS: &[&str] = &["sum.golang.org"];

/// Go escapes a capital letter in a module path as `!` + the lowercase letter (`github.com/!burnt!sushi/toml`) and its
/// HTTP client sends that `!` percent-encoded (`%21`). Only this one escape is decoded; every other `%` stays and is
/// refused by the checks.
fn unescape_bang(path: &str) -> String {
    path.replace("%21", "!")
}

/// A module proxy path: escaped module path characters (`!` marks capitals), versions, never `..`.
fn valid_path(path: &str) -> bool {
    !path.is_empty()
        && path.len() <= 1024
        && !path
            .split('/')
            .any(|part| part.is_empty() || part == "." || part == "..")
        && path.chars().all(|c| {
            c.is_ascii_lowercase()
                || c.is_ascii_digit()
                || matches!(c, '.' | '_' | '-' | '~' | '!' | '/' | '@' | '+')
        })
}

pub(crate) fn handle(
    shared: &Shared,
    request: &Request,
    rest: &str,
    out: &mut dyn Write,
) -> io::Result<()> {
    if request.method != "GET" {
        return write_error(out, 405, "only GET is served for Go");
    }
    let rest = unescape_bang(rest);
    let rest = rest.as_str();
    if let Some(sumdb) = rest.strip_prefix("sumdb/") {
        return sum_database(shared, request, sumdb, out);
    }
    if !valid_path(rest) {
        return write_error(out, 400, "not a Go module proxy address");
    }
    let url = format!("{}/{}", shared.go_proxy().trim_end_matches('/'), rest);
    if rest.ends_with(".zip") && rest.contains("/@v/") {
        let artifact = ArtifactRequest {
            provider: Provider::Go,
            url,
            mirrors: Vec::new(),
            sha256: None,
            size: None,
        };
        return super::fetch::serve_artifact(shared, &artifact, out);
    }
    super::fetch::pass_through(shared, request, &url, false, out)
}

fn sum_database(
    shared: &Shared,
    request: &Request,
    path: &str,
    out: &mut dyn Write,
) -> io::Result<()> {
    let (name, rest) = path.split_once('/').unwrap_or((path, ""));
    if !SUMDBS.contains(&name) {
        return write_error(out, 404, "this checksum database is not served");
    }
    if rest == "supported" {
        return write_full(out, 200, &[], b"");
    }
    let valid = !rest.is_empty()
        && !rest.split('/').any(|part| part == "..")
        && rest.chars().all(|c| {
            c.is_ascii_alphanumeric() || matches!(c, '/' | '.' | '_' | '-' | '~' | '!' | '@' | '+')
        });
    if !valid {
        return write_error(out, 400, "not a checksum database address");
    }
    super::fetch::pass_through(
        shared,
        request,
        &format!("https://{name}/{rest}"),
        false,
        out,
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn module_paths_are_validated() {
        assert!(valid_path("golang.org/x/text/@v/list"));
        assert!(valid_path("github.com/!burnt!sushi/toml/@v/v1.4.0.zip"));
        assert!(
            !valid_path("github.com/BurntSushi/toml/@v/list"),
            "capitals are escaped by go"
        );
        assert!(!valid_path("../x/@v/list"));
        assert!(!valid_path("a//b"));
    }

    #[test]
    fn go_s_percent_encoded_capital_escapes_are_accepted() {
        // What `go` really sends for github.com/BurntSushi/toml (found by installing gopls through the gateway).
        let sent = "github.com/%21burnt%21sushi/toml/@v/v1.6.0.zip";
        assert!(valid_path(&unescape_bang(sent)));
        assert_eq!(
            unescape_bang(sent),
            "github.com/!burnt!sushi/toml/@v/v1.6.0.zip"
        );
        // Nothing else is decoded: other escapes are still refused.
        assert!(!valid_path(&unescape_bang("github.com/%2e%2e/x/@v/list")));
        assert!(!valid_path(&unescape_bang("a/%2f/b")));
    }
}
