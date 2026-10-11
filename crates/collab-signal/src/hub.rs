//! The relay's whole state, in memory only: which connections exist and which topics they host or joined. Nothing is
//! written anywhere and nothing survives a restart. The hub never reads what a signal contains (it only checks its
//! size and forwards it), and it forwards only between a topic's host and that topic's participants.

use std::collections::{HashMap, HashSet};
use std::time::{Duration, Instant};

use tokio::sync::mpsc;

use crate::proto::{ClientMessage, ErrorCode, RelayMessage, Signal, Slot, Topic};

/// Limits of one relay.
#[derive(Debug, Clone)]
pub struct RelayConfig {
    /// A topic with no signaling (host renewals included) for this long expires.
    pub topic_ttl: Duration,
    pub max_topics: usize,
    pub max_peers_per_topic: usize,
    pub max_connections: usize,
    pub max_messages_per_second: u32,
    /// Malformed messages tolerated before the connection is closed.
    pub max_strikes: u32,
    /// Only connections from this computer may host a topic (a relay embedded in an Owner's app for the local network:
    /// other machines may join, never register rooms on it).
    pub loopback_hosts_only: bool,
}

impl Default for RelayConfig {
    fn default() -> Self {
        Self {
            topic_ttl: Duration::from_secs(600),
            max_topics: 10_000,
            max_peers_per_topic: 64,
            max_connections: 20_000,
            max_messages_per_second: 200,
            max_strikes: 3,
            loopback_hosts_only: false,
        }
    }
}

pub type Outbox = mpsc::Sender<RelayMessage>;

struct Connection {
    out: Outbox,
    topic: Option<Topic>,
    /// Where the connection comes from (unknown for in-memory test connections).
    remote: Option<std::net::SocketAddr>,
}

struct TopicEntry {
    host: Slot,
    peers: HashSet<Slot>,
    last_activity: Instant,
}

/// Counts for tests and the log.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct HubCounts {
    pub connections: usize,
    pub topics: usize,
}

pub struct Hub {
    config: RelayConfig,
    connections: HashMap<Slot, Connection>,
    topics: HashMap<Topic, TopicEntry>,
}

impl Hub {
    pub fn new(config: RelayConfig) -> Self {
        Self {
            config,
            connections: HashMap::new(),
            topics: HashMap::new(),
        }
    }

    pub fn config(&self) -> &RelayConfig {
        &self.config
    }

    pub fn counts(&self) -> HubCounts {
        HubCounts {
            connections: self.connections.len(),
            topics: self.topics.len(),
        }
    }

    /// A new connection; `None` when the relay is full.
    pub fn connect(&mut self, out: Outbox) -> Option<Slot> {
        self.connect_from(out, None)
    }

    /// A new connection from `remote`; `None` when the relay is full.
    pub fn connect_from(
        &mut self,
        out: Outbox,
        remote: Option<std::net::SocketAddr>,
    ) -> Option<Slot> {
        if self.connections.len() >= self.config.max_connections {
            return None;
        }
        let slot = Slot::random().ok()?;
        self.connections.insert(
            slot.clone(),
            Connection {
                out,
                topic: None,
                remote,
            },
        );
        Some(slot)
    }

    /// Where a connection comes from, if known.
    pub fn remote_of(&self, slot: &Slot) -> Option<std::net::SocketAddr> {
        self.connections.get(slot).and_then(|c| c.remote)
    }

    fn send(&self, slot: &Slot, message: RelayMessage) {
        if let Some(connection) = self.connections.get(slot) {
            // A peer that can't keep up loses messages rather than stalling the relay; the WebRTC negotiation
            // then times out on its side and is retried.
            let _ = connection.out.try_send(message);
        }
    }

    fn error(&self, slot: &Slot, code: ErrorCode) {
        self.send(slot, RelayMessage::Error { code });
    }

    /// Handles one message from `slot`.
    pub fn handle(&mut self, slot: &Slot, message: ClientMessage, now: Instant) {
        match message {
            ClientMessage::Host { topic, .. } => self.host(slot, topic, now),
            ClientMessage::Join { topic, .. } => self.join(slot, topic, now),
            ClientMessage::Signal { to, signal } => self.forward(slot, &to, signal, now),
            ClientMessage::Renew => self.renew(slot, now),
            ClientMessage::Leave => self.leave_topic(slot),
        }
    }

    fn host(&mut self, slot: &Slot, topic: Topic, now: Instant) {
        if self
            .connections
            .get(slot)
            .is_some_and(|c| c.topic.is_some())
        {
            return self.error(slot, ErrorCode::AlreadyRegistered);
        }
        let remote_host = self
            .connections
            .get(slot)
            .is_some_and(|c| !c.remote.is_some_and(|addr| addr.ip().is_loopback()));
        if self.config.loopback_hosts_only && remote_host {
            return self.error(slot, ErrorCode::RelayFull);
        }
        if self.topics.contains_key(&topic) {
            return self.error(slot, ErrorCode::TopicTaken);
        }
        if self.topics.len() >= self.config.max_topics {
            return self.error(slot, ErrorCode::RelayFull);
        }
        self.topics.insert(
            topic.clone(),
            TopicEntry {
                host: slot.clone(),
                peers: HashSet::new(),
                last_activity: now,
            },
        );
        if let Some(connection) = self.connections.get_mut(slot) {
            connection.topic = Some(topic);
        }
        let ttl_secs = self.config.topic_ttl.as_secs();
        self.send(
            slot,
            RelayMessage::Hosted {
                slot: slot.clone(),
                ttl_secs,
            },
        );
    }

    fn join(&mut self, slot: &Slot, topic: Topic, now: Instant) {
        if self
            .connections
            .get(slot)
            .is_some_and(|c| c.topic.is_some())
        {
            return self.error(slot, ErrorCode::AlreadyRegistered);
        }
        let max = self.config.max_peers_per_topic;
        let Some(entry) = self.topics.get_mut(&topic) else {
            return self.error(slot, ErrorCode::NoHost);
        };
        if entry.peers.len() >= max {
            return self.error(slot, ErrorCode::TopicFull);
        }
        entry.peers.insert(slot.clone());
        entry.last_activity = now;
        let host = entry.host.clone();
        if let Some(connection) = self.connections.get_mut(slot) {
            connection.topic = Some(topic);
        }
        self.send(
            slot,
            RelayMessage::Joined {
                slot: slot.clone(),
                host: host.clone(),
            },
        );
        self.send(&host, RelayMessage::PeerArrived { slot: slot.clone() });
    }

    fn forward(&mut self, from: &Slot, to: &Slot, signal: Signal, now: Instant) {
        let Some(topic) = self.connections.get(from).and_then(|c| c.topic.clone()) else {
            return self.error(from, ErrorCode::NotInTopic);
        };
        let Some(entry) = self.topics.get_mut(&topic) else {
            return self.error(from, ErrorCode::NotInTopic);
        };
        // Star topology: host <-> participant only; never participant <-> participant or across topics.
        let allowed = (entry.host == *from && entry.peers.contains(to))
            || (entry.peers.contains(from) && entry.host == *to);
        if !allowed {
            return self.error(from, ErrorCode::UnknownPeer);
        }
        entry.last_activity = now;
        self.send(
            to,
            RelayMessage::Signal {
                from: from.clone(),
                signal,
            },
        );
    }

    fn renew(&mut self, slot: &Slot, now: Instant) {
        let topic = self.connections.get(slot).and_then(|c| c.topic.clone());
        match topic.and_then(|t| self.topics.get_mut(&t)) {
            Some(entry) => entry.last_activity = now,
            None => self.error(slot, ErrorCode::NotInTopic),
        }
    }

    /// The connection leaves its topic (a host's leaving ends the topic).
    fn leave_topic(&mut self, slot: &Slot) {
        let Some(topic) = self.connections.get_mut(slot).and_then(|c| c.topic.take()) else {
            return;
        };
        let Some(entry) = self.topics.get_mut(&topic) else {
            return;
        };
        if entry.host == *slot {
            if let Some(entry) = self.topics.remove(&topic) {
                for peer in &entry.peers {
                    if let Some(connection) = self.connections.get_mut(peer) {
                        connection.topic = None;
                    }
                    self.send(peer, RelayMessage::PeerLeft { slot: slot.clone() });
                }
            }
        } else {
            entry.peers.remove(slot);
            let host = entry.host.clone();
            self.send(&host, RelayMessage::PeerLeft { slot: slot.clone() });
        }
    }

    /// A connection closed.
    pub fn disconnect(&mut self, slot: &Slot) {
        self.leave_topic(slot);
        self.connections.remove(slot);
    }

    /// Removes topics idle for longer than the TTL and tells their members. Returns how many expired.
    pub fn sweep(&mut self, now: Instant) -> usize {
        let ttl = self.config.topic_ttl;
        let expired: Vec<Topic> = self
            .topics
            .iter()
            .filter(|(_, entry)| now.saturating_duration_since(entry.last_activity) >= ttl)
            .map(|(topic, _)| topic.clone())
            .collect();
        for topic in &expired {
            if let Some(entry) = self.topics.remove(topic) {
                for member in entry.peers.iter().chain(std::iter::once(&entry.host)) {
                    if let Some(connection) = self.connections.get_mut(member) {
                        connection.topic = None;
                    }
                    self.send(member, RelayMessage::Expired);
                }
            }
        }
        expired.len()
    }
}

#[cfg(test)]
#[path = "hub_tests.rs"]
mod tests;
