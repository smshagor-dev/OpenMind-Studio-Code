//! Connection states and the transitions allowed between them. Every connection (a peer link, the signaling link)
//! reports through a [`StateTracker`]; an impossible transition is refused and logged rather than shown.

use serde::Serialize;
use tokio::sync::watch;

/// Which way a connection was set up. A route is only how the two sides found each other and exchanged offers; the
/// room, its authority and every message after the handshake are the same on both.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum ConnectionRoute {
    /// Found on the local network and signaled through the Owner's own rendezvous: a direct connection, nothing on
    /// the Internet involved.
    LocalLan,
    /// Through the configured signaling relay (and STUN/TURN as configured).
    InternetRelay,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum ConnectionState {
    Idle,
    /// Exchanging offers/answers/candidates through the relay.
    Signaling,
    /// ICE/DTLS/SCTP are being set up.
    Connecting,
    Connected,
    /// The link dropped and ICE is trying to recover (or a restart is under way).
    Reconnecting,
    /// The other side went away; the state can be negotiated again.
    Disconnected,
    Failed,
    /// Closed on purpose; final.
    Closed,
}

impl ConnectionState {
    pub fn can_move_to(self, next: ConnectionState) -> bool {
        use ConnectionState::*;
        if self == next {
            return false;
        }
        match self {
            Idle => matches!(next, Signaling | Connecting | Failed | Closed),
            Signaling => matches!(next, Connecting | Disconnected | Failed | Closed),
            Connecting => matches!(next, Connected | Disconnected | Failed | Closed),
            Connected => matches!(next, Reconnecting | Disconnected | Failed | Closed),
            Reconnecting => matches!(next, Connected | Disconnected | Failed | Closed),
            Disconnected | Failed => matches!(next, Signaling | Closed),
            Closed => false,
        }
    }

    pub fn is_finished(self) -> bool {
        matches!(
            self,
            ConnectionState::Disconnected | ConnectionState::Failed | ConnectionState::Closed
        )
    }
}

/// The current state of one connection, observable by any number of watchers.
#[derive(Debug)]
pub struct StateTracker {
    tx: watch::Sender<ConnectionState>,
    name: &'static str,
}

impl StateTracker {
    pub fn new(name: &'static str) -> Self {
        let (tx, _) = watch::channel(ConnectionState::Idle);
        Self { tx, name }
    }

    pub fn get(&self) -> ConnectionState {
        *self.tx.borrow()
    }

    pub fn watch(&self) -> watch::Receiver<ConnectionState> {
        self.tx.subscribe()
    }

    /// Moves to `next` when allowed; returns whether the state changed.
    pub fn set(&self, next: ConnectionState) -> bool {
        let current = self.get();
        if !current.can_move_to(next) {
            if current != next {
                tracing::debug!(
                    connection = self.name,
                    ?current,
                    ?next,
                    "ignored an impossible state change"
                );
            }
            return false;
        }
        self.tx.send_replace(next);
        true
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use ConnectionState::*;

    #[test]
    fn the_happy_path_and_recovery_are_allowed() {
        let tracker = StateTracker::new("test");
        for next in [
            Signaling,
            Connecting,
            Connected,
            Reconnecting,
            Connected,
            Closed,
        ] {
            assert!(tracker.set(next), "{next:?}");
        }
        assert!(!tracker.set(Connected), "closed is final");
    }

    #[test]
    fn impossible_jumps_are_refused() {
        assert!(!Idle.can_move_to(Connected));
        assert!(!Signaling.can_move_to(Reconnecting));
        assert!(!Failed.can_move_to(Connected));
        assert!(
            Failed.can_move_to(Signaling),
            "a failed link can be negotiated again"
        );
        assert!(Disconnected.is_finished() && !Reconnecting.is_finished());
    }
}
