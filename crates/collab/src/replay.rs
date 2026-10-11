//! Replay protection for one authenticated session. Every frame carries the session it belongs to, a sequence
//! number that starts at 1 and rises, and a message id. The guard accepts each sequence number and each message id
//! once, tolerates reordering inside a 128-frame window, refuses anything older than the window, and refuses frames
//! of any other (an earlier or a forged) session. Message ids are also remembered across a bounded history so an
//! outbox resend of an already accepted update under a new sequence number is recognised as a duplicate.

use std::collections::{HashSet, VecDeque};

use crate::ids::{MessageId, SessionId};

const WINDOW: u64 = 128;
const REMEMBERED_IDS: usize = 8192;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ReplayError {
    /// The frame belongs to another session (an old connection, or a forged one).
    WrongSession,
    /// Sequence numbers start at 1.
    ZeroSequence,
    /// Older than the window.
    TooOld,
    /// This sequence number was already accepted.
    DuplicateSequence,
    /// This message id was already accepted (a resend).
    DuplicateMessage,
}

#[derive(Debug)]
pub struct ReplayGuard {
    session: SessionId,
    highest: u64,
    /// Bit `i` set = sequence `highest - i` was accepted.
    seen: u128,
    ids: HashSet<MessageId>,
    order: VecDeque<MessageId>,
}

impl ReplayGuard {
    pub fn new(session: SessionId) -> Self {
        Self {
            session,
            highest: 0,
            seen: 0,
            ids: HashSet::new(),
            order: VecDeque::new(),
        }
    }

    pub fn session(&self) -> &SessionId {
        &self.session
    }

    /// Checks a frame's session, sequence number and message id, and records them when accepted.
    pub fn accept(
        &mut self,
        session: &SessionId,
        seq: u64,
        id: &MessageId,
    ) -> Result<(), ReplayError> {
        if *session != self.session {
            return Err(ReplayError::WrongSession);
        }
        if seq == 0 {
            return Err(ReplayError::ZeroSequence);
        }
        if self.ids.contains(id) {
            return Err(ReplayError::DuplicateMessage);
        }
        if seq > self.highest {
            let shift = seq - self.highest;
            self.seen = if shift >= WINDOW {
                0
            } else {
                self.seen << shift
            };
            self.seen |= 1;
            self.highest = seq;
        } else {
            let age = self.highest - seq;
            if age >= WINDOW {
                return Err(ReplayError::TooOld);
            }
            let bit = 1u128 << age;
            if self.seen & bit != 0 {
                return Err(ReplayError::DuplicateSequence);
            }
            self.seen |= bit;
        }
        self.remember(id.clone());
        Ok(())
    }

    fn remember(&mut self, id: MessageId) {
        if self.order.len() >= REMEMBERED_IDS {
            if let Some(old) = self.order.pop_front() {
                self.ids.remove(&old);
            }
        }
        self.ids.insert(id.clone());
        self.order.push_back(id);
    }
}

/// The sending side: the next sequence number of a session.
#[derive(Debug, Default)]
pub struct SequenceCounter(u64);

impl SequenceCounter {
    /// The next sequence number to send.
    pub fn advance(&mut self) -> u64 {
        self.0 += 1;
        self.0
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn id() -> MessageId {
        MessageId::random().expect("id")
    }

    #[test]
    fn in_order_frames_pass_and_duplicates_fail() {
        let session = SessionId::random().expect("session");
        let mut guard = ReplayGuard::new(session.clone());
        let first = id();
        assert_eq!(guard.accept(&session, 1, &first), Ok(()));
        assert_eq!(
            guard.accept(&session, 1, &id()),
            Err(ReplayError::DuplicateSequence)
        );
        assert_eq!(
            guard.accept(&session, 2, &first),
            Err(ReplayError::DuplicateMessage)
        );
        assert_eq!(guard.accept(&session, 2, &id()), Ok(()));
        assert_eq!(
            guard.accept(&session, 0, &id()),
            Err(ReplayError::ZeroSequence)
        );
    }

    #[test]
    fn reordering_inside_the_window_is_tolerated_and_old_frames_refused() {
        let session = SessionId::random().expect("session");
        let mut guard = ReplayGuard::new(session.clone());
        assert_eq!(guard.accept(&session, 5, &id()), Ok(()));
        assert_eq!(guard.accept(&session, 3, &id()), Ok(()));
        assert_eq!(
            guard.accept(&session, 3, &id()),
            Err(ReplayError::DuplicateSequence)
        );
        assert_eq!(guard.accept(&session, 300, &id()), Ok(()));
        assert_eq!(guard.accept(&session, 172, &id()), Err(ReplayError::TooOld));
        assert_eq!(guard.accept(&session, 173, &id()), Ok(()));
    }

    #[test]
    fn frames_of_another_session_are_refused() {
        let session = SessionId::random().expect("session");
        let old = SessionId::random().expect("session");
        let mut guard = ReplayGuard::new(session);
        assert_eq!(guard.accept(&old, 1, &id()), Err(ReplayError::WrongSession));
    }

    #[test]
    fn remembered_ids_are_bounded() {
        let session = SessionId::random().expect("session");
        let mut guard = ReplayGuard::new(session.clone());
        for seq in 1..=(REMEMBERED_IDS as u64 + 10) {
            guard.accept(&session, seq, &id()).expect("accept");
        }
        assert_eq!(guard.ids.len(), REMEMBERED_IDS);
        assert_eq!(guard.order.len(), REMEMBERED_IDS);
    }
}
