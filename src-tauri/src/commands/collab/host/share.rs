//! Sharing a hosted room's folder (Milestone 24, phase 5): the manifest participants browse and the file snapshots
//! they fetch.
//!
//! - **What is shared**: the search index's crawl (`openmind_search::index::crawl` — `.gitignore`, `.openmindignore`,
//!   the always-excluded folders, links never followed; hidden files included so `.github/` or `.eslintrc` are
//!   visible) filtered by the collaboration privacy floor in `openmind_collab::share` (secrets, `.env*`, keys never).
//! - **Ids**: the stored `collab_files` table, kept in step by `openmind_collab::share::sync_table` (ids survive
//!   renames the watcher reported; a deleted path's id is gone for good; a recreated path gets a new id).
//! - **Reading a file**: authorized and path-checked by `SharedWorkspace::authorize` (session, `file.read`, id lookup,
//!   privacy, containment, no link or junction), then read whole *outside* the room lock. The read is confirmed by a
//!   second pass that must find the same bytes (and the same size and modification time); a file that changed
//!   meanwhile is read again (up to three times, then "changed"), so the snapshot — and its hash — is one version.

use std::collections::HashMap;
use std::path::Path;
use std::sync::atomic::AtomicBool;
use std::sync::Arc;

use openmind_collab::authz::Action;
use openmind_collab::fsauth::{FileRequest, SharedWorkspace};
use openmind_collab::manifest::{diff, entries_of, FileStat, ManifestSnapshot};
use openmind_collab::share::sync_table;
use openmind_collab::transfer::{FileErrorCode, Snapshot, MAX_FILE_BYTES};
use openmind_collab::{Actor, FileId, FileKind, FileTable, RelPath};
use openmind_collab_net::owner::TreeChange;
use openmind_db::collab::{self as repo, files, CollabFileRow};
use openmind_db::Db;

use super::{CollabRuntime, Outcome};

pub(super) struct ShareState {
    pub(super) shared: SharedWorkspace,
    manifest: ManifestSnapshot,
}

/// What the crawl found: shareable-looking files with their stats (the privacy floor is applied by the table sync).
fn crawl(root: &Path) -> Result<Vec<(RelPath, FileStat)>, String> {
    let settings = openmind_search::index::settings::IndexSettings {
        use_gitignore: true,
        index_hidden: true,
        exclude: Vec::new(),
        ..Default::default()
    };
    let mut found = Vec::new();
    openmind_search::index::crawl::crawl(root, &settings, &AtomicBool::new(false), &mut |entry| {
        // Names a shared path can't have (`:` streams, reserved names ...) are simply not shared.
        if let Ok(path) = RelPath::parse(&entry.rel) {
            found.push((
                path,
                FileStat {
                    size: entry.size,
                    modified_ms: entry.mtime_ms,
                },
            ));
        }
    })
    .map_err(|err| err.to_string())?;
    Ok(found)
}

fn stat(path: &Path) -> Option<(u64, Option<std::time::SystemTime>)> {
    std::fs::metadata(path)
        .ok()
        .map(|m| (m.len(), m.modified().ok()))
}

fn read_whole(path: &Path) -> Result<Vec<u8>, FileErrorCode> {
    use std::io::Read;
    let file = std::fs::File::open(path).map_err(|_| FileErrorCode::Unavailable)?;
    let mut bytes = Vec::new();
    file.take(MAX_FILE_BYTES + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| FileErrorCode::Unavailable)?;
    if bytes.len() as u64 > MAX_FILE_BYTES {
        return Err(FileErrorCode::TooLarge);
    }
    Ok(bytes)
}

/// Whether the file holds exactly `bytes` now (read in pieces: no second whole copy in memory).
fn still_matches(path: &Path, bytes: &[u8]) -> bool {
    use std::io::Read;
    let Ok(mut file) = std::fs::File::open(path) else {
        return false;
    };
    let mut piece = vec![0u8; 64 * 1024];
    let mut offset = 0;
    loop {
        let n = match file.read(&mut piece) {
            Ok(n) => n,
            Err(_) => return false,
        };
        if n == 0 {
            return offset == bytes.len();
        }
        if bytes.get(offset..offset + n) != piece.get(..n) {
            return false;
        }
        offset += n;
    }
}

/// Text unless it looks binary; UTF-16 with a byte-order mark is text (its NULs are half of every character).
fn is_text(bytes: &[u8]) -> bool {
    bytes.starts_with(&[0xFF, 0xFE])
        || bytes.starts_with(&[0xFE, 0xFF])
        || !openmind_fs::looks_binary(&bytes[..bytes.len().min(8000)])
}

/// Reads one consistent version of a file (see the module documentation). Size and modification time alone can't
/// prove that on Windows (a path's metadata can lag behind a writer's open handle), so the first read is confirmed
/// by a second one that must find exactly the same bytes; a file that differs is read again, three times at most.
pub(super) fn read_snapshot(path: &Path) -> Result<Snapshot, FileErrorCode> {
    for _ in 0..3 {
        let before = stat(path).ok_or(FileErrorCode::Unavailable)?;
        if before.0 > MAX_FILE_BYTES {
            return Err(FileErrorCode::TooLarge);
        }
        let bytes = read_whole(path)?;
        if stat(path) == Some(before)
            && bytes.len() as u64 == before.0
            && still_matches(path, &bytes)
        {
            let text = is_text(&bytes);
            return Ok(Snapshot::new(bytes, text));
        }
    }
    Err(FileErrorCode::Changed)
}

async fn load_table(db: &Db, row_id: i64) -> Result<FileTable, String> {
    let mut table = FileTable::default();
    for row in files::list(db.pool(), row_id)
        .await
        .map_err(|e| e.to_string())?
    {
        let parsed = (
            openmind_collab::FileId::parse(&row.file_id),
            RelPath::parse(&row.rel_path),
            FileKind::parse(&row.kind),
        );
        if let (Ok(id), Ok(path), Ok(kind)) = parsed {
            // A damaged or duplicate row is dropped; the next sync gives its path a fresh id.
            let _ = table.restore(id, path, kind);
        }
    }
    Ok(table)
}

async fn persist(
    db: &Db,
    row_id: i64,
    table: &FileTable,
    written: &[FileId],
    removed: &[FileId],
) -> Result<(), String> {
    let mut tx = repo::begin(db).await.map_err(|e| e.to_string())?;
    // Moved rows are deleted first and inserted again: updating them one by one could briefly give two rows the
    // same path (a swap, a case-only rename) and trip the table's unique path.
    for id in removed.iter().chain(written) {
        files::delete(&mut *tx, row_id, id.as_str())
            .await
            .map_err(|e| e.to_string())?;
    }
    for id in written {
        if let Some(entry) = table.get(id) {
            let row = CollabFileRow {
                file_id: id.to_string(),
                rel_path: entry.path.to_string(),
                kind: entry.kind.as_str().into(),
            };
            files::upsert(&mut *tx, row_id, &row, &entry.path.key())
                .await
                .map_err(|e| e.to_string())?;
        }
    }
    repo::commit(tx).await.map_err(|e| e.to_string())
}

impl CollabRuntime {
    /// Re-reads the shared folder of a hosted room and returns the change to push (`None` when nothing changed or
    /// this was the first read). `renames` are the watcher's (from, to) pairs, so ids follow moved files.
    pub async fn refresh_share(
        &self,
        db: &Db,
        room_uid: &str,
        renames: Vec<(RelPath, RelPath)>,
        now: i64,
    ) -> Result<Option<TreeChange>, String> {
        let _serial = self.share_lock.lock().await;
        // Loads the room if needed; its shared folder comes from the stored row.
        self.with_room(db, room_uid, now, |_| Ok((Outcome::default(), ())))
            .await?;
        let root = self
            .workspace_of(room_uid)
            .await
            .ok_or("This room has no shared folder.")?;
        let crawl_root = root.clone();
        let found = tauri::async_runtime::spawn_blocking(move || crawl(Path::new(&crawl_root)))
            .await
            .map_err(|e| e.to_string())??;
        let paths: Vec<RelPath> = found.iter().map(|(p, _)| p.clone()).collect();
        let stats: HashMap<String, FileStat> = found.iter().map(|(p, s)| (p.key(), *s)).collect();
        let mut rooms = self.rooms.lock().await;
        let hosted = rooms
            .get_mut(room_uid)
            .ok_or("The room couldn't be loaded.")?;
        let first = hosted.share.is_none();
        if first {
            let table = load_table(db, hosted.row_id).await?;
            let shared =
                SharedWorkspace::new(Path::new(&root), table).map_err(|e| e.to_string())?;
            let manifest = ManifestSnapshot {
                version: 0,
                root: folder_name(&root),
                entries: Arc::default(),
            };
            hosted.share = Some(ShareState { shared, manifest });
        }
        let row_id = hosted.row_id;
        let Some(share) = hosted.share.as_mut() else {
            return Ok(None);
        };
        let changes = sync_table(share.shared.files_mut(), &paths, &renames);
        persist(
            db,
            row_id,
            share.shared.files(),
            &changes.written,
            &changes.removed,
        )
        .await?;
        let entries = entries_of(share.shared.files(), &stats);
        let (upserts, removed) = diff(&share.manifest.entries, &entries);
        if !first && upserts.is_empty() && removed.is_empty() {
            return Ok(None);
        }
        let base = share.manifest.version;
        share.manifest = ManifestSnapshot {
            version: base + 1,
            root: share.manifest.root.clone(),
            entries: Arc::new(entries),
        };
        Ok((!first).then_some(TreeChange::Delta {
            base,
            version: base + 1,
            upserts,
            removed,
        }))
    }

    async fn workspace_of(&self, room_uid: &str) -> Option<String> {
        self.rooms
            .lock()
            .await
            .get(room_uid)
            .and_then(|h| h.workspace_path.clone())
    }

    /// The hosted rooms whose shared folder is `folder` (compared the way Windows compares paths).
    pub async fn rooms_sharing(&self, folder: &Path) -> Vec<String> {
        let key = |p: &Path| {
            p.to_string_lossy()
                .replace('\\', "/")
                .trim_end_matches('/')
                .to_lowercase()
        };
        let wanted = key(folder);
        self.rooms
            .lock()
            .await
            .iter()
            .filter(|(_, h)| {
                h.workspace_path
                    .as_deref()
                    .is_some_and(|w| key(Path::new(w)) == wanted)
            })
            .map(|(uid, _)| uid.clone())
            .collect()
    }

    /// The current manifest, for `actor` (authorized as a read); read on first use.
    pub async fn manifest(
        &self,
        db: &Db,
        room_uid: &str,
        actor: Actor,
        now: i64,
    ) -> Result<ManifestSnapshot, String> {
        self.with_room(db, room_uid, now, |a| {
            a.authorize(&actor, &Action::ReadFile)
                .map_err(|d| d.to_string())?;
            Ok((Outcome::default(), ()))
        })
        .await?;
        let ready = self
            .rooms
            .lock()
            .await
            .get(room_uid)
            .and_then(|h| h.share.as_ref())
            .map(|s| s.manifest.clone());
        if let Some(manifest) = ready {
            return Ok(manifest);
        }
        self.refresh_share(db, room_uid, Vec::new(), now).await?;
        self.rooms
            .lock()
            .await
            .get(room_uid)
            .and_then(|h| h.share.as_ref())
            .map(|s| s.manifest.clone())
            .ok_or_else(|| "The shared folder couldn't be read.".into())
    }

    /// One file's snapshot for `actor`. Every refusal reads "unavailable" (unknown, deleted, hidden, outside, link).
    pub async fn open_file(
        &self,
        room_uid: &str,
        actor: Actor,
        file: FileId,
    ) -> Result<Snapshot, FileErrorCode> {
        let path = {
            let rooms = self.rooms.lock().await;
            let hosted = rooms.get(room_uid).ok_or(FileErrorCode::Unavailable)?;
            let share = hosted.share.as_ref().ok_or(FileErrorCode::Unavailable)?;
            let authorized =
                share
                    .shared
                    .authorize(&hosted.authority, &actor, &FileRequest::Read(file));
            authorized.map_err(|_| FileErrorCode::Unavailable)?.absolute
        };
        tauri::async_runtime::spawn_blocking(move || read_snapshot(&path))
            .await
            .unwrap_or(Err(FileErrorCode::Failed))
    }
}

fn folder_name(root: &str) -> String {
    Path::new(root)
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_else(|| "Workspace".into())
}

#[cfg(test)]
#[path = "share_tests.rs"]
mod tests;
