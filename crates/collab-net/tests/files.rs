//! Workspace sharing over real WebRTC on loopback: the manifest, chunked transfers and live tree changes.

mod common;

use std::sync::Arc;
use std::time::Duration;

use common::*;
use openmind_collab::protocol::{Body, Bytes};
use openmind_collab::transfer::{FileErrorCode, TransferError, CHUNK_BYTES};
use openmind_collab::{FileId, TransferId};
use openmind_collab_net::files::FetchError;
use openmind_collab_net::owner::TreeChange;
use openmind_collab_net::participant::ParticipantEvent;
use openmind_collab_net::remote::{self, RemoteEvent, RemoteWorkspace};
use tokio::sync::mpsc;

struct Shared {
    world: World,
    remote: Arc<RemoteWorkspace>,
    events: mpsc::UnboundedReceiver<RemoteEvent>,
}

async fn shared(files: &[(&str, Vec<u8>)]) -> Shared {
    let world = world().await;
    world.authority.put_many(files).await;
    let (_identity, participant) = join(&world).await;
    let (tx, mut events) = mpsc::unbounded_channel();
    let (remote, _task) = remote::spawn(
        participant,
        Arc::new(move |e| {
            let _ = tx.send(e);
        }),
    );
    until(&mut events, |e| matches!(e, RemoteEvent::TreeReady { .. })).await;
    Shared {
        world,
        remote,
        events,
    }
}

async fn until(
    events: &mut mpsc::UnboundedReceiver<RemoteEvent>,
    f: impl Fn(&RemoteEvent) -> bool,
) -> RemoteEvent {
    let mut seen = Vec::new();
    let found = tokio::time::timeout(WAIT, async {
        loop {
            let event = events.recv().await.expect("remote events");
            if f(&event) {
                return event;
            }
            if !matches!(event, RemoteEvent::Progress { .. }) {
                seen.push(format!("{event:?}").chars().take(200).collect::<String>());
            }
        }
    })
    .await;
    found.unwrap_or_else(|_| panic!("no matching remote event in time; saw {seen:?}"))
}

fn bytes(len: usize) -> Vec<u8> {
    (0..len).map(|i| (i * 7 % 253) as u8).collect()
}

async fn id(s: &Shared, path: &str) -> FileId {
    s.world.authority.workspace.lock().await.id(path)
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn the_manifest_arrives_in_pages_without_any_file_content() {
    let files: Vec<(String, Vec<u8>)> = (0..3000)
        .map(|i| (format!("pkg{}/m{i}/file_number_{i}.ts", i % 30), vec![1; 3]))
        .collect();
    let refs: Vec<(&str, Vec<u8>)> = files.iter().map(|(p, b)| (p.as_str(), b.clone())).collect();
    let s = shared(&refs).await;
    let (count, root) = s.remote.tree(|t| (t.entries().len(), t.root().to_string()));
    assert_eq!(count, s.world.authority.workspace.lock().await.table.len());
    assert!(count > 3000, "files and their folders");
    assert_eq!(root, "My Project");
    assert_eq!(s.remote.files().active(), 0, "nothing was downloaded");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn files_of_every_size_arrive_verified() {
    let sizes = [
        0,
        10,
        CHUNK_BYTES,
        CHUNK_BYTES + 1,
        3 * CHUNK_BYTES + 5,
        2 * 1024 * 1024,
    ];
    let files: Vec<(String, Vec<u8>)> = sizes
        .iter()
        .map(|n| (format!("f{n}.bin"), bytes(*n)))
        .collect();
    let refs: Vec<(&str, Vec<u8>)> = files.iter().map(|(p, b)| (p.as_str(), b.clone())).collect();
    let s = shared(&refs).await;
    for (path, content) in &files {
        let received = s.remote.fetch(id(&s, path).await).await.expect("fetched");
        assert_eq!(&received.bytes, content, "{path}");
        assert_eq!(
            received.sha256,
            openmind_collab::transfer::sha256_hex(content)
        );
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn unknown_corrupt_and_oversized_files_fail_cleanly_and_can_be_retried() {
    let s = shared(&[
        ("ok.ts", bytes(100)),
        ("bad.ts", bytes(CHUNK_BYTES * 2)),
        ("huge.log", bytes(10)),
    ])
    .await;
    let ghost = FileId::random().expect("id");
    assert_eq!(
        s.remote.fetch(ghost).await,
        Err(FetchError::Owner(FileErrorCode::Unavailable))
    );
    {
        let mut ws = s.world.authority.workspace.lock().await;
        ws.corrupt.insert("bad.ts".into());
        ws.too_large.insert("huge.log".into());
    }
    let bad = id(&s, "bad.ts").await;
    assert_eq!(
        s.remote.fetch(bad.clone()).await,
        Err(FetchError::Corrupt(TransferError::HashMismatch))
    );
    s.world.authority.workspace.lock().await.corrupt.clear();
    assert!(s.remote.fetch(bad).await.is_ok(), "a retry succeeds");
    assert_eq!(
        s.remote.fetch(id(&s, "huge.log").await).await,
        Err(FetchError::Owner(FileErrorCode::TooLarge))
    );
    assert_eq!(s.remote.files().active(), 0, "nothing left behind");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn concurrent_transfers_are_bounded() {
    let files: Vec<(String, Vec<u8>)> = (0..5)
        .map(|i| (format!("big{i}.dat"), bytes(1024 * 1024 + i)))
        .collect();
    let refs: Vec<(&str, Vec<u8>)> = files.iter().map(|(p, b)| (p.as_str(), b.clone())).collect();
    let s = shared(&refs).await;
    let mut ids = Vec::new();
    for (path, _) in &files {
        ids.push(id(&s, path).await);
    }
    let r = &s.remote;
    let (a, b, c, d, e) = tokio::join!(
        r.fetch(ids[0].clone()),
        r.fetch(ids[1].clone()),
        r.fetch(ids[2].clone()),
        r.fetch(ids[3].clone()),
        r.fetch(ids[4].clone())
    );
    for (result, (_, content)) in [a, b, c, d].into_iter().zip(&files) {
        assert_eq!(&result.expect("transfer").bytes, content);
    }
    assert_eq!(
        e,
        Err(FetchError::Busy),
        "a fifth at once is refused locally"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_cancelled_transfer_is_cleaned_up_and_can_be_requested_again() {
    let mut s = shared(&[("large.bin", bytes(12 * 1024 * 1024))]).await;
    let file = id(&s, "large.bin").await;
    let remote = s.remote.clone();
    let wanted = file.clone();
    let task = tokio::spawn(async move { remote.fetch(wanted).await });
    until(&mut s.events, |e| matches!(e, RemoteEvent::Progress { .. })).await;
    task.abort(); // the waiting tab went away
    let _ = task.await;
    assert_eq!(s.remote.files().active(), 0);
    assert_eq!(
        s.remote.fetch(file).await.expect("again").bytes.len(),
        12 * 1024 * 1024
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_disconnect_fails_the_transfer() {
    let mut s = shared(&[("large.bin", bytes(12 * 1024 * 1024))]).await;
    let file = id(&s, "large.bin").await;
    let remote = s.remote.clone();
    let task = tokio::spawn(async move { remote.fetch(file).await });
    until(&mut s.events, |e| matches!(e, RemoteEvent::Progress { .. })).await;
    s.remote.sender().close();
    let result = tokio::time::timeout(WAIT, task)
        .await
        .expect("in time")
        .expect("task");
    assert_eq!(result, Err(FetchError::Disconnected));
    assert_eq!(s.remote.files().active(), 0);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn tree_changes_arrive_as_deltas_and_removed_files_stop_transferring() {
    let mut s = shared(&[("a.ts", bytes(10)), ("large.bin", bytes(12 * 1024 * 1024))]).await;
    let before = s.world.authority.workspace.lock().await.snapshot();
    s.world.authority.put("src/new.ts", bytes(5)).await;
    let after = s.world.authority.workspace.lock().await.snapshot();
    let (upserts, removed) = openmind_collab::manifest::diff(&before.entries, &after.entries);
    s.world.owner.tree_changed(TreeChange::Delta {
        base: before.version,
        version: after.version,
        upserts,
        removed,
    });
    until(&mut s.events, |e| {
        matches!(e, RemoteEvent::TreeDelta { .. })
    })
    .await;
    assert!(s.remote.tree(|t| t
        .entries()
        .values()
        .any(|e| e.path.as_str() == "src/new.ts")));
    // A file deleted while it is being sent: the transfer stops with "unavailable".
    let large = id(&s, "large.bin").await;
    let remote = s.remote.clone();
    let wanted = large.clone();
    let task = tokio::spawn(async move { remote.fetch(wanted).await });
    until(&mut s.events, |e| matches!(e, RemoteEvent::Progress { .. })).await;
    let base = after.version;
    s.world.owner.tree_changed(TreeChange::Delta {
        base,
        version: base + 1,
        upserts: Vec::new(),
        removed: vec![large],
    });
    let result = tokio::time::timeout(WAIT, task)
        .await
        .expect("in time")
        .expect("task");
    assert_eq!(result, Err(FetchError::Owner(FileErrorCode::Unavailable)));
    // A reset (too much changed) makes the participant fetch the manifest again.
    s.world
        .owner
        .tree_changed(TreeChange::Reset { version: base + 2 });
    until(&mut s.events, |e| matches!(e, RemoteEvent::TreeStale)).await;
    until(&mut s.events, |e| {
        matches!(e, RemoteEvent::TreeReady { .. })
    })
    .await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn request_floods_are_throttled_and_misbehaviour_disconnects() {
    let world = world().await;
    world.authority.put("a.ts", bytes(10)).await;
    let (_identity, mut flooder) = join(&world).await;
    for _ in 0..60 {
        let request = Body::FileRequest {
            file: FileId::random().expect("id"),
            transfer: TransferId::random().expect("t"),
        };
        flooder.send(request).expect("send");
    }
    let mut busy = 0;
    let _ = tokio::time::timeout(Duration::from_secs(3), async {
        // Every event is read until the window ends (a connection report, such as its path, isn't the end).
        while let Some(event) = flooder.next_event().await {
            if let ParticipantEvent::Frame(frame) = event {
                if matches!(
                    frame.body,
                    Body::FileError {
                        code: FileErrorCode::Busy,
                        ..
                    }
                ) {
                    busy += 1;
                }
            }
        }
    })
    .await;
    assert!(busy > 0, "the rate limit answered busy");
    // Messages only the Owner may send, from a participant: the connection is closed.
    let (_other, mut rogue) = join(&world).await;
    for index in 0..10 {
        let chunk = Body::FileChunk {
            transfer: TransferId::random().expect("t"),
            index,
            data: Bytes(vec![0; 4]),
        };
        rogue.send(chunk).expect("send");
    }
    let closed = tokio::time::timeout(WAIT, async {
        loop {
            match rogue.next_event().await {
                Some(ParticipantEvent::State(state)) if state.is_finished() => return true,
                None => return true,
                _ => {}
            }
        }
    })
    .await;
    assert_eq!(closed, Ok(true));
}
