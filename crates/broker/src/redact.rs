//! Addresses as they may appear in logs, events and the staging record: no user name or password, no query and no
//! fragment (a signed download address carries its token there). Applied wherever an address leaves the broker.

pub use openmind_network::redact::{log_text as text, log_url as url};

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn credentials_queries_and_fragments_never_survive() {
        assert_eq!(
            url("https://ivan:s3cr3t@files.example/a/b.whl?X-Amz-Signature=abc#sha256=f"),
            "https://files.example/a/b.whl"
        );
        assert_eq!(url("https://host"), "https://host");
        assert_eq!(
            text("HTTP 404 from https://h.example/x?token=s3cr3t (then http://u:p@h2/y)"),
            "HTTP 404 from https://h.example/x (then http://h2/y)"
        );
        assert_eq!(text("no address here"), "no address here");
    }
}
