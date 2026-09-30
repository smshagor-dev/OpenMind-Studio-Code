//! rustup: its distribution server (`RUSTUP_DIST_SERVER=<base>/rustup`) and its self-update root
//! (`RUSTUP_UPDATE_ROOT=<base>/rustup/rustup`) through the gateway, for `static.rust-lang.org` only. Channel manifests and
//! their `.sha256`/`.asc` files pass through; component archives (tens to hundreds of MB) are downloaded by the broker
//! (resume, retries, staging). rustup keeps verifying every archive against the SHA-256 in the channel manifest it
//! fetched — the gateway changes no byte.

use std::io::{self, Write};

use super::http1::{write_error, Request};
use super::server::Shared;
use crate::broker::ArtifactRequest;
use crate::staging::Provider;

const UPSTREAM: &str = "https://static.rust-lang.org";

/// A path below the distribution server: `dist/...` or `rustup/...`, safe characters, never `..`.
fn valid_path(path: &str) -> bool {
    (path.starts_with("dist/") || path.starts_with("rustup/"))
        && path.len() <= 512
        && !path
            .split('/')
            .any(|part| part.is_empty() || part == "." || part == "..")
        && path
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-' | '/' | '+'))
}

fn is_archive(path: &str) -> bool {
    [".tar.xz", ".tar.gz", ".tar.zst", ".msi", ".exe", ".zip"]
        .iter()
        .any(|suffix| path.ends_with(suffix))
}

pub(crate) fn handle(
    shared: &Shared,
    request: &Request,
    rest: &str,
    out: &mut dyn Write,
) -> io::Result<()> {
    if request.method != "GET" {
        return write_error(out, 405, "only GET is served for rustup");
    }
    if !valid_path(rest) {
        return write_error(out, 400, "not a Rust distribution address");
    }
    let url = format!("{UPSTREAM}/{rest}");
    if is_archive(rest) {
        let artifact = ArtifactRequest {
            provider: Provider::Rustup,
            url,
            mirrors: Vec::new(),
            sha256: None,
            size: None,
        };
        return super::fetch::serve_artifact(shared, &artifact, out);
    }
    super::fetch::pass_through(shared, request, &url, false, out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn distribution_paths_are_validated() {
        assert!(valid_path("dist/channel-rust-stable.toml.sha256"));
        assert!(valid_path(
            "dist/2026-08-07/rust-std-1.97.0-x86_64-pc-windows-msvc.tar.xz"
        ));
        assert!(valid_path("rustup/release-stable.toml"));
        assert!(!valid_path("dist/../etc"));
        assert!(!valid_path("other/x"));
        assert!(!valid_path("dist//x"));
        assert!(!valid_path("dist/x?y=1"));
        assert!(is_archive(
            "dist/x/rustc-1.97.0-x86_64-pc-windows-msvc.tar.xz"
        ));
        assert!(!is_archive("dist/channel-rust-stable.toml"));
    }
}
