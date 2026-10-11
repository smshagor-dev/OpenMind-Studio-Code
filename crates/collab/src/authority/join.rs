//! Admitting peers. A join needs the Owner's fresh challenge, a valid signature by the peer's key and a valid
//! proof of the *current* Room Code (a rotated code's proofs fail). A reconnect needs only the signature, and only
//! for an Active member. Each admission gets a new session and supersedes the peer's previous one.

use std::collections::BTreeMap;

use super::{meta, Actor, Authority, Outcome};
use crate::audit::EventKind;
use crate::error::CollabError;
use crate::ids::{Challenge, PeerId, SessionId};
use crate::permission::Overrides;
use crate::protocol::{Admission, JoinRequest, ReconnectRequest, Refusal};
use crate::room::{validate_display_name, Member, MemberStatus, MAX_MEMBERS};

/// The answer to a join or reconnect.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum JoinOutcome {
    Admitted(Admission),
    /// Waiting for a moderator (the room requires approval).
    Pending,
    Refused(Refusal),
}

impl Authority {
    /// A fresh challenge for a new connection.
    pub fn new_challenge() -> Result<Challenge, CollabError> {
        Challenge::random()
    }

    /// Handles a join request answering `issued`.
    pub fn join(
        &mut self,
        request: &JoinRequest,
        issued: &Challenge,
        now_ms: i64,
    ) -> Result<(JoinOutcome, Outcome), CollabError> {
        let peer = request.public_key.peer_id();
        if let Some(refusal) = self.check_join(request, issued, &peer) {
            return Ok((JoinOutcome::Refused(refusal), Outcome::default()));
        }
        let Ok(name) = validate_display_name(&request.display_name) else {
            return Ok((
                JoinOutcome::Refused(Refusal::InvalidName),
                Outcome::default(),
            ));
        };
        let mut out = Outcome::default();
        let status = self.room.member(&peer).map(|m| m.status);
        match status {
            Some(MemberStatus::Active) => {
                let admission =
                    self.admit(&peer, EventKind::MemberReconnected, &mut out, now_ms)?;
                return Ok((JoinOutcome::Admitted(admission), out));
            }
            Some(MemberStatus::Pending) => return Ok((JoinOutcome::Pending, out)),
            _ => {}
        }
        if self.room.locked {
            return Ok((JoinOutcome::Refused(Refusal::Locked), out));
        }
        if status.is_none() && self.room.members.len() >= MAX_MEMBERS {
            return Ok((JoinOutcome::Refused(Refusal::Full), out));
        }
        self.upsert_candidate(request, &peer, name, now_ms);
        out.changed_members.push(peer.clone());
        if self.room.approval_required {
            let actor = Actor::Host(self.host.peer_id());
            let data = meta([("target", peer.to_string())]);
            self.emit(&mut out, &actor, EventKind::JoinRequested, data, now_ms)?;
            return Ok((JoinOutcome::Pending, out));
        }
        if let Some(member) = self.room.members.get_mut(&peer) {
            member.status = MemberStatus::Active;
        }
        let admission = self.admit(&peer, EventKind::MemberJoined, &mut out, now_ms)?;
        Ok((JoinOutcome::Admitted(admission), out))
    }

    fn check_join(
        &self,
        request: &JoinRequest,
        issued: &Challenge,
        peer: &PeerId,
    ) -> Option<Refusal> {
        if request.room != self.room.room_uid {
            return Some(Refusal::WrongRoom);
        }
        if request.challenge != *issued {
            return Some(Refusal::WrongChallenge);
        }
        if request.verify_signature().is_err() {
            return Some(Refusal::BadSignature);
        }
        if self.room.closed {
            return Some(Refusal::Closed);
        }
        if *peer == self.host.peer_id() {
            return Some(Refusal::NotAMember);
        }
        if self.room.member(peer).map(|m| m.status) == Some(MemberStatus::Banned) {
            return Some(Refusal::Banned);
        }
        let room = &self.room.room_uid;
        if !self
            .invite
            .verify_join_proof(room, peer, request.challenge.as_str(), &request.proof)
        {
            return Some(Refusal::InvalidInvite);
        }
        None
    }

    /// Adds the peer as a Pending member, or brings a Kicked/Removed one back as Pending (a Kicked member keeps
    /// its role and overrides; a Removed one was reset when removed).
    fn upsert_candidate(
        &mut self,
        request: &JoinRequest,
        peer: &PeerId,
        name: String,
        now_ms: i64,
    ) {
        let default_role = self.room.default_role;
        let member = self
            .room
            .members
            .entry(peer.clone())
            .or_insert_with(|| Member {
                peer: peer.clone(),
                public_key: request.public_key,
                display_name: name.clone(),
                role: default_role,
                overrides: Overrides::default(),
                status: MemberStatus::Pending,
                force_muted: false,
                first_seen_ms: now_ms,
                last_seen_ms: now_ms,
            });
        member.display_name = name;
        member.status = MemberStatus::Pending;
        member.last_seen_ms = now_ms;
    }

    /// Handles a returning Active member answering `issued`.
    pub fn reconnect(
        &mut self,
        request: &ReconnectRequest,
        issued: &Challenge,
        now_ms: i64,
    ) -> Result<(JoinOutcome, Outcome), CollabError> {
        let peer = request.public_key.peer_id();
        let refusal = if request.room != self.room.room_uid {
            Some(Refusal::WrongRoom)
        } else if request.challenge != *issued {
            Some(Refusal::WrongChallenge)
        } else if request.verify_signature().is_err() {
            Some(Refusal::BadSignature)
        } else if self.room.closed {
            Some(Refusal::Closed)
        } else {
            match self.room.member(&peer).map(|m| m.status) {
                Some(MemberStatus::Active) if peer != self.host.peer_id() => None,
                Some(MemberStatus::Banned) => Some(Refusal::Banned),
                _ => Some(Refusal::NotAMember),
            }
        };
        if let Some(refusal) = refusal {
            return Ok((JoinOutcome::Refused(refusal), Outcome::default()));
        }
        let mut out = Outcome::default();
        let admission = self.admit(&peer, EventKind::MemberReconnected, &mut out, now_ms)?;
        Ok((JoinOutcome::Admitted(admission), out))
    }

    /// Gives `peer` (an Active member) a new session, superseding any older one.
    fn admit(
        &mut self,
        peer: &PeerId,
        kind: EventKind,
        out: &mut Outcome,
        now_ms: i64,
    ) -> Result<Admission, CollabError> {
        self.end_session_of(peer, out);
        let session = SessionId::random()?;
        self.sessions.insert(peer.clone(), session.clone());
        if let Some(member) = self.room.members.get_mut(peer) {
            member.last_seen_ms = now_ms;
        }
        out.changed_members.push(peer.clone());
        let actor = Actor::Remote {
            peer: peer.clone(),
            session: session.clone(),
        };
        self.emit(out, &actor, kind, BTreeMap::new(), now_ms)?;
        self.emit(
            out,
            &actor,
            EventKind::SessionStarted,
            BTreeMap::new(),
            now_ms,
        )?;
        let member = self
            .room
            .member(peer)
            .ok_or_else(|| crate::error::invalid("member", "missing after admission"))?;
        out.started_sessions
            .push((peer.clone(), session.clone(), member.role));
        Ok(Admission {
            session,
            peer: peer.clone(),
            role: member.role,
            permissions: member.permissions(),
            room_name: self.room.name.clone(),
            owner: self.room.owner.clone(),
        })
    }

    /// Admits a member a moderator just approved, if they are still connected and waiting.
    pub fn admit_approved(
        &mut self,
        peer: &PeerId,
        now_ms: i64,
    ) -> Result<(Admission, Outcome), CollabError> {
        if self.room.active_member(peer).is_none() {
            return Err(crate::error::invalid("member", "not approved"));
        }
        let mut out = Outcome::default();
        let admission = self.admit(peer, EventKind::MemberJoined, &mut out, now_ms)?;
        Ok((admission, out))
    }
}
