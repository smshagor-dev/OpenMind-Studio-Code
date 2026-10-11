//! The Owner network's view of a hosted room ([`OwnerAuthority`]), implemented over the app's [`super::CollabRuntime`]:
//! every call goes through the same load/execute/persist path as the host's own commands, so a remote join, frame or
//! disconnect is authorized by `openmind_collab::authorize` and saved in the machine database before it counts.
//! Changes that affect other live connections (a remote moderator's kick, an approval) are applied to the network
//! afterwards, and the `Collaboration` canonical domain is refreshed.

use openmind_collab::authority::JoinOutcome;
use openmind_collab::ids::Challenge;
use openmind_collab::manifest::ManifestSnapshot;
use openmind_collab::protocol::{Admission, Body, Frame, Handshake};
use openmind_collab::transfer::{FileErrorCode, Snapshot};
use openmind_collab::{Actor, FileId, PeerId, RoomUid, SessionId};
use openmind_collab_net::owner::{FrameOutcome, OwnerAuthority, OwnerNetwork};
use openmind_collab_net::transport::BoxFuture;
use openmind_collab_signal::Topic;
use tauri::{AppHandle, Manager};

use super::host::Effects;
use super::now_ms;
use crate::app_state::AppState;
use crate::state::Domain;

pub(super) struct AppAuthority {
    pub app: AppHandle,
    pub room: RoomUid,
}

fn changed(app: &AppHandle) {
    crate::state::refresh_soon(app, &[Domain::Collaboration]);
}

/// Tells the new member its write access once its link is admitted (the network handles the admission first).
fn access_soon(app: &AppHandle, room: &str) {
    let (app, room) = (app.clone(), room.to_string());
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(std::time::Duration::from_millis(200)).await;
        super::net_docs::refresh_access(&app, &room).await;
        super::net_presence::on_admitted(&app, &room).await;
        // The newcomer sees who is in the voice call before anyone changes it.
        super::net_voice::broadcast(&app, &room).await;
    });
}

/// The room was closed: each connected member is told (a last room view saying so), then its connection ends and
/// the room goes off the local network and the signaling server. Its history stays in the database.
fn close_room(app: &AppHandle, room: &str, network: OwnerNetwork, members: Vec<PeerId>) {
    let (app, room) = (app.clone(), room.to_string());
    tauri::async_runtime::spawn(async move {
        let Some(state) = app.try_state::<AppState>() else {
            return;
        };
        for peer in &members {
            if let Some(view) = state.collab.room_view(&room, peer).await {
                network.send(peer.clone(), Body::RoomView { view });
            }
        }
        tokio::time::sleep(std::time::Duration::from_millis(400)).await;
        for peer in members {
            network.close_peer(peer);
        }
        state.collab.net.stop_host(&room);
        crate::state::refresh_soon(&app, &[Domain::Collaboration]);
    });
}

/// Closes the connections of ended sessions and admits an approved member on the room's network.
pub(super) fn apply_effects(app: &AppHandle, room: &str, effects: Effects) {
    let Some(state) = app.try_state::<AppState>() else {
        return;
    };
    let Some(network) = state.collab.net.hosting(room) else {
        return;
    };
    if effects.closed {
        close_room(app, room, network, effects.ended);
        return;
    }
    for peer in effects.ended {
        network.close_peer(peer);
    }
    if let Some(peer) = effects.approved {
        network.approved(peer);
    }
    for (peer, refusal) in effects.refused {
        network.refuse(peer, refusal);
    }
    if !effects.owner_docs.is_empty() {
        super::net_docs::owner_events(app, room, effects.owner_docs);
    }
    if let Some(notice) = effects.presence {
        super::net_presence::owner_notice(app, room, notice);
    }
    if let Some((from, signal)) = effects.voice_to_host {
        super::net_voice::to_host(app, room, from, signal);
    }
    if let Some((actor, of)) = effects.voice_media {
        answer_media(app, room, network.clone(), actor, of);
    }
    if effects.voice_changed {
        let (app, room) = (app.clone(), room.to_string());
        tauri::async_runtime::spawn(async move { super::net_voice::broadcast(&app, &room).await });
    }
    if effects.access_changed {
        let (app, room) = (app.clone(), room.to_string());
        tauri::async_runtime::spawn(async move {
            super::net_docs::refresh_access(&app, &room).await;
            super::net_presence::refresh_roster(&app, &room).await;
        });
    }
    if effects.rotated {
        let (app, room) = (app.clone(), room.to_string());
        tauri::async_runtime::spawn(async move {
            if let Err(err) = super::net::rehost(&app, &room).await {
                tracing::warn!(%err, "a rotated room couldn't be offered under its new code");
            }
        });
    }
}

impl OwnerAuthority for AppAuthority {
    fn room_uid(&self) -> RoomUid {
        self.room.clone()
    }

    fn topic(&self) -> BoxFuture<'_, Result<Topic, String>> {
        Box::pin(async move {
            let state = self.app.state::<AppState>();
            let topic = state
                .collab
                .topic(&state.db, self.room.as_str(), now_ms())
                .await?;
            Topic::parse(&topic)
        })
    }

    fn hello(
        &self,
        challenge: Challenge,
        bound: Challenge,
    ) -> BoxFuture<'_, Result<Handshake, String>> {
        Box::pin(async move {
            let state = self.app.state::<AppState>();
            state
                .collab
                .hello(&state.db, self.room.as_str(), challenge, bound, now_ms())
                .await
        })
    }

    fn admit(
        &self,
        request: Handshake,
        bound: Challenge,
    ) -> BoxFuture<'_, Result<JoinOutcome, String>> {
        Box::pin(async move {
            let state = self.app.state::<AppState>();
            let outcome = state
                .collab
                .admit(&state.db, self.room.as_str(), request, bound, now_ms())
                .await;
            changed(&self.app);
            if matches!(outcome, Ok(JoinOutcome::Admitted(_))) {
                access_soon(&self.app, self.room.as_str());
            }
            outcome
        })
    }

    fn admit_approved(&self, peer: PeerId) -> BoxFuture<'_, Result<Admission, String>> {
        Box::pin(async move {
            let state = self.app.state::<AppState>();
            let admission = state
                .collab
                .admit_approved(&state.db, self.room.as_str(), peer, now_ms())
                .await;
            changed(&self.app);
            if admission.is_ok() {
                access_soon(&self.app, self.room.as_str());
            }
            admission
        })
    }

    fn frame(&self, actor: Actor, frame: Frame) -> BoxFuture<'_, FrameOutcome> {
        Box::pin(async move {
            let state = self.app.state::<AppState>();
            let (outcome, effects) = state
                .collab
                .remote_frame(&state.db, self.room.as_str(), actor, frame, now_ms())
                .await;
            if !matches!(outcome, FrameOutcome::Rejected(_)) {
                apply_effects(&self.app, self.room.as_str(), effects);
                changed(&self.app);
            }
            outcome
        })
    }

    fn disconnected(&self, peer: PeerId, session: SessionId, reason: String) -> BoxFuture<'_, ()> {
        Box::pin(async move {
            let state = self.app.state::<AppState>();
            let peer_left = peer.clone();
            if let Err(err) = state
                .collab
                .disconnected(
                    &state.db,
                    self.room.as_str(),
                    peer,
                    session,
                    reason,
                    now_ms(),
                )
                .await
            {
                tracing::warn!(%err, "a participant's disconnect couldn't be recorded");
            }
            state
                .collab
                .doc_peer_left(&state.db, self.room.as_str(), &peer_left, now_ms())
                .await;
            super::net_presence::on_left(&self.app, self.room.as_str(), &peer_left).await;
            super::net_voice::member_left(&self.app, self.room.as_str(), &peer_left).await;
            changed(&self.app);
        })
    }

    fn manifest(&self, actor: Actor) -> BoxFuture<'_, Result<ManifestSnapshot, String>> {
        Box::pin(async move {
            let state = self.app.state::<AppState>();
            state
                .collab
                .manifest(&state.db, self.room.as_str(), actor, now_ms())
                .await
        })
    }

    fn open_file(
        &self,
        actor: Actor,
        file: FileId,
    ) -> BoxFuture<'_, Result<Snapshot, FileErrorCode>> {
        Box::pin(async move {
            let state = self.app.state::<AppState>();
            state
                .collab
                .open_file(self.room.as_str(), actor, file)
                .await
        })
    }
}

/// A member's media request: OpenMind's checks, then a grant (peer to peer, or a media token for this member only), or
/// a refusal naming the request.
fn answer_media(
    app: &AppHandle,
    room: &str,
    network: openmind_collab_net::owner::OwnerNetwork,
    actor: openmind_collab::Actor,
    of: openmind_collab::MessageId,
) {
    let (app, room) = (app.clone(), room.to_string());
    tauri::async_runtime::spawn(async move {
        let state = app.state::<AppState>();
        let openmind_collab::Actor::Remote { peer, .. } = &actor else {
            return;
        };
        let peer = peer.clone();
        let body = match super::sfu::grant(&state, &room, &actor).await {
            Ok(media) => openmind_collab::protocol::Body::VoiceMedia { of, media },
            Err(reason) => openmind_collab::protocol::Body::Reject { of, reason },
        };
        network.send(peer, body);
    });
}
