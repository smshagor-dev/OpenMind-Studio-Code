//! pip: a PEP 503/691 index at `<base>/pypi/simple/`. Index pages come from the configured index (PyPI) with the file
//! addresses pointed at `<base>/pypi/files/`; the SHA-256 each page publishes is remembered, so the broker verifies every
//! file before pip gets it (pip checks the same hash again). pip keeps resolving dependencies, markers, wheels tags and
//! `--require-hashes` itself — the gateway only moves bytes.

use std::io::{self, Write};

use serde_json::Value;

use super::http1::{write_error, write_full, Request};
use super::server::Shared;
use super::upstream::{request_headers, UpRequest};
use crate::broker::ArtifactRequest;
use crate::staging::Provider;

/// Largest index page accepted (PyPI's root listing is tens of MB).
const MAX_PAGE: usize = 256 * 1024 * 1024;

pub(crate) fn handle(
    shared: &Shared,
    request: &Request,
    rest: &str,
    out: &mut dyn Write,
) -> io::Result<()> {
    if request.method != "GET" {
        return write_error(out, 405, "only GET is served for pip");
    }
    if let Some(project) = rest.strip_prefix("simple") {
        return index(shared, request, project.trim_start_matches('/'), out);
    }
    if let Some(file) = rest.strip_prefix("files/") {
        return file_download(shared, request, file, out);
    }
    write_error(out, 404, "not a pip index address")
}

/// `""` (the project list) or one project name with an optional trailing slash.
fn valid_project(path: &str) -> bool {
    let name = path.trim_end_matches('/');
    name.is_empty()
        || (!name.contains('/')
            && name.len() <= 200
            && name
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-')))
}

/// A path below `packages/` made of safe characters, never climbing out.
fn valid_file(path: &str) -> bool {
    path.starts_with("packages/")
        && path.len() <= 1024
        && !path
            .split('/')
            .any(|part| part.is_empty() || part == "." || part == "..")
        && path.chars().all(|c| {
            c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-' | '/' | '+' | '%' | '!' | '~')
        })
}

fn index(shared: &Shared, request: &Request, project: &str, out: &mut dyn Write) -> io::Result<()> {
    if !valid_project(project) {
        return write_error(out, 400, "not a project name");
    }
    let url = format!("{}{}", shared.config.pypi_index, project);
    let headers: Vec<(String, String)> = request_headers(&request.headers)
        .into_iter()
        .filter(|(name, _)| !name.eq_ignore_ascii_case("authorization"))
        .collect();
    let response = match shared.upstream.send(UpRequest {
        method: "GET".into(),
        url: url.clone(),
        headers,
        body: Vec::new(),
        follow_redirects: true,
    }) {
        Ok(response) => response,
        Err(error) => {
            tracing::warn!(%url, kind = ?error.kind, detail = %error.detail, "pip index request failed");
            return write_error(
                out,
                error.kind.gateway_status(error.status),
                &format!("{}: {}", error.kind.label(), error.detail),
            );
        }
    };
    let status = response.status;
    let headers = response.headers.clone();
    let json = response
        .header("content-type")
        .is_some_and(|t| t.contains("json"));
    let body = match response.read_all(MAX_PAGE) {
        Ok(body) => body,
        Err(error) => return write_error(out, 502, &error.detail),
    };
    if status != 200 {
        return write_full(out, status, &headers, &body);
    }
    let text = String::from_utf8_lossy(&body);
    let rewritten = rewrite_page(shared, &text, json);
    write_full(out, 200, &headers, rewritten.as_bytes())
}

/// Points the file addresses of an index page at the gateway and remembers their SHA-256.
fn rewrite_page(shared: &Shared, text: &str, json: bool) -> String {
    let files = shared.config.pypi_files.as_str();
    if json {
        if let Ok(value) = serde_json::from_str::<Value>(text) {
            for file in value["files"].as_array().into_iter().flatten() {
                if let (Some(url), Some(sha)) =
                    (file["url"].as_str(), file["hashes"]["sha256"].as_str())
                {
                    let plain = url.split('#').next().unwrap_or(url);
                    shared.remember_hash(plain, sha);
                }
            }
        }
    } else {
        for (url, sha) in hashed_links(text, files) {
            shared.remember_hash(&url, &sha);
        }
    }
    text.replace(files, &format!("{}/pypi/files/", shared.base()))
}

/// `(address without fragment, sha256)` of every `<files host>...#sha256=<hex>` link in an HTML page.
pub(crate) fn hashed_links(text: &str, files: &str) -> Vec<(String, String)> {
    let mut found = Vec::new();
    let mut rest = text;
    while let Some(start) = rest.find(files) {
        let tail = &rest[start..];
        let end = tail.find(['"', '\'', '<', ' ']).unwrap_or(tail.len());
        let link = &tail[..end].replace("&amp;", "&");
        if let Some((url, fragment)) = link.split_once('#') {
            if let Some(hex) = fragment.strip_prefix("sha256=") {
                if hex.len() == 64 && hex.chars().all(|c| c.is_ascii_hexdigit()) {
                    found.push((url.to_string(), hex.to_string()));
                }
            }
        }
        rest = &tail[end..];
    }
    found
}

fn file_download(
    shared: &Shared,
    request: &Request,
    path: &str,
    out: &mut dyn Write,
) -> io::Result<()> {
    if !valid_file(path) {
        return write_error(out, 400, "not a package file address");
    }
    let url = format!("{}{}", shared.config.pypi_files, path);
    if path.ends_with(".metadata") {
        // PEP 658 metadata: small, and pip checks its hash from the index page.
        return super::fetch::pass_through(shared, request, &url, false, out);
    }
    let sha256 = shared.hash_of(&url);
    let artifact = ArtifactRequest {
        provider: Provider::Pypi,
        url: url.clone(),
        mirrors: Vec::new(),
        sha256,
        size: None,
    };
    super::fetch::serve_artifact(shared, &artifact, out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn project_and_file_paths_are_validated() {
        assert!(valid_project(""));
        assert!(valid_project("requests/"));
        assert!(valid_project("Zope.Interface"));
        assert!(!valid_project("../etc/"));
        assert!(!valid_project("a/b/"));
        assert!(valid_file(
            "packages/f1/a2/abc/six-1.17.0-py2.py3-none-any.whl"
        ));
        assert!(!valid_file("packages/../../x"));
        assert!(!valid_file("other/x.whl"));
        assert!(!valid_file("packages//x.whl"));
        assert!(!valid_file("packages/a/x.whl?y=1"));
    }

    #[test]
    fn hashed_links_are_found_in_html() {
        let hex = "a".repeat(64);
        let page = format!(
            "<a href=\"https://files.pythonhosted.org/packages/x/six-1.whl#sha256={hex}\" data-requires-python=\"&gt;=3\">six</a>\
             <a href=\"https://files.pythonhosted.org/packages/y/six.tar.gz\">no hash</a>"
        );
        let links = hashed_links(&page, "https://files.pythonhosted.org/");
        assert_eq!(
            links,
            vec![(
                "https://files.pythonhosted.org/packages/x/six-1.whl".to_string(),
                hex
            )]
        );
    }
}
