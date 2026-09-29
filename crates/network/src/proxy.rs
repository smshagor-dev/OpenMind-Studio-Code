//! The proxy the user chose (settings) and the proxy that is in force (resolved): parsing, validation and the
//! bypass (NO_PROXY) rules. Pure: detection of the system proxy lives in `system`, credentials are passed in.

use serde::{Deserialize, Serialize};

/// Settings > Network > Proxy mode.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ProxyMode {
    /// OpenMind adds no proxy configuration (tools behave as they would without OpenMind).
    None,
    /// Use the proxy Windows (or the environment) is configured with.
    System,
    /// Use the proxy typed in the settings.
    Manual,
}

impl ProxyMode {
    pub fn parse(value: &str) -> ProxyMode {
        match value {
            "system" => ProxyMode::System,
            "manual" => ProxyMode::Manual,
            _ => ProxyMode::None,
        }
    }
}

/// The raw settings (`network.proxy.*`).
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProxySettings {
    pub http: String,
    pub https: String,
    pub socks: String,
    pub no_proxy: String,
}

/// Username and password for a proxy that asks for them. Never logged, never serialized to the UI.
#[derive(Clone, PartialEq, Eq)]
pub struct Credentials {
    pub username: String,
    pub password: String,
}

impl std::fmt::Debug for Credentials {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Credentials")
            .field("username", &self.username)
            .field("password", &"****")
            .finish()
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Scheme {
    Http,
    Https,
    Socks5,
}

impl Scheme {
    fn as_str(self) -> &'static str {
        match self {
            Scheme::Http => "http",
            Scheme::Https => "https",
            Scheme::Socks5 => "socks5",
        }
    }
}

/// A proxy address without credentials.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProxyUrl {
    pub scheme: Scheme,
    pub host: String,
    pub port: u16,
}

/// Why a proxy address was refused. The UI turns the code into a sentence in its language.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, thiserror::Error)]
#[serde(rename_all = "camelCase")]
pub enum ProxyProblem {
    #[error("the address is empty")]
    Empty,
    #[error("the address isn't host:port or scheme://host:port")]
    InvalidAddress,
    #[error("only http://, https:// and socks5:// proxies are supported")]
    UnsupportedScheme,
    #[error("the port must be 1-65535")]
    BadPort,
    #[error("put the user name and password in the credential fields, not in the address")]
    CredentialsInAddress,
}

impl ProxyUrl {
    /// `host:port`, `http://host:port`, `https://host:port/`, `socks5://host:port`. A default scheme is used when
    /// none is written. Credentials in the address are refused (they would end up in logs and settings files).
    pub fn parse(text: &str, default_scheme: Scheme) -> Result<ProxyUrl, ProxyProblem> {
        let text = text.trim();
        if text.is_empty() {
            return Err(ProxyProblem::Empty);
        }
        let (scheme, rest) = match text.split_once("://") {
            Some((scheme, rest)) => (
                match scheme.to_ascii_lowercase().as_str() {
                    "http" => Scheme::Http,
                    "https" => Scheme::Https,
                    "socks5" | "socks5h" | "socks" => Scheme::Socks5,
                    _ => return Err(ProxyProblem::UnsupportedScheme),
                },
                rest,
            ),
            None => (default_scheme, text),
        };
        let rest = rest.trim_end_matches('/');
        if rest.contains('@') {
            return Err(ProxyProblem::CredentialsInAddress);
        }
        if rest.contains('/') || rest.contains('?') || rest.contains('#') || rest.contains(' ') {
            return Err(ProxyProblem::InvalidAddress);
        }
        let (host, port) = split_host_port(rest)?;
        let port = match port {
            Some(port) => port,
            None => match scheme {
                Scheme::Http => 80,
                Scheme::Https => 443,
                Scheme::Socks5 => 1080,
            },
        };
        Ok(ProxyUrl { scheme, host, port })
    }

    /// The address with the credentials in it (percent-encoded), for the tools that read `HTTP_PROXY`.
    pub fn url(&self, credentials: Option<&Credentials>) -> String {
        let auth = credentials
            .filter(|c| !c.username.is_empty())
            .map(|c| format!("{}:{}@", encode(&c.username), encode(&c.password)))
            .unwrap_or_default();
        format!(
            "{}://{auth}{}:{}",
            self.scheme.as_str(),
            self.host_for_url(),
            self.port
        )
    }

    /// The address as shown to the user: never with a password.
    pub fn display(&self) -> String {
        format!(
            "{}://{}:{}",
            self.scheme.as_str(),
            self.host_for_url(),
            self.port
        )
    }

    fn host_for_url(&self) -> String {
        if self.host.contains(':') {
            format!("[{}]", self.host)
        } else {
            self.host.clone()
        }
    }
}

fn split_host_port(text: &str) -> Result<(String, Option<u16>), ProxyProblem> {
    let (host, port) = if let Some(inner) = text.strip_prefix('[') {
        let (host, after) = inner.split_once(']').ok_or(ProxyProblem::InvalidAddress)?;
        (host.to_string(), after.strip_prefix(':'))
    } else {
        match text.rsplit_once(':') {
            Some((host, port)) if !host.contains(':') => (host.to_string(), Some(port)),
            Some(_) => return Err(ProxyProblem::InvalidAddress),
            None => (text.to_string(), None),
        }
    };
    let valid_host = !host.is_empty()
        && host
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | '_' | ':'));
    if !valid_host {
        return Err(ProxyProblem::InvalidAddress);
    }
    let port = match port {
        None => None,
        Some(port) => match port.parse::<u16>() {
            Ok(0) | Err(_) => return Err(ProxyProblem::BadPort),
            Ok(port) => Some(port),
        },
    };
    Ok((host, port))
}

/// Percent-encodes a user name or password for the userinfo part of a URL.
fn encode(text: &str) -> String {
    text.bytes()
        .map(|b| {
            if b.is_ascii_alphanumeric() || matches!(b, b'-' | b'.' | b'_' | b'~') {
                (b as char).to_string()
            } else {
                format!("%{b:02X}")
            }
        })
        .collect()
}

/// The hosts that never go through the proxy, whatever the user wrote.
pub const ALWAYS_DIRECT: &[&str] = &["localhost", "127.0.0.1", "::1"];

/// The default bypass list of the setting.
pub const DEFAULT_NO_PROXY: &str = "localhost,127.0.0.1,::1,.local";

/// Splits a bypass list (`,` or `;` separated, `<local>` kept) and adds the loopback names.
pub fn parse_no_proxy(text: &str) -> Vec<String> {
    let mut list: Vec<String> = text
        .split([',', ';'])
        .map(|item| item.trim().to_ascii_lowercase())
        .filter(|item| !item.is_empty())
        .collect();
    for host in ALWAYS_DIRECT {
        if !list.iter().any(|item| item == host) {
            list.push((*host).to_string());
        }
    }
    list
}

/// Whether `host` bypasses the proxy: an exact name, a domain suffix (`.corp`, `*.corp`, `corp` matches
/// `a.corp`), `<local>` (a name without dots) or `*`.
pub fn bypasses(host: &str, no_proxy: &[String]) -> bool {
    let host = host
        .trim_start_matches('[')
        .trim_end_matches(']')
        .to_ascii_lowercase();
    no_proxy.iter().any(|rule| {
        let rule = rule.as_str();
        if rule == "*" {
            return true;
        }
        if rule == "<local>" {
            return !host.contains('.') && !host.contains(':');
        }
        let suffix = rule.trim_start_matches('*').trim_start_matches('.');
        host == suffix || host.ends_with(&format!(".{suffix}"))
    })
}

/// Where the proxy in force came from.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum ProxySource {
    /// OpenMind adds nothing.
    Off,
    Manual,
    /// Windows' per-user Internet Settings (what browsers use).
    SystemUser,
    /// The machine-wide WinHTTP proxy.
    SystemWinHttp,
    /// `HTTP_PROXY` & co. that were already set for OpenMind.
    Environment,
    /// System mode, but nothing is configured.
    NoneDetected,
}

/// The proxy in force: what processes and downloads use.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ResolvedProxy {
    pub mode: ProxyMode,
    pub source: ProxySource,
    pub http: Option<ProxyUrl>,
    pub https: Option<ProxyUrl>,
    pub socks: Option<ProxyUrl>,
    pub no_proxy: Vec<String>,
    /// A PAC script address Windows uses; OpenMind can't evaluate PAC files and says so.
    pub pac_url: Option<String>,
    /// Windows is set to detect the proxy automatically (WPAD); OpenMind doesn't do that lookup and says so.
    pub auto_detect: bool,
    /// Addresses that were refused, as `(field, problem)`.
    pub problems: Vec<(String, ProxyProblem)>,
}

impl ResolvedProxy {
    pub fn off() -> Self {
        ResolvedProxy {
            mode: ProxyMode::None,
            source: ProxySource::Off,
            http: None,
            https: None,
            socks: None,
            no_proxy: parse_no_proxy(""),
            pac_url: None,
            auto_detect: false,
            problems: Vec::new(),
        }
    }

    /// Whether any proxy is in force.
    pub fn active(&self) -> bool {
        self.http.is_some() || self.https.is_some() || self.socks.is_some()
    }

    /// The proxy for a URL of this scheme, or `None` (direct).
    pub fn for_target(&self, https: bool, host: &str) -> Option<&ProxyUrl> {
        if bypasses(host, &self.no_proxy) {
            return None;
        }
        let preferred = if https {
            self.https.as_ref().or(self.http.as_ref())
        } else {
            self.http.as_ref().or(self.https.as_ref())
        };
        preferred.or(self.socks.as_ref())
    }
}

/// The manual settings as a resolved proxy. An `http` address alone serves https too (the usual lab setup).
pub fn resolve_manual(settings: &ProxySettings) -> ResolvedProxy {
    let mut problems = Vec::new();
    let mut field = |name: &str, text: &str, scheme: Scheme| -> Option<ProxyUrl> {
        if text.trim().is_empty() {
            return None;
        }
        match ProxyUrl::parse(text, scheme) {
            Ok(url) => Some(url),
            Err(problem) => {
                problems.push((name.to_string(), problem));
                None
            }
        }
    };
    let http = field("http", &settings.http, Scheme::Http);
    let https = field("https", &settings.https, Scheme::Http);
    let socks = field("socks", &settings.socks, Scheme::Socks5);
    ResolvedProxy {
        mode: ProxyMode::Manual,
        source: ProxySource::Manual,
        https: https.or_else(|| http.clone()),
        http,
        socks,
        no_proxy: parse_no_proxy(&settings.no_proxy),
        pac_url: None,
        auto_detect: false,
        problems,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn addresses_parse_with_and_without_a_scheme() {
        let url = ProxyUrl::parse("proxy.uni.ru:3128", Scheme::Http).expect("parse");
        assert_eq!(
            url,
            ProxyUrl {
                scheme: Scheme::Http,
                host: "proxy.uni.ru".into(),
                port: 3128
            }
        );
        assert_eq!(url.display(), "http://proxy.uni.ru:3128");
        assert_eq!(
            ProxyUrl::parse("https://p:8443/", Scheme::Http)
                .expect("parse")
                .display(),
            "https://p:8443"
        );
        assert_eq!(
            ProxyUrl::parse("socks5://10.0.0.1", Scheme::Http)
                .expect("parse")
                .port,
            1080
        );
        assert_eq!(
            ProxyUrl::parse("[::1]:8080", Scheme::Http)
                .expect("parse")
                .display(),
            "http://[::1]:8080"
        );
    }

    #[test]
    fn bad_addresses_are_refused_with_a_reason() {
        assert_eq!(ProxyUrl::parse(" ", Scheme::Http), Err(ProxyProblem::Empty));
        assert_eq!(
            ProxyUrl::parse("ftp://p:21", Scheme::Http),
            Err(ProxyProblem::UnsupportedScheme)
        );
        assert_eq!(
            ProxyUrl::parse("p:99999", Scheme::Http),
            Err(ProxyProblem::BadPort)
        );
        assert_eq!(
            ProxyUrl::parse("p:0", Scheme::Http),
            Err(ProxyProblem::BadPort)
        );
        assert_eq!(
            ProxyUrl::parse("http://u:pw@p:8080", Scheme::Http),
            Err(ProxyProblem::CredentialsInAddress)
        );
        assert_eq!(
            ProxyUrl::parse("http://p:80/path", Scheme::Http),
            Err(ProxyProblem::InvalidAddress)
        );
        assert_eq!(
            ProxyUrl::parse("bad host:80", Scheme::Http),
            Err(ProxyProblem::InvalidAddress)
        );
    }

    #[test]
    fn credentials_are_percent_encoded_in_the_url_and_hidden_in_debug() {
        let url = ProxyUrl::parse("p:8080", Scheme::Http).expect("parse");
        let creds = Credentials {
            username: "DOMAIN\\ivan".into(),
            password: "p@ss:w/rd".into(),
        };
        assert_eq!(
            url.url(Some(&creds)),
            "http://DOMAIN%5Civan:p%40ss%3Aw%2Frd@p:8080"
        );
        assert_eq!(url.url(None), "http://p:8080");
        assert!(!format!("{creds:?}").contains("p@ss"));
    }

    #[test]
    fn the_bypass_list_matches_names_suffixes_and_local_names() {
        let list = parse_no_proxy("intranet.corp; .local, *.lab.ru, <local>");
        for host in [
            "localhost",
            "127.0.0.1",
            "::1",
            "[::1]",
            "intranet.corp",
            "printer.local",
            "a.lab.ru",
            "lab.ru",
            "fileserver",
        ] {
            assert!(bypasses(host, &list), "{host}");
        }
        for host in ["github.com", "pypi.org", "notlab.ru"] {
            assert!(!bypasses(host, &list), "{host}");
        }
    }

    #[test]
    fn manual_http_serves_https_and_bad_fields_are_reported() {
        let resolved = resolve_manual(&ProxySettings {
            http: "proxy:3128".into(),
            socks: "nope://x".into(),
            ..ProxySettings::default()
        });
        assert!(resolved.active());
        assert_eq!(
            resolved.https.as_ref().map(ProxyUrl::display).as_deref(),
            Some("http://proxy:3128")
        );
        assert_eq!(
            resolved.problems,
            vec![("socks".to_string(), ProxyProblem::UnsupportedScheme)]
        );
        assert!(resolved.for_target(true, "localhost").is_none());
        assert_eq!(
            resolved.for_target(true, "pypi.org").map(|u| u.port),
            Some(3128)
        );
    }
}
