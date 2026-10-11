//! The Owner side of the two-computer check: a room (in memory: the app's database isn't used) sharing a real folder
//! with the same rules as the app — privacy floor, stable ids that follow the watcher's renames, link-safe paths,
//! consistent snapshots — hosted on the local network only (embedded rendezvous, mDNS, broadcast; no Internet relay).

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use openmind_collab::authority::{Actor, Authority, Command, JoinOutcome};
use openmind_collab::binding::owner_hello;
use openmind_collab::ids::Challenge;
use openmind_collab::manifest::{diff, entries_of, FileStat, ManifestSnapshot};
use openmind_collab::protocol::{Admission, Body, Frame, Handshake};
use openmind_collab::share::sync_table;
use openmind_collab::transfer::{FileErrorCode, Snapshot, MAX_FILE_BYTES};
use openmind_collab::workspace::WorkspaceRoot;
use openmind_collab::{
    privacy, FileId, FileTable, PeerId, PeerIdentity, RelPath, RoomUid, SessionId,
};
use openmind_collab_net::owner::{FrameOutcome, OwnerAuthority, TreeChange};
use openmind_collab_net::transport::BoxFuture;
use openmind_collab_signal::Topic;
use tokio::sync::Mutex;

struct Share {
    table: FileTable,
    manifest: ManifestSnapshot,
}

pub struct DiskAuthority {
    pub authority: Mutex<Authority>,
    room: RoomUid,
    root: WorkspaceRoot,
    share: Mutex<Share>,
}

/// Every file under `root` with its stats (links not followed; at most 50 000 entries, 32 levels).
fn walk(root: &Path) -> Vec<(RelPath, FileStat)> {
    let mut found = Vec::new();
    let mut stack: Vec<(PathBuf, String)> = vec![(root.to_path_buf(), String::new())];
    while let Some((dir, prefix)) = stack.pop() {
        let Ok(entries) = std::fs::read_dir(&dir) else {
            continue;
        };
        for entry in entries.flatten() {
            let Ok(meta) = entry.metadata() else { continue };
            let name = entry.file_name().to_string_lossy().into_owned();
            let rel = if prefix.is_empty() {
                name
            } else {
                format!("{prefix}/{name}")
            };
            let Ok(path) = RelPath::parse(&rel) else {
                continue;
            };
            if entry.file_type().is_ok_and(|t| t.is_symlink())
                || privacy::classify(&path) == privacy::Exposure::Excluded
            {
                continue;
            }
            if meta.is_dir() {
                if path.segments().count() < 32 {
                    stack.push((entry.path(), rel));
                }
            } else if found.len() < 50_000 {
                let modified_ms = meta
                    .modified()
                    .ok()
                    .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                    .map_or(0, |d| i64::try_from(d.as_millis()).unwrap_or(0));
                found.push((
                    path,
                    FileStat {
                        size: meta.len(),
                        modified_ms,
                    },
                ));
            }
        }
    }
    found
}

/// A watcher path inside `root` as a shared path.
pub fn relative(root: &Path, path: &str) -> Option<RelPath> {
    let root = root
        .to_string_lossy()
        .replace('\\', "/")
        .trim_end_matches('/')
        .to_lowercase();
    let slashed = path.replace('\\', "/");
    let rest = slashed.get(root.len() + 1..)?;
    (slashed.to_lowercase().starts_with(&format!("{root}/")))
        .then(|| RelPath::parse(rest).ok())
        .flatten()
}

impl DiskAuthority {
    pub fn new(folder: &Path) -> Result<Arc<Self>, String> {
        let host = PeerIdentity::generate().map_err(|e| e.to_string())?;
        let (authority, _) =
            Authority::create(host, "Owner", "LAN check", 1).map_err(|e| e.to_string())?;
        let room = authority.room().room_uid.clone();
        let root = WorkspaceRoot::new(folder).map_err(|e| e.to_string())?;
        let name = folder
            .file_name()
            .map_or("Workspace".into(), |n| n.to_string_lossy().into_owned());
        let manifest = ManifestSnapshot {
            version: 0,
            root: name,
            entries: Arc::default(),
        };
        let me = Arc::new(Self {
            authority: Mutex::new(authority),
            room,
            root,
            share: Mutex::new(Share {
                table: FileTable::default(),
                manifest,
            }),
        });
        Ok(me)
    }

    pub fn root(&self) -> &Path {
        self.root.path()
    }

    /// Re-reads the folder (renames from the watcher keep their ids); the delta to push, if anything changed.
    pub async fn rescan(&self, renames: &[(RelPath, RelPath)]) -> Option<TreeChange> {
        let found = walk(self.root.path());
        let paths: Vec<RelPath> = found.iter().map(|(p, _)| p.clone()).collect();
        let stats: HashMap<String, FileStat> =
            found.into_iter().map(|(p, s)| (p.key(), s)).collect();
        let mut share = self.share.lock().await;
        sync_table(&mut share.table, &paths, renames);
        let entries = entries_of(&share.table, &stats);
        let (upserts, removed) = diff(&share.manifest.entries, &entries);
        if upserts.is_empty() && removed.is_empty() {
            return None;
        }
        let base = share.manifest.version;
        share.manifest = ManifestSnapshot {
            version: base + 1,
            root: share.manifest.root.clone(),
            entries: Arc::new(entries),
        };
        Some(TreeChange::Delta {
            base,
            version: base + 1,
            upserts,
            removed,
        })
    }

    pub async fn files(&self) -> usize {
        self.share.lock().await.table.len()
    }

    pub async fn command(&self, command: Command) -> Result<(), String> {
        let mut authority = self.authority.lock().await;
        let host = Actor::Host(authority.host_identity().peer_id());
        authority
            .execute(&host, command, 10)
            .map(|_| ())
            .map_err(|e| e.to_string())
    }

    pub async fn members(&self) -> Vec<PeerId> {
        let authority = self.authority.lock().await;
        let owner = authority.room().owner.clone();
        authority
            .room()
            .members
            .keys()
            .filter(|p| **p != owner)
            .cloned()
            .collect()
    }

    fn read(path: &Path) -> Result<Snapshot, FileErrorCode> {
        let bytes = std::fs::read(path).map_err(|_| FileErrorCode::Unavailable)?;
        if bytes.len() as u64 > MAX_FILE_BYTES {
            return Err(FileErrorCode::TooLarge);
        }
        let text = bytes.starts_with(&[0xFF, 0xFE])
            || bytes.starts_with(&[0xFE, 0xFF])
            || !bytes[..bytes.len().min(8000)].contains(&0);
        Ok(Snapshot::new(bytes, text))
    }
}

impl OwnerAuthority for DiskAuthority {
    fn room_uid(&self) -> RoomUid {
        self.room.clone()
    }
    fn topic(&self) -> BoxFuture<'_, Result<Topic, String>> {
        Box::pin(
            async move { Topic::parse(&self.authority.lock().await.invite().signaling_topic()) },
        )
    }
    fn hello(
        &self,
        challenge: Challenge,
        bound: Challenge,
    ) -> BoxFuture<'_, Result<Handshake, String>> {
        Box::pin(async move {
            let a = self.authority.lock().await;
            Ok(owner_hello(
                a.host_identity(),
                a.invite(),
                &self.room,
                &challenge,
                &bound,
            ))
        })
    }
    fn admit(
        &self,
        request: Handshake,
        bound: Challenge,
    ) -> BoxFuture<'_, Result<JoinOutcome, String>> {
        Box::pin(async move {
            let mut a = self.authority.lock().await;
            let result = match &request {
                Handshake::Join(join) => a.join(join, &bound, 20),
                Handshake::Reconnect(again) => a.reconnect(again, &bound, 20),
                _ => return Err("not a join".into()),
            };
            result
                .map(|(outcome, _)| outcome)
                .map_err(|e| e.to_string())
        })
    }
    fn admit_approved(&self, peer: PeerId) -> BoxFuture<'_, Result<Admission, String>> {
        Box::pin(async move {
            self.authority
                .lock()
                .await
                .admit_approved(&peer, 21)
                .map(|(a, _)| a)
                .map_err(|e| e.to_string())
        })
    }
    fn frame(&self, actor: Actor, frame: Frame) -> BoxFuture<'_, FrameOutcome> {
        Box::pin(async move {
            match frame.body {
                Body::Command { command } => {
                    match self.authority.lock().await.execute(&actor, command, 22) {
                        Ok(_) => FrameOutcome::Accepted,
                        Err(err) => FrameOutcome::Rejected(err.to_string()),
                    }
                }
                _ => FrameOutcome::Rejected("not used by this check".into()),
            }
        })
    }
    fn disconnected(&self, peer: PeerId, session: SessionId, reason: String) -> BoxFuture<'_, ()> {
        Box::pin(async move {
            let _ = self
                .authority
                .lock()
                .await
                .disconnect(&peer, &session, &reason, 23);
        })
    }
    fn manifest(&self, actor: Actor) -> BoxFuture<'_, Result<ManifestSnapshot, String>> {
        Box::pin(async move {
            self.authority
                .lock()
                .await
                .authorize(&actor, &openmind_collab::Action::ReadFile)
                .map_err(|d| d.to_string())?;
            Ok(self.share.lock().await.manifest.clone())
        })
    }
    fn open_file(
        &self,
        actor: Actor,
        file: FileId,
    ) -> BoxFuture<'_, Result<Snapshot, FileErrorCode>> {
        Box::pin(async move {
            if self
                .authority
                .lock()
                .await
                .authorize(&actor, &openmind_collab::Action::ReadFile)
                .is_err()
            {
                return Err(FileErrorCode::Unavailable);
            }
            let path = {
                let share = self.share.lock().await;
                let entry = share.table.get(&file).ok_or(FileErrorCode::Unavailable)?;
                if !privacy::is_shareable(&entry.path) {
                    return Err(FileErrorCode::Unavailable);
                }
                self.root
                    .resolve(&entry.path)
                    .map_err(|_| FileErrorCode::Unavailable)?
            };
            tokio::task::spawn_blocking(move || Self::read(&path))
                .await
                .unwrap_or(Err(FileErrorCode::Failed))
        })
    }
}
