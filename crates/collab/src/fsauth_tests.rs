//! Layer 3 against a real folder: what each role may do, and every way a malicious peer tries to reach outside.

use super::*;
use crate::authority::{Command, JoinOutcome};
use crate::authz::DenyReason;
use crate::identity::PeerIdentity;
use crate::ids::SessionId;
use crate::permission::Role;
use crate::protocol::JoinRequest;

struct World {
    _dir: tempfile::TempDir,
    authority: Authority,
    shared: SharedWorkspace,
    main: FileId,
    env: FileId,
    escape: Option<FileId>,
}

fn rel(text: &str) -> RelPath {
    RelPath::parse(text).expect("path")
}

fn world() -> World {
    let dir = tempfile::tempdir().expect("tempdir");
    let ws = dir.path().join("My Project");
    std::fs::create_dir_all(ws.join("src")).expect("mkdir");
    std::fs::write(ws.join("src/main.ts"), "let a = 1;").expect("write");
    std::fs::write(ws.join(".env"), "TOKEN=secret").expect("write");
    let outside = dir.path().join("outside");
    std::fs::create_dir_all(&outside).expect("mkdir");
    std::fs::write(outside.join("secret.txt"), "s").expect("write");
    let mut files = FileTable::default();
    files.insert(rel("src"), FileKind::Folder).expect("insert");
    let main = files
        .insert(rel("src/main.ts"), FileKind::File)
        .expect("insert");
    let env = files.insert(rel(".env"), FileKind::File).expect("insert");
    let escape = make_junction(&ws.join("escape"), &outside).then(|| {
        files
            .insert(rel("escape/secret.txt"), FileKind::File)
            .expect("insert")
    });
    let host = PeerIdentity::generate().expect("identity");
    let (authority, _) = Authority::create(host, "Owner", "Room", 1).expect("create");
    let shared = SharedWorkspace::new(&ws, files).expect("shared");
    World {
        _dir: dir,
        authority,
        shared,
        main,
        env,
        escape,
    }
}

#[cfg(windows)]
fn make_junction(link: &Path, target: &Path) -> bool {
    std::process::Command::new("cmd")
        .args(["/C", "mklink", "/J"])
        .arg(link)
        .arg(target)
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false)
}

#[cfg(unix)]
fn make_junction(link: &Path, target: &Path) -> bool {
    std::os::unix::fs::symlink(target, link).is_ok()
}

fn join(world: &mut World, role: Role) -> Actor {
    let peer = PeerIdentity::generate().expect("identity");
    let challenge = Authority::new_challenge().expect("challenge");
    let room = world.authority.room().room_uid.clone();
    let request = JoinRequest::create(&peer, world.authority.invite(), &room, &challenge, "Peer");
    let (outcome, _) = world.authority.join(&request, &challenge, 1).expect("join");
    let JoinOutcome::Admitted(admission) = outcome else {
        panic!("admitted")
    };
    let actor = Actor::Remote {
        peer: admission.peer.clone(),
        session: admission.session,
    };
    if role != Role::Viewer {
        let host = Actor::Host(world.authority.host_identity().peer_id());
        world
            .authority
            .execute(
                &host,
                Command::ChangeRole {
                    target: admission.peer,
                    role,
                },
                1,
            )
            .expect("role");
    }
    actor
}

fn denied(result: Result<Authorized, CollabError>) -> DenyReason {
    match result {
        Err(CollabError::Denied(denied)) => denied.reason,
        other => panic!("expected a denial, got {other:?}"),
    }
}

#[test]
fn a_viewer_reads_but_every_change_is_refused_before_the_disk() {
    let mut w = world();
    let viewer = join(&mut w, Role::Viewer);
    let read = w
        .shared
        .authorize(&w.authority, &viewer, &FileRequest::Read(w.main.clone()))
        .expect("read");
    assert!(read.absolute.ends_with("main.ts"));
    for request in [
        FileRequest::Write(w.main.clone()),
        FileRequest::Create {
            path: rel("src/new.ts"),
            kind: FileKind::File,
        },
        FileRequest::Rename {
            file: w.main.clone(),
            to: rel("src/renamed.ts"),
        },
        FileRequest::Delete(w.main.clone()),
    ] {
        assert!(
            matches!(
                denied(w.shared.authorize(&w.authority, &viewer, &request)),
                DenyReason::MissingPermission { .. }
            ),
            "{request:?}"
        );
    }
}

#[test]
fn an_editor_writes_creates_and_renames_but_deletes_only_when_granted() {
    let mut w = world();
    let editor = join(&mut w, Role::Editor);
    let auth = |w: &World, r: FileRequest| w.shared.authorize(&w.authority, &editor, &r);
    assert!(auth(&w, FileRequest::Write(w.main.clone())).is_ok());
    assert!(auth(
        &w,
        FileRequest::Create {
            path: rel("src/new.ts"),
            kind: FileKind::File
        }
    )
    .is_ok());
    let renamed = auth(
        &w,
        FileRequest::Rename {
            file: w.main.clone(),
            to: rel("src/app.ts"),
        },
    )
    .expect("rename");
    assert!(renamed
        .destination
        .expect("destination")
        .1
        .ends_with("app.ts"));
    assert!(matches!(
        denied(auth(&w, FileRequest::Delete(w.main.clone()))),
        DenyReason::MissingPermission { .. }
    ));
}

#[test]
fn sensitive_files_look_like_unknown_ones_and_their_names_can_not_be_created() {
    let mut w = world();
    let editor = join(&mut w, Role::Editor);
    let unknown = FileId::random().expect("id");
    for request in [FileRequest::Read(w.env.clone()), FileRequest::Read(unknown)] {
        assert_eq!(
            w.shared.authorize(&w.authority, &editor, &request),
            Err(CollabError::UnknownFile)
        );
    }
    for path in [
        ".env.local",
        "keys/server.pem",
        ".git/config",
        "node_modules/x.js",
    ] {
        let create = FileRequest::Create {
            path: rel(path),
            kind: FileKind::File,
        };
        assert!(
            matches!(
                w.shared.authorize(&w.authority, &editor, &create),
                Err(CollabError::UnsafePath(_))
            ),
            "{path}"
        );
    }
    let onto_env = FileRequest::Rename {
        file: w.main.clone(),
        to: rel(".env.production"),
    };
    assert!(matches!(
        w.shared.authorize(&w.authority, &editor, &onto_env),
        Err(CollabError::UnsafePath(_))
    ));
    let taken = FileRequest::Create {
        path: rel("SRC/Main.ts"),
        kind: FileKind::File,
    };
    assert!(matches!(
        w.shared.authorize(&w.authority, &editor, &taken),
        Err(CollabError::UnsafePath(_))
    ));
}

#[test]
fn a_link_or_junction_out_of_the_workspace_is_refused() {
    let mut w = world();
    let editor = join(&mut w, Role::Editor);
    #[cfg(windows)]
    assert!(w.escape.is_some(), "a junction needs no rights on Windows");
    let Some(escape) = w.escape.clone() else {
        return; // No junction/symlink could be made here.
    };
    assert!(matches!(
        w.shared
            .authorize(&w.authority, &editor, &FileRequest::Read(escape)),
        Err(CollabError::UnsafePath(_))
    ));
    let create = FileRequest::Create {
        path: rel("escape/new.txt"),
        kind: FileKind::File,
    };
    assert!(matches!(
        w.shared.authorize(&w.authority, &editor, &create),
        Err(CollabError::UnsafePath(_))
    ));
}

#[test]
fn stale_sessions_and_strangers_get_nothing() {
    let mut w = world();
    let editor = join(&mut w, Role::Editor);
    let replayed = Actor::Remote {
        peer: editor.peer().clone(),
        session: SessionId::random().expect("session"),
    };
    assert_eq!(
        denied(
            w.shared
                .authorize(&w.authority, &replayed, &FileRequest::Read(w.main.clone()))
        ),
        DenyReason::StaleSession
    );
    let stranger = Actor::Remote {
        peer: PeerIdentity::generate().expect("identity").peer_id(),
        session: SessionId::random().expect("session"),
    };
    assert_eq!(
        denied(
            w.shared
                .authorize(&w.authority, &stranger, &FileRequest::Read(w.main.clone()))
        ),
        DenyReason::StaleSession
    );
}

#[test]
fn a_folder_has_no_content_to_write() {
    let mut w = world();
    let editor = join(&mut w, Role::Editor);
    let src = w.shared.files().id_of(&rel("src")).cloned().expect("src");
    assert!(matches!(
        w.shared
            .authorize(&w.authority, &editor, &FileRequest::Write(src)),
        Err(CollabError::UnsafePath(_))
    ));
}
