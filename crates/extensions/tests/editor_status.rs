//! Milestone 10.3 against a real Node.js (skipped when the machine has none): `TextEditor.edit`, `workspace.applyEdit`
//! and status bar items. The test plays the application: it answers the host's `editor/*` requests the way the app
//! does (apply, then tell the host about the new text and version before replying) and records `statusBar/*`.

use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use openmind_extensions::host::{host_descriptor, resolve_host_node, HostEvents, HostStart};
use openmind_extensions::{
    vsix, ExtensionHost, ExtensionPaths, ExtensionStore, InstalledExtension,
};
use serde_json::{json, Value};

const WAIT: Duration = Duration::from_secs(20);

#[derive(Default)]
struct Recorder {
    requests: Mutex<Vec<(Value, String, Value)>>,
    notifications: Mutex<Vec<(String, Value)>>,
}

impl HostEvents for Recorder {
    fn request(&self, id: Value, method: &str, params: Value) {
        self.requests
            .lock()
            .expect("lock")
            .push((id, method.to_string(), params));
    }
    fn notification(&self, method: &str, params: Value) {
        self.notifications
            .lock()
            .expect("lock")
            .push((method.to_string(), params));
    }
    fn exited(&self, _reason: Option<String>) {}
}

impl Recorder {
    fn named(&self, name: &str) -> Vec<Value> {
        self.notifications
            .lock()
            .expect("lock")
            .iter()
            .filter(|(method, _)| method == name)
            .map(|(_, params)| params.clone())
            .collect()
    }

    fn wait_for(&self, what: &str, condition: impl Fn(&Recorder) -> bool) {
        let started = Instant::now();
        while started.elapsed() < WAIT {
            if condition(self) {
                return;
            }
            std::thread::sleep(Duration::from_millis(20));
        }
        panic!("timed out waiting for {what}");
    }
}

struct Fixture {
    _dir: tempfile::TempDir,
    paths: ExtensionPaths,
    store: ExtensionStore,
    events: Arc<Recorder>,
}

fn setup() -> Fixture {
    let dir = tempfile::tempdir().expect("tempdir");
    let paths = ExtensionPaths::new(&dir.path().join("Open Mind").join("extensions"));
    paths.ensure().expect("layout");
    let store = ExtensionStore::new(paths.clone());
    Fixture {
        _dir: dir,
        paths,
        store,
        events: Arc::new(Recorder::default()),
    }
}

fn install(fixture: &Fixture, name: &str) -> InstalledExtension {
    let fixtures = Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures");
    let package = fixture.paths.cache.join(format!("{name}.vsix"));
    vsix::pack(&fixtures.join(name), &package).expect("pack");
    fixture.store.install(&package, false).expect("install")
}

fn file_in_workspace(fixture: &Fixture) -> PathBuf {
    fixture.paths.root.join("My Site").join("a.txt")
}

/// Starts the host with one document open and shown in the active editor.
fn start(
    fixture: &Fixture,
    extension: &InstalledExtension,
    text: &str,
    selection: [u32; 4],
) -> Option<ExtensionHost> {
    let node = resolve_host_node(&[], std::env::var_os("PATH"), true).ok()?;
    let host = ExtensionHost::start(
        &fixture.paths,
        HostStart {
            node,
            path_prepend: Vec::new(),
            vars: Vec::new(),
        },
        fixture.events.clone(),
    )
    .expect("host starts");
    let file = file_in_workspace(fixture).to_string_lossy().into_owned();
    host.request(
        "host/init",
        json!({
            "extensions": [host_descriptor(&fixture.paths, extension, Some("test"))],
            "configuration": {},
            "workspaceFolders": [{ "path": fixture.paths.root.join("My Site"), "name": "My Site" }],
            "documents": [{ "path": file, "languageId": "plaintext", "version": 1, "text": text, "isDirty": false }],
            "activeEditor": {
                "path": file,
                "selections": [{ "anchorLine": selection[0], "anchorColumn": selection[1], "activeLine": selection[2], "activeColumn": selection[3] }],
                "tabSize": 4,
                "insertSpaces": true
            },
        }),
        WAIT,
    )
    .expect("init");
    host.request("host/activate", json!({ "id": extension.id }), WAIT)
        .expect("activate");
    Some(host)
}

/// Runs a command while answering the host's requests like the application would.
fn run_serving(
    host: &ExtensionHost,
    events: &Recorder,
    command: &str,
    answer: impl Fn(&ExtensionHost, &str, &Value) -> Value,
) -> Value {
    std::thread::scope(|scope| {
        let call = scope.spawn(|| {
            host.request(
                "host/executeCommand",
                json!({ "command": command, "args": [] }),
                WAIT,
            )
        });
        let started = Instant::now();
        while !call.is_finished() && started.elapsed() < WAIT {
            let pending: Vec<_> = events.requests.lock().expect("lock").drain(..).collect();
            for (id, method, params) in pending {
                let result = answer(host, &method, &params);
                host.respond(&id, Ok(result)).expect("respond");
            }
            std::thread::sleep(Duration::from_millis(10));
        }
        call.join()
            .expect("thread")
            .unwrap_or_else(|err| panic!("{command}: {err}"))
    })
}

/// The application's side of an edit: report the changed text and version, then say it was applied.
fn app_applies(host: &ExtensionHost, file: &str, new_text: &str, version: u32) -> Value {
    host.notify(
        "host/documentChanged",
        json!({ "path": file, "languageId": "plaintext", "version": version, "text": new_text, "isDirty": true }),
    )
    .expect("notify");
    json!({ "applied": true })
}

#[test]
fn a_selection_is_replaced_and_the_document_reports_its_new_version_and_dirty_state() {
    let fixture = setup();
    let extension = install(&fixture, "editor-edit-basic");
    let Some(host) = start(
        &fixture,
        &extension,
        "hello world\nsecond line",
        [0, 0, 0, 5],
    ) else {
        eprintln!("no Node.js on this machine: skipped");
        return;
    };
    let file = file_in_workspace(&fixture).to_string_lossy().into_owned();
    let seen = Mutex::new(Vec::new());
    let result = run_serving(
        &host,
        &fixture.events,
        "sampleEdit.transform",
        |host, method, params| {
            seen.lock()
                .expect("lock")
                .push((method.to_string(), params.clone()));
            assert_eq!(method, "editor/applyEdits");
            app_applies(host, &file, "HELLO world\nsecond line", 2)
        },
    );
    assert_eq!(result, json!(true));
    let seen = seen.into_inner().expect("lock");
    assert_eq!(seen.len(), 1);
    assert_eq!(seen[0].1["version"], json!(1));
    assert_eq!(
        seen[0].1["edits"],
        json!([{ "startLine": 0, "startColumn": 0, "endLine": 0, "endColumn": 5, "text": "HELLO" }])
    );
    fixture.events.wait_for("the result message", |events| {
        events.named("ui/showMessage").iter().any(|m| {
            m["message"]
                .as_str()
                .is_some_and(|t| t.contains("applied (version 1 -> 2, dirty=true)"))
        })
    });
    host.stop();
}

#[test]
fn with_no_selection_the_text_is_inserted_at_the_cursor_and_applyedit_edits_an_open_document() {
    let fixture = setup();
    let extension = install(&fixture, "editor-edit-basic");
    let Some(host) = start(
        &fixture,
        &extension,
        "hello world\nsecond line",
        [1, 3, 1, 3],
    ) else {
        eprintln!("no Node.js on this machine: skipped");
        return;
    };
    let file = file_in_workspace(&fixture).to_string_lossy().into_owned();
    let seen = Mutex::new(Vec::new());
    let result = run_serving(
        &host,
        &fixture.events,
        "sampleEdit.transform",
        |host, method, params| {
            seen.lock()
                .expect("lock")
                .push((method.to_string(), params.clone()));
            app_applies(host, &file, "hello world\nsec[inserted]ond line", 2)
        },
    );
    assert_eq!(result, json!(true));
    assert_eq!(
        seen.lock().expect("lock")[0].1["edits"],
        json!([{ "startLine": 1, "startColumn": 3, "endLine": 1, "endColumn": 3, "text": "[inserted]" }])
    );

    // workspace.applyEdit: one open file, all edits in a single request (needs the workspaceWrite permission).
    let workspace_seen = Mutex::new(Vec::new());
    let ok = run_serving(
        &host,
        &fixture.events,
        "sampleEdit.workspaceEdit",
        |host, method, params| {
            workspace_seen
                .lock()
                .expect("lock")
                .push((method.to_string(), params.clone()));
            app_applies(
                host,
                &file,
                "hello world\nsec[inserted]ond line\nappended by applyEdit",
                3,
            )
        },
    );
    assert_eq!(ok, json!(true));
    let workspace_seen = workspace_seen.into_inner().expect("lock");
    assert_eq!(workspace_seen[0].0, "editor/applyWorkspaceEdit");
    assert_eq!(workspace_seen[0].1["files"][0]["version"], json!(2));
    assert_eq!(
        workspace_seen[0].1["files"][0]["edits"][0]["text"],
        json!("\nappended by applyEdit")
    );
    host.stop();
}

#[test]
fn a_refused_edit_returns_false_and_overlapping_edits_are_rejected_before_anything_is_sent() {
    let fixture = setup();
    let basic = install(&fixture, "editor-edit-basic");
    let Some(host) = start(&fixture, &basic, "hello world", [0, 0, 0, 5]) else {
        eprintln!("no Node.js on this machine: skipped");
        return;
    };
    // The app says no (a preview, a stale version...): the extension gets false and the reason is logged.
    let result = run_serving(
        &host,
        &fixture.events,
        "sampleEdit.transform",
        |_host, _method, _params| json!({ "applied": false, "reason": "the file is shown read-only (a preview)" }),
    );
    assert_eq!(result, json!(false));
    fixture.events.wait_for("the rejected message", |events| {
        events.named("ui/showMessage").iter().any(|m| {
            m["message"]
                .as_str()
                .is_some_and(|t| t.contains("REJECTED"))
        })
    });
    host.stop();

    let fixture = setup();
    let overlap = install(&fixture, "editor-edit-overlap");
    let Some(host) = start(&fixture, &overlap, "abcdef", [0, 0, 0, 0]) else {
        return;
    };
    let sent = Mutex::new(0);
    let result = run_serving(
        &host,
        &fixture.events,
        "sampleOverlap.run",
        |_host, _method, _params| {
            *sent.lock().expect("lock") += 1;
            json!({ "applied": true })
        },
    );
    let text = result.as_str().expect("text");
    assert!(
        text.contains("rejected: Overlapping ranges are not allowed!"),
        "{text}"
    );
    assert!(text.contains("buffer unchanged=true"), "{text}");
    assert_eq!(*sent.lock().expect("lock"), 0, "nothing reaches the app");
    host.stop();
}

#[test]
fn status_bar_items_are_created_updated_and_removed_with_their_extension() {
    let fixture = setup();
    let extension = install(&fixture, "statusbar-basic");
    let Some(host) = start(&fixture, &extension, "x", [0, 0, 0, 0]) else {
        eprintln!("no Node.js on this machine: skipped");
        return;
    };
    fixture.events.wait_for("both items", |events| {
        events.named("statusBar/set").len() >= 2
    });
    let sets = fixture.events.named("statusBar/set");
    let left = sets
        .iter()
        .find(|s| s["alignment"] == json!("left"))
        .expect("left");
    let right = sets
        .iter()
        .find(|s| s["alignment"] == json!("right"))
        .expect("right");
    assert_eq!(left["extension"], json!(extension.id));
    assert!(left["id"]
        .as_str()
        .expect("id")
        .starts_with(&format!("{}#", extension.id)));
    assert_eq!(left["priority"], json!(100));
    assert_eq!(left["visible"], json!(true));
    assert_eq!(left["text"], json!("$(rocket) Sample Status"));
    assert_eq!(
        left["command"],
        json!({ "command": "sampleStatus.clicked", "args": [] })
    );
    assert_eq!(
        right["background"],
        json!("statusBarItem.warningBackground")
    );
    assert_eq!(right["priority"], json!(50));

    // A click runs the command in the host, which updates the item's text.
    let clicked = run_serving(
        &host,
        &fixture.events,
        "sampleStatus.clicked",
        |_h, _m, _p| json!(null),
    );
    assert_eq!(clicked, json!(null));
    fixture.events.wait_for("the updated text", |events| {
        events
            .named("statusBar/set")
            .iter()
            .any(|s| s["text"] == json!("$(rocket) Clicked 1"))
    });

    // Deactivating disposes both items.
    host.request("host/deactivate", json!({ "id": extension.id }), WAIT)
        .expect("deactivate");
    fixture.events.wait_for("both disposed", |events| {
        events.named("statusBar/dispose").len() >= 2
    });
    host.stop();
}

#[test]
fn a_disposed_status_bar_item_can_no_longer_be_updated() {
    let fixture = setup();
    let extension = install(&fixture, "statusbar-dispose");
    let Some(host) = start(&fixture, &extension, "x", [0, 0, 0, 0]) else {
        eprintln!("no Node.js on this machine: skipped");
        return;
    };
    let result = run_serving(
        &host,
        &fixture.events,
        "sampleStatusDispose.cycle",
        |_h, _m, _p| json!(null),
    );
    assert_eq!(result, json!("disposed"));
    fixture.events.wait_for("dispose", |events| {
        !events.named("statusBar/dispose").is_empty()
    });
    std::thread::sleep(Duration::from_millis(200));
    let visibility: Vec<Value> = fixture
        .events
        .named("statusBar/set")
        .iter()
        .map(|s| s["visible"].clone())
        .collect();
    assert_eq!(visibility, vec![json!(true), json!(false), json!(true)]);
    assert!(fixture
        .events
        .named("statusBar/set")
        .iter()
        .all(|s| s["text"] != json!("updated after dispose")));
    host.stop();
}

#[test]
fn apis_that_stay_unsupported_still_fail_with_the_clear_message() {
    let fixture = setup();
    let extension = install(&fixture, "unsupported-api-still-clear");
    let Some(host) = start(&fixture, &extension, "x", [0, 0, 0, 0]) else {
        eprintln!("no Node.js on this machine: skipped");
        return;
    };
    let result = run_serving(
        &host,
        &fixture.events,
        "sampleStillUnsupported.run",
        |_h, _m, _p| json!(null),
    );
    let lines: Vec<String> = result
        .as_array()
        .expect("list")
        .iter()
        .map(|v| v.as_str().unwrap_or_default().to_string())
        .collect();
    // Implemented since: input boxes, decorations, debug source URIs (they now fail only for their own reasons).
    for line in ["inputBox: allowed", "decorations: allowed"] {
        assert!(lines.contains(&line.to_string()), "{line} not in {lines:?}");
    }
    assert!(
        lines
            .iter()
            .any(|l| l.starts_with("debug: ") && !l.contains("not supported")),
        "{lines:?}"
    );
    for (label, api) in [
        (
            "notebook",
            "notebooks.registerNotebookCellStatusBarItemProvider",
        ),
        ("createFile", "WorkspaceEdit.createFile"),
    ] {
        let expected =
            format!("{label}: VS Code API '{api}' is not supported by OpenMind Studio yet.");
        assert!(lines.contains(&expected), "{expected} not in {lines:?}");
    }
    host.stop();
}
