//! A participant's view of the Owner's workspace: the shared tree (assembled from manifest pages, kept current by
//! deltas, refetched when a delta doesn't follow) and file fetching. [`spawn`] takes an admitted [`Participant`],
//! asks for the manifest at once — never for file contents — and routes every frame the Owner sends; the caller
//! hears about it through [`RemoteEvent`]s (transient: progress and tree changes are not durable state).

use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use openmind_collab::manifest::{DeltaResult, ManifestEntry, RemoteTree};
use openmind_collab::protocol::{Body, Bytes, DocClosedReason};
use openmind_collab::sync_chunk::{split, Reassembler};
use openmind_collab::{FileId, MessageId};
use tokio::task::JoinHandle;

use crate::files::{FetchError, FileClient, ReceivedFile};
use crate::participant::{Participant, ParticipantEvent, ParticipantSender};
use crate::state::ConnectionState;

/// The Owner allows one manifest request per second; requests closer together are delayed, not dropped.
const MANIFEST_SPACING: Duration = Duration::from_millis(1100);

#[derive(Debug, Clone, PartialEq)]
pub enum RemoteEvent {
    /// A complete manifest arrived (`version`); read it with [`RemoteWorkspace::tree`].
    TreeReady {
        version: u64,
    },
    TreeDelta {
        base: u64,
        version: u64,
        upserts: Vec<ManifestEntry>,
        removed: Vec<FileId>,
    },
    /// The local copy is stale; a fresh manifest was requested.
    TreeStale,
    Progress {
        file: FileId,
        received: u64,
        total: u64,
    },
    State(ConnectionState),
    /// A message from the Owner was refused (logged; nothing else happens).
    Invalid(String),
    /// Collaborative editing (phase 6).
    Doc(DocEvent),
    /// Who is where (phase 7; ephemeral).
    Presence(PresenceEvent),
    /// The voice call: who is in it, and negotiation from another member (phase 9; ephemeral).
    Voice(VoiceEvent),
    /// The kind of path the connection to the Owner takes (direct, STUN, or a TURN relay); never an address.
    Path(crate::transport::IcePath),
}

/// What the Owner says about the voice call.
#[derive(Debug, Clone, PartialEq)]
pub enum VoiceEvent {
    /// Who is in the call, and how the call carries media.
    Roster {
        members: Vec<openmind_collab::voice::VoiceMember>,
        mode: openmind_collab::sfu::VoiceMode,
    },
    /// The Owner's answer to a media request (`of`: the request's frame).
    Media {
        of: openmind_collab::MessageId,
        media: openmind_collab::sfu::VoiceMediaGrant,
    },
    Signal {
        from: openmind_collab::PeerId,
        signal: openmind_collab::voice::VoiceSignal,
    },
}

/// What the Owner says about members' presence.
#[derive(Debug, Clone, PartialEq)]
pub enum PresenceEvent {
    Roster(Vec<openmind_collab::presence::RosterEntry>),
    Peer {
        peer: openmind_collab::PeerId,
        state: openmind_collab::presence::PresenceState,
    },
    Gone {
        peer: openmind_collab::PeerId,
    },
    /// The room and its members as this member may manage them (phase 8).
    Room(Box<openmind_collab::roomview::RoomView>),
}

/// What the Owner says about collaborative documents.
#[derive(Debug, Clone, PartialEq)]
pub enum DocEvent {
    /// The answer to a subscription: what this side was missing, and the Owner's state vector.
    Sync {
        file: FileId,
        state_vector: Vec<u8>,
        update: Vec<u8>,
    },
    /// Someone else's accepted change.
    Update {
        file: FileId,
        update: Vec<u8>,
    },
    Closed {
        file: FileId,
        reason: DocClosedReason,
    },
    /// Whether this member may change files now.
    Access {
        write: bool,
    },
    /// The Owner stored (or refused) the message whose (last) frame was `frame`.
    Acked {
        frame: MessageId,
    },
    Rejected {
        frame: MessageId,
        reason: String,
    },
}

pub type Listener = Arc<dyn Fn(RemoteEvent) + Send + Sync>;

pub struct RemoteWorkspace {
    files: Arc<FileClient>,
    tree: Mutex<RemoteTree>,
    sender: ParticipantSender,
    last_request: Mutex<Option<Instant>>,
    chunks: Mutex<Reassembler>,
}

impl RemoteWorkspace {
    fn tree_lock(&self) -> std::sync::MutexGuard<'_, RemoteTree> {
        self.tree
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }

    /// Reads the current tree (ready or not).
    pub fn tree<R>(&self, read: impl FnOnce(&RemoteTree) -> R) -> R {
        read(&self.tree_lock())
    }

    pub async fn fetch(&self, file: FileId) -> Result<ReceivedFile, FetchError> {
        self.files.fetch(file).await
    }

    pub fn cancel(&self, file: &FileId) {
        self.files.cancel_file(file);
    }

    pub fn files(&self) -> &Arc<FileClient> {
        &self.files
    }

    pub fn sender(&self) -> &ParticipantSender {
        &self.sender
    }

    /// Opens `file` for collaborative editing (answered with `DocEvent::Sync`).
    pub fn subscribe(
        &self,
        file: FileId,
        state_vector: Vec<u8>,
    ) -> Result<MessageId, crate::NetError> {
        self.sender.send(Body::YjsStateRequest {
            file,
            state_vector: Bytes(state_vector),
        })
    }

    pub fn unsubscribe(&self, file: FileId) -> Result<MessageId, crate::NetError> {
        self.sender.send(Body::DocUnsubscribe { file })
    }

    /// Sends one change (`id` identifies the change across resends). Returns the id of the frame the Owner's
    /// acknowledgement will name (the last piece, when it had to be sent in pieces).
    pub fn send_update(
        &self,
        file: FileId,
        id: MessageId,
        update: Vec<u8>,
    ) -> Result<MessageId, crate::NetError> {
        let bodies = split(Body::YjsUpdate {
            file,
            id,
            update: Bytes(update),
        })
        .map_err(|e| crate::NetError::Protocol(e.to_string()))?;
        let mut last = None;
        for body in bodies {
            last = Some(self.sender.send(body)?);
        }
        last.ok_or(crate::NetError::Closed)
    }

    /// Asks the Owner for the manifest (spaced to its rate limit).
    pub fn request_manifest(self: &Arc<Self>) {
        let wait = {
            let mut last = self
                .last_request
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            let wait = last.map_or(Duration::ZERO, |at| {
                MANIFEST_SPACING.saturating_sub(at.elapsed())
            });
            *last = Some(Instant::now() + wait);
            wait
        };
        let me = self.clone();
        tokio::spawn(async move {
            tokio::time::sleep(wait).await;
            let _ = me.sender.send(Body::ManifestRequest);
        });
    }

    fn frame(self: &Arc<Self>, body: Body, listener: &Listener) {
        if self.files.handle(&body) {
            return;
        }
        let body = match body {
            Body::SyncChunk {
                id: transfer,
                index,
                count,
                sha256,
                data,
            } => {
                let rebuilt = self
                    .chunks
                    .lock()
                    .unwrap_or_else(std::sync::PoisonError::into_inner)
                    .add(transfer, index, count, sha256, data.0);
                match rebuilt {
                    Ok(Some(body)) => body,
                    Ok(None) => return,
                    Err(err) => return listener(RemoteEvent::Invalid(err.to_string())),
                }
            }
            other => other,
        };
        let body = match doc_event(body) {
            Ok(event) => return listener(event),
            Err(body) => body,
        };
        let event = match body {
            Body::ManifestPage {
                version,
                page,
                pages,
                root,
                entries,
            } => {
                match self
                    .tree_lock()
                    .apply_page(version, page, pages, &root, entries)
                {
                    Ok(true) => Some(RemoteEvent::TreeReady { version }),
                    Ok(false) => None,
                    Err(err) => Some(RemoteEvent::Invalid(err.to_string())),
                }
            }
            Body::TreeDelta {
                base,
                version,
                upserts,
                removed,
            } => {
                match self
                    .tree_lock()
                    .apply_delta(base, version, upserts.clone(), removed.clone())
                {
                    Ok(DeltaResult::Applied) => Some(RemoteEvent::TreeDelta {
                        base,
                        version,
                        upserts,
                        removed,
                    }),
                    Ok(DeltaResult::Resync) => {
                        self.request_manifest();
                        Some(RemoteEvent::TreeStale)
                    }
                    Err(err) => Some(RemoteEvent::Invalid(err.to_string())),
                }
            }
            Body::TreeReset { .. } => {
                self.tree_lock().invalidate();
                self.request_manifest();
                Some(RemoteEvent::TreeStale)
            }
            _ => None,
        };
        if let Some(event) = event {
            listener(event);
        }
    }
}

/// A collaborative-document or presence message (or an acknowledgement) as an event; anything else is handed back.
fn doc_event(body: Body) -> Result<RemoteEvent, Body> {
    let event = match body {
        Body::VoiceRoster { members, mode } => {
            return Ok(RemoteEvent::Voice(VoiceEvent::Roster { members, mode }))
        }
        Body::VoiceMedia { of, media } => {
            return Ok(RemoteEvent::Voice(VoiceEvent::Media { of, media }))
        }
        Body::VoicePeerSignal { from, signal } => {
            return Ok(RemoteEvent::Voice(VoiceEvent::Signal { from, signal }))
        }
        Body::RoomView { view } => {
            return Ok(RemoteEvent::Presence(PresenceEvent::Room(Box::new(view))))
        }
        Body::Roster { members } => {
            return Ok(RemoteEvent::Presence(PresenceEvent::Roster(members)))
        }
        Body::PeerPresence { peer, state } => {
            return Ok(RemoteEvent::Presence(PresenceEvent::Peer { peer, state }))
        }
        Body::PresenceGone { peer } => {
            return Ok(RemoteEvent::Presence(PresenceEvent::Gone { peer }))
        }
        Body::DocSync {
            file,
            state_vector,
            update,
        } => DocEvent::Sync {
            file,
            state_vector: state_vector.0,
            update: update.0,
        },
        Body::YjsUpdate { file, update, .. } => DocEvent::Update {
            file,
            update: update.0,
        },
        Body::DocClosed { file, reason } => DocEvent::Closed { file, reason },
        Body::Access { write } => DocEvent::Access { write },
        Body::Ack { of } => DocEvent::Acked { frame: of },
        Body::Reject { of, reason } => DocEvent::Rejected { frame: of, reason },
        other => return Err(other),
    };
    Ok(RemoteEvent::Doc(event))
}

/// Starts following an admitted participant session: requests the manifest and routes the Owner's frames.
pub fn spawn(
    mut participant: Participant,
    listener: Listener,
) -> (Arc<RemoteWorkspace>, JoinHandle<()>) {
    let progress_listener = listener.clone();
    let progress: crate::files::Progress = Arc::new(move |file: &FileId, received, total| {
        progress_listener(RemoteEvent::Progress {
            file: file.clone(),
            received,
            total,
        });
    });
    let sender = participant.sender();
    let remote = Arc::new(RemoteWorkspace {
        files: FileClient::new(sender.clone(), Some(progress)),
        tree: Mutex::new(RemoteTree::default()),
        sender,
        last_request: Mutex::new(None),
        chunks: Mutex::new(Reassembler::default()),
    });
    remote.request_manifest();
    let me = remote.clone();
    let task = tokio::spawn(async move {
        while let Some(event) = participant.next_event().await {
            match event {
                ParticipantEvent::Frame(frame) => me.frame(frame.body, &listener),
                ParticipantEvent::Invalid(reason) => listener(RemoteEvent::Invalid(reason)),
                ParticipantEvent::Path(path) => listener(RemoteEvent::Path(path)),
                ParticipantEvent::State(state) => {
                    listener(RemoteEvent::State(state));
                    if state.is_finished() {
                        break;
                    }
                }
            }
        }
        me.files.disconnected();
        participant.close();
    });
    (remote, task)
}
