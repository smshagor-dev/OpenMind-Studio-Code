//! Presence in a hosted room, on the Owner's machine (Milestone 24, phase 7). Ephemeral: held in memory only, never
//! stored. A member's state is relayed only if it comes on that member's *current* session, the member is active, the
//! state is newer than the last one, and its active file is one of this room's shared files the member may read; anything
//! else is dropped without an answer (a harmless stale race costs nothing, a forged one achieves nothing). The relayed
//! copy names the authenticated peer. Roles come from the membership ([`CollabRuntime::roster`]).

use std::path::PathBuf;

use openmind_collab::fsauth::FileRequest;
use openmind_collab::presence::{PresenceState, RosterEntry};
use openmind_collab::protocol::Body;
use openmind_collab::room::MemberStatus;
use openmind_collab::{Actor, FileId, PeerId};
use openmind_collab_net::owner::FrameOutcome;
use openmind_db::Db;

use super::CollabRuntime;

/// What the Owner's own windows hear about a member's presence (with the file's place on this computer).
#[derive(Debug, Clone, PartialEq)]
pub struct PresenceNotice {
    pub peer: PeerId,
    pub state: PresenceState,
    pub active_path: Option<PathBuf>,
}

impl CollabRuntime {
    /// The members other than `except` that are connected now.
    async fn connected_except(&self, room: &str, except: Option<&PeerId>) -> Vec<PeerId> {
        self.access_list(room)
            .await
            .into_iter()
            .map(|(peer, _)| peer)
            .filter(|peer| Some(peer) != except)
            .collect()
    }

    async fn path_of(&self, room: &str, actor: &Actor, file: &FileId) -> Option<PathBuf> {
        let rooms = self.rooms.lock().await;
        let hosted = rooms.get(room)?;
        let share = hosted.share.as_ref()?;
        // Presence names a file, never a folder.
        let entry = share.shared.files().get(file)?;
        if entry.kind != openmind_collab::files::FileKind::File {
            return None;
        }
        share
            .shared
            .authorize(&hosted.authority, actor, &FileRequest::Read(file.clone()))
            .ok()
            .map(|a| a.absolute)
    }

    /// A participant's presence state. `Relay` to the other connected members, or `Dropped`.
    pub async fn presence_frame(
        &self,
        room: &str,
        actor: Actor,
        state: PresenceState,
    ) -> (FrameOutcome, Option<PresenceNotice>) {
        let Actor::Remote { peer, session } = &actor else {
            return (FrameOutcome::Dropped, None);
        };
        {
            let rooms = self.rooms.lock().await;
            let Some(hosted) = rooms.get(room) else {
                return (FrameOutcome::Dropped, None);
            };
            let authority = &hosted.authority;
            let current = authority.session_of(peer) == Some(session);
            let active = authority
                .room()
                .member(peer)
                .is_some_and(|m| m.status == MemberStatus::Active);
            if !current || !active {
                return (FrameOutcome::Dropped, None); // an old session, or a member who is gone
            }
        }
        let active_path = match &state.active {
            Some(file) => match self.path_of(room, &actor, file).await {
                Some(path) => Some(path),
                None => return (FrameOutcome::Dropped, None), // not a file of this room this member may see
            },
            None => None,
        };
        let accepted = {
            let mut rooms = self.rooms.lock().await;
            rooms
                .get_mut(room)
                .is_some_and(|h| h.presence.accept(peer, &state))
        };
        if !accepted {
            return (FrameOutcome::Dropped, None);
        }
        let others = self.connected_except(room, Some(peer)).await;
        let relay = others
            .into_iter()
            .map(|to| {
                (
                    to,
                    Body::PeerPresence {
                        peer: peer.clone(),
                        state: state.clone(),
                    },
                )
            })
            .collect();
        (
            FrameOutcome::Relay(relay),
            Some(PresenceNotice {
                peer: peer.clone(),
                state,
                active_path,
            }),
        )
    }

    /// The Owner's own presence (from its focused editor window): sent to every connected member.
    pub async fn owner_presence(
        &self,
        db: &Db,
        room: &str,
        state: PresenceState,
    ) -> Vec<(PeerId, Body)> {
        let Ok(host) = self.identity(db).await.map(|i| i.peer_id()) else {
            return Vec::new();
        };
        if let Some(file) = &state.active {
            if self
                .path_of(room, &Actor::Host(host.clone()), file)
                .await
                .is_none()
            {
                return Vec::new();
            }
        }
        let accepted = self
            .rooms
            .lock()
            .await
            .get_mut(room)
            .is_some_and(|h| h.presence.accept(&host, &state));
        if !accepted {
            return Vec::new();
        }
        let members = self.connected_except(room, None).await;
        members
            .into_iter()
            .map(|to| {
                (
                    to,
                    Body::PeerPresence {
                        peer: host.clone(),
                        state: state.clone(),
                    },
                )
            })
            .collect()
    }

    /// A member left or its session ended: its presence is gone for everyone.
    pub async fn presence_gone(&self, room: &str, peer: &PeerId) -> Vec<(PeerId, Body)> {
        if let Some(hosted) = self.rooms.lock().await.get_mut(room) {
            hosted.presence.forget(peer);
        }
        let members = self.connected_except(room, Some(peer)).await;
        members
            .into_iter()
            .map(|to| (to, Body::PresenceGone { peer: peer.clone() }))
            .collect()
    }

    /// Every current presence state, for someone who just joined.
    pub async fn presence_states(&self, room: &str) -> Vec<(PeerId, PresenceState)> {
        self.rooms
            .lock()
            .await
            .get(room)
            .map(|h| h.presence.all())
            .unwrap_or_default()
    }

    /// A shared file was deleted or hidden: everyone who had it active now has no active file.
    pub async fn presence_file_gone(&self, room: &str, file: &FileId) -> Vec<(PeerId, Body)> {
        let changed = self
            .rooms
            .lock()
            .await
            .get_mut(room)
            .map(|h| h.presence.file_gone(file))
            .unwrap_or_default();
        let members = self.connected_except(room, None).await;
        let mut out = Vec::new();
        for (peer, state) in changed {
            for to in members.iter().filter(|to| **to != peer) {
                out.push((
                    to.clone(),
                    Body::PeerPresence {
                        peer: peer.clone(),
                        state: state.clone(),
                    },
                ));
            }
        }
        out
    }

    /// The members as every window and participant should show them: name, role and whether they are connected —
    /// from the room's membership, never from what anyone says about itself.
    pub async fn roster(&self, room: &str) -> Vec<RosterEntry> {
        let rooms = self.rooms.lock().await;
        let Some(hosted) = rooms.get(room) else {
            return Vec::new();
        };
        let authority = &hosted.authority;
        // The hosting user is always connected (it may no longer be the Owner after a transfer).
        let host = authority.host_identity().peer_id();
        authority
            .room()
            .members
            .values()
            .filter(|m| m.status == MemberStatus::Active)
            .map(|m| RosterEntry {
                peer: m.peer.clone(),
                display_name: m
                    .display_name
                    .chars()
                    .take(openmind_collab::presence::MAX_NAME_CHARS)
                    .collect(),
                role: m.role,
                online: m.peer == host || authority.session_of(&m.peer).is_some(),
            })
            .collect()
    }

    /// The shared file at `path` on this computer, if `path` is one (the Owner's own editor reports paths).
    pub async fn file_at(&self, db: &Db, room: &str, path: &std::path::Path) -> Option<FileId> {
        let host = Actor::Host(self.identity(db).await.ok()?.peer_id());
        let id = {
            let rooms = self.rooms.lock().await;
            let share = rooms.get(room)?.share.as_ref()?;
            // Compared by segment, ignoring case (Windows) and a `\\?\` prefix; the file's own spelling is kept.
            let segments = |p: &std::path::Path| -> Vec<String> {
                let text = p.to_string_lossy().replace('\\', "/");
                let text = text.strip_prefix("//?/").unwrap_or(&text).to_string();
                text.split('/')
                    .filter(|s| !s.is_empty())
                    .map(str::to_string)
                    .collect()
            };
            let (root, full) = (segments(share.shared.root().path()), segments(path));
            let same = |a: &String, b: &String| a.to_lowercase() == b.to_lowercase();
            if full.len() <= root.len() || !root.iter().zip(&full).all(|(a, b)| same(a, b)) {
                return None;
            }
            let rel = full[root.len()..].join("/");
            share
                .shared
                .files()
                .id_of(&openmind_collab::files::RelPath::parse(&rel).ok()?)?
                .clone()
        };
        self.path_of(room, &host, &id).await.map(|_| id)
    }

    /// Where a shared file is on this computer (for the Owner's own windows; never sent anywhere).
    pub async fn file_path(&self, db: &Db, room: &str, file: &FileId) -> Option<PathBuf> {
        let host = Actor::Host(self.identity(db).await.ok()?.peer_id());
        self.path_of(room, &host, file).await
    }
}

#[cfg(test)]
#[path = "presence_tests.rs"]
mod tests;
