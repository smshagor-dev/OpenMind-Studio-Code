//! mDNS / DNS-SD announcement and lookup (the primary discovery method; `mdns-sd`, pure Rust, no Bonjour service, no
//! administrator rights). An Owner registers one `_omcollab._tcp` instance per hosted room:
//!
//! - instance name `<tag>-<instance>`, host name `om-<instance>.local.` (random, never the computer's name);
//! - TXT `v` (version), `tag` (the room's [`DiscoveryTag`]) and `i` (the per-run instance id); the SRV port is the
//!   rendezvous port; the addresses are the usable interfaces' ([`super::netif`]) — not every adapter.
//!
//! Unregistering sends mDNS "goodbye" records, so a closed room disappears from other computers at once; an Owner that
//! vanished without one ages out with mDNS's own record lifetimes (and fails the handshake meanwhile).

use std::net::{IpAddr, SocketAddr};
use std::time::Duration;

use mdns_sd::{IfKind, ServiceDaemon, ServiceEvent, ServiceInfo};

use super::{DiscoveryTag, LanEndpoint, LanSource, LAN_VERSION, SERVICE_TYPE};

/// The announcement of one hosted room; withdrawn when dropped.
pub struct MdnsAdvertiser {
    daemon: ServiceDaemon,
    fullname: String,
    service: (DiscoveryTag, u16, String),
    addresses: Vec<IpAddr>,
}

fn daemon_on(addresses: &[IpAddr]) -> Result<ServiceDaemon, String> {
    let daemon = ServiceDaemon::new().map_err(|e| e.to_string())?;
    // Only the chosen interfaces: never a host-only virtual switch, loopback only when asked for (tests).
    daemon
        .disable_interface(IfKind::All)
        .map_err(|e| e.to_string())?;
    for ip in addresses {
        let kind = match ip {
            IpAddr::V4(v4) if v4.is_loopback() => IfKind::LoopbackV4,
            IpAddr::V6(v6) if v6.is_loopback() => IfKind::LoopbackV6,
            other => IfKind::Addr(*other),
        };
        daemon.enable_interface(kind).map_err(|e| e.to_string())?;
    }
    let _ = daemon.set_multicast_loop_v4(true);
    Ok(daemon)
}

impl MdnsAdvertiser {
    pub fn start(
        tag: &DiscoveryTag,
        port: u16,
        instance: &str,
        addresses: Vec<IpAddr>,
    ) -> Result<Self, String> {
        if addresses.is_empty() {
            return Err("no local network address to announce on".into());
        }
        let daemon = daemon_on(&addresses)?;
        let mut me = Self {
            daemon,
            fullname: String::new(),
            service: (tag.clone(), port, instance.to_string()),
            addresses: Vec::new(),
        };
        me.register(addresses)?;
        Ok(me)
    }

    fn register(&mut self, addresses: Vec<IpAddr>) -> Result<(), String> {
        let (tag, port, instance) = &self.service;
        let name = format!("{tag}-{instance}");
        let host = format!("om-{instance}.local.");
        let version = LAN_VERSION.to_string();
        let properties = [
            ("v", version.as_str()),
            ("tag", tag.as_str()),
            ("i", instance.as_str()),
        ];
        let info = ServiceInfo::new(
            SERVICE_TYPE,
            &name,
            &host,
            addresses.as_slice(),
            *port,
            &properties[..],
        )
        .map_err(|e| e.to_string())?;
        self.fullname = info.get_fullname().to_string();
        self.daemon.register(info).map_err(|e| e.to_string())?;
        self.addresses = addresses;
        Ok(())
    }

    pub fn addresses(&self) -> &[IpAddr] {
        &self.addresses
    }

    /// The usable addresses changed (Ethernet unplugged, Wi-Fi joined): announce the new ones.
    pub fn update(&mut self, addresses: Vec<IpAddr>) -> Result<(), String> {
        if addresses == self.addresses || addresses.is_empty() {
            return Ok(());
        }
        let _ = self.daemon.unregister(&self.fullname);
        for ip in &addresses {
            if !self.addresses.contains(ip) {
                let _ = self.daemon.enable_interface(IfKind::Addr(*ip));
            }
        }
        self.register(addresses)
    }
}

impl Drop for MdnsAdvertiser {
    fn drop(&mut self) {
        if let Ok(done) = self.daemon.unregister(&self.fullname) {
            let _ = done.recv_timeout(Duration::from_millis(500)); // goodbye records sent
        }
        let _ = self.daemon.shutdown();
    }
}

/// Looks for `tag` for up to `window` on the given interfaces' addresses; returns early shortly after a first find.
pub async fn browse(tag: &DiscoveryTag, window: Duration, on: Vec<IpAddr>) -> Vec<LanEndpoint> {
    let tag = tag.clone();
    tokio::task::spawn_blocking(move || browse_blocking(&tag, window, &on))
        .await
        .unwrap_or_default()
}

fn browse_blocking(tag: &DiscoveryTag, window: Duration, on: &[IpAddr]) -> Vec<LanEndpoint> {
    if on.is_empty() {
        return Vec::new();
    }
    let Ok(daemon) = daemon_on(on) else {
        return Vec::new();
    };
    let Ok(events) = daemon.browse(SERVICE_TYPE) else {
        let _ = daemon.shutdown();
        return Vec::new();
    };
    let start = std::time::Instant::now();
    let mut deadline = start + window;
    let mut found: Vec<LanEndpoint> = Vec::new();
    while let Some(left) = deadline.checked_duration_since(std::time::Instant::now()) {
        let Ok(event) = events.recv_timeout(left) else {
            break;
        };
        let ServiceEvent::ServiceResolved(service) = event else {
            continue;
        };
        let props = &service.txt_properties;
        let version = props
            .get_property_val_str("v")
            .and_then(|v| v.parse::<u32>().ok());
        let instance = props
            .get_property_val_str("i")
            .unwrap_or_default()
            .to_string();
        let valid_instance =
            instance.len() == 16 && instance.bytes().all(|b| b.is_ascii_hexdigit());
        if version != Some(LAN_VERSION)
            || props.get_property_val_str("tag") != Some(tag.as_str())
            || !valid_instance
        {
            continue; // another room, another version, or a malformed announcement
        }
        let mut addresses: Vec<IpAddr> = service
            .get_addresses()
            .iter()
            .map(|ip| ip.to_ip_addr())
            .filter(|ip| !matches!(ip, IpAddr::V6(v6) if (v6.segments()[0] & 0xFFC0) == 0xFE80))
            .collect();
        addresses.sort_by_key(|ip| (ip.is_ipv6(), *ip)); // IPv4 first
        for ip in addresses {
            let endpoint = LanEndpoint {
                addr: SocketAddr::new(ip, service.get_port()),
                source: LanSource::Mdns,
                instance: instance.clone(),
            };
            if service.get_port() != 0 && !found.contains(&endpoint) {
                found.push(endpoint);
            }
        }
        if !found.is_empty() {
            deadline = deadline.min(std::time::Instant::now() + Duration::from_millis(250));
        }
    }
    let _ = daemon.stop_browse(SERVICE_TYPE);
    let _ = daemon.shutdown();
    found
}
