//! The system proxy: what the environment and Windows are configured with. Only read — OpenMind never changes the
//! system proxy. The parsers are pure; the readers are thin Windows calls (WinHTTP's view of the per-user Internet
//! Settings and of the machine-wide WinHTTP proxy).

use serde::Serialize;

use crate::proxy::{
    parse_no_proxy, Credentials, ProxyMode, ProxyProblem, ProxySource, ProxyUrl, ResolvedProxy,
    Scheme,
};

/// What was found, before choosing.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SystemProxy {
    /// `HTTP_PROXY`, `https_proxy`, `ALL_PROXY`, `NO_PROXY` ... already set for OpenMind's process.
    pub env: Vec<(String, String)>,
    /// Internet Settings (per user): the proxy server string, its bypass list and a PAC address.
    pub user_proxy: Option<String>,
    pub user_bypass: Option<String>,
    pub user_pac: Option<String>,
    /// "Automatically detect settings" is on (WPAD).
    pub user_auto_detect: bool,
    /// The WinHTTP (machine) proxy.
    pub winhttp_proxy: Option<String>,
    pub winhttp_bypass: Option<String>,
}

const ENV_NAMES: &[&str] = &[
    "HTTP_PROXY",
    "HTTPS_PROXY",
    "ALL_PROXY",
    "NO_PROXY",
    "http_proxy",
    "https_proxy",
    "all_proxy",
    "no_proxy",
];

/// Reads the environment and (on Windows) WinHTTP's view of the system proxy.
pub fn detect() -> SystemProxy {
    let env = ENV_NAMES
        .iter()
        .filter_map(|name| {
            std::env::var(name)
                .ok()
                .map(|value| ((*name).to_string(), value))
        })
        .filter(|(_, value)| !value.trim().is_empty())
        .collect();
    let mut found = SystemProxy {
        env,
        ..SystemProxy::default()
    };
    windows::read(&mut found);
    found
}

/// `host:port` for every protocol, or `http=h:p;https=h:p;socks=h:p` (Internet Settings / WinHTTP format).
pub fn parse_proxy_server(text: &str) -> (Option<ProxyUrl>, Option<ProxyUrl>, Option<ProxyUrl>) {
    let text = text.trim();
    if text.is_empty() {
        return (None, None, None);
    }
    if !text.contains('=') {
        let first = text
            .split([';', ' '])
            .find(|part| !part.is_empty())
            .unwrap_or_default();
        let url = ProxyUrl::parse(first, Scheme::Http).ok();
        return (url.clone(), url, None);
    }
    let (mut http, mut https, mut socks) = (None, None, None);
    for part in text.split([';', ' ']).filter(|part| !part.is_empty()) {
        let Some((kind, address)) = part.split_once('=') else {
            continue;
        };
        match kind.trim().to_ascii_lowercase().as_str() {
            "http" => http = ProxyUrl::parse(address, Scheme::Http).ok(),
            "https" => https = ProxyUrl::parse(address, Scheme::Http).ok(),
            "socks" => socks = ProxyUrl::parse(address, Scheme::Socks5).ok(),
            _ => {}
        }
    }
    (http, https, socks)
}

/// Splits `user:pass@` off an environment proxy address (the only place credentials may come from outside).
fn split_env_credentials(value: &str) -> (String, Option<Credentials>) {
    let (scheme, rest) = value.split_once("://").map_or(("", value), |(s, r)| (s, r));
    match rest.rsplit_once('@') {
        Some((userinfo, host)) => {
            let (user, pass) = userinfo.split_once(':').unwrap_or((userinfo, ""));
            let address = if scheme.is_empty() {
                host.to_string()
            } else {
                format!("{scheme}://{host}")
            };
            (
                address,
                Some(Credentials {
                    username: decode(user),
                    password: decode(pass),
                }),
            )
        }
        None => (value.to_string(), None),
    }
}

fn decode(text: &str) -> String {
    let bytes = text.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            let hex = std::str::from_utf8(&bytes[i + 1..i + 3]).ok();
            if let Some(byte) = hex.and_then(|hex| u8::from_str_radix(hex, 16).ok()) {
                out.push(byte);
                i += 3;
                continue;
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

fn env_value<'a>(env: &'a [(String, String)], name: &str) -> Option<&'a str> {
    env.iter()
        .find(|(key, _)| key == name)
        .or_else(|| env.iter().find(|(key, _)| key.eq_ignore_ascii_case(name)))
        .map(|(_, value)| value.as_str())
}

/// The system proxy in force, in this order: the environment, the per-user Internet Settings, WinHTTP. Credentials
/// can only come from an environment address; they are returned beside the proxy and never stored.
pub fn resolve_system(found: &SystemProxy) -> (ResolvedProxy, Option<Credentials>) {
    let mut problems: Vec<(String, ProxyProblem)> = Vec::new();
    let mut credentials = None;
    let mut env_url = |name: &str, scheme: Scheme| -> Option<ProxyUrl> {
        let value = env_value(&found.env, name)?;
        let (address, creds) = split_env_credentials(value);
        match ProxyUrl::parse(&address, scheme) {
            Ok(url) => {
                if creds.is_some() {
                    credentials = creds;
                }
                Some(url)
            }
            Err(problem) => {
                problems.push((name.to_string(), problem));
                None
            }
        }
    };
    let http = env_url("HTTP_PROXY", Scheme::Http);
    let https = env_url("HTTPS_PROXY", Scheme::Http);
    let socks = env_url("ALL_PROXY", Scheme::Socks5);
    let no_proxy_env = env_value(&found.env, "NO_PROXY")
        .unwrap_or_default()
        .to_string();
    if http.is_some() || https.is_some() || socks.is_some() {
        return (
            ResolvedProxy {
                mode: ProxyMode::System,
                source: ProxySource::Environment,
                https: https.or_else(|| http.clone()),
                http,
                socks,
                no_proxy: parse_no_proxy(&no_proxy_env),
                pac_url: found.user_pac.clone(),
                auto_detect: found.user_auto_detect,
                problems,
            },
            credentials,
        );
    }
    let from = |proxy: &Option<String>, bypass: &Option<String>, source: ProxySource| {
        let (http, https, socks) = parse_proxy_server(proxy.as_deref().unwrap_or_default());
        (http.is_some() || https.is_some() || socks.is_some()).then(|| ResolvedProxy {
            mode: ProxyMode::System,
            source,
            https: https.or_else(|| http.clone()),
            http,
            socks,
            no_proxy: parse_no_proxy(bypass.as_deref().unwrap_or_default()),
            pac_url: found.user_pac.clone(),
            auto_detect: found.user_auto_detect,
            problems: Vec::new(),
        })
    };
    if let Some(resolved) = from(
        &found.user_proxy,
        &found.user_bypass,
        ProxySource::SystemUser,
    ) {
        return (resolved, None);
    }
    if let Some(resolved) = from(
        &found.winhttp_proxy,
        &found.winhttp_bypass,
        ProxySource::SystemWinHttp,
    ) {
        return (resolved, None);
    }
    let mut none = ResolvedProxy::off();
    none.mode = ProxyMode::System;
    none.source = ProxySource::NoneDetected;
    none.pac_url = found.user_pac.clone();
    none.auto_detect = found.user_auto_detect;
    none.problems = problems;
    (none, None)
}

#[cfg(windows)]
mod windows {
    use super::SystemProxy;
    use winapi::shared::minwindef::FALSE;
    use winapi::um::winbase::GlobalFree;
    use winapi::um::winhttp::{
        WinHttpGetDefaultProxyConfiguration, WinHttpGetIEProxyConfigForCurrentUser,
        WINHTTP_ACCESS_TYPE_NAMED_PROXY, WINHTTP_CURRENT_USER_IE_PROXY_CONFIG, WINHTTP_PROXY_INFO,
    };
    use winapi::um::winnt::LPWSTR;

    /// Copies and frees a string WinHTTP allocated.
    fn take(text: LPWSTR) -> Option<String> {
        if text.is_null() {
            return None;
        }
        // SAFETY: WinHTTP returned a NUL-terminated wide string it allocated with GlobalAlloc; it is read up to the
        // NUL and then freed exactly once.
        let value = unsafe {
            let mut len = 0usize;
            while *text.add(len) != 0 {
                len += 1;
            }
            let value = String::from_utf16_lossy(std::slice::from_raw_parts(text, len));
            GlobalFree(text.cast());
            value
        };
        let value = value.trim().to_string();
        (!value.is_empty()).then_some(value)
    }

    pub fn read(found: &mut SystemProxy) {
        // SAFETY: the structs are zero-initialized out-parameters; every returned string is taken (and freed) once.
        unsafe {
            let mut user: WINHTTP_CURRENT_USER_IE_PROXY_CONFIG = std::mem::zeroed();
            if WinHttpGetIEProxyConfigForCurrentUser(&mut user) != FALSE {
                found.user_pac = take(user.lpszAutoConfigUrl);
                found.user_auto_detect = user.fAutoDetect != FALSE;
                found.user_proxy = take(user.lpszProxy);
                found.user_bypass = take(user.lpszProxyBypass);
            }
            let mut machine: WINHTTP_PROXY_INFO = std::mem::zeroed();
            if WinHttpGetDefaultProxyConfiguration(&mut machine) != FALSE {
                let proxy = take(machine.lpszProxy);
                let bypass = take(machine.lpszProxyBypass);
                if machine.dwAccessType == WINHTTP_ACCESS_TYPE_NAMED_PROXY {
                    found.winhttp_proxy = proxy;
                    found.winhttp_bypass = bypass;
                }
            }
        }
    }
}

#[cfg(not(windows))]
mod windows {
    pub fn read(_found: &mut super::SystemProxy) {}
}

#[cfg(test)]
mod tests {
    use super::*;

    fn env(pairs: &[(&str, &str)]) -> Vec<(String, String)> {
        pairs
            .iter()
            .map(|(k, v)| ((*k).to_string(), (*v).to_string()))
            .collect()
    }

    #[test]
    fn internet_settings_strings_parse_in_both_forms() {
        let (http, https, socks) = parse_proxy_server("proxy.lab:8080");
        assert_eq!(
            http.as_ref().map(ProxyUrl::display).as_deref(),
            Some("http://proxy.lab:8080")
        );
        assert_eq!(https, http);
        assert!(socks.is_none());
        let (http, https, socks) = parse_proxy_server("http=a:80;https=b:443;socks=c:1080");
        assert_eq!(http.map(|u| u.host).as_deref(), Some("a"));
        assert_eq!(https.map(|u| u.port), Some(443));
        assert_eq!(socks.map(|u| u.scheme), Some(Scheme::Socks5));
        assert_eq!(parse_proxy_server(""), (None, None, None));
    }

    #[test]
    fn the_environment_comes_first_and_its_credentials_are_split_off() {
        let found = SystemProxy {
            env: env(&[
                ("https_proxy", "http://ivan:s%40cret@proxy.uni:3128"),
                ("NO_PROXY", "intra.uni"),
            ]),
            user_proxy: Some("other:80".into()),
            ..SystemProxy::default()
        };
        let (resolved, creds) = resolve_system(&found);
        assert_eq!(resolved.source, ProxySource::Environment);
        assert_eq!(
            resolved.https.as_ref().map(ProxyUrl::display).as_deref(),
            Some("http://proxy.uni:3128")
        );
        assert!(resolved.no_proxy.contains(&"intra.uni".to_string()));
        let creds = creds.expect("credentials");
        assert_eq!(
            (creds.username.as_str(), creds.password.as_str()),
            ("ivan", "s@cret")
        );
    }

    #[test]
    fn then_internet_settings_then_winhttp_then_nothing() {
        let user = SystemProxy {
            user_proxy: Some("u:8080".into()),
            user_bypass: Some("<local>;*.corp".into()),
            winhttp_proxy: Some("m:3128".into()),
            ..SystemProxy::default()
        };
        let (resolved, _) = resolve_system(&user);
        assert_eq!(resolved.source, ProxySource::SystemUser);
        assert!(resolved.no_proxy.contains(&"<local>".to_string()));
        let machine = SystemProxy {
            winhttp_proxy: Some("m:3128".into()),
            ..SystemProxy::default()
        };
        assert_eq!(
            resolve_system(&machine).0.source,
            ProxySource::SystemWinHttp
        );
        let pac_only = SystemProxy {
            user_pac: Some("http://wpad/wpad.dat".into()),
            ..SystemProxy::default()
        };
        let (none, _) = resolve_system(&pac_only);
        assert_eq!(none.source, ProxySource::NoneDetected);
        assert!(!none.active());
        assert_eq!(none.pac_url.as_deref(), Some("http://wpad/wpad.dat"));
        assert!(!none.auto_detect);
        let detect = SystemProxy {
            user_auto_detect: true,
            ..SystemProxy::default()
        };
        assert!(
            resolve_system(&detect).0.auto_detect,
            "WPAD is reported, never evaluated"
        );
    }

    #[test]
    fn detection_reads_without_failing() {
        let found = detect();
        let _ = resolve_system(&found);
    }
}
