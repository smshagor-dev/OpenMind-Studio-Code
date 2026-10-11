//! The voice call of a hosted room, on the Owner's machine (Milestone 24, phase 9). Ephemeral: who is in the call, muted,
//! speaking and with a raised hand lives in memory only. A state counts only on the member's *current* session and only
//! within its permissions (`voice.join`, `voice.speak`, not force-muted); a negotiation message is relayed only between
//! two members of the call, named by the authenticated sender. Voice media never comes here: it flows directly between
//! the members' WebViews. Joining and leaving are recorded in the room's history (not mutes, speaking or hands).

use std::collections::BTreeMap;

use openmind_collab::audit::EventKind;
use openmind_collab::permission::Permission;
use openmind_collab::protocol::Body;
use openmind_collab::room::MemberStatus;
use openmind_collab::sfu::VoiceMode;
use openmind_collab::voice::{VoiceChange, VoiceMember, VoiceRefusal, VoiceSelf, VoiceSignal};
use openmind_collab::{Actor, PeerId};
use openmind_collab_net::owner::FrameOutcome;
use openmind_db::Db;

use super::{CollabRuntime, Effects};

fn peer_of(actor: &Actor) -> &PeerId {
    match actor {
        Actor::Host(peer) | Actor::Remote { peer, .. } => peer,
    }
}

impl CollabRuntime {
    /// Whether `actor` is a current, active member of the room (the hosting user always is while it is a member).
    async fn voice_actor_ok(&self, room: &str, actor: &Actor) -> bool {
        let rooms = self.rooms.lock().await;
        let Some(hosted) = rooms.get(room) else {
            return false;
        };
        let authority = &hosted.authority;
        let current = match actor {
            Actor::Host(peer) => *peer == authority.host_identity().peer_id(),
            Actor::Remote { peer, session } => authority.session_of(peer) == Some(session),
        };
        let active = authority
            .room()
            .member(peer_of(actor))
            .is_some_and(|m| m.status == MemberStatus::Active);
        current && active && !authority.room().closed
    }

    /// A member's (or this computer's own user's) voice state. `Ok(true)` when the call changed.
    pub async fn voice_state(
        &self,
        db: &Db,
        room: &str,
        actor: Actor,
        state: VoiceSelf,
        now: i64,
    ) -> Result<bool, String> {
        if !self.voice_actor_ok(room, &actor).await {
            return Err("this connection is no longer valid; reconnect".into());
        }
        let change = {
            let mut rooms = self.rooms.lock().await;
            let hosted = rooms.get_mut(room).ok_or("The room isn't hosted here.")?;
            let room_state = hosted.authority.room().clone();
            hosted
                .voice
                .update(&room_state, peer_of(&actor), state)
                .map_err(|refusal| refusal.text().to_string())?
        };
        let kind = match change {
            VoiceChange::Joined => Some(EventKind::VoiceJoined),
            VoiceChange::Left => Some(EventKind::VoiceLeft),
            VoiceChange::Updated | VoiceChange::Unchanged => None,
        };
        if let Some(kind) = kind {
            let recorded = self
                .with_room(db, room, now, |a| {
                    let outcome = a
                        .record_activity(&actor, kind, None, BTreeMap::new(), now)
                        .map_err(|err| err.to_string())?;
                    Ok((outcome, ()))
                })
                .await;
            if let Err(err) = recorded {
                tracing::warn!(%err, "a voice join or leave couldn't be recorded");
            }
        }
        Ok(change != VoiceChange::Unchanged)
    }

    /// Who may receive a negotiation message from `actor` for `to`: `Some(sender)` when both are in the call.
    pub async fn voice_route(&self, room: &str, actor: &Actor, to: &PeerId) -> Option<PeerId> {
        if !self.voice_actor_ok(room, actor).await {
            return None;
        }
        let from = peer_of(actor).clone();
        let rooms = self.rooms.lock().await;
        rooms
            .get(room)
            .filter(|h| h.voice.may_signal(&from, to))
            .map(|_| from)
    }

    /// A participant's negotiation frame: relayed to its target, handed to this computer's user, or dropped.
    pub(super) async fn voice_signal_frame(
        &self,
        db: &Db,
        room: &str,
        actor: Actor,
        to: PeerId,
        signal: VoiceSignal,
    ) -> (FrameOutcome, Effects) {
        let Some(from) = self.voice_route(room, &actor, &to).await else {
            return (FrameOutcome::Dropped, Effects::default());
        };
        let host = self.identity(db).await.ok().map(|i| i.peer_id());
        if host.as_ref() == Some(&to) {
            let effects = Effects {
                voice_to_host: Some((from, signal)),
                ..Effects::default()
            };
            return (FrameOutcome::Relay(Vec::new()), effects);
        }
        (
            FrameOutcome::Relay(vec![(to, Body::VoicePeerSignal { from, signal })]),
            Effects::default(),
        )
    }

    /// A member's connection ended: it is out of the call. `true` when it was in it.
    pub async fn voice_left(&self, room: &str, peer: &PeerId) -> bool {
        self.rooms
            .lock()
            .await
            .get_mut(room)
            .is_some_and(|h| h.voice.leave(peer))
    }

    /// Ends the room's call (hosting stopped). `true` when anyone was in it.
    pub async fn voice_reset(&self, room: &str) -> bool {
        let mut rooms = self.rooms.lock().await;
        let Some(hosted) = rooms.get_mut(room) else {
            return false;
        };
        let had = !hosted.voice.is_empty();
        hosted.voice.clear();
        had
    }

    /// Applies the room's rules after a membership change (permissions, roles, force mute, removals, closing).
    pub async fn voice_enforce(&self, room: &str) -> bool {
        let mut rooms = self.rooms.lock().await;
        let Some(hosted) = rooms.get_mut(room) else {
            return false;
        };
        if hosted.authority.room().closed {
            let had = !hosted.voice.is_empty();
            hosted.voice.clear();
            return had;
        }
        let room_state = hosted.authority.room().clone();
        hosted.voice.enforce(&room_state).1
    }

    /// Everyone in the call, as the room is told.
    pub async fn voice_roster(&self, room: &str) -> Vec<VoiceMember> {
        let rooms = self.rooms.lock().await;
        rooms
            .get(room)
            .map(|h| h.voice.roster(h.authority.room()))
            .unwrap_or_default()
    }

    /// The room's voice mode (peer to peer unless classroom mode was turned on).
    pub async fn voice_mode(&self, room: &str) -> VoiceMode {
        self.rooms
            .lock()
            .await
            .get(room)
            .map(|h| h.voice.mode())
            .unwrap_or_default()
    }

    /// Puts back the mode the Owner chose before (hosting starts); not a change, so not in the history.
    pub async fn voice_restore_mode(&self, room: &str, mode: VoiceMode) -> Result<bool, String> {
        let mut rooms = self.rooms.lock().await;
        let hosted = rooms.get_mut(room).ok_or("The room isn't hosted here.")?;
        hosted
            .voice
            .set_mode(mode)
            .map_err(|_| "The voice mode can't change while people are in the call.".to_string())
    }

    /// Changes how the room's call carries media; refused while anyone is in the call. `Ok(true)` when it changed (then
    /// it is in the room's history, recorded as the Owner's).
    pub async fn voice_set_mode(
        &self,
        db: &Db,
        room: &str,
        mode: VoiceMode,
        now: i64,
    ) -> Result<bool, String> {
        let changed = self.voice_restore_mode(room, mode).await?;
        if changed {
            let host = Actor::Host(self.identity(db).await?.peer_id());
            let label = match mode {
                VoiceMode::P2p => "p2p",
                VoiceMode::Sfu => "sfu",
            };
            let metadata = BTreeMap::from([("mode".to_string(), label.to_string())]);
            let recorded = self
                .with_room(db, room, now, |a| {
                    let outcome = a
                        .record_activity(&host, EventKind::VoiceModeChanged, None, metadata, now)
                        .map_err(|err| err.to_string())?;
                    Ok((outcome, ()))
                })
                .await;
            if let Err(err) = recorded {
                tracing::warn!(%err, "a voice mode change couldn't be recorded");
            }
        }
        Ok(changed)
    }

    /// Whether `actor` may carry media in the room's call now (a current, active member with `voice.join` whom the Owner
    /// already let into the call), the mode, and whether it may publish its microphone (`voice.speak`, not force-muted).
    pub async fn voice_media_check(
        &self,
        room: &str,
        actor: &Actor,
    ) -> Result<(VoiceMode, bool), String> {
        if !self.voice_actor_ok(room, actor).await {
            return Err("this connection is no longer valid; reconnect".into());
        }
        let rooms = self.rooms.lock().await;
        let hosted = rooms.get(room).ok_or("The room isn't hosted here.")?;
        let peer = peer_of(actor);
        let room_state = hosted.authority.room();
        let member = room_state.member(peer).ok_or("not a member of this room")?;
        let permissions = member.permissions();
        if !permissions.contains(Permission::VoiceJoin) {
            return Err(VoiceRefusal::NotAllowed.text().into());
        }
        if !hosted
            .voice
            .roster(room_state)
            .iter()
            .any(|m| &m.peer == peer)
        {
            return Err("join the voice call first".into());
        }
        let can_speak = permissions.contains(Permission::VoiceSpeak) && !member.force_muted;
        Ok((hosted.voice.mode(), can_speak))
    }

    /// The call's members and whether each may publish now (for the media server's permissions).
    pub async fn voice_media_members(&self, room: &str) -> (VoiceMode, Vec<(PeerId, bool)>) {
        let rooms = self.rooms.lock().await;
        let Some(hosted) = rooms.get(room) else {
            return (VoiceMode::P2p, Vec::new());
        };
        let members = hosted
            .voice
            .roster(hosted.authority.room())
            .into_iter()
            .map(|m| (m.peer, m.can_speak))
            .collect();
        (hosted.voice.mode(), members)
    }
}

#[cfg(test)]
#[path = "voice_tests.rs"]
mod tests;

#[cfg(test)]
#[path = "outage_tests.rs"]
mod outage_tests;
