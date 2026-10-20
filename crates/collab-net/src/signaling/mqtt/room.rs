//! What the relay's hub does, done by each client over a plain publish/subscribe broker: the Owner listens on the
//! room's host inbox, a participant on its own inbox, and the two exchange `join` / `welcome` / `signal` / `left`
//! envelopes. Pure (no I/O, time passed in), so the whole exchange is tested without a broker.
//!
//! Privacy on a public broker: the MQTT topic is a one-way hash of the signaling topic (itself derived from the Room
//! Code) under its own label, and every payload is sealed with ChaCha20-Poly1305 under a key derived the same way with
//! another label, the inbox's topic as associated data. The broker sees random-looking topics and ciphertext only —
//! never the code, the SDP or the candidates' addresses. Whoever knows the code can read and send envelopes, exactly
//! like the relay's model: the peers authenticate each other afterwards (Owner proof bound to DTLS).

use std::collections::HashSet;
use std::time::{Duration, Instant};

use chacha20poly1305::aead::{Aead, KeyInit, Payload};
use chacha20poly1305::{ChaCha20Poly1305, Key, Nonce};
use openmind_collab_signal::proto::MAX_MESSAGE_BYTES;
use openmind_collab_signal::{ClientMessage, ErrorCode, RelayMessage, Signal, Slot, Topic};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

/// A participant re-announces itself this often until the Owner answers (the Owner may be reconnecting).
const JOIN_RESEND: Duration = Duration::from_secs(2);
/// No answer for this long: no Owner hosts this room on this broker.
pub const NO_HOST_AFTER: Duration = Duration::from_secs(12);
const MAX_PEERS: usize = 64;
/// What the relay would say about its topics' lifetime; a broker keeps nothing, so nothing expires.
const TTL_SECS: u64 = 600;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "t", rename_all = "camelCase", rename_all_fields = "camelCase")]
enum Envelope {
    Join { from: Slot },
    Welcome { from: Slot },
    Signal { from: Slot, signal: Signal },
    Left { from: Slot },
}

/// One room's topics and key on the broker.
#[derive(Clone)]
struct Channel {
    base: String,
    cipher: ChaCha20Poly1305,
}

fn digest(label: &str, topic: &Topic) -> [u8; 32] {
    let mut hash = Sha256::new();
    hash.update(label.as_bytes());
    hash.update(topic.as_str().as_bytes());
    hash.finalize().into()
}

impl Channel {
    fn for_topic(topic: &Topic) -> Self {
        let name = digest("openmind-collab-mqtt-topic-v1\n", topic);
        let key = digest("openmind-collab-mqtt-key-v1\n", topic);
        Self {
            base: format!("openmind-collab/v1/{}", hex::encode(&name[..16])),
            cipher: ChaCha20Poly1305::new(Key::from_slice(&key)),
        }
    }

    fn host_inbox(&self) -> String {
        format!("{}/h", self.base)
    }

    fn peer_inbox(&self, slot: &Slot) -> String {
        format!("{}/p/{slot}", self.base)
    }

    fn seal(&self, inbox: &str, envelope: &Envelope) -> Option<Vec<u8>> {
        let mut nonce = [0u8; 12];
        getrandom::fill(&mut nonce).ok()?;
        let plain = serde_json::to_vec(envelope).ok()?;
        let sealed = self
            .cipher
            .encrypt(
                Nonce::from_slice(&nonce),
                Payload {
                    msg: &plain,
                    aad: inbox.as_bytes(),
                },
            )
            .ok()?;
        Some([nonce.as_slice(), &sealed].concat())
    }

    fn open(&self, inbox: &str, payload: &[u8]) -> Option<Envelope> {
        if payload.len() < 12 + 16 || payload.len() > MAX_MESSAGE_BYTES + 64 {
            return None;
        }
        let (nonce, sealed) = payload.split_at(12);
        let plain = self
            .cipher
            .decrypt(
                Nonce::from_slice(nonce),
                Payload {
                    msg: sealed,
                    aad: inbox.as_bytes(),
                },
            )
            .ok()?;
        serde_json::from_slice(&plain).ok()
    }
}

/// What the I/O side must do.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Action {
    Subscribe(String),
    Publish(String, Vec<u8>),
    Event(RelayMessage),
}

enum Role {
    Idle,
    Host {
        channel: Channel,
        peers: HashSet<Slot>,
    },
    Join {
        channel: Channel,
        host: Option<Slot>,
        subscribed: bool,
        started: Instant,
        announced: Option<Instant>,
        gave_up: bool,
    },
}

/// One signaling link's side of the room.
pub struct Room {
    slot: Slot,
    role: Role,
}

fn event(message: RelayMessage) -> Vec<Action> {
    vec![Action::Event(message)]
}

fn error(code: ErrorCode) -> Vec<Action> {
    event(RelayMessage::Error { code })
}

fn publish(channel: &Channel, inbox: String, envelope: &Envelope) -> Vec<Action> {
    channel
        .seal(&inbox, envelope)
        .map(|payload| Action::Publish(inbox, payload))
        .into_iter()
        .collect()
}

impl Room {
    pub fn new(slot: Slot) -> Self {
        Self {
            slot,
            role: Role::Idle,
        }
    }

    /// A message the session layer sent to "the relay".
    pub fn client(&mut self, message: ClientMessage, now: Instant) -> Vec<Action> {
        match message {
            ClientMessage::Host { .. } | ClientMessage::Join { .. }
                if !matches!(self.role, Role::Idle) =>
            {
                error(ErrorCode::AlreadyRegistered)
            }
            ClientMessage::Host { topic, .. } => {
                let channel = Channel::for_topic(&topic);
                let inbox = channel.host_inbox();
                self.role = Role::Host {
                    channel,
                    peers: HashSet::new(),
                };
                vec![Action::Subscribe(inbox)]
            }
            ClientMessage::Join { topic, .. } => {
                let channel = Channel::for_topic(&topic);
                let inbox = channel.peer_inbox(&self.slot);
                self.role = Role::Join {
                    channel,
                    host: None,
                    subscribed: false,
                    started: now,
                    announced: None,
                    gave_up: false,
                };
                vec![Action::Subscribe(inbox)]
            }
            ClientMessage::Signal { to, signal } => self.signal(to, signal),
            ClientMessage::Renew => Vec::new(),
            ClientMessage::Leave => self.leave(),
        }
    }

    fn signal(&self, to: Slot, signal: Signal) -> Vec<Action> {
        let from = self.slot.clone();
        match &self.role {
            Role::Host { channel, peers } if peers.contains(&to) => publish(
                channel,
                channel.peer_inbox(&to),
                &Envelope::Signal { from, signal },
            ),
            Role::Join {
                channel,
                host: Some(host),
                ..
            } if *host == to => publish(
                channel,
                channel.host_inbox(),
                &Envelope::Signal { from, signal },
            ),
            Role::Idle => error(ErrorCode::NotInTopic),
            _ => error(ErrorCode::UnknownPeer),
        }
    }

    /// What to say on the way out (also sent when the link closes).
    pub fn leave(&mut self) -> Vec<Action> {
        let from = self.slot.clone();
        let actions = match &self.role {
            Role::Host { channel, peers } => peers
                .iter()
                .flat_map(|peer| {
                    publish(
                        channel,
                        channel.peer_inbox(peer),
                        &Envelope::Left { from: from.clone() },
                    )
                })
                .collect(),
            Role::Join { channel, .. } => {
                publish(channel, channel.host_inbox(), &Envelope::Left { from })
            }
            Role::Idle => Vec::new(),
        };
        self.role = Role::Idle;
        actions
    }

    /// The broker confirmed the subscription.
    pub fn subscribed(&mut self, now: Instant) -> Vec<Action> {
        match &mut self.role {
            Role::Host { .. } => event(RelayMessage::Hosted {
                slot: self.slot.clone(),
                ttl_secs: TTL_SECS,
            }),
            Role::Join { subscribed, .. } => {
                *subscribed = true;
                self.tick(now)
            }
            Role::Idle => Vec::new(),
        }
    }

    /// A participant waiting for its Owner asks again, then gives up.
    pub fn tick(&mut self, now: Instant) -> Vec<Action> {
        let Role::Join {
            channel,
            host: None,
            subscribed: true,
            started,
            announced,
            gave_up,
        } = &mut self.role
        else {
            return Vec::new();
        };
        if now.saturating_duration_since(*started) >= NO_HOST_AFTER {
            if *gave_up {
                return Vec::new();
            }
            *gave_up = true;
            return error(ErrorCode::NoHost);
        }
        if announced.is_some_and(|at| now.saturating_duration_since(at) < JOIN_RESEND) {
            return Vec::new();
        }
        *announced = Some(now);
        let from = self.slot.clone();
        publish(channel, channel.host_inbox(), &Envelope::Join { from })
    }

    /// Something arrived on a subscribed topic.
    pub fn inbound(&mut self, inbox: &str, payload: &[u8]) -> Vec<Action> {
        let me = self.slot.clone();
        match &mut self.role {
            Role::Host { channel, peers } if inbox == channel.host_inbox() => {
                match channel.open(inbox, payload) {
                    Some(Envelope::Join { from }) => {
                        if !peers.contains(&from) && peers.len() >= MAX_PEERS {
                            return Vec::new();
                        }
                        let fresh = peers.insert(from.clone());
                        let mut actions = publish(
                            channel,
                            channel.peer_inbox(&from),
                            &Envelope::Welcome { from: me },
                        );
                        if fresh {
                            actions.push(Action::Event(RelayMessage::PeerArrived { slot: from }));
                        }
                        actions
                    }
                    Some(Envelope::Signal { from, signal }) if peers.contains(&from) => {
                        event(RelayMessage::Signal { from, signal })
                    }
                    Some(Envelope::Left { from }) if peers.remove(&from) => {
                        event(RelayMessage::PeerLeft { slot: from })
                    }
                    _ => Vec::new(),
                }
            }
            Role::Join { channel, host, .. } if inbox == channel.peer_inbox(&me) => {
                match (channel.open(inbox, payload), host.clone()) {
                    (Some(Envelope::Welcome { from }), None) => {
                        *host = Some(from.clone());
                        event(RelayMessage::Joined {
                            slot: me,
                            host: from,
                        })
                    }
                    (Some(Envelope::Signal { from, signal }), Some(h)) if from == h => {
                        event(RelayMessage::Signal { from, signal })
                    }
                    (Some(Envelope::Left { from }), Some(h)) if from == h => {
                        event(RelayMessage::PeerLeft { slot: from })
                    }
                    _ => Vec::new(),
                }
            }
            _ => Vec::new(),
        }
    }
}

#[cfg(test)]
#[path = "room_tests.rs"]
mod tests;
