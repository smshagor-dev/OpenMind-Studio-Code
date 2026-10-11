//! The first checks every received data channel message passes, before anything acts on it:
//!
//! 1. before admission only a handshake on `openmind-control` is accepted;
//! 2. after admission the message must decode as a protocol frame (`openmind_collab::protocol::Frame::decode`:
//!    size, version, unknown fields, field limits, body on its declared channel);
//! 3. it must have arrived on the data channel it declares (a control body on `openmind-sync` is refused);
//! 4. it must carry the session this connection was admitted with, and pass the replay window.
//!
//! Only then does the caller hand it, with the authenticated actor, to the Owner's authority — which still runs the
//! central `authorize` and refuses a session that is no longer current. Nothing a peer sends names its own role.

use openmind_collab::protocol::{Channel, Frame, Handshake};
use openmind_collab::replay::{ReplayError, ReplayGuard};
use openmind_collab::{Actor, PeerId, SessionId};

#[derive(Debug, Clone, PartialEq)]
pub enum Inbound {
    Handshake(Handshake),
    Frame(Frame),
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum GateError {
    /// Something other than a handshake (or on another channel) before admission.
    NotAdmitted,
    Malformed(String),
    /// The frame declares another channel than the one it arrived on.
    WrongChannel,
    Replay(ReplayError),
}

impl GateError {
    pub fn reason(&self) -> String {
        match self {
            GateError::NotAdmitted => "the connection isn't admitted to the room yet".into(),
            GateError::Malformed(why) => format!("malformed message: {why}"),
            GateError::WrongChannel => "the message arrived on the wrong data channel".into(),
            GateError::Replay(ReplayError::WrongSession) => {
                "the message belongs to another session".into()
            }
            GateError::Replay(_) => {
                "the message was already received (replayed or duplicated)".into()
            }
        }
    }
}

/// The checks of one connection (one per side).
#[derive(Debug, Default)]
pub struct InboundGate {
    admitted: Option<(PeerId, ReplayGuard)>,
}

impl InboundGate {
    /// From now on frames of `session` (and only those) are accepted, as `peer`.
    pub fn admit(&mut self, peer: PeerId, session: SessionId) {
        self.admitted = Some((peer, ReplayGuard::new(session)));
    }

    pub fn is_admitted(&self) -> bool {
        self.admitted.is_some()
    }

    /// The authenticated actor of this connection (the Owner side).
    pub fn actor(&self) -> Option<Actor> {
        self.admitted.as_ref().map(|(peer, guard)| Actor::Remote {
            peer: peer.clone(),
            session: guard.session().clone(),
        })
    }

    pub fn accept(&mut self, arrived_on: Channel, bytes: &[u8]) -> Result<Inbound, GateError> {
        let Some((_, guard)) = self.admitted.as_mut() else {
            if arrived_on != Channel::Control {
                return Err(GateError::NotAdmitted);
            }
            return Handshake::decode(bytes)
                .map(Inbound::Handshake)
                .map_err(|e| GateError::Malformed(e.to_string()));
        };
        let frame = Frame::decode(bytes).map_err(|e| GateError::Malformed(e.to_string()))?;
        if frame.channel != arrived_on {
            return Err(GateError::WrongChannel);
        }
        guard
            .accept(&frame.session, frame.seq, &frame.id)
            .map_err(GateError::Replay)?;
        Ok(Inbound::Frame(frame))
    }
}

/// The message id of a frame that failed the gate, when it can still be read (to name it in a rejection).
pub fn frame_id(bytes: &[u8]) -> Option<openmind_collab::MessageId> {
    #[derive(serde::Deserialize)]
    struct IdOnly {
        id: openmind_collab::MessageId,
    }
    serde_json::from_slice::<IdOnly>(bytes).ok().map(|f| f.id)
}

#[cfg(test)]
mod tests {
    use super::*;
    use openmind_collab::protocol::Body;

    fn session() -> SessionId {
        SessionId::random().expect("session")
    }

    fn admitted() -> (InboundGate, SessionId) {
        let mut gate = InboundGate::default();
        let session = session();
        gate.admit(PeerId::of_key(&[1; 32]), session.clone());
        (gate, session)
    }

    #[test]
    fn before_admission_only_control_handshakes_pass() {
        let mut gate = InboundGate::default();
        let ping = Frame::new(session(), 1, Body::Ping { nonce: 1 })
            .expect("frame")
            .encode()
            .expect("bytes");
        assert!(matches!(
            gate.accept(Channel::Control, &ping),
            Err(GateError::Malformed(_))
        ));
        assert_eq!(
            gate.accept(Channel::Sync, b"{}"),
            Err(GateError::NotAdmitted)
        );
        let pending = Handshake::Pending.encode().expect("bytes");
        assert_eq!(
            gate.accept(Channel::Control, &pending),
            Ok(Inbound::Handshake(Handshake::Pending))
        );
    }

    #[test]
    fn frames_must_match_channel_session_and_be_new() {
        let (mut gate, session) = admitted();
        let ping = Frame::new(session.clone(), 1, Body::Ping { nonce: 7 }).expect("frame");
        let bytes = ping.encode().expect("bytes");
        assert_eq!(
            gate.accept(Channel::Sync, &bytes),
            Err(GateError::WrongChannel)
        );
        assert_eq!(
            gate.accept(Channel::Control, &bytes),
            Ok(Inbound::Frame(ping))
        );
        assert_eq!(
            gate.accept(Channel::Control, &bytes),
            Err(GateError::Replay(ReplayError::DuplicateMessage))
        );
        let stale =
            Frame::new(SessionId::random().expect("s"), 2, Body::Ping { nonce: 8 }).expect("frame");
        let stale = stale.encode().expect("bytes");
        assert_eq!(
            gate.accept(Channel::Control, &stale),
            Err(GateError::Replay(ReplayError::WrongSession))
        );
        assert!(matches!(
            gate.accept(Channel::Control, b"\xff\xfe garbage"),
            Err(GateError::Malformed(_))
        ));
        assert!(frame_id(&stale).is_some());
        assert!(gate.actor().is_some());
    }
}
