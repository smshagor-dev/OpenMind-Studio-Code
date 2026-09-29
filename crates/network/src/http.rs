//! How OpenMind's own HTTP requests (Runtime Manager, Open VSX, AI providers, the connection test) reach the
//! network. The app sets the proxy in force once it knows the settings (`set_current`); every client asks `route`
//! for each URL. With the mode None nothing is changed, so the HTTP client behaves exactly as before.

use std::sync::RwLock;
use std::time::Duration;

use crate::proxy::{Credentials, ProxyMode, ResolvedProxy, Scheme};

/// The proxy in force for this process, with the credentials to use (in memory only).
#[derive(Debug, Clone)]
pub struct HttpProxy {
    pub resolved: ResolvedProxy,
    pub credentials: Option<Credentials>,
}

static CURRENT: RwLock<Option<HttpProxy>> = RwLock::new(None);

/// Sets (or clears) the proxy OpenMind's own requests use from now on.
pub fn set_current(proxy: Option<HttpProxy>) {
    if let Ok(mut current) = CURRENT.write() {
        *current = proxy;
    }
}

pub fn current() -> Option<HttpProxy> {
    CURRENT.read().ok().and_then(|current| current.clone())
}

/// What a client does for one URL.
#[derive(Debug)]
pub enum Route {
    /// The mode is None: leave the client's own behaviour alone.
    Unchanged,
    /// Go straight to the server (bypass list, or no proxy found in System mode).
    Direct,
    Proxy(ureq::Proxy),
}

/// The host and whether the URL is https.
fn target(url: &str) -> (bool, String) {
    let https = url.to_ascii_lowercase().starts_with("https://");
    let rest = url.split_once("://").map_or(url, |(_, rest)| rest);
    let authority = rest.split(['/', '?', '#']).next().unwrap_or_default();
    let host_port = authority
        .rsplit_once('@')
        .map_or(authority, |(_, host)| host);
    let host = if let Some(inner) = host_port.strip_prefix('[') {
        inner.split(']').next().unwrap_or_default().to_string()
    } else {
        host_port.split(':').next().unwrap_or_default().to_string()
    };
    (https, host)
}

/// The route for `url` under `proxy`.
pub fn route_with(proxy: Option<&HttpProxy>, url: &str) -> Route {
    let Some(proxy) = proxy.filter(|p| p.resolved.mode != ProxyMode::None) else {
        return Route::Unchanged;
    };
    let (https, host) = target(url);
    let Some(address) = proxy.resolved.for_target(https, &host) else {
        return Route::Direct;
    };
    let protocol = match address.scheme {
        Scheme::Http => ureq::ProxyProtocol::Http,
        Scheme::Https => ureq::ProxyProtocol::Https,
        Scheme::Socks5 => ureq::ProxyProtocol::Socks5h,
    };
    let mut builder = ureq::Proxy::builder(protocol)
        .host(&address.host)
        .port(address.port);
    if let Some(creds) = proxy
        .credentials
        .as_ref()
        .filter(|c| !c.username.is_empty())
    {
        builder = builder.username(&creds.username).password(&creds.password);
    }
    match builder.build() {
        Ok(proxy) => Route::Proxy(proxy),
        Err(err) => {
            tracing::warn!(%err, "the proxy address can't be used; connecting directly");
            Route::Direct
        }
    }
}

/// The route for `url` under the proxy in force.
pub fn route(url: &str) -> Route {
    route_with(current().as_ref(), url)
}

/// Time limits of one request made by OpenMind. ureq's body limit is the *total* time for the body.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Timeouts {
    pub connect: Duration,
    pub response: Duration,
    pub body: Duration,
}

impl Timeouts {
    /// The Download Manager's limits: 15 s to connect, 30 s to the first byte, `body` for the rest.
    pub fn download(body: Duration) -> Self {
        Timeouts {
            connect: Duration::from_secs(15),
            response: Duration::from_secs(30),
            body,
        }
    }
}

/// The one agent every OpenMind download is made with (the Runtime Manager's `UreqClient`, and the package gateway that
/// serves pip, npm, Go and Git): https only, HTTP statuses returned instead of turned into errors, the proxy route in
/// force for `url`, the same TLS roots. `max_redirects` `None` keeps ureq's default (the Download Manager follows
/// redirects); the gateway passes `Some(0)` so a tool sees the redirect itself.
pub fn agent(url: &str, timeouts: Timeouts, max_redirects: Option<u32>) -> ureq::Agent {
    let mut builder = ureq::Agent::config_builder()
        .https_only(true)
        .http_status_as_error(false)
        .timeout_connect(Some(timeouts.connect))
        .timeout_recv_response(Some(timeouts.response))
        .timeout_recv_body(Some(timeouts.body));
    if let Some(redirects) = max_redirects {
        builder = builder.max_redirects(redirects);
    }
    configure(builder, url).build().into()
}

/// A failed request as a categorized network error, free of the proxy credentials (through a proxy a refused connection or
/// an unknown name is the proxy's problem).
pub fn net_error(error: &ureq::Error, url: &str) -> crate::problem::NetError {
    let credentials = current().and_then(|proxy| proxy.credentials);
    let detail = crate::redact::redact(&error.to_string(), credentials.as_ref());
    let through_proxy = matches!(route(url), Route::Proxy(_));
    crate::problem::NetError::new(crate::problem::classify_via(error, through_proxy), detail)
}

/// Applies the route for `url` to an agent's configuration.
pub fn configure(
    builder: ureq::config::ConfigBuilder<ureq::typestate::AgentScope>,
    url: &str,
) -> ureq::config::ConfigBuilder<ureq::typestate::AgentScope> {
    match route(url) {
        Route::Unchanged => builder,
        Route::Direct => builder.proxy(None),
        Route::Proxy(proxy) => builder.proxy(Some(proxy)),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::proxy::{resolve_manual, ProxySettings};

    fn manual() -> HttpProxy {
        HttpProxy {
            resolved: resolve_manual(&ProxySettings {
                http: "proxy.lab:3128".into(),
                no_proxy: "intranet.lab".into(),
                ..ProxySettings::default()
            }),
            credentials: Some(Credentials {
                username: "ivan".into(),
                password: "pw".into(),
            }),
        }
    }

    #[test]
    fn urls_are_routed_by_mode_and_bypass_list() {
        assert!(matches!(
            route_with(None, "https://pypi.org"),
            Route::Unchanged
        ));
        let off = HttpProxy {
            resolved: ResolvedProxy::off(),
            credentials: None,
        };
        assert!(matches!(
            route_with(Some(&off), "https://pypi.org"),
            Route::Unchanged
        ));
        let proxy = manual();
        match route_with(Some(&proxy), "https://open-vsx.org/api/x") {
            Route::Proxy(p) => {
                assert_eq!((p.host(), p.port()), ("proxy.lab", 3128));
                assert_eq!(p.username(), Some("ivan"));
            }
            other => panic!("{other:?}"),
        }
        for url in [
            "http://127.0.0.1:11434/v1/models",
            "https://intranet.lab/x",
            "http://localhost:8080",
            "http://[::1]:5000/",
        ] {
            assert!(
                matches!(route_with(Some(&proxy), url), Route::Direct),
                "{url}"
            );
        }
    }

    #[test]
    fn the_host_is_found_in_every_url_shape() {
        assert_eq!(
            target("https://user@host.x:8443/p?q"),
            (true, "host.x".to_string())
        );
        assert_eq!(target("http://[::1]:80/"), (false, "::1".to_string()));
        assert_eq!(target("https://a.b"), (true, "a.b".to_string()));
    }
}
