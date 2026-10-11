//! One participant's connection on the Owner side: its peer connection, the signals exchanged for it, its gate and
//! its handshake progress.

use openmind_collab::binding::bind_challenge;
use openmind_collab::ids::Challenge;
use std::collections::HashMap;
use std::time::Instant;

use openmind_collab::protocol::{Body, Handshake};
use openmind_collab::{FileId, PeerId, SessionId, TransferId};
use tokio::task::AbortHandle;

use super::serve::{FrameSender, RateLimit};
use openmind_collab_signal::{NegotiationId, Signal, SignalKind};

use crate::gate::InboundGate;
use crate::peer::PeerHandle;
use crate::transport::{DataChannelTransport, PeerTransport};

/// How many invalid frames an admitted connection may send before it is closed.
pub(super) const MAX_STRIKES: u32 = 8;

pub(super) struct Link {
    pub peer: PeerHandle,
    /// The participant's negotiation and the last signal number accepted from it.
    pub remote_negotiation: NegotiationId,
    pub remote_seq: u64,
    pub local_negotiation: NegotiationId,
    pub local_seq: u64,
    pub gate: InboundGate,
    pub challenge: Challenge,
    pub fingerprints: Option<(String, String)>,
    pub control_open: bool,
    pub hello_sent: bool,
    pub waiting: Option<PeerId>,
    pub admitted: Option<(PeerId, SessionId)>,
    /// Sends frames of the admitted session (also from transfer tasks).
    pub sender: Option<FrameSender>,
    pub strikes: u32,
    pub secured: bool,
    /// Active file transfers of this participant.
    pub transfers: HashMap<TransferId, (FileId, AbortHandle)>,
    pub rate: RateLimit,
    /// Presence states (latest-value; over the rate they are dropped).
    pub presence_rate: RateLimit,
    /// Voice states and negotiation (their own budget).
    pub voice_rate: RateLimit,
    pub last_manifest: Option<Instant>,
    /// "Unavailable" answers so far (a participant guessing ids is disconnected past a limit).
    pub unavailable: u32,
    /// `openmind-sync` messages this participant is sending in pieces.
    pub chunks: openmind_collab::sync_chunk::Reassembler,
}

impl Link {
    pub fn new(
        peer: PeerHandle,
        remote_negotiation: NegotiationId,
        remote_seq: u64,
    ) -> Option<Self> {
        Some(Self {
            peer,
            remote_negotiation,
            remote_seq,
            local_negotiation: NegotiationId::random().ok()?,
            local_seq: 0,
            gate: InboundGate::default(),
            challenge: Challenge::random().ok()?,
            fingerprints: None,
            control_open: false,
            hello_sent: false,
            waiting: None,
            admitted: None,
            sender: None,
            strikes: 0,
            secured: false,
            transfers: HashMap::new(),
            rate: RateLimit::default(),
            presence_rate: RateLimit::new(
                super::serve::PRESENCE_BURST,
                super::serve::PRESENCE_PER_SECOND,
            ),
            voice_rate: RateLimit::new(super::serve::VOICE_BURST, super::serve::VOICE_PER_SECOND),
            last_manifest: None,
            unavailable: 0,
            chunks: Default::default(),
        })
    }

    /// Whether a signal from the participant is new for this link (drops duplicates and stale numbers).
    pub fn accept_signal(&mut self, signal: &Signal) -> bool {
        if signal.negotiation != self.remote_negotiation || signal.seq <= self.remote_seq {
            return false;
        }
        self.remote_seq = signal.seq;
        true
    }

    pub fn next_signal(&mut self, kind: SignalKind) -> Signal {
        self.local_seq += 1;
        Signal {
            negotiation: self.local_negotiation.clone(),
            seq: self.local_seq,
            kind,
        }
    }

    /// The challenge bound to this connection, once DTLS is up.
    pub fn bound(&self) -> Option<Challenge> {
        self.fingerprints
            .as_ref()
            .map(|(a, b)| bind_challenge(&self.challenge, a, b))
    }

    pub fn ready_for_hello(&self) -> bool {
        !self.hello_sent && self.control_open && self.fingerprints.is_some()
    }

    pub fn send_handshake(&self, message: &Handshake) {
        match message.encode() {
            Ok(bytes) => {
                let _ = self
                    .peer
                    .send(openmind_collab::protocol::Channel::Control, bytes);
            }
            Err(err) => tracing::warn!(%err, "a handshake message couldn't be encoded"),
        }
    }

    /// The connection is now admitted as `peer` with `session`.
    pub fn admit(&mut self, peer: PeerId, session: SessionId) {
        self.gate.admit(peer.clone(), session.clone());
        self.sender = Some(FrameSender::new(self.peer.clone(), session.clone()));
        self.admitted = Some((peer, session));
        self.waiting = None;
    }

    /// Sends a frame on the session this link was admitted with (an `openmind-sync` message too large for one data
    /// channel message goes as `SyncChunk`s).
    pub fn send_body(&mut self, body: Body) {
        let Some(sender) = &self.sender else { return };
        let bodies = match openmind_collab::sync_chunk::split(body) {
            Ok(bodies) => bodies,
            Err(err) => return tracing::warn!(%err, "a sync message couldn't be sent"),
        };
        for body in bodies {
            if let Err(err) = sender.send(body) {
                tracing::debug!(%err, "a frame couldn't be sent");
                return;
            }
        }
    }

    /// Stops the transfers of `file` (deleted or hidden meanwhile) and tells the participant.
    pub fn cancel_file(&mut self, file: &FileId) {
        let stopped: Vec<TransferId> = self
            .transfers
            .iter()
            .filter(|(_, (f, _))| f == file)
            .map(|(t, _)| t.clone())
            .collect();
        for transfer in stopped {
            if let Some((_, task)) = self.transfers.remove(&transfer) {
                task.abort();
                self.send_body(Body::FileError {
                    transfer,
                    code: openmind_collab::transfer::FileErrorCode::Unavailable,
                });
            }
        }
    }

    pub fn close(&self) {
        for (_, task) in self.transfers.values() {
            task.abort();
        }
        self.peer.close();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn duplicate_and_stale_signals_are_dropped() {
        let ice = crate::ice::IceSetup {
            bind_ip: Some("127.0.0.1".parse().expect("ip")),
            ..Default::default()
        };
        let gatherer = crate::stun::StunGatherer::new(Vec::new());
        let relay = std::sync::Arc::new(crate::relay::TurnRelay::new(Vec::new()));
        let config = crate::peer::PeerConfig::new(crate::peer::PeerRole::Answerer);
        let (peer, _events) = crate::peer::start(config, &ice, &gatherer, relay)
            .await
            .expect("peer");
        let negotiation = NegotiationId::random().expect("id");
        let mut link = Link::new(peer, negotiation.clone(), 1).expect("link");
        let signal = |n: &NegotiationId, seq| Signal {
            negotiation: n.clone(),
            seq,
            kind: SignalKind::EndOfCandidates,
        };
        assert!(
            !link.accept_signal(&signal(&negotiation, 1)),
            "the offer itself, again"
        );
        assert!(link.accept_signal(&signal(&negotiation, 2)));
        assert!(!link.accept_signal(&signal(&negotiation, 2)), "duplicate");
        assert!(link.accept_signal(&signal(&negotiation, 5)));
        assert!(!link.accept_signal(&signal(&negotiation, 3)), "stale");
        let other = NegotiationId::random().expect("id");
        assert!(
            !link.accept_signal(&signal(&other, 9)),
            "another negotiation"
        );
        assert_eq!(link.next_signal(SignalKind::EndOfCandidates).seq, 1);
        assert_eq!(link.next_signal(SignalKind::EndOfCandidates).seq, 2);
        link.close();
    }
}
