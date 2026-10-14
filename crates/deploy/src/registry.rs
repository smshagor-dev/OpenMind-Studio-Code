//! The deployments a computer knows about, grouped by **deployment id** — never by address, user name, path or drive
//! letter, which can all change or repeat. One shared installation announced by twenty computers is one deployment with
//! twenty sources; a source that restarted (new instance) or moved to another address stays the same deployment; a
//! source not heard from for the time-to-live is dropped, and a deployment with no source left is gone.
//!
//! Pure: callers pass the time, so tests replay any sequence.

use std::collections::BTreeMap;
use std::net::SocketAddr;
use std::time::{Duration, Instant};

use crate::advert::Advert;

/// At most this many deployments and this many sources per deployment are kept (forged answers can't grow it).
pub const MAX_DEPLOYMENTS: usize = 256;
pub const MAX_SOURCES: usize = 64;

/// How long an answer counts after it arrived.
pub const DEFAULT_TTL: Duration = Duration::from_secs(90);

/// One computer announcing a deployment.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Source {
    pub address: SocketAddr,
    pub instance: String,
    pub http_port: u16,
    pub app_version: String,
    pub last_seen: Instant,
}

/// One deployment and every computer currently announcing it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Deployment {
    /// The most recent answer.
    pub advert: Advert,
    pub sources: Vec<Source>,
    pub first_seen: Instant,
}

impl Deployment {
    /// The source heard from most recently (offering packages first).
    pub fn best_source(&self) -> Option<&Source> {
        self.sources
            .iter()
            .max_by_key(|s| (s.http_port != 0, s.last_seen))
    }
}

/// What one answer changed.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Observation {
    /// A deployment not known before.
    New,
    /// Another computer announcing a known deployment.
    NewSource,
    /// A known source again (a duplicate answer: nothing new).
    Refreshed,
    /// A known source whose OpenMind Studio restarted (a new instance at the same address and port — a responder always
    /// answers from the discovery port, so two programs on one computer are two sources, not a restart).
    Restarted,
    /// A known instance at a new address (DHCP gave it another one).
    Moved,
    /// Not taken: it claims a known deployment's id with another kind, or a limit was reached.
    Ignored,
}

#[derive(Debug, Default)]
pub struct DiscoveredSet {
    deployments: BTreeMap<String, Deployment>,
}

impl DiscoveredSet {
    pub fn observe(&mut self, advert: Advert, from: SocketAddr, now: Instant) -> Observation {
        let source = Source {
            address: from,
            instance: advert.instance.clone(),
            http_port: advert.http_port,
            app_version: advert.app_version.clone(),
            last_seen: now,
        };
        let Some(known) = self.deployments.get_mut(&advert.deployment_id) else {
            if self.deployments.len() >= MAX_DEPLOYMENTS {
                return Observation::Ignored;
            }
            self.deployments.insert(
                advert.deployment_id.clone(),
                Deployment {
                    advert,
                    sources: vec![source],
                    first_seen: now,
                },
            );
            return Observation::New;
        };
        // A deployment never changes kind: an answer that says otherwise is someone else's claim to its id.
        if known.advert.kind != advert.kind {
            return Observation::Ignored;
        }
        let new_source = !known
            .sources
            .iter()
            .any(|s| s.instance == source.instance || s.address == source.address);
        if new_source && known.sources.len() >= MAX_SOURCES {
            return Observation::Ignored;
        }
        known.advert = advert;
        let observation = if let Some(same) = known
            .sources
            .iter_mut()
            .find(|s| s.instance == source.instance)
        {
            let moved = same.address != source.address;
            *same = source;
            if moved {
                Observation::Moved
            } else {
                Observation::Refreshed
            }
        } else if let Some(restarted) = known
            .sources
            .iter_mut()
            .find(|s| s.address == source.address)
        {
            *restarted = source;
            Observation::Restarted
        } else {
            known.sources.push(source);
            Observation::NewSource
        };
        observation
    }

    /// Drops sources older than `ttl` and deployments left without one; returns the ids that disappeared.
    pub fn prune(&mut self, now: Instant, ttl: Duration) -> Vec<String> {
        let mut gone = Vec::new();
        self.deployments.retain(|id, deployment| {
            deployment
                .sources
                .retain(|s| now.saturating_duration_since(s.last_seen) <= ttl);
            let keep = !deployment.sources.is_empty();
            if !keep {
                gone.push(id.clone());
            }
            keep
        });
        gone
    }

    pub fn get(&self, id: &str) -> Option<&Deployment> {
        self.deployments.get(id)
    }

    pub fn list(&self) -> Vec<&Deployment> {
        self.deployments.values().collect()
    }

    pub fn len(&self) -> usize {
        self.deployments.len()
    }

    pub fn is_empty(&self) -> bool {
        self.deployments.is_empty()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::advert::tests::share_advert;

    fn addr(text: &str) -> SocketAddr {
        text.parse().expect("addr")
    }

    fn from(instance: &str) -> Advert {
        Advert {
            instance: instance.into(),
            ..share_advert()
        }
    }

    #[test]
    fn one_share_announced_by_many_computers_is_one_deployment() {
        let mut set = DiscoveredSet::default();
        let t = Instant::now();
        assert_eq!(
            set.observe(from("1111111111111111"), addr("10.0.0.1:47741"), t),
            Observation::New
        );
        assert_eq!(
            set.observe(from("2222222222222222"), addr("10.0.0.2:47741"), t),
            Observation::NewSource
        );
        assert_eq!(
            set.observe(from("1111111111111111"), addr("10.0.0.1:47741"), t),
            Observation::Refreshed
        );
        assert_eq!(set.len(), 1);
        assert_eq!(set.list()[0].sources.len(), 2);
    }

    #[test]
    fn a_restart_or_a_new_address_keeps_the_deployment() {
        let mut set = DiscoveredSet::default();
        let t = Instant::now();
        set.observe(from("1111111111111111"), addr("10.0.0.1:47741"), t);
        assert_eq!(
            set.observe(from("3333333333333333"), addr("10.0.0.1:47741"), t),
            Observation::Restarted
        );
        assert_eq!(
            set.observe(from("3333333333333333"), addr("10.0.0.9:47741"), t),
            Observation::Moved
        );
        let deployment = set.list()[0];
        assert_eq!(deployment.sources.len(), 1);
        assert_eq!(deployment.sources[0].address, addr("10.0.0.9:47741"));
    }

    #[test]
    fn silent_sources_expire_and_take_their_deployment_with_them() {
        let mut set = DiscoveredSet::default();
        let t = Instant::now();
        set.observe(from("1111111111111111"), addr("10.0.0.1:47741"), t);
        set.observe(
            from("2222222222222222"),
            addr("10.0.0.2:47741"),
            t + Duration::from_secs(60),
        );
        assert!(set
            .prune(t + Duration::from_secs(100), DEFAULT_TTL)
            .is_empty());
        assert_eq!(
            set.list()[0].sources.len(),
            1,
            "the first source went stale"
        );
        let gone = set.prune(t + Duration::from_secs(200), DEFAULT_TTL);
        assert_eq!(gone, vec![share_advert().deployment_id]);
        assert!(set.is_empty());
        // It comes back: a new deployment again, under the same identity.
        assert_eq!(
            set.observe(from("4444444444444444"), addr("10.0.0.7:47741"), t),
            Observation::New
        );
        assert!(set.get(&share_advert().deployment_id).is_some());
    }

    #[test]
    fn an_answer_claiming_a_known_id_with_another_kind_is_ignored() {
        let mut set = DiscoveredSet::default();
        let t = Instant::now();
        set.observe(from("1111111111111111"), addr("10.0.0.1:47741"), t);
        let mut forged = from("9999999999999999");
        forged.kind = crate::advert::DeploymentKind::PackageSource;
        forged.share_path = None;
        assert_eq!(
            set.observe(forged, addr("10.6.6.6:47741"), t),
            Observation::Ignored
        );
        let kept = set.get(&share_advert().deployment_id).expect("kept");
        assert_eq!(
            kept.advert.kind,
            crate::advert::DeploymentKind::NetworkShare
        );
        assert_eq!(kept.sources.len(), 1);
    }

    #[test]
    fn a_flood_of_sources_is_capped() {
        let mut set = DiscoveredSet::default();
        let t = Instant::now();
        for i in 0..(MAX_SOURCES + 20) {
            let instance = format!("{i:016x}");
            set.observe(
                from(&instance),
                addr(&format!("10.1.{}.{}:47741", i / 250, i % 250 + 1)),
                t,
            );
        }
        assert_eq!(set.list()[0].sources.len(), MAX_SOURCES);
    }

    #[test]
    fn the_best_source_is_one_that_serves_packages() {
        let mut set = DiscoveredSet::default();
        let t = Instant::now();
        let mut with_packages = from("1111111111111111");
        with_packages.http_port = 50000;
        with_packages.packages = 1;
        set.observe(with_packages, addr("10.0.0.1:47741"), t);
        set.observe(
            from("2222222222222222"),
            addr("10.0.0.2:47741"),
            t + Duration::from_secs(5),
        );
        let best = set.list()[0].best_source().expect("source");
        assert_eq!(best.http_port, 50000);
    }
}
