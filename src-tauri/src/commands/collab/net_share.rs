//! Live tree updates for hosted rooms (Milestone 24, phase 5). The Owner's *existing* project watcher
//! (`commands::watch`) hands every `fs:changed` batch here too; nothing else watches the disk and nothing polls.
//!
//! For each room this window's folder hosts *on the network*, the batch's renames (absolute watcher paths made
//! workspace-relative) are queued and the room's share is re-read (`CollabRuntime::refresh_share`: the search
//! crawler's ignore rules, the privacy floor, ids kept across the renames); the resulting delta goes to every admitted
//! participant through `OwnerNetwork::tree_changed`. A burst of batches costs at most one read running and one
//! pending per room ([`ShareQueue`]), with the pending renames merged — so a `git checkout` of thousands of files is
//! one or two crawls, not thousands. An `overflow` batch carries no paths; the re-read still finds everything (renames
//! it couldn't report become a delete + a create, i.e. new ids).

use std::collections::HashMap;
use std::path::Path;
use std::sync::Mutex;

use openmind_collab::RelPath;
use openmind_file_watch::{ChangeBatch, ChangeKind};
use tauri::{AppHandle, Manager};

use crate::app_state::AppState;

type Renames = Vec<(RelPath, RelPath)>;

/// Per room: absent = idle; `None` = a refresh is running with nothing waiting; `Some` = more work after it.
#[derive(Default)]
pub struct ShareQueue {
    rooms: Mutex<HashMap<String, Option<Renames>>>,
}

impl ShareQueue {
    fn lock(&self) -> std::sync::MutexGuard<'_, HashMap<String, Option<Renames>>> {
        self.rooms
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }

    /// Queues work for `room`; `true` when the caller must start the room's drain task.
    pub fn push(&self, room: &str, renames: Renames) -> bool {
        let mut rooms = self.lock();
        match rooms.get_mut(room) {
            None => {
                rooms.insert(room.to_string(), Some(renames));
                true
            }
            Some(waiting) => {
                waiting.get_or_insert_with(Vec::new).extend(renames);
                false
            }
        }
    }

    /// The next work for `room`, or `None` (and the room is idle again) when there is none.
    pub fn take(&self, room: &str) -> Option<Renames> {
        let mut rooms = self.lock();
        match rooms.get_mut(room).map(Option::take) {
            Some(Some(work)) => Some(work),
            _ => {
                rooms.remove(room);
                None
            }
        }
    }
}

fn key(path: &str) -> String {
    let slashed = path.replace('\\', "/");
    let trimmed = slashed.trim_end_matches('/');
    if cfg!(windows) {
        trimmed.to_lowercase()
    } else {
        trimmed.to_string()
    }
}

/// `path` relative to `root` as a shared path, when it is inside it (the case of the root's part is not kept).
pub fn relative(root: &Path, path: &str) -> Option<RelPath> {
    let root_key = key(&root.to_string_lossy());
    let slashed = path.replace('\\', "/");
    let prefix_len = root_key.len() + 1;
    if slashed.len() <= prefix_len || !key(&slashed).starts_with(&format!("{root_key}/")) {
        return None;
    }
    RelPath::parse(slashed.get(prefix_len..)?.trim_end_matches('/')).ok()
}

/// The watcher's renames inside `root`, as shared paths.
pub fn renames_of(root: &Path, batch: &ChangeBatch) -> Renames {
    batch
        .changes
        .iter()
        .filter(|change| change.kind == ChangeKind::Renamed)
        .filter_map(|change| {
            Some((
                relative(root, change.from.as_deref()?)?,
                relative(root, &change.path)?,
            ))
        })
        .collect()
}

/// Called with every batch of a window's project watcher.
pub fn files_changed(app: &AppHandle, root: &Path, batch: &ChangeBatch) {
    if batch.changes.is_empty() && !batch.overflow {
        return;
    }
    let renames = renames_of(root, batch);
    let (app, root) = (app.clone(), root.to_path_buf());
    tauri::async_runtime::spawn(async move {
        let Some(state) = app.try_state::<AppState>() else {
            return;
        };
        for room in state.collab.rooms_sharing(&root).await {
            if state.collab.net.hosting(&room).is_some()
                && state.collab.net.share_queue.push(&room, renames.clone())
            {
                tauri::async_runtime::spawn(drain(app.clone(), room));
            }
        }
    });
}

async fn drain(app: AppHandle, room: String) {
    let Some(state) = app.try_state::<AppState>() else {
        return;
    };
    while let Some(renames) = state.collab.net.share_queue.take(&room) {
        match state
            .collab
            .refresh_share(&state.db, &room, renames, super::now_ms())
            .await
        {
            Ok(Some(change)) => {
                let removed = match &change {
                    openmind_collab_net::owner::TreeChange::Delta { removed, .. } => {
                        removed.clone()
                    }
                    openmind_collab_net::owner::TreeChange::Reset { .. } => Vec::new(),
                };
                if let Some(network) = state.collab.net.hosting(&room) {
                    network.tree_changed(change);
                }
                let (send, owner) = state
                    .collab
                    .docs_after_share(&state.db, &room, &removed, super::now_ms())
                    .await;
                super::net_docs::send_all(&app, &room, send);
                super::net_docs::owner_events(&app, &room, owner);
                for file in &removed {
                    super::net_presence::file_gone(&app, &room, file).await;
                }
                super::net_presence::paths_moved(&app, &room).await;
            }
            Ok(None) => {
                let (send, owner) = state
                    .collab
                    .docs_after_share(&state.db, &room, &[], super::now_ms())
                    .await;
                super::net_docs::send_all(&app, &room, send);
                super::net_docs::owner_events(&app, &room, owner);
            }
            Err(err) => {
                tracing::warn!(%err, "a shared folder couldn't be re-read; participants keep the last tree")
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use openmind_file_watch::FileChange;

    #[test]
    fn a_burst_runs_one_refresh_and_merges_what_arrives_meanwhile() {
        let queue = ShareQueue::default();
        let p = |s: &str| RelPath::parse(s).expect("path");
        assert!(
            queue.push("r", vec![(p("a"), p("b"))]),
            "the first push starts the drain"
        );
        assert_eq!(
            queue.take("r").map(|r| r.len()),
            Some(1),
            "the drain takes it and is running"
        );
        assert!(
            !queue.push("r", vec![(p("c"), p("d"))]),
            "a running drain picks the rest up"
        );
        assert!(!queue.push("r", Vec::new()));
        assert!(queue.push("other", Vec::new()), "rooms are independent");
        assert_eq!(
            queue.take("r").map(|r| r.len()),
            Some(1),
            "the two later pushes, merged into one read"
        );
        assert_eq!(queue.take("r"), None);
        assert!(
            queue.push("r", Vec::new()),
            "idle again: the next push starts a new drain"
        );
    }

    #[test]
    fn watcher_paths_become_shared_paths_only_inside_the_root() {
        let root = Path::new(if cfg!(windows) {
            r"C:\Work\My Project"
        } else {
            "/work/My Project"
        });
        let inside = if cfg!(windows) {
            r"c:\work\my project\src\Main.ts"
        } else {
            "/work/My Project/src/Main.ts"
        };
        assert_eq!(
            relative(root, inside).map(|p| p.to_string()),
            Some("src/Main.ts".into())
        );
        let sibling = if cfg!(windows) {
            r"C:\Work\My Project2\x.ts"
        } else {
            "/work/My Project2/x.ts"
        };
        assert_eq!(
            relative(root, sibling),
            None,
            "a sibling with the same prefix is outside"
        );
        assert_eq!(
            relative(root, &root.to_string_lossy()),
            None,
            "the root itself is not an entry"
        );
        let batch = ChangeBatch {
            changes: vec![
                FileChange {
                    path: format!("{}/b.ts", root.display()),
                    kind: ChangeKind::Renamed,
                    from: Some(format!("{}/a.ts", root.display())),
                },
                FileChange {
                    path: format!("{}/c.ts", root.display()),
                    kind: ChangeKind::Created,
                    from: None,
                },
                FileChange {
                    path: format!("{}/d.ts", root.display()),
                    kind: ChangeKind::Renamed,
                    from: Some(sibling.into()),
                },
            ],
            overflow: false,
        };
        let renames = renames_of(root, &batch);
        assert_eq!(
            renames.len(),
            1,
            "creates and moves in from outside are not renames: {renames:?}"
        );
        assert_eq!(
            (renames[0].0.as_str(), renames[0].1.as_str()),
            ("a.ts", "b.ts")
        );
    }
}
