//! Sharing a hosted room's folder against a real machine database and real temporary workspaces: what the manifest
//! lists (ignore files, the privacy floor), stable ids across refreshes/renames/restarts, deletion and recreation,
//! and every way a file request must answer "unavailable".

use std::path::{Path, PathBuf};

use openmind_collab::authority::JoinOutcome;
use openmind_collab::manifest::ManifestSnapshot;
use openmind_collab::protocol::Handshake;
use openmind_collab::transfer::{sha256_hex, FileErrorCode, MAX_FILE_BYTES};
use openmind_collab::{Actor, FileId, JoinRequest, PeerIdentity, RelPath, RoomCode};
use openmind_collab_net::owner::TreeChange;
use openmind_db::Db;

use super::super::{CollabRuntime, NewHostedRoom};
use super::read_snapshot;

fn block<F: std::future::Future>(f: F) -> F::Output {
    tauri::async_runtime::block_on(f)
}

struct World {
    _dir: tempfile::TempDir,
    db: Db,
    runtime: CollabRuntime,
    ws: PathBuf,
    room: String,
    code: String,
}

fn write(ws: &Path, rel: &str, text: &str) {
    let path = ws.join(rel);
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).expect("mkdir");
    }
    std::fs::write(path, text).expect("write");
}

fn world_with(files: &[(&str, &str)]) -> World {
    let dir = tempfile::tempdir().expect("tempdir");
    let db = block(Db::connect(&dir.path().join("openmind-studio.db"))).expect("connect");
    let ws = dir.path().join("My Project");
    std::fs::create_dir_all(&ws).expect("mkdir");
    for (rel, text) in files {
        write(&ws, rel, text);
    }
    let runtime = CollabRuntime::default();
    let path = ws.to_string_lossy().into_owned();
    let new = NewHostedRoom {
        name: "Room",
        display_name: "Owner",
        workspace_path: &path,
        workspace_name: "My Project",
    };
    let created = block(runtime.create_room(&db, &new, 100)).expect("create");
    World {
        _dir: dir,
        db,
        runtime,
        ws,
        room: created.room_uid,
        code: created.code,
    }
}

impl World {
    fn refresh(&self, renames: &[(&str, &str)]) -> Option<TreeChange> {
        let renames = renames.iter().map(|(a, b)| (rel(a), rel(b))).collect();
        block(
            self.runtime
                .refresh_share(&self.db, &self.room, renames, 200),
        )
        .expect("refresh")
    }

    fn host(&self) -> Actor {
        Actor::Host(
            block(self.runtime.identity(&self.db))
                .expect("identity")
                .peer_id(),
        )
    }

    /// A participant admitted through the same path a network join takes (default role: viewer).
    fn viewer(&self) -> Actor {
        let student = PeerIdentity::generate().expect("identity");
        let code = RoomCode::parse(&self.code).expect("code");
        let bound = openmind_collab::Authority::new_challenge().expect("challenge");
        let uid = openmind_collab::RoomUid::parse(&self.room).expect("uid");
        let request = Handshake::Join(JoinRequest::create(
            &student, &code, &uid, &bound, "Student",
        ));
        match block(
            self.runtime
                .admit(&self.db, &self.room, request, bound, 150),
        )
        .expect("admit")
        {
            JoinOutcome::Admitted(admission) => Actor::Remote {
                peer: student.peer_id(),
                session: admission.session,
            },
            other => panic!("not admitted: {other:?}"),
        }
    }

    fn manifest(&self, actor: Actor) -> ManifestSnapshot {
        block(self.runtime.manifest(&self.db, &self.room, actor, 200)).expect("manifest")
    }

    fn paths(&self) -> Vec<String> {
        let mut all: Vec<String> = self
            .manifest(self.host())
            .entries
            .values()
            .map(|e| e.path.to_string())
            .collect();
        all.sort();
        all
    }

    fn id(&self, path: &str) -> FileId {
        self.manifest(self.host())
            .entries
            .values()
            .find(|e| e.path.as_str() == path)
            .map(|e| e.id.clone())
            .unwrap_or_else(|| panic!("{path} is not shared"))
    }

    fn open(&self, actor: Actor, file: FileId) -> Result<Vec<u8>, FileErrorCode> {
        block(self.runtime.open_file(&self.room, actor, file)).map(|s| s.bytes.to_vec())
    }
}

fn rel(text: &str) -> RelPath {
    RelPath::parse(text).expect("path")
}

#[test]
fn the_manifest_honours_ignore_files_and_never_lists_secrets() {
    let w = world_with(&[
        ("src/main.ts", "main"),
        ("src/util/a.ts", "a"),
        (".gitignore", "logs/\n*.tmp\n"),
        (".openmindignore", "private/\n"),
        ("logs/app.log", "x"),
        ("cache.tmp", "x"),
        ("private/notes.md", "x"),
        ("node_modules/pkg/index.js", "x"),
        (".git/config", "x"),
        (".env", "SECRET=1"),
        (".env.local", "SECRET=1"),
        (".env.example", "SECRET="),
        ("keys/id_rsa", "x"),
        ("certs/site.pem", "x"),
        (".github/workflows/ci.yml", "on: push"),
        ("README.md", "readme"),
    ]);
    w.refresh(&[]);
    assert_eq!(
        w.paths(),
        [
            ".github",
            ".github/workflows",
            ".github/workflows/ci.yml",
            ".gitignore",
            ".openmindignore",
            "README.md",
            "src",
            "src/main.ts",
            "src/util",
            "src/util/a.ts",
        ]
    );
}

#[test]
fn the_manifest_never_names_the_owners_folder() {
    let w = world_with(&[("src/main.ts", "main")]);
    let manifest = w.manifest(w.viewer());
    assert_eq!(manifest.root, "My Project");
    let encoded =
        serde_json::to_string(&manifest.entries.values().collect::<Vec<_>>()).expect("json");
    let absolute = w.ws.to_string_lossy().replace('\\', "/");
    assert!(
        !encoded.contains(&absolute) && !encoded.contains(&*w.ws.to_string_lossy()),
        "{encoded}"
    );
    assert!(
        !encoded.contains(":/") && !encoded.contains(":\\\\"),
        "no drive letters: {encoded}"
    );
}

#[test]
fn ids_are_stable_follow_renames_survive_restarts_and_die_with_their_file() {
    let w = world_with(&[("src/a.ts", "a"), ("src/b.ts", "b")]);
    assert!(w.refresh(&[]).is_none(), "the first read is not a change");
    let a = w.id("src/a.ts");
    let src = w.id("src");
    assert!(w.refresh(&[]).is_none(), "nothing changed");
    assert_eq!(w.id("src/a.ts"), a);

    std::fs::rename(w.ws.join("src"), w.ws.join("app")).expect("rename");
    let change = w.refresh(&[("src", "app")]).expect("a delta");
    let TreeChange::Delta {
        removed, upserts, ..
    } = change
    else {
        panic!("expected a delta")
    };
    assert!(removed.is_empty(), "a reported rename keeps ids");
    assert!(upserts
        .iter()
        .any(|e| e.id == a && e.path.as_str() == "app/a.ts"));
    assert_eq!((w.id("app/a.ts"), w.id("app")), (a.clone(), src));

    // A restart: a fresh runtime on the same database keeps the stored ids.
    let restarted = CollabRuntime::default();
    let manifest = block(restarted.manifest(&w.db, &w.room, w.host(), 300)).expect("manifest");
    assert!(manifest
        .entries
        .get(&a)
        .is_some_and(|e| e.path.as_str() == "app/a.ts"));

    std::fs::remove_file(w.ws.join("app/a.ts")).expect("delete");
    let TreeChange::Delta { removed, .. } = w.refresh(&[]).expect("delta") else {
        panic!()
    };
    assert_eq!(removed, vec![a.clone()]);
    assert_eq!(
        w.open(w.host(), a.clone()),
        Err(FileErrorCode::Unavailable),
        "a deleted file's id is gone"
    );

    write(&w.ws, "app/a.ts", "again");
    w.refresh(&[]);
    assert_ne!(
        w.id("app/a.ts"),
        a,
        "a recreated file is a new collaboration file"
    );
}

#[test]
fn an_unreported_rename_is_a_delete_plus_a_create() {
    let w = world_with(&[("a.ts", "a")]);
    let a = w.id("a.ts");
    std::fs::rename(w.ws.join("a.ts"), w.ws.join("b.ts")).expect("rename");
    let TreeChange::Delta {
        removed, upserts, ..
    } = w.refresh(&[]).expect("delta")
    else {
        panic!()
    };
    assert_eq!(removed, vec![a.clone()]);
    assert!(upserts
        .iter()
        .any(|e| e.path.as_str() == "b.ts" && e.id != a));
}

#[test]
fn becoming_ignored_or_sensitive_hides_a_path_and_becoming_allowed_shows_it_again() {
    let w = world_with(&[("notes/todo.md", "t"), ("config.json", "{}")]);
    let todo = w.id("notes/todo.md");
    write(&w.ws, ".gitignore", "notes/\n");
    let TreeChange::Delta { removed, .. } = w.refresh(&[]).expect("delta") else {
        panic!()
    };
    assert!(removed.contains(&todo));
    assert!(!w.paths().iter().any(|p| p.starts_with("notes")));

    std::fs::rename(w.ws.join("config.json"), w.ws.join(".env.json")).expect("rename");
    w.refresh(&[("config.json", ".env.json")]);
    assert!(
        !w.paths().iter().any(|p| p.contains("env")),
        "renamed into a secret name: hidden"
    );

    std::fs::remove_file(w.ws.join(".gitignore")).expect("unignore");
    w.refresh(&[]);
    let back = w.id("notes/todo.md");
    assert_ne!(back, todo, "visible again, as a new collaboration file");
}

#[test]
fn a_viewer_reads_shared_files_and_everything_else_is_unavailable() {
    let w = world_with(&[("src/main.ts", "console.log(1)"), (".env", "SECRET=1")]);
    let viewer = w.viewer();
    let main = w.id("src/main.ts");
    assert_eq!(
        w.open(viewer.clone(), main.clone()).expect("read"),
        b"console.log(1)"
    );
    assert_eq!(
        w.open(viewer.clone(), FileId::random().expect("id")),
        Err(FileErrorCode::Unavailable),
        "unknown"
    );
    assert_eq!(
        w.open(viewer.clone(), w.id("src")),
        Err(FileErrorCode::Unavailable),
        "a folder has no bytes"
    );
    let stranger = Actor::Remote {
        peer: PeerIdentity::generate().expect("id").peer_id(),
        session: openmind_collab::SessionId::random().expect("s"),
    };
    assert_eq!(
        w.open(stranger, main.clone()),
        Err(FileErrorCode::Unavailable),
        "not a member"
    );
    let forged = match &viewer {
        Actor::Remote { peer, .. } => Actor::Remote {
            peer: peer.clone(),
            session: openmind_collab::SessionId::random().expect("s"),
        },
        Actor::Host(_) => unreachable!(),
    };
    assert_eq!(
        w.open(forged, main),
        Err(FileErrorCode::Unavailable),
        "another session of the same peer"
    );
}

#[test]
fn an_id_from_another_room_is_unavailable() {
    let a = world_with(&[("shared.ts", "a")]);
    let b = world_with(&[("shared.ts", "b")]);
    let id_in_a = a.id("shared.ts");
    let _ = b.id("shared.ts");
    assert_eq!(b.open(b.host(), id_in_a), Err(FileErrorCode::Unavailable));
}

#[cfg(windows)]
#[test]
fn a_folder_swapped_for_a_junction_out_of_the_workspace_is_unavailable() {
    let w = world_with(&[("linked/data.txt", "inside")]);
    let outside = w.ws.parent().expect("parent").join("outside");
    std::fs::create_dir_all(&outside).expect("mkdir");
    std::fs::write(outside.join("data.txt"), "SECRET").expect("write");
    let file = w.id("linked/data.txt");
    std::fs::remove_dir_all(w.ws.join("linked")).expect("rm");
    let made = std::process::Command::new("cmd")
        .args(["/C", "mklink", "/J"])
        .arg(w.ws.join("linked"))
        .arg(&outside)
        .output()
        .expect("mklink");
    assert!(made.status.success(), "a junction needs no rights");
    assert_eq!(
        w.open(w.host(), file),
        Err(FileErrorCode::Unavailable),
        "the stale id can't follow the junction"
    );
    w.refresh(&[]);
    assert!(
        !w.paths().iter().any(|p| p.starts_with("linked")),
        "the crawl never follows links"
    );
}

#[test]
fn a_snapshot_classifies_text_and_binary_and_refuses_oversized_files() {
    let dir = tempfile::tempdir().expect("tempdir");
    let text = dir.path().join("a.ts");
    std::fs::write(&text, "héllo").expect("write");
    let snap = read_snapshot(&text).expect("text");
    assert!(snap.text);
    assert_eq!(snap.sha256, sha256_hex("héllo".as_bytes()));
    let binary = dir.path().join("a.bin");
    std::fs::write(&binary, [0u8, 1, 2, 0, 9]).expect("write");
    assert!(!read_snapshot(&binary).expect("binary").text);
    let utf16 = dir.path().join("w.txt");
    std::fs::write(&utf16, [0xFF, 0xFE, b'h', 0, b'i', 0]).expect("write");
    assert!(
        read_snapshot(&utf16).expect("utf16").text,
        "UTF-16 with a BOM is text"
    );
    let huge = dir.path().join("huge.log");
    std::fs::File::create(&huge)
        .and_then(|f| f.set_len(MAX_FILE_BYTES + 1))
        .expect("sparse");
    assert_eq!(read_snapshot(&huge).err(), Some(FileErrorCode::TooLarge));
    let exact = dir.path().join("exact.log");
    std::fs::File::create(&exact)
        .and_then(|f| f.set_len(MAX_FILE_BYTES))
        .expect("sparse");
    assert_eq!(
        read_snapshot(&exact).expect("at the limit").bytes.len() as u64,
        MAX_FILE_BYTES
    );
    assert_eq!(
        read_snapshot(&dir.path().join("missing")).err(),
        Some(FileErrorCode::Unavailable)
    );
}

#[test]
fn a_file_rewritten_during_reads_never_yields_a_mixed_version() {
    let dir = tempfile::tempdir().expect("tempdir");
    let path = dir.path().join("busy.txt");
    let a = "a".repeat(300_000);
    let b = "b".repeat(200_000);
    std::fs::write(&path, &a).expect("write");
    let stop = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
    let writer = {
        let (path, a, b, stop) = (path.clone(), a.clone(), b.clone(), stop.clone());
        std::thread::spawn(move || {
            let mut flip = false;
            while !stop.load(std::sync::atomic::Ordering::Relaxed) {
                let _ = std::fs::write(&path, if flip { &a } else { &b });
                flip = !flip;
            }
        })
    };
    let (mut whole, mut changed) = (0, 0);
    for _ in 0..200 {
        match read_snapshot(&path) {
            Ok(snapshot) => {
                let bytes = snapshot.bytes.as_slice();
                // Empty is a real state too: the instant between a rewrite's truncate and its write.
                let version = bytes == a.as_bytes() || bytes == b.as_bytes() || bytes.is_empty();
                assert!(version, "a torn read of {} bytes", bytes.len());
                assert_eq!(
                    snapshot.sha256,
                    sha256_hex(bytes),
                    "the hash describes exactly these bytes"
                );
                whole += 1;
            }
            Err(FileErrorCode::Changed) => changed += 1,
            Err(FileErrorCode::Unavailable) => {} // between the truncate and the open of a rewrite
            Err(other) => panic!("{other:?}"),
        }
    }
    stop.store(true, std::sync::atomic::Ordering::Relaxed);
    writer.join().expect("writer");
    assert!(whole + changed > 0, "{whole} whole, {changed} changed");
}
