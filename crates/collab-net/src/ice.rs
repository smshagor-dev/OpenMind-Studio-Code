//! ICE server configuration from the Phase 1 settings (`openmind_collab::netconfig`, already validated there). No
//! password lives here: the TURN login is asked for when an allocation starts ([`crate::turn::TurnCredentialSource`]).
//! Only the public STUN servers in [`DEFAULT_STUN`] are built in (used when none is set).

use std::net::IpAddr;

use openmind_collab::netconfig::NetConfig;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StunServer {
    pub host: String,
    pub port: u16,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TurnTransport {
    Udp,
    Tcp,
}

#[derive(Clone, PartialEq, Eq)]
pub struct TurnServer {
    /// `turns:` (TURN over TLS).
    pub secure: bool,
    pub host: String,
    pub port: u16,
    pub transport: TurnTransport,
}

impl std::fmt::Debug for TurnServer {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}", self.url())
    }
}

impl TurnServer {
    /// The address without the user name or password.
    pub fn url(&self) -> String {
        let scheme = if self.secure { "turns" } else { "turn" };
        let transport = match self.transport {
            TurnTransport::Udp => "udp",
            TurnTransport::Tcp => "tcp",
        };
        format!("{scheme}:{}:{}?transport={transport}", self.host, self.port)
    }
}

/// Which local candidates a peer connection offers.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub enum IcePolicy {
    /// Host, STUN-discovered and (when a TURN server is set) relayed candidates; ICE prefers the direct ones.
    #[default]
    All,
    /// Only the relayed candidate, so every packet goes through TURN. For verifying TURN (diagnostics and tests),
    /// never a normal setting.
    RelayOnly,
}

/// Everything a peer connection needs to find candidates.
#[derive(Debug, Clone, Default)]
pub struct IceSetup {
    pub stun: Vec<StunServer>,
    pub turn: Vec<TurnServer>,
    pub policy: IcePolicy,
    /// The local address to bind (tests use 127.0.0.1); `None` picks the address of the default route.
    pub bind_ip: Option<IpAddr>,
}

fn host_port(rest: &str, default_port: u16) -> Option<(String, u16)> {
    let rest = rest.trim_start_matches("//");
    if let Some(inner) = rest.strip_prefix('[') {
        let (host, after) = inner.split_once(']')?;
        let port = after
            .strip_prefix(':')
            .map_or(Some(default_port), |p| p.parse().ok())?;
        return Some((host.to_string(), port));
    }
    match rest.rsplit_once(':') {
        Some((host, port)) => Some((host.to_string(), port.parse().ok()?)),
        None => Some((rest.to_string(), default_port)),
    }
}

/// Public STUN servers used when none is set: they only tell a computer its public address (one UDP request from the
/// connection's own socket), so two computers behind different routers can find a direct path. Nothing else is sent.
pub const DEFAULT_STUN: &[(&str, u16)] =
    &[("stun.l.google.com", 19302), ("stun.cloudflare.com", 3478)];

impl IceSetup {
    /// [`DEFAULT_STUN`] when no STUN server is configured.
    pub fn with_default_stun(mut self) -> Self {
        if self.stun.is_empty() {
            self.stun = DEFAULT_STUN
                .iter()
                .map(|(host, port)| StunServer {
                    host: (*host).to_string(),
                    port: *port,
                })
                .collect();
        }
        self
    }

    /// Builds the setup from validated settings. URLs the settings layer already refused never get here.
    pub fn from_config(config: &NetConfig) -> Self {
        let stun = config
            .stun_urls
            .iter()
            .filter_map(|url| {
                let rest = url
                    .strip_prefix("stuns:")
                    .or_else(|| url.strip_prefix("stun:"))?;
                let (host, port) = host_port(rest, 3478)?;
                Some(StunServer { host, port })
            })
            .collect();
        let turn = config
            .turn_urls
            .iter()
            .filter_map(|url| {
                let secure = url.starts_with("turns:");
                let rest = url
                    .strip_prefix("turns:")
                    .or_else(|| url.strip_prefix("turn:"))?;
                let (address, query) = rest.split_once('?').unwrap_or((rest, ""));
                let (host, port) = host_port(address, if secure { 5349 } else { 3478 })?;
                let transport = if query.eq_ignore_ascii_case("transport=tcp") || secure {
                    TurnTransport::Tcp
                } else {
                    TurnTransport::Udp
                };
                Some(TurnServer {
                    secure,
                    host,
                    port,
                    transport,
                })
            })
            .collect();
        Self {
            stun,
            turn,
            policy: IcePolicy::All,
            bind_ip: None,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn settings_become_servers_without_built_in_defaults() {
        assert!(IceSetup::from_config(&NetConfig::default()).stun.is_empty());
        let config = NetConfig::parse(
            "",
            "stun:stun.example.org, stun:[2001:db8::1]:3479",
            "turn:turn.example.org:3478?transport=udp, turns:turn.example.org:443?transport=tcp",
            "classroom",
        );
        let setup = IceSetup::from_config(&config);
        assert_eq!(
            setup.stun,
            vec![
                StunServer {
                    host: "stun.example.org".into(),
                    port: 3478
                },
                StunServer {
                    host: "2001:db8::1".into(),
                    port: 3479
                },
            ]
        );
        assert_eq!(setup.turn.len(), 2);
        assert!(
            setup.turn[1].secure
                && setup.turn[1].port == 443
                && setup.turn[1].transport == TurnTransport::Tcp
        );
        assert_eq!(
            format!("{:?}", setup.turn),
            "[turn:turn.example.org:3478?transport=udp, turns:turn.example.org:443?transport=tcp]",
            "servers print as addresses only"
        );
    }
}
