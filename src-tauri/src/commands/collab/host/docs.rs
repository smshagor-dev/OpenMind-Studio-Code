//! A hosted room's collaborative documents on the Owner's machine (Milestone 24, phase 6), over
//! `openmind_collab::docs::DocHost`:
//!
//! - **Opening** (a participant's `YjsStateRequest`): `file.read` through the filesystem authority (id lookup, privacy,
//!   path safety); text files up to `crdt::MAX_TEXT_UNITS` only. A document not in memory is rebuilt from storage
//!   (latest snapshot + later updates, `collab_crdt_updates` / `collab_document_snapshots`); when the file on disk
//!   differs from that (edited while not shared), the difference becomes one stored Owner change.
//! - **Changes**: a participant's needs `file.write` through the same authority, every time (a role change applies to
//!   the next keystroke); the Owner's own come from its editor. Each accepted change is stored — idempotently, by the
//!   change's own id — *before* it is acknowledged or forwarded. A snapshot is stored every `SNAPSHOT_EVERY` changes and
//!   when a document is unloaded. Nothing here writes the file: the Owner's editor holds the text and saves it the
//!   usual way.
//! - **Deletes** close the document for everyone and refuse late changes; the stored history stays.

use std::path::{Path, PathBuf};

use openmind_collab::crdt::{CollabDoc, MAX_TEXT_UNITS};
use openmind_collab::docs::{Change, Origin, StoredUpdate};
use openmind_collab::fsauth::FileRequest;
use openmind_collab::protocol::{Body, DocClosedReason};
use openmind_collab::{Action, Actor, FileId, MessageId, PeerId};
use openmind_collab_net::owner::FrameOutcome;
use openmind_db::collab::crdt;
use openmind_db::Db;

use super::CollabRuntime;

/// What the Owner's own editor must hear about.
#[derive(Debug, Clone, PartialEq)]
pub enum OwnerDocEvent {
    /// Someone opened `file`: the Owner's editor should follow it (it is at `path` on this machine).
    Active { file: FileId, path: PathBuf },
    /// Someone else's accepted change.
    Update { file: FileId, update: Vec<u8> },
    /// The document closed (deleted).
    Closed { file: FileId },
}

fn origin_text(origin: &Origin) -> String {
    match origin {
        Origin::Owner => "owner".into(),
        Origin::Peer(peer) => peer.to_string(),
    }
}

async fn store(
    db: &Db,
    row_id: i64,
    update: &StoredUpdate,
    now: i64,
) -> Result<Option<i64>, String> {
    crdt::insert_update(
        db.pool(),
        row_id,
        update.file.as_str(),
        update.id.as_str(),
        &origin_text(&update.origin),
        &update.bytes,
        now,
    )
    .await
    .map_err(|e| e.to_string())
}

/// The file's text as the Owner's disk has it now, with the SHA-256 of its bytes; `None` when it can't be edited
/// together (binary, too large).
fn disk_text(path: &Path) -> Result<Option<(String, String)>, String> {
    let snapshot = super::share::read_snapshot(path).map_err(|code| code.message().to_string())?;
    if !snapshot.text {
        return Ok(None);
    }
    let text = openmind_fs::encoding::decode(&snapshot.bytes).text;
    Ok((text.encode_utf16().count() <= MAX_TEXT_UNITS).then_some((text, snapshot.sha256)))
}

impl CollabRuntime {
    /// Where `file` is on this machine, if `actor` may do `request` with it.
    async fn doc_path(
        &self,
        room: &str,
        actor: &Actor,
        request: FileRequest,
    ) -> Result<PathBuf, String> {
        let rooms = self.rooms.lock().await;
        let hosted = rooms.get(room).ok_or("The room isn't loaded.")?;
        let share = hosted.share.as_ref().ok_or("This file isn't available.")?;
        share
            .shared
            .authorize(&hosted.authority, actor, &request)
            .map(|a| a.absolute)
            .map_err(|e| e.to_string())
    }

    /// Loads `file`'s document if it isn't in memory. `Ok(Some(path))` when it was just loaded.
    async fn ensure_doc(
        &self,
        db: &Db,
        room: &str,
        file: &FileId,
        path: &Path,
        now: i64,
    ) -> Result<Option<PathBuf>, DocClosedReason> {
        let row_id = {
            let rooms = self.rooms.lock().await;
            let hosted = rooms.get(room).ok_or(DocClosedReason::Unavailable)?;
            if hosted.docs.is_loaded(file) {
                return Ok(None);
            }
            hosted.row_id
        };
        let owned = path.to_path_buf();
        let (text, disk_sha) = tauri::async_runtime::spawn_blocking(move || disk_text(&owned))
            .await
            .map_err(|_| DocClosedReason::Unavailable)?
            .map_err(|_| DocClosedReason::Unavailable)?
            .ok_or(DocClosedReason::NotEditable)?;
        let snapshot = crdt::latest_snapshot(db.pool(), row_id, file.as_str())
            .await
            .map_err(|_| DocClosedReason::Unavailable)?;
        let after = snapshot.as_ref().map_or(0, |s| s.covers_update_id);
        let rows = crdt::updates_after(db.pool(), row_id, file.as_str(), after)
            .await
            .map_err(|_| DocClosedReason::Unavailable)?;
        let last = rows.last().map_or(after, |r| r.id);
        let has_history = snapshot.is_some() || !rows.is_empty();
        let updates: Vec<Vec<u8>> = rows.into_iter().map(|r| r.update_data).collect();
        let doc = if has_history {
            CollabDoc::restore(snapshot.as_ref().map(|s| s.state_data.as_slice()), &updates)
                .map_err(|_| DocClosedReason::Unavailable)?
        } else {
            CollabDoc::default()
        };
        // The stored document wins while the file is as it was when they last matched (it may hold accepted changes
        // nobody saved yet); a file changed meanwhile (outside the room) wins, as one Owner change.
        let baseline = crdt::baseline(db.pool(), row_id, file.as_str())
            .await
            .map_err(|_| DocClosedReason::Unavailable)?;
        let disk_unchanged = has_history && baseline.as_deref() == Some(disk_sha.as_str());
        let reconcile = if disk_unchanged {
            None
        } else {
            doc.set_text(&text)
        };
        let mut rooms = self.rooms.lock().await;
        let hosted = rooms.get_mut(room).ok_or(DocClosedReason::Unavailable)?;
        if hosted.docs.is_loaded(file) {
            return Ok(None); // loaded meanwhile by another request
        }
        let mut last_stored = last;
        if let Some(bytes) = reconcile {
            let id = MessageId::random().map_err(|_| DocClosedReason::Unavailable)?;
            let update = StoredUpdate {
                file: file.clone(),
                id,
                origin: Origin::Owner,
                bytes,
            };
            last_stored = store(db, hosted.row_id, &update, now)
                .await
                .map_err(|_| DocClosedReason::Unavailable)?
                .unwrap_or(last);
        }
        if doc.text() == text {
            let _ =
                crdt::set_baseline(db.pool(), hosted.row_id, file.as_str(), &disk_sha, now).await;
        }
        hosted.docs.load(file.clone(), doc, last_stored);
        Ok(Some(path.to_path_buf()))
    }

    /// Stores an accepted change (and a snapshot when one is due). On a storage failure the document is dropped from
    /// memory — it is rebuilt from what *was* stored — and the change is refused.
    async fn persist_change(
        &self,
        db: &Db,
        room: &str,
        change: &Change,
        now: i64,
    ) -> Result<(), String> {
        let Some(update) = &change.store else {
            return Ok(());
        };
        let mut rooms = self.rooms.lock().await;
        let hosted = rooms.get_mut(room).ok_or("The room isn't loaded.")?;
        let row_id = hosted.row_id;
        match store(db, row_id, update, now).await {
            Ok(Some(row)) => {
                if let Some((state, sv, covers)) = hosted.docs.stored(&update.file, row) {
                    if let Err(err) = crdt::save_snapshot(
                        db.pool(),
                        row_id,
                        update.file.as_str(),
                        &state,
                        &sv,
                        covers,
                        now,
                    )
                    .await
                    {
                        tracing::warn!(%err, "a document snapshot couldn't be stored; recovery replays more updates");
                    }
                }
                Ok(())
            }
            Ok(None) => Ok(()), // this change was stored before (a resend)
            Err(err) => {
                hosted.docs.discard(&update.file);
                Err(format!("The change couldn't be stored: {err}"))
            }
        }
    }

    /// A participant's document message, after the gate. Returns what the network answers and what the Owner's
    /// editor must hear.
    pub async fn doc_frame(
        &self,
        db: &Db,
        room: &str,
        actor: Actor,
        body: Body,
        now: i64,
    ) -> (FrameOutcome, Vec<OwnerDocEvent>) {
        let Actor::Remote { peer, .. } = &actor else {
            return (
                FrameOutcome::Rejected("Not a participant.".into()),
                Vec::new(),
            );
        };
        match body {
            Body::YjsStateRequest { file, state_vector } => {
                self.doc_open(db, room, &actor, peer, file, &state_vector.0, now)
                    .await
            }
            Body::YjsUpdate { file, id, update } => {
                if let Err(reason) = self
                    .doc_path(room, &actor, FileRequest::Write(file.clone()))
                    .await
                {
                    return (FrameOutcome::Rejected(reason), Vec::new());
                }
                let applied = {
                    let mut rooms = self.rooms.lock().await;
                    match rooms.get_mut(room) {
                        Some(hosted) => hosted
                            .docs
                            .update(Origin::Peer(peer.clone()), &file, id, update.0)
                            .map_err(|e| e.to_string()),
                        None => Err("The room isn't loaded.".into()),
                    }
                };
                let change = match applied {
                    Ok(change) => change,
                    Err(reason) => return (FrameOutcome::Rejected(reason), Vec::new()),
                };
                if let Err(reason) = self.persist_change(db, room, &change, now).await {
                    return (FrameOutcome::Rejected(reason), Vec::new());
                }
                let to_owner = change
                    .to_owner
                    .map(|update| OwnerDocEvent::Update { file, update })
                    .into_iter()
                    .collect();
                (FrameOutcome::Reply(change.send), to_owner)
            }
            Body::DocUnsubscribe { file } => {
                if let Some(hosted) = self.rooms.lock().await.get_mut(room) {
                    hosted.docs.unsubscribe(peer, &file);
                }
                self.unload_idle(db, room, now).await;
                (FrameOutcome::Accepted, Vec::new())
            }
            _ => (
                FrameOutcome::Rejected("This isn't available yet.".into()),
                Vec::new(),
            ),
        }
    }

    #[allow(clippy::too_many_arguments)]
    async fn doc_open(
        &self,
        db: &Db,
        room: &str,
        actor: &Actor,
        peer: &PeerId,
        file: FileId,
        state_vector: &[u8],
        now: i64,
    ) -> (FrameOutcome, Vec<OwnerDocEvent>) {
        let closed = |reason| {
            (
                FrameOutcome::Reply(vec![(
                    peer.clone(),
                    Body::DocClosed {
                        file: file.clone(),
                        reason,
                    },
                )]),
                Vec::new(),
            )
        };
        let path = match self
            .doc_path(room, actor, FileRequest::Read(file.clone()))
            .await
        {
            Ok(path) => path,
            Err(_) => return closed(DocClosedReason::Unavailable), // unknown, hidden, not allowed: indistinguishable
        };
        let activated = match self.ensure_doc(db, room, &file, &path, now).await {
            Ok(activated) => activated,
            Err(reason) => return closed(reason),
        };
        let mut rooms = self.rooms.lock().await;
        let Some(hosted) = rooms.get_mut(room) else {
            return closed(DocClosedReason::Unavailable);
        };
        match hosted.docs.subscribe(peer, &file, state_vector) {
            Ok(sync) => {
                let owner = activated
                    .map(|path| OwnerDocEvent::Active {
                        file: file.clone(),
                        path,
                    })
                    .into_iter()
                    .collect();
                (FrameOutcome::Reply(vec![(peer.clone(), sync)]), owner)
            }
            Err(err) => (FrameOutcome::Rejected(err.to_string()), Vec::new()),
        }
    }

    /// The Owner's editor changed a followed document. Returns the messages for the participants.
    pub async fn owner_doc_update(
        &self,
        db: &Db,
        room: &str,
        file: &FileId,
        update: Vec<u8>,
        now: i64,
    ) -> Result<Vec<(PeerId, Body)>, String> {
        let host = Actor::Host(self.identity(db).await?.peer_id());
        self.doc_path(room, &host, FileRequest::Write(file.clone()))
            .await?;
        let change = {
            let mut rooms = self.rooms.lock().await;
            let hosted = rooms.get_mut(room).ok_or("The room isn't loaded.")?;
            hosted
                .docs
                .update(
                    Origin::Owner,
                    file,
                    MessageId::random().map_err(|e| e.to_string())?,
                    update,
                )
                .map_err(|e| e.to_string())?
        };
        self.persist_change(db, room, &change, now).await?;
        Ok(change.send)
    }

    /// The whole document as one update (the Owner's editor starts following it from this).
    pub async fn owner_doc_state(&self, room: &str, file: &FileId) -> Option<Vec<u8>> {
        self.rooms
            .lock()
            .await
            .get(room)
            .and_then(|h| h.docs.full_state(file))
    }

    pub async fn owner_doc_bind(&self, db: &Db, room: &str, file: &FileId, bound: bool, now: i64) {
        if let Some(hosted) = self.rooms.lock().await.get_mut(room) {
            hosted.docs.set_owner_bound(file, bound);
        }
        if !bound {
            self.unload_idle(db, room, now).await;
        }
    }

    /// A participant left: it follows no document any more; unused documents are unloaded.
    pub async fn doc_peer_left(&self, db: &Db, room: &str, peer: &PeerId, now: i64) {
        if let Some(hosted) = self.rooms.lock().await.get_mut(room) {
            hosted.docs.peer_left(peer);
        }
        self.unload_idle(db, room, now).await;
    }

    async fn unload_idle(&self, db: &Db, room: &str, now: i64) {
        let mut rooms = self.rooms.lock().await;
        let Some(hosted) = rooms.get_mut(room) else {
            return;
        };
        for (file, state, sv, covers) in hosted.docs.unload_idle() {
            if let Err(err) = crdt::save_snapshot(
                db.pool(),
                hosted.row_id,
                file.as_str(),
                &state,
                &sv,
                covers,
                now,
            )
            .await
            {
                tracing::warn!(%err, "a document snapshot couldn't be stored; recovery replays more updates");
            }
        }
    }

    /// Hosting resumed (after a restart or a crash): documents whose stored state holds accepted changes the file on disk
    /// doesn't have yet — the file is as it was when they last matched — are loaded now and handed to the Owner's
    /// editor (`Active`, as when a participant opens one), so the Owner sees and saves them instead of editing the older
    /// text from disk (which, saved first, would count as an outside edit and drop them). Documents that match their
    /// file are left unloaded.
    pub async fn docs_recover(&self, db: &Db, room: &str, now: i64) -> Vec<OwnerDocEvent> {
        let Some(row_id) = self.rooms.lock().await.get(room).map(|h| h.row_id) else {
            return Vec::new();
        };
        let (Ok(files), Ok(host)) = (
            crdt::baseline_files(db.pool(), row_id).await,
            self.identity(db).await.map(|i| Actor::Host(i.peer_id())),
        ) else {
            return Vec::new();
        };
        let mut events = Vec::new();
        for file in files.iter().filter_map(|f| FileId::parse(f).ok()) {
            let Ok(path) = self
                .doc_path(room, &host, FileRequest::Read(file.clone()))
                .await
            else {
                continue; // no longer shared
            };
            let Ok(Some(path)) = self.ensure_doc(db, room, &file, &path, now).await else {
                continue; // already loaded (someone has it open), or can't be read
            };
            let owned = path.clone();
            let disk = tauri::async_runtime::spawn_blocking(move || disk_text(&owned))
                .await
                .ok()
                .and_then(Result::ok)
                .flatten()
                .map(|(text, _)| text);
            let mut rooms = self.rooms.lock().await;
            let Some(hosted) = rooms.get_mut(room) else {
                break;
            };
            if disk.is_some() && hosted.docs.text(&file) != disk {
                events.push(OwnerDocEvent::Active { file, path });
            } else {
                hosted.docs.discard(&file); // nothing to recover: stays in storage only
            }
        }
        events
    }

    /// After the shared folder was re-read: deleted documents close; a document whose file now holds exactly its text
    /// (the Owner saved) records that as its baseline; one the Owner's editor doesn't follow takes a different text
    /// from disk as an Owner change (with the editor following it, the editor's own file sync does that). Returns the
    /// participant messages and the Owner editor events.
    pub async fn docs_after_share(
        &self,
        db: &Db,
        room: &str,
        removed: &[FileId],
        now: i64,
    ) -> (Vec<(PeerId, Body)>, Vec<OwnerDocEvent>) {
        let (mut send, mut owner) = (Vec::new(), Vec::new());
        let loaded: Vec<(FileId, bool)> = {
            let mut rooms = self.rooms.lock().await;
            let Some(hosted) = rooms.get_mut(room) else {
                return (send, owner);
            };
            for file in removed {
                if hosted.docs.is_loaded(file) {
                    owner.push(OwnerDocEvent::Closed { file: file.clone() });
                }
                send.extend(hosted.docs.deleted(file));
            }
            hosted
                .docs
                .loaded_files()
                .into_iter()
                .map(|f| {
                    let bound = hosted.docs.owner_bound(&f);
                    (f, bound)
                })
                .collect()
        };
        let Ok(host) = self.identity(db).await.map(|i| Actor::Host(i.peer_id())) else {
            return (send, owner);
        };
        for (file, bound) in loaded {
            let Ok(path) = self
                .doc_path(room, &host, FileRequest::Read(file.clone()))
                .await
            else {
                continue;
            };
            let Ok(Ok(Some((text, sha)))) =
                tauri::async_runtime::spawn_blocking(move || disk_text(&path)).await
            else {
                continue;
            };
            let (row_id, same) = {
                let rooms = self.rooms.lock().await;
                let Some(hosted) = rooms.get(room) else {
                    continue;
                };
                (
                    hosted.row_id,
                    hosted.docs.text(&file).as_deref() == Some(text.as_str()),
                )
            };
            if same || !bound {
                let _ = crdt::set_baseline(db.pool(), row_id, file.as_str(), &sha, now).await;
            }
            if same || bound {
                continue;
            }
            let change = {
                let mut rooms = self.rooms.lock().await;
                rooms
                    .get_mut(room)
                    .and_then(|h| h.docs.set_text(&file, &text).ok().flatten())
            };
            if let Some(change) = change {
                if self.persist_change(db, room, &change, now).await.is_ok() {
                    send.extend(change.send);
                }
            }
        }
        (send, owner)
    }

    /// Whether each connected member may change files now (sent to them as `Access`).
    pub async fn access_list(&self, room: &str) -> Vec<(PeerId, bool)> {
        let rooms = self.rooms.lock().await;
        let Some(hosted) = rooms.get(room) else {
            return Vec::new();
        };
        let authority = &hosted.authority;
        authority
            .room()
            .members
            .keys()
            .filter_map(|peer| {
                let session = authority.session_of(peer)?.clone();
                let actor = Actor::Remote {
                    peer: peer.clone(),
                    session,
                };
                Some((
                    peer.clone(),
                    authority.authorize(&actor, &Action::WriteFile).is_ok(),
                ))
            })
            .collect()
    }
}

#[cfg(test)]
#[path = "docs_tests.rs"]
pub(super) mod tests;
