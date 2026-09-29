//! Requests the gateway passes on (package indexes, registry metadata, Git's smart-HTTP exchange): made with the Download
//! Manager's agent builder (`openmind_network::http::agent` — the same proxy route and TLS roots), https only. Only
//! headers a tool needs cross in either direction; ureq decodes gzip itself, so encoding and length headers of the
//! answer are dropped and the gateway frames the decoded body anew.

use std::io::Read;
use std::time::Duration;

use openmind_network::http::{agent, net_error, Timeouts};

use crate::error::{BrokerError, FailureKind};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct UpRequest {
    pub method: String,
    pub url: String,
    pub headers: Vec<(String, String)>,
    pub body: Vec<u8>,
    /// Follow redirects within the upstream (package indexes) or hand them back (Git).
    pub follow_redirects: bool,
}

pub struct UpResponse {
    pub status: u16,
    pub headers: Vec<(String, String)>,
    pub body: Box<dyn Read + Send>,
}

impl UpResponse {
    pub fn header(&self, name: &str) -> Option<&str> {
        self.headers
            .iter()
            .find(|(key, _)| key.eq_ignore_ascii_case(name))
            .map(|(_, value)| value.as_str())
    }

    /// Reads the whole body, refusing more than `limit` bytes.
    pub fn read_all(self, limit: usize) -> Result<Vec<u8>, BrokerError> {
        let mut out = Vec::new();
        self.body
            .take(limit as u64 + 1)
            .read_to_end(&mut out)
            .map_err(|err| BrokerError::new(FailureKind::Connection, err.to_string()))?;
        if out.len() > limit {
            return Err(BrokerError::new(
                FailureKind::InvalidMetadata,
                "the registry's answer is larger than OpenMind accepts",
            ));
        }
        Ok(out)
    }
}

pub trait Upstream: Send + Sync {
    fn send(&self, request: UpRequest) -> Result<UpResponse, BrokerError>;
}

/// Request headers a tool may pass on (everything else — cookies, proxy headers, hop-by-hop — stays behind).
const REQUEST_HEADERS: &[&str] = &[
    "accept",
    "authorization",
    "cache-control",
    "content-encoding",
    "content-type",
    "git-protocol",
    "if-modified-since",
    "if-none-match",
    "npm-command",
    "npm-session",
    "pnpm-command",
    "user-agent",
];

/// Response headers passed back to the tool.
const RESPONSE_HEADERS: &[&str] = &[
    "cache-control",
    "content-type",
    "etag",
    "expires",
    "last-modified",
    "location",
    "vary",
    "www-authenticate",
    "x-pypi-last-serial",
];

pub fn request_headers(headers: &[(String, String)]) -> Vec<(String, String)> {
    headers
        .iter()
        .filter(|(name, _)| {
            REQUEST_HEADERS
                .iter()
                .any(|allowed| name.eq_ignore_ascii_case(allowed))
        })
        .cloned()
        .collect()
}

pub fn response_headers(headers: &[(String, String)]) -> Vec<(String, String)> {
    headers
        .iter()
        .filter(|(name, _)| {
            RESPONSE_HEADERS
                .iter()
                .any(|allowed| name.eq_ignore_ascii_case(allowed))
        })
        .cloned()
        .collect()
}

/// The real upstream: the Download Manager's agent.
pub struct UreqUpstream;

impl Upstream for UreqUpstream {
    fn send(&self, request: UpRequest) -> Result<UpResponse, BrokerError> {
        if !request.url.to_ascii_lowercase().starts_with("https://") {
            return Err(BrokerError::new(
                FailureKind::Refused,
                "only https:// addresses are fetched",
            ));
        }
        let timeouts = Timeouts {
            connect: Duration::from_secs(15),
            response: Duration::from_secs(60),
            body: Duration::from_secs(60 * 60),
        };
        let agent = agent(
            &request.url,
            timeouts,
            Some(if request.follow_redirects { 5 } else { 0 }),
        );
        let mut builder = ureq::http::Request::builder()
            .method(request.method.as_str())
            .uri(request.url.as_str());
        for (name, value) in request_headers(&request.headers) {
            builder = builder.header(name, value);
        }
        let http_request = builder
            .body(request.body)
            .map_err(|err| BrokerError::new(FailureKind::Refused, err.to_string()))?;
        let response = agent
            .run(http_request)
            .map_err(|err| BrokerError::net(&net_error(&err, &request.url)))?;
        let status = response.status().as_u16();
        let headers: Vec<(String, String)> = response
            .headers()
            .iter()
            .filter_map(|(name, value)| {
                value
                    .to_str()
                    .ok()
                    .map(|value| (name.as_str().to_string(), value.to_string()))
            })
            .collect();
        Ok(UpResponse {
            status,
            headers: response_headers(&headers),
            body: Box::new(response.into_body().into_reader()),
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn pairs(list: &[(&str, &str)]) -> Vec<(String, String)> {
        list.iter()
            .map(|(a, b)| ((*a).into(), (*b).into()))
            .collect()
    }

    #[test]
    fn only_allowed_headers_cross_the_gateway() {
        let sent = request_headers(&pairs(&[
            ("Accept", "application/vnd.pypi.simple.v1+json"),
            ("Host", "127.0.0.1:1"),
            ("Proxy-Authorization", "Basic xx"),
            ("Cookie", "a=b"),
            ("Git-Protocol", "version=2"),
            ("Accept-Encoding", "gzip"),
        ]));
        assert_eq!(
            sent,
            pairs(&[
                ("Accept", "application/vnd.pypi.simple.v1+json"),
                ("Git-Protocol", "version=2")
            ])
        );
        let back = response_headers(&pairs(&[
            ("Content-Type", "text/html"),
            ("Content-Encoding", "gzip"),
            ("Content-Length", "5"),
            ("Set-Cookie", "x"),
            ("ETag", "\"1\""),
        ]));
        assert_eq!(
            back,
            pairs(&[("Content-Type", "text/html"), ("ETag", "\"1\"")])
        );
    }

    #[test]
    fn plain_http_upstreams_are_refused() {
        let result = UreqUpstream.send(UpRequest {
            method: "GET".into(),
            url: "http://pypi.org/simple/".into(),
            headers: Vec::new(),
            body: Vec::new(),
            follow_redirects: true,
        });
        assert_eq!(result.err().map(|e| e.kind), Some(FailureKind::Refused));
    }
}
