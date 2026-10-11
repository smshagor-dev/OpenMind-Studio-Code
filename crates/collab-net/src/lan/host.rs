//! The Owner's local-network presence for one hosted room:
//!
//! - a rendezvous — the ordinary signaling relay (`openmind_collab_signal::Relay`), embedded and listening on the LAN,
//!   holding just this room's topic, which only this computer may host (`loopback_hosts_only`); participants join it
//!   with the same messages they would send to the Internet relay;
//! - announcements: the mDNS service and the broadcast responder, both naming only the room's [`DiscoveryTag`];
//! - a watcher that re-reads the usable interfaces every [`LanHostConfig::refresh`] and re-announces when they change
//!   (Ethernet unplugged, Wi-Fi joined), so participants find the Owner at its new address.
//!
//! [`LanHost::connector`] is how the Owner itself registers on its rendezvous (over loopback), with the participants'
//! addresses available to the Owner loop (see `signaling::multi`). Dropping or [`LanHost::stop`]ping it withdraws the
//! announcements (mDNS goodbye) and closes the rendezvous at once.

use std::net::{IpAddr, Ipv4Addr, SocketAddr};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use openmind_collab_signal::{Relay, RelayConfig};
use tokio::task::JoinHandle;

use super::broadcast::Responder;
use super::mdns::MdnsAdvertiser;
use super::{netif, random_hex, DiscoveryTag, DISCOVERY_PORT, PREFERRED_RENDEZVOUS_PORT};
use crate::error::NetError;
use crate::signaling::multi::Route;
use crate::signaling::WsSignaling;
use crate::state::ConnectionRoute;

#[derive(Debug, Clone)]
pub struct LanHostConfig {
    /// Address the rendezvous listens on (all IPv4 interfaces by default).
    pub bind: IpAddr,
    /// Port tried first (then any free one).
    pub preferred_port: Option<u16>,
    pub discovery_port: u16,
    pub mdns: bool,
    /// Addresses to announce on; `None` = this computer's usable interfaces (re-read every `refresh`).
    pub announce_on: Option<Vec<IpAddr>>,
    pub refresh: Duration,
}

impl Default for LanHostConfig {
    fn default() -> Self {
        Self {
            bind: IpAddr::V4(Ipv4Addr::UNSPECIFIED),
            preferred_port: Some(PREFERRED_RENDEZVOUS_PORT),
            discovery_port: DISCOVERY_PORT,
            mdns: true,
            announce_on: None,
            refresh: Duration::from_secs(15),
        }
    }
}

fn rendezvous_config() -> RelayConfig {
    RelayConfig {
        // This room's topic, and briefly a second one while a rotated Room Code re-registers.
        max_topics: 2,
        max_peers_per_topic: 64,
        max_connections: 256,
        loopback_hosts_only: true,
        ..RelayConfig::default()
    }
}

fn announce_addresses(config: &LanHostConfig) -> Vec<IpAddr> {
    // The rendezvous listens on IPv4, so only IPv4 addresses are announced.
    config.announce_on.clone().unwrap_or_else(|| {
        netif::current()
            .iter()
            .flat_map(|i| i.ipv4.iter().map(|(ip, _)| IpAddr::V4(*ip)))
            .collect()
    })
}

/// What a hosted room's local presence is doing (diagnostics; no tag, code or path).
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LanHostStatus {
    pub rendezvous_port: u16,
    /// The rendezvous still accepts connections (false if its accepting task ended unexpectedly).
    pub listening: bool,
    /// `ip:port` addresses participants can type in.
    pub endpoints: Vec<String>,
    /// Answering broadcast discovery (the discovery port could be opened).
    pub broadcast: bool,
    /// Announced over mDNS right now.
    pub mdns: bool,
}

pub struct LanHost {
    relay: Option<Relay>,
    port: u16,
    tag: DiscoveryTag,
    instance: String,
    _responder: Option<Responder>,
    mdns: Arc<Mutex<Option<MdnsAdvertiser>>>,
    watcher: JoinHandle<()>,
    config: LanHostConfig,
}

impl LanHost {
    /// Starts the rendezvous and the announcements for the room whose signaling topic is `topic`. Announcing is best
    /// effort (a network with no usable interface yet still gets the rendezvous, and the watcher retries); only a
    /// rendezvous that can't listen at all is an error.
    pub async fn start(topic: &str, config: LanHostConfig) -> Result<Self, NetError> {
        let relay = match config.preferred_port {
            Some(port) => {
                match Relay::start(SocketAddr::new(config.bind, port), rendezvous_config()).await {
                    Ok(relay) => relay,
                    Err(_) => {
                        Relay::start(SocketAddr::new(config.bind, 0), rendezvous_config()).await?
                    }
                }
            }
            None => Relay::start(SocketAddr::new(config.bind, 0), rendezvous_config()).await?,
        };
        let port = relay.addr().port();
        let tag = DiscoveryTag::for_topic(topic);
        let instance = random_hex(8).ok_or_else(|| NetError::Io("no randomness".into()))?;
        let responder = match Responder::start(
            config.discovery_port,
            tag.clone(),
            port,
            instance.clone(),
        ) {
            Ok(responder) => Some(responder),
            Err(err) => {
                tracing::info!(%err, "broadcast discovery can't listen; mDNS and typed-in addresses still work");
                None
            }
        };
        let mdns = Arc::new(Mutex::new(None));
        let watcher = tokio::spawn(watch(
            config.clone(),
            tag.clone(),
            port,
            instance.clone(),
            mdns.clone(),
        ));
        Ok(Self {
            relay: Some(relay),
            port,
            tag,
            instance,
            _responder: responder,
            mdns,
            watcher,
            config,
        })
    }

    pub fn port(&self) -> u16 {
        self.port
    }

    pub fn tag(&self) -> &DiscoveryTag {
        &self.tag
    }

    pub fn instance(&self) -> &str {
        &self.instance
    }

    /// The addresses participants can type in (`ip:port` on each announced interface).
    pub fn endpoints(&self) -> Vec<SocketAddr> {
        announce_addresses(&self.config)
            .into_iter()
            .map(|ip| SocketAddr::new(ip, self.port))
            .collect()
    }

    pub fn status(&self) -> LanHostStatus {
        LanHostStatus {
            rendezvous_port: self.port,
            listening: self.relay.as_ref().is_some_and(Relay::is_running),
            endpoints: self.endpoints().iter().map(ToString::to_string).collect(),
            broadcast: self._responder.is_some(),
            mdns: self.mdns.lock().is_ok_and(|m| m.is_some()),
        }
    }

    /// The Owner's own route to its rendezvous (loopback), with each participant's address known.
    pub fn route(&self) -> Option<Route> {
        let relay = self.relay.as_ref()?;
        let host = if self.config.bind.is_unspecified() {
            IpAddr::V4(Ipv4Addr::LOCALHOST)
        } else {
            self.config.bind
        };
        let url = format!("ws://{}", SocketAddr::new(host, self.port));
        let lookup = relay.lookup();
        Some(Route {
            route: ConnectionRoute::LocalLan,
            connector: Arc::new(WsSignaling::direct(&url)),
            lookup: Some(Arc::new(move |slot| lookup.remote_of(slot))),
        })
    }

    /// Announces the room under a new signaling topic (its Room Code was rotated): the old tag is withdrawn at once
    /// (broadcast registration dropped, mDNS goodbye), so the old code no longer finds the room here.
    pub fn set_topic(&mut self, topic: &str) {
        let tag = DiscoveryTag::for_topic(topic);
        if tag == self.tag {
            return;
        }
        self.withdraw();
        self._responder = None;
        match Responder::start(
            self.config.discovery_port,
            tag.clone(),
            self.port,
            self.instance.clone(),
        ) {
            Ok(responder) => self._responder = Some(responder),
            Err(err) => {
                tracing::info!(%err, "broadcast discovery can't listen; mDNS and typed-in addresses still work")
            }
        }
        self.tag = tag.clone();
        self.watcher = tokio::spawn(watch(
            self.config.clone(),
            tag,
            self.port,
            self.instance.clone(),
            self.mdns.clone(),
        ));
    }

    /// Withdraws the announcements and closes the rendezvous.
    pub async fn stop(mut self) {
        self.withdraw();
        if let Some(relay) = self.relay.take() {
            relay.stop().await;
        }
    }

    fn withdraw(&mut self) {
        self.watcher.abort();
        if let Ok(mut mdns) = self.mdns.lock() {
            mdns.take(); // its drop sends the goodbye records
        }
    }
}

impl Drop for LanHost {
    fn drop(&mut self) {
        self.withdraw(); // the relay stops when dropped
    }
}

async fn watch(
    config: LanHostConfig,
    tag: DiscoveryTag,
    port: u16,
    instance: String,
    mdns: Arc<Mutex<Option<MdnsAdvertiser>>>,
) {
    if !config.mdns {
        return;
    }
    loop {
        let addresses = announce_addresses(&config);
        let (tag, instance, mdns) = (tag.clone(), instance.clone(), mdns.clone());
        // mDNS registration talks to sockets synchronously; keep it off the async workers.
        let _ = tokio::task::spawn_blocking(move || {
            let Ok(mut current) = mdns.lock() else { return };
            let result = match current.as_mut() {
                Some(advertiser) => advertiser.update(addresses),
                None => MdnsAdvertiser::start(&tag, port, &instance, addresses).map(|advertiser| {
                    *current = Some(advertiser);
                }),
            };
            if let Err(err) = result {
                tracing::debug!(%err, "the room isn't announced over mDNS yet");
            }
        })
        .await;
        tokio::time::sleep(config.refresh).await;
    }
}
