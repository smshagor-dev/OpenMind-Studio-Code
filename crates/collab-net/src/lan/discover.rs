//! A participant's search for a room's Owner on the local network: mDNS and the broadcast query run side by side for a
//! short, bounded window; whatever answers is returned (broadcast answers first — their nonce proves they are fresh —,
//! then mDNS), without duplicates. Nothing is scanned: if both methods are filtered on a network, the Owner's address
//! can still be typed in ([`super::parse_endpoint`]).

use std::net::{IpAddr, SocketAddr};
use std::time::Duration;

use super::{broadcast, mdns, netif, DiscoveryTag, LanEndpoint, DISCOVERY_PORT};

#[derive(Debug, Clone)]
pub struct DiscoveryConfig {
    pub window: Duration,
    pub mdns: bool,
    /// Interfaces' addresses to browse mDNS on; `None` = this computer's usable interfaces.
    pub mdns_on: Option<Vec<IpAddr>>,
    pub broadcast: bool,
    /// Where queries go; `None` = the limited broadcast and each interface's subnet broadcast on the discovery port.
    pub broadcast_targets: Option<Vec<SocketAddr>>,
}

impl Default for DiscoveryConfig {
    fn default() -> Self {
        Self {
            window: Duration::from_millis(2500),
            mdns: true,
            mdns_on: None,
            broadcast: true,
            broadcast_targets: None,
        }
    }
}

/// What a search found, and why a method couldn't search at all (an empty `found` with no problem means nobody
/// answered).
#[derive(Debug, Default)]
pub struct Discovery {
    pub found: Vec<LanEndpoint>,
    pub problems: Vec<String>,
}

pub async fn discover(tag: &DiscoveryTag, config: &DiscoveryConfig) -> Vec<LanEndpoint> {
    discover_reporting(tag, config).await.found
}

/// [`discover`], with the reason a method couldn't search (logged too).
pub async fn discover_reporting(tag: &DiscoveryTag, config: &DiscoveryConfig) -> Discovery {
    let mdns_on = config.mdns_on.clone().unwrap_or_else(|| {
        netif::current()
            .iter()
            .flat_map(|i| i.ipv4.iter().map(|(ip, _)| IpAddr::V4(*ip)))
            .collect()
    });
    let targets = config
        .broadcast_targets
        .clone()
        .unwrap_or_else(|| broadcast::default_targets(DISCOVERY_PORT));
    let by_mdns = async {
        if config.mdns {
            mdns::browse(tag, config.window, mdns_on).await
        } else {
            Vec::new()
        }
    };
    let by_broadcast = async {
        if config.broadcast {
            broadcast::query(tag, &targets, config.window).await
        } else {
            Ok(Vec::new())
        }
    };
    let (from_mdns, from_broadcast) = tokio::join!(by_mdns, by_broadcast);
    let mut problems = Vec::new();
    let from_broadcast = from_broadcast.unwrap_or_else(|problem| {
        tracing::warn!(%problem, "broadcast discovery couldn't search");
        problems.push(problem);
        Vec::new()
    });
    let mut found: Vec<LanEndpoint> = Vec::new();
    for endpoint in from_broadcast.into_iter().chain(from_mdns) {
        if !found.iter().any(|known| known.addr == endpoint.addr) {
            found.push(endpoint);
        }
    }
    Discovery {
        found: by_route(found, &netif::current()),
        problems,
    }
}

/// Orders found addresses by the interface the system would reach them through: a LAN interface's rank first; then
/// anything reached another way (a host-only virtual switch answering a limited broadcast, loopback) — kept, but tried
/// last. Stable, so equal addresses keep the order they were found in (broadcast before mDNS).
pub fn by_route(
    mut found: Vec<LanEndpoint>,
    interfaces: &[netif::LanInterface],
) -> Vec<LanEndpoint> {
    let rank = |endpoint: &LanEndpoint| {
        netif::route_ip(endpoint.addr.ip())
            .and_then(|local| interfaces.iter().find(|i| i.addresses().contains(&local)))
            .map_or(u8::MAX, |i| i.rank)
    };
    found.sort_by_cached_key(rank);
    found
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::lan::LanSource;

    #[test]
    fn addresses_behind_a_lan_interface_are_tried_before_others() {
        let found: Vec<LanEndpoint> = ["127.0.0.1:1", "127.0.0.2:1"]
            .iter()
            .map(|a| LanEndpoint {
                addr: a.parse().expect("addr"),
                source: LanSource::Broadcast,
                instance: String::new(),
            })
            .collect();
        // Loopback is no LAN interface: with none selected, the order found stays.
        assert_eq!(by_route(found.clone(), &[]), found);
        // Pretend 127.0.0.2's route is a ranked interface: it moves first.
        let lan = netif::LanInterface {
            index: 1,
            rank: 0,
            ipv4: vec![("127.0.0.2".parse().expect("ip"), 8)],
            ipv6: Vec::new(),
        };
        let ordered = by_route(found, &[lan]);
        assert_eq!(ordered[0].addr.to_string(), "127.0.0.2:1");
    }
}
