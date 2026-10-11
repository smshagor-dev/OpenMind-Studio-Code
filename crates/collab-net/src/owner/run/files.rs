//! The Owner loop's handling of `openmind-files` messages and tree changes. Requests arrive here only after the
//! gate (validation, session, replay); the authority still authorizes each one when the task asks it for the
//! manifest or a file.

use std::time::Instant;

use openmind_collab::manifest::delta_fits;
use openmind_collab::protocol::Body;
use openmind_collab::transfer::FileErrorCode;
use openmind_collab::{Actor, FileId, TransferId};
use openmind_collab_signal::Slot;

use super::super::serve::{self, Done, MANIFEST_INTERVAL, MAX_TRANSFERS_PER_PEER, MAX_UNAVAILABLE};
use super::super::TreeChange;
use super::Hosting;

impl Hosting {
    /// Handles a files-channel message; `false` when it isn't one this layer serves (the authority gets it).
    pub(super) fn files_frame(&mut self, slot: &Slot, actor: Actor, body: &Body) -> bool {
        match body {
            Body::ManifestRequest => self.manifest_request(slot, actor),
            Body::FileRequest { file, transfer } => {
                self.file_request(slot, actor, file.clone(), transfer.clone())
            }
            Body::FileCancel { transfer } => {
                if let Some((_, task)) = self
                    .links
                    .get_mut(slot)
                    .and_then(|l| l.transfers.remove(transfer))
                {
                    task.abort();
                }
            }
            // Messages only the Owner sends: a participant sending them is misbehaving.
            Body::ManifestPage { .. }
            | Body::TreeDelta { .. }
            | Body::TreeReset { .. }
            | Body::FileMeta { .. }
            | Body::FileChunk { .. }
            | Body::FileComplete { .. }
            | Body::FileError { .. } => self.strike(slot),
            _ => return false,
        }
        true
    }

    fn strike(&mut self, slot: &Slot) {
        if let Some(link) = self.links.get_mut(slot) {
            link.strikes += 1;
            if link.strikes >= super::MAX_STRIKES {
                link.close();
            }
        }
    }

    fn manifest_request(&mut self, slot: &Slot, actor: Actor) {
        let Some(link) = self.links.get_mut(slot) else {
            return;
        };
        if link
            .last_manifest
            .is_some_and(|at| at.elapsed() < MANIFEST_INTERVAL)
        {
            return self.strike(slot);
        }
        link.last_manifest = Some(Instant::now());
        if let Some(sender) = link.sender.clone() {
            tokio::spawn(serve::serve_manifest(self.authority.clone(), actor, sender));
        }
    }

    fn file_request(&mut self, slot: &Slot, actor: Actor, file: FileId, transfer: TransferId) {
        let Some(link) = self.links.get_mut(slot) else {
            return;
        };
        let Some(sender) = link.sender.clone() else {
            return;
        };
        if link.transfers.contains_key(&transfer) {
            return self.strike(slot);
        }
        let refuse = |code| {
            let _ = sender.send(Body::FileError {
                transfer: transfer.clone(),
                code,
            });
        };
        if link.transfers.len() >= MAX_TRANSFERS_PER_PEER || !link.rate.allow() {
            return refuse(FileErrorCode::Busy);
        }
        let Some(held) = self.budget.transfer() else {
            return refuse(FileErrorCode::Busy);
        };
        let task = tokio::spawn(serve::serve_file(
            self.authority.clone(),
            actor,
            file.clone(),
            transfer.clone(),
            sender,
            self.budget.clone(),
            held,
            (slot.clone(), self.done.clone()),
        ));
        link.transfers.insert(transfer, (file, task.abort_handle()));
    }

    pub(super) fn transfer_done(&mut self, done: Done) {
        let Some(link) = self.links.get_mut(&done.slot) else {
            return;
        };
        link.transfers.remove(&done.transfer);
        if done.unavailable {
            link.unavailable += 1;
            if link.unavailable > MAX_UNAVAILABLE {
                tracing::info!(
                    "a participant kept asking for files that don't exist; disconnecting it"
                );
                link.close();
            }
        }
    }

    /// Pushes a tree change to every admitted participant; transfers of removed files stop.
    pub(super) fn tree(&mut self, change: TreeChange) {
        let (body, removed) = match change {
            TreeChange::Delta {
                base,
                version,
                upserts,
                removed,
            } => {
                if delta_fits(&upserts, &removed) {
                    let gone = removed.clone();
                    (
                        Body::TreeDelta {
                            base,
                            version,
                            upserts,
                            removed,
                        },
                        gone,
                    )
                } else {
                    (Body::TreeReset { version }, removed)
                }
            }
            TreeChange::Reset { version } => (Body::TreeReset { version }, Vec::new()),
        };
        for link in self.links.values_mut().filter(|l| l.admitted.is_some()) {
            for id in &removed {
                link.cancel_file(id);
            }
            link.send_body(body.clone());
        }
    }
}
