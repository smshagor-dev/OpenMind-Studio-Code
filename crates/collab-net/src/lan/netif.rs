//! Which local addresses take part in local-network rooms.
//!
//! A computer can have Ethernet, Wi-Fi, a VPN, Hyper-V / WSL / Docker switches, other virtual adapters and loopback.
//! Names are not used (they are localized and arbitrary); the decision is made from facts the system reports:
//!
//! - **excluded**: not up, loopback, no usable address, and a *virtual adapter with no gateway* — a host-only switch
//!   (Hyper-V "Default Switch", WSL, Docker Desktop, VMware/VirtualBox host-only), recognized by its adapter vendor
//!   prefix (OUI), which leads to no other computer;
//! - **ranked**, best first: Ethernet/Wi-Fi with a gateway (a normal LAN), Ethernet/Wi-Fi without one (a lab switch
//!   with no router), anything else that is up (VPN/tunnel, a bridged virtual adapter); within a rank, by address.
//!
//! Usable IPv4: not loopback, unspecified, multicast or broadcast; a link-local 169.254.x.x address (no DHCP answer)
//! only when an interface has nothing else — two lab PCs with no DHCP server do reach each other on it. IPv6: global
//! and unique-local addresses are announced over mDNS; broadcast discovery is IPv4 only.
//!
//! Which interface a connection actually uses is left to the routing table ([`route_ip`]): the peer binds to the
//! local address the system would send from towards the other side.

use std::net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddr, UdpSocket};

/// Adapter vendor prefixes of virtual NICs (Hyper-V, VMware, VirtualBox, Parallels, Xen, QEMU/KVM, Docker).
const VIRTUAL_OUIS: &[[u8; 3]] = &[
    [0x00, 0x15, 0x5D],
    [0x00, 0x50, 0x56],
    [0x00, 0x0C, 0x29],
    [0x00, 0x05, 0x69],
    [0x00, 0x1C, 0x14],
    [0x08, 0x00, 0x27],
    [0x0A, 0x00, 0x27],
    [0x00, 0x1C, 0x42],
    [0x00, 0x16, 0x3E],
    [0x52, 0x54, 0x00],
    [0x02, 0x42, 0xAC],
];

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum IfKind {
    Ethernet,
    Wifi,
    Loopback,
    Tunnel,
    Other,
}

/// What the system reports about one interface (the input of [`classify`]).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct IfFacts {
    pub index: u32,
    pub kind: IfKind,
    pub up: bool,
    pub has_gateway: bool,
    pub mac: Option<[u8; 6]>,
    pub ipv4: Vec<(Ipv4Addr, u8)>,
    pub ipv6: Vec<Ipv6Addr>,
}

/// A usable interface: its addresses and rank (0 is best).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LanInterface {
    pub index: u32,
    pub rank: u8,
    pub ipv4: Vec<(Ipv4Addr, u8)>,
    pub ipv6: Vec<Ipv6Addr>,
}

impl LanInterface {
    /// The subnet broadcast address of each IPv4 address (none for /31 and /32).
    pub fn broadcasts(&self) -> Vec<Ipv4Addr> {
        self.ipv4
            .iter()
            .filter(|(_, prefix)| *prefix < 31)
            .map(|(ip, prefix)| Ipv4Addr::from(u32::from(*ip) | (u32::MAX >> prefix)))
            .collect()
    }

    pub fn addresses(&self) -> Vec<IpAddr> {
        self.ipv4
            .iter()
            .map(|(ip, _)| IpAddr::V4(*ip))
            .chain(self.ipv6.iter().map(|ip| IpAddr::V6(*ip)))
            .collect()
    }
}

fn is_virtual(mac: Option<[u8; 6]>) -> bool {
    mac.is_some_and(|mac| VIRTUAL_OUIS.iter().any(|oui| mac[..3] == oui[..]))
}

fn usable_v4(ip: &Ipv4Addr) -> bool {
    !(ip.is_loopback()
        || ip.is_unspecified()
        || ip.is_multicast()
        || ip.is_broadcast()
        || ip.is_documentation())
}

fn usable_v6(ip: &Ipv6Addr) -> bool {
    let first = ip.segments()[0];
    // Global unicast (2000::/3) or unique local (fc00::/7); not link-local (needs a scope), loopback or multicast.
    (first & 0xE000) == 0x2000 || (first & 0xFE00) == 0xFC00
}

/// Decides whether an interface takes part and how well it ranks; `None` excludes it.
pub fn classify(facts: &IfFacts) -> Option<LanInterface> {
    if !facts.up || facts.kind == IfKind::Loopback {
        return None;
    }
    if is_virtual(facts.mac) && !facts.has_gateway {
        return None; // a host-only virtual switch: no other computer is behind it
    }
    let mut ipv4: Vec<(Ipv4Addr, u8)> = facts
        .ipv4
        .iter()
        .copied()
        .filter(|(ip, _)| usable_v4(ip))
        .collect();
    let routable: Vec<(Ipv4Addr, u8)> = ipv4
        .iter()
        .copied()
        .filter(|(ip, _)| !ip.is_link_local())
        .collect();
    let apipa_only = routable.is_empty() && !ipv4.is_empty();
    if !apipa_only {
        ipv4 = routable;
    }
    ipv4.sort();
    let mut ipv6: Vec<Ipv6Addr> = facts.ipv6.iter().copied().filter(usable_v6).collect();
    ipv6.sort();
    if ipv4.is_empty() && ipv6.is_empty() {
        return None;
    }
    let physical = matches!(facts.kind, IfKind::Ethernet | IfKind::Wifi) && !is_virtual(facts.mac);
    let rank = match (physical, facts.has_gateway, apipa_only) {
        (_, _, true) => 3,
        (true, true, false) => 0,
        (true, false, false) => 1,
        (false, _, false) => 2,
    };
    Some(LanInterface {
        index: facts.index,
        rank,
        ipv4,
        ipv6,
    })
}

/// The usable interfaces, best first (deterministic: rank, then addresses).
pub fn select(all: &[IfFacts]) -> Vec<LanInterface> {
    let mut chosen: Vec<LanInterface> = all.iter().filter_map(classify).collect();
    chosen.sort_by(|a, b| {
        a.rank
            .cmp(&b.rank)
            .then_with(|| a.ipv4.cmp(&b.ipv4))
            .then_with(|| a.ipv6.cmp(&b.ipv6))
    });
    chosen
}

fn facts_of(interface: &netdev::Interface) -> IfFacts {
    use netdev::interface::state::OperState;
    use netdev::interface::types::InterfaceType;
    let kind = match interface.if_type {
        InterfaceType::Loopback => IfKind::Loopback,
        InterfaceType::Wireless80211 => IfKind::Wifi,
        InterfaceType::Tunnel | InterfaceType::Ppp => IfKind::Tunnel,
        InterfaceType::Ethernet
        | InterfaceType::FastEthernetT
        | InterfaceType::FastEthernetFx
        | InterfaceType::GigabitEthernet => IfKind::Ethernet,
        _ => IfKind::Other,
    };
    IfFacts {
        index: interface.index,
        kind,
        // Some systems report "unknown" for working adapters; only a definite down state excludes one.
        up: !matches!(
            interface.oper_state,
            OperState::Down | OperState::LowerLayerDown | OperState::NotPresent
        ),
        has_gateway: interface.gateway.is_some(),
        mac: interface.mac_addr.map(|m| m.octets()),
        ipv4: interface
            .ipv4
            .iter()
            .map(|net| (net.addr(), net.prefix_len()))
            .collect(),
        ipv6: interface.ipv6.iter().map(|net| net.addr()).collect(),
    }
}

/// This computer's usable interfaces now (read fresh each call: adapters come and go).
pub fn current() -> Vec<LanInterface> {
    let facts: Vec<IfFacts> = netdev::get_interfaces().iter().map(facts_of).collect();
    select(&facts)
}

/// The local address the system would send from towards `remote` (no packet is sent). Loopback for a loopback
/// remote; `None` when there is no route.
pub fn route_ip(remote: IpAddr) -> Option<IpAddr> {
    if remote.is_loopback() {
        return Some(remote);
    }
    let bind: SocketAddr = match remote {
        IpAddr::V4(_) => (Ipv4Addr::UNSPECIFIED, 0).into(),
        IpAddr::V6(_) => (Ipv6Addr::UNSPECIFIED, 0).into(),
    };
    let socket = UdpSocket::bind(bind).ok()?;
    socket.connect((remote, 9)).ok()?;
    let local = socket.local_addr().ok()?.ip();
    (!local.is_unspecified()).then_some(local)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn facts(kind: IfKind, gateway: bool, mac: [u8; 6], v4: &[(&str, u8)]) -> IfFacts {
        IfFacts {
            index: 1,
            kind,
            up: true,
            has_gateway: gateway,
            mac: Some(mac),
            ipv4: v4
                .iter()
                .map(|(ip, p)| (ip.parse().expect("ip"), *p))
                .collect(),
            ipv6: Vec::new(),
        }
    }

    const NIC: [u8; 6] = [0x3C, 0x52, 0x82, 1, 2, 3];
    const HYPERV: [u8; 6] = [0x00, 0x15, 0x5D, 9, 9, 9];

    #[test]
    fn host_only_virtual_switches_loopback_and_down_adapters_are_left_out() {
        assert!(
            classify(&facts(
                IfKind::Ethernet,
                false,
                HYPERV,
                &[("172.27.80.1", 20)]
            ))
            .is_none(),
            "WSL / Default Switch"
        );
        assert!(classify(&facts(IfKind::Loopback, false, NIC, &[("127.0.0.1", 8)])).is_none());
        let mut down = facts(IfKind::Ethernet, true, NIC, &[("192.168.1.5", 24)]);
        down.up = false;
        assert!(classify(&down).is_none());
        assert!(
            classify(&facts(IfKind::Ethernet, true, NIC, &[])).is_none(),
            "no address"
        );
        let bridged = classify(&facts(IfKind::Ethernet, true, HYPERV, &[("10.1.2.3", 16)]))
            .expect("external switch");
        assert_eq!(
            bridged.rank, 2,
            "a virtual adapter bridged to a real network still counts, ranked lower"
        );
    }

    #[test]
    fn real_lans_rank_first_and_a_router_less_lab_switch_still_works() {
        let all = vec![
            facts(IfKind::Tunnel, true, NIC, &[("10.8.0.2", 24)]),
            facts(IfKind::Ethernet, false, NIC, &[("192.168.50.10", 24)]),
            facts(IfKind::Wifi, true, NIC, &[("192.168.1.20", 24)]),
            facts(IfKind::Ethernet, false, HYPERV, &[("172.20.0.1", 20)]),
            facts(IfKind::Ethernet, false, NIC, &[("169.254.10.20", 16)]),
        ];
        let chosen = select(&all);
        let ranks: Vec<(u8, String)> = chosen
            .iter()
            .map(|i| (i.rank, i.ipv4[0].0.to_string()))
            .collect();
        assert_eq!(
            ranks,
            [
                (0, "192.168.1.20".into()),
                (1, "192.168.50.10".into()),
                (2, "10.8.0.2".into()),
                (3, "169.254.10.20".into())
            ]
        );
        assert_eq!(select(&all), chosen, "deterministic");
    }

    #[test]
    fn link_local_is_used_only_when_nothing_else_is_there_and_broadcasts_follow_the_prefix() {
        let both = classify(&facts(
            IfKind::Ethernet,
            true,
            NIC,
            &[("169.254.1.1", 16), ("10.0.5.7", 22)],
        ))
        .expect("lan");
        assert_eq!(both.ipv4, vec![("10.0.5.7".parse().expect("ip"), 22)]);
        assert_eq!(
            both.broadcasts(),
            vec!["10.0.7.255".parse::<Ipv4Addr>().expect("ip")]
        );
        let point =
            classify(&facts(IfKind::Ethernet, true, NIC, &[("10.0.0.1", 32)])).expect("lan");
        assert!(point.broadcasts().is_empty());
        let mut v6 = facts(IfKind::Ethernet, true, NIC, &[]);
        v6.ipv6 = vec![
            "fe80::1".parse().expect("ip"),
            "fd12::5".parse().expect("ip"),
            "::1".parse().expect("ip"),
        ];
        assert_eq!(
            classify(&v6).expect("v6").ipv6,
            vec!["fd12::5".parse::<Ipv6Addr>().expect("ip")]
        );
    }

    #[test]
    fn the_route_probe_sends_nothing_and_answers_for_loopback() {
        assert_eq!(
            route_ip("127.0.0.1".parse().expect("ip")),
            Some("127.0.0.1".parse().expect("ip"))
        );
        // Whatever this machine's interfaces are, the live list is well-formed.
        for interface in current() {
            assert!(!interface.addresses().is_empty());
            assert!(interface.addresses().iter().all(|ip| !ip.is_loopback()));
        }
    }
}
