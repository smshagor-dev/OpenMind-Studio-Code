//! The rooms this machine hosts, in memory: each one's [`Authority`] behind one async lock, loaded from the database
//! on first use. A change is executed and saved while the lock is held, so the stored chain has the same order as
//! the authority's; if saving fails the room is dropped from memory and reloaded from the database (the database is
//! the truth) on its next use.

use std::collections::HashMap;

use openmind_collab::authority::JoinOutcome;
use openmind_collab::ids::Challenge;
use openmind_collab::protocol::{Admission, Body, Frame, Handshake};
use openmind_collab::{Actor, Authority, Command, Outcome, PeerId, PeerIdentity, SessionId};
use openmind_collab_net::owner::FrameOutcome;
use openmind_db::collab::{self as repo, rooms, NewRoom};
use openmind_db::Db;
use serde::Serialize;
use tokio::sync::Mutex;

use super::{identity, persist};
use crate::secret;

struct HostedRoom {
    row_id: i64,
    authority: Authority,
    /// The shared folder on this machine (never sent anywhere).
    workspace_path: Option<String>,
    /// The shared tree, once a participant asked for it or the folder changed.
    share: Option<share::ShareState>,
    /// Collaborative documents someone has open (phase 6).
    docs: openmind_collab::docs::DocHost,
    /// Members' latest presence (phase 7; memory only).
    presence: openmind_collab::presence::PresenceBoard,
    /// Who is in the voice call (phase 9; memory only).
    voice: openmind_collab::voice::VoiceBoard,
}

mod docs;
mod manage;
mod presence;
mod share;
mod voice;

pub use docs::OwnerDocEvent;
pub use presence::PresenceNotice;

/// A room just created: its permanent id and the Room Code to share (shown to the host only).
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CreatedRoom {
    pub room_uid: String,
    pub code: String,
}

pub struct NewHostedRoom<'a> {
    pub name: &'a str,
    pub display_name: &'a str,
    pub workspace_path: &'a str,
    pub workspace_name: &'a str,
}

/// What a change means for live connections: sessions to close and a member to admit now.
#[derive(Debug, Default)]
pub struct Effects {
    pub ended: Vec<PeerId>,
    pub approved: Option<PeerId>,
    /// What the Owner's own editor must hear about collaborative documents.
    pub owner_docs: Vec<OwnerDocEvent>,
    /// A room or membership change: members' write access may have changed.
    pub access_changed: bool,
    /// A member's presence the Owner's windows should show.
    pub presence: Option<PresenceNotice>,
    /// The voice call changed (a member joined, left, muted, spoke; a permission or moderation applied).
    pub voice_changed: bool,
    /// A voice negotiation message for this computer's own user, from the member named.
    pub voice_to_host: Option<(PeerId, openmind_collab::voice::VoiceSignal)>,
    /// A member asked how to carry its call's media (answered by the app with a grant or a refusal; phase 11).
    pub voice_media: Option<(Actor, openmind_collab::MessageId)>,
    /// The Room Code was rotated: a hosted room must be found under the new code's topic (members stay connected).
    pub rotated: bool,
    /// Peers waiting for approval that were turned down (denied, removed or banned while pending): told why.
    pub refused: Vec<(PeerId, openmind_collab::protocol::Refusal)>,
    /// The room was closed: it goes off the network.
    pub closed: bool,
}

fn nothing_changed(outcome: &Outcome) -> bool {
    outcome.events.is_empty()
        && outcome.new_invite.is_none()
        && outcome.started_sessions.is_empty()
        && outcome.ended_sessions.is_empty()
        && outcome.changed_members.is_empty()
        && !outcome.room_changed
}

#[derive(Default)]
pub struct CollabRuntime {
    identity: Mutex<Option<PeerIdentity>>,
    rooms: Mutex<HashMap<String, HostedRoom>>,
    /// Serializes re-reading a shared folder (a crawl and its application to the table happen as one step).
    share_lock: Mutex<()>,
    /// Live networks (rooms hosted on the network, rooms joined).
    pub net: super::net::NetRuntime,
}

impl CollabRuntime {
    /// This profile's identity (created on first use).
    pub async fn identity(&self, db: &Db) -> Result<PeerIdentity, String> {
        let mut cached = self.identity.lock().await;
        if let Some(identity) = cached.as_ref() {
            return Ok(identity.clone());
        }
        let identity = identity::load_or_create(db).await?;
        *cached = Some(identity.clone());
        Ok(identity)
    }

    pub async fn create_room(
        &self,
        db: &Db,
        new: &NewHostedRoom<'_>,
        now: i64,
    ) -> Result<CreatedRoom, String> {
        let host = self.identity(db).await?;
        let (authority, outcome) = Authority::create(host.clone(), new.display_name, new.name, now)
            .map_err(|err| err.to_string())?;
        let room = authority.room();
        let code = authority.invite().display();
        let protected = secret::protect(&code).map_err(|err| err.to_string())?;
        let (owner_peer, owner_key) = (host.peer_id(), host.public_key().to_text());
        let mut tx = repo::begin(db).await.map_err(|err| err.to_string())?;
        let row = NewRoom {
            room_uid: room.room_uid.as_str(),
            relation: "created",
            name: &room.name,
            local_role: "owner",
            owner_peer: owner_peer.as_str(),
            owner_public_key: &owner_key,
            workspace_path: Some(new.workspace_path),
            workspace_name: Some(new.workspace_name),
            created_at: now,
        };
        let row_id = rooms::insert(&mut *tx, &row)
            .await
            .map_err(|err| err.to_string())?;
        let generation = i64::from(room.invite_generation);
        rooms::set_invite(&mut *tx, row_id, &room.invite_hash, &protected, generation)
            .await
            .map_err(|err| err.to_string())?;
        persist::save_outcome(&mut tx, row_id, &authority, &outcome, now).await?;
        rooms::touch_joined(&mut *tx, row_id, now)
            .await
            .map_err(|err| err.to_string())?;
        repo::commit(tx).await.map_err(|err| err.to_string())?;
        let created = CreatedRoom {
            room_uid: room.room_uid.to_string(),
            code,
        };
        self.rooms.lock().await.insert(
            created.room_uid.clone(),
            HostedRoom {
                row_id,
                authority,
                workspace_path: Some(new.workspace_path.to_string()),
                share: None,
                docs: Default::default(),
                presence: Default::default(),
                voice: Default::default(),
            },
        );
        Ok(created)
    }

    /// Runs `f` on a hosted room's authority (loading it first) and saves its outcome.
    async fn with_room<R>(
        &self,
        db: &Db,
        room_uid: &str,
        now: i64,
        f: impl FnOnce(&mut Authority) -> Result<(Outcome, R), String>,
    ) -> Result<R, String> {
        let host = self.identity(db).await?;
        let mut rooms = self.rooms.lock().await;
        if !rooms.contains_key(room_uid) {
            let row = rooms::get_by_uid(db.pool(), room_uid)
                .await
                .map_err(|err| err.to_string())?
                .ok_or("This room isn't stored on this computer.")?;
            if row.relation != "created" {
                return Err("This room is hosted on another computer.".into());
            }
            let authority = persist::load_hosted(db, &row, host, now).await?;
            rooms.insert(
                room_uid.to_string(),
                HostedRoom {
                    row_id: row.id,
                    authority,
                    workspace_path: row.workspace_path.clone(),
                    share: None,
                    docs: Default::default(),
                    presence: Default::default(),
                    voice: Default::default(),
                },
            );
        }
        let hosted = rooms
            .get_mut(room_uid)
            .ok_or("The room couldn't be loaded.")?;
        let (outcome, result) = f(&mut hosted.authority)?;
        if nothing_changed(&outcome) {
            return Ok(result);
        }
        let saved = async {
            let mut tx = repo::begin(db).await.map_err(|err| err.to_string())?;
            persist::save_outcome(&mut tx, hosted.row_id, &hosted.authority, &outcome, now).await?;
            repo::commit(tx).await.map_err(|err| err.to_string())
        }
        .await;
        if let Err(err) = saved {
            tracing::warn!(%err, "a room change couldn't be saved; the room is reloaded from the database");
            rooms.remove(room_uid);
            return Err(err);
        }
        Ok(result)
    }

    /// Executes a room or membership change as this machine's user.
    pub async fn run_command(
        &self,
        db: &Db,
        room_uid: &str,
        command: Command,
        now: i64,
    ) -> Result<Effects, String> {
        let host = Actor::Host(self.identity(db).await?.peer_id());
        self.execute(db, room_uid, host, command, now).await
    }

    async fn execute(
        &self,
        db: &Db,
        room_uid: &str,
        actor: Actor,
        command: Command,
        now: i64,
    ) -> Result<Effects, String> {
        let approved = match &command {
            Command::Approve { target } => Some(target.clone()),
            _ => None,
        };
        let closed = matches!(command, Command::CloseRoom);
        let effects = self
            .with_room(db, room_uid, now, |authority| {
                let refused = manage::refusal(authority.room(), &command)
                    .into_iter()
                    .collect();
                let outcome = authority
                    .execute(&actor, command, now)
                    .map_err(|err| err.to_string())?;
                let ended = outcome
                    .ended_sessions
                    .iter()
                    .map(|(peer, _)| peer.clone())
                    .collect();
                let rotated = outcome.new_invite.is_some();
                Ok((
                    outcome,
                    Effects {
                        ended,
                        approved,
                        rotated,
                        access_changed: true,
                        refused,
                        closed,
                        ..Effects::default()
                    },
                ))
            })
            .await?;
        // A permission, role, moderation or membership change applies to the voice call at once.
        let voice_changed = self.voice_enforce(room_uid).await;
        Ok(Effects {
            voice_changed,
            ..effects
        })
    }

    /// The signaling topic of a hosted room's current Room Code.
    pub async fn topic(&self, db: &Db, room_uid: &str, now: i64) -> Result<String, String> {
        self.with_room(db, room_uid, now, |a| {
            Ok((Outcome::default(), a.invite().signaling_topic()))
        })
        .await
    }

    /// The Owner's first handshake message on a new connection (proofs over the bound challenge).
    pub async fn hello(
        &self,
        db: &Db,
        room_uid: &str,
        challenge: Challenge,
        bound: Challenge,
        now: i64,
    ) -> Result<Handshake, String> {
        self.with_room(db, room_uid, now, |a| {
            let room = a.room().room_uid.clone();
            let hello = openmind_collab::binding::owner_hello(
                a.host_identity(),
                a.invite(),
                &room,
                &challenge,
                &bound,
            );
            Ok((Outcome::default(), hello))
        })
        .await
    }

    /// A remote join or reconnect request (answering the bound challenge); the result is persisted.
    pub async fn admit(
        &self,
        db: &Db,
        room_uid: &str,
        request: Handshake,
        bound: Challenge,
        now: i64,
    ) -> Result<JoinOutcome, String> {
        self.with_room(db, room_uid, now, |a| {
            let (result, outcome) = match &request {
                Handshake::Join(join) => a.join(join, &bound, now),
                Handshake::Reconnect(again) => a.reconnect(again, &bound, now),
                _ => return Err("Expected a join or reconnect request.".into()),
            }
            .map_err(|err| err.to_string())?;
            Ok((outcome, result))
        })
        .await
    }

    pub async fn admit_approved(
        &self,
        db: &Db,
        room_uid: &str,
        peer: PeerId,
        now: i64,
    ) -> Result<Admission, String> {
        self.with_room(db, room_uid, now, |a| {
            let (admission, outcome) = a
                .admit_approved(&peer, now)
                .map_err(|err| err.to_string())?;
            Ok((outcome, admission))
        })
        .await
    }

    /// An admitted remote frame: commands go through the authority (which authorizes them for `actor`); bodies of
    /// later phases (documents, files, presence, voice) are refused for now.
    pub async fn remote_frame(
        &self,
        db: &Db,
        room_uid: &str,
        actor: Actor,
        frame: Frame,
        now: i64,
    ) -> (FrameOutcome, Effects) {
        match frame.body {
            Body::Command { command } => {
                match self.execute(db, room_uid, actor, command, now).await {
                    Ok(effects) => (FrameOutcome::Accepted, effects),
                    Err(reason) => (FrameOutcome::Rejected(reason), Effects::default()),
                }
            }
            Body::VoiceState { state } => {
                match self.voice_state(db, room_uid, actor, state, now).await {
                    Ok(voice_changed) => (
                        FrameOutcome::Accepted,
                        Effects {
                            voice_changed,
                            ..Effects::default()
                        },
                    ),
                    Err(reason) => (FrameOutcome::Rejected(reason), Effects::default()),
                }
            }
            Body::VoiceSignal { to, signal } => {
                self.voice_signal_frame(db, room_uid, actor, to, signal)
                    .await
            }
            // Answered by the app (it knows the media server), never with a plain Ack.
            Body::VoiceMediaRequest => (
                FrameOutcome::Relay(Vec::new()),
                Effects {
                    voice_media: Some((actor, frame.id)),
                    ..Effects::default()
                },
            ),
            Body::Presence { state } => {
                let (outcome, presence) = self.presence_frame(room_uid, actor, state).await;
                (
                    outcome,
                    Effects {
                        presence,
                        ..Effects::default()
                    },
                )
            }
            body @ (Body::YjsStateRequest { .. }
            | Body::YjsUpdate { .. }
            | Body::DocUnsubscribe { .. }) => {
                let (outcome, owner_docs) = self.doc_frame(db, room_uid, actor, body, now).await;
                (
                    outcome,
                    Effects {
                        owner_docs,
                        ..Effects::default()
                    },
                )
            }
            _ => (
                FrameOutcome::Rejected("This isn't available yet.".into()),
                Effects::default(),
            ),
        }
    }

    /// A participant's connection ended.
    pub async fn disconnected(
        &self,
        db: &Db,
        room_uid: &str,
        peer: PeerId,
        session: SessionId,
        reason: String,
        now: i64,
    ) -> Result<(), String> {
        self.with_room(db, room_uid, now, |a| {
            let outcome = a
                .disconnect(&peer, &session, &reason, now)
                .map_err(|err| err.to_string())?;
            Ok((outcome, ()))
        })
        .await
    }

    /// The current Room Code of a hosted, open room.
    pub async fn invite_code(&self, db: &Db, room_uid: &str, now: i64) -> Result<String, String> {
        self.with_room(db, room_uid, now, |authority| {
            if authority.room().closed {
                return Err("The room is closed.".into());
            }
            Ok((Outcome::default(), authority.invite().display()))
        })
        .await
    }

    /// Peers with a live connection per hosted room (the hosting user counts as online).
    pub async fn online(&self) -> HashMap<String, Vec<String>> {
        let rooms = self.rooms.lock().await;
        rooms
            .iter()
            .map(|(uid, hosted)| {
                let room = hosted.authority.room();
                let host = hosted.authority.host_identity().peer_id();
                let online = room
                    .members
                    .keys()
                    .filter(|peer| **peer == host || hosted.authority.session_of(peer).is_some())
                    .map(ToString::to_string)
                    .collect();
                (uid.clone(), online)
            })
            .collect()
    }
}

#[cfg(test)]
#[path = "host_tests.rs"]
mod tests;
