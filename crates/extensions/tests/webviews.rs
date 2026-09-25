//! Milestone 10.4 against a real Node.js (skipped when the machine has none): webview panels. The test plays the
//! application: it records the `webview/*` notifications and sends the page's messages and "closed" events back.

use std::path::Path;
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
    notifications: Mutex<Vec<(String, Value)>>,
}

impl HostEvents for Recorder {
    fn request(&self, _id: Value, _method: &str, _params: Value) {}
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

fn start(fixture: &Fixture, extension: &InstalledExtension) -> Option<ExtensionHost> {
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
    host.request(
        "host/init",
        json!({
            "extensions": [host_descriptor(&fixture.paths, extension, Some("test"))],
            "configuration": {},
            "workspaceFolders": [{ "path": fixture.paths.root.join("My Site"), "name": "My Site" }],
            "documents": [],
        }),
        WAIT,
    )
    .expect("init");
    host.request("host/activate", json!({ "id": extension.id }), WAIT)
        .expect("activate");
    Some(host)
}

fn run(host: &ExtensionHost, command: &str) -> Value {
    host.request(
        "host/executeCommand",
        json!({ "command": command, "args": [] }),
        WAIT,
    )
    .unwrap_or_else(|err| panic!("{command}: {err}"))
}

#[test]
fn a_basic_panel_is_created_with_its_title_html_and_safe_defaults() {
    let fixture = setup();
    let extension = install(&fixture, "webview-panel-basic");
    let Some(host) = start(&fixture, &extension) else {
        eprintln!("no Node.js on this machine: skipped");
        return;
    };
    assert_eq!(run(&host, "sampleWebview.basic"), json!("Basic Webview"));
    fixture
        .events
        .wait_for("html", |events| !events.named("webview/html").is_empty());
    let create = &fixture.events.named("webview/create")[0];
    assert_eq!(create["extension"], json!(extension.id));
    assert_eq!(create["viewType"], json!("sampleBasic"));
    assert_eq!(create["title"], json!("Basic Webview"));
    assert_eq!(
        create["enableScripts"],
        json!(false),
        "scripts are off by default"
    );
    assert!(create["id"]
        .as_str()
        .expect("id")
        .starts_with(&format!("{}#", extension.id)));
    // Only the extension's own folder is a resource root by default.
    assert_eq!(create["roots"].as_array().expect("roots").len(), 1);
    let html = fixture.events.named("webview/html")[0]["html"]
        .as_str()
        .expect("html")
        .to_string();
    assert!(html.contains("Hello from a webview"));
    host.stop();
}

#[test]
fn messages_go_both_ways_only_as_json_and_only_to_their_panel() {
    let fixture = setup();
    let extension = install(&fixture, "webview-panel-message");
    let Some(host) = start(&fixture, &extension) else {
        eprintln!("no Node.js on this machine: skipped");
        return;
    };
    run(&host, "sampleWebviewMessage.open");
    let create = fixture.events.named("webview/create")[0].clone();
    assert_eq!(create["enableScripts"], json!(true));
    let id = create["id"].as_str().expect("id").to_string();

    // The page's message reaches the extension, which answers through postMessage.
    host.notify(
        "host/webviewMessage",
        json!({ "id": id, "message": "{\"command\":\"ping\",\"count\":1}" }),
    )
    .expect("notify");
    fixture.events.wait_for("the reply", |events| {
        !events.named("webview/postMessage").is_empty()
    });
    let reply = &fixture.events.named("webview/postMessage")[0];
    assert_eq!(reply["id"], json!(id));
    assert_eq!(reply["extension"], json!(extension.id));
    assert_eq!(reply["message"], json!("{\"reply\":\"pong 1\"}"));

    // A message for another panel id, or one that isn't JSON, reaches nobody.
    host.notify(
        "host/webviewMessage",
        json!({ "id": "someone.else#wv-9", "message": "{\"count\":2}" }),
    )
    .expect("notify");
    host.notify(
        "host/webviewMessage",
        json!({ "id": id, "message": "not json" }),
    )
    .expect("notify");
    std::thread::sleep(Duration::from_millis(300));
    assert_eq!(fixture.events.named("webview/postMessage").len(), 1);
    host.stop();
}

#[test]
fn local_resources_are_addressed_through_as_webview_uri_and_traversal_is_refused() {
    let fixture = setup();
    let extension = install(&fixture, "webview-local-resource");
    let Some(host) = start(&fixture, &extension) else {
        eprintln!("no Node.js on this machine: skipped");
        return;
    };
    let traversal = run(&host, "sampleWebviewResource.open");
    let text = traversal.as_str().expect("text");
    assert!(
        text.starts_with("blocked: The file is outside this webview's localResourceRoots:"),
        "{text}"
    );
    fixture
        .events
        .wait_for("html", |events| !events.named("webview/html").is_empty());
    let html = fixture.events.named("webview/html")[0]["html"]
        .as_str()
        .expect("html")
        .to_string();
    assert!(
        html.contains("openmind-webview-resource://panel/"),
        "{html}"
    );
    assert!(!html.contains("file:"), "no file: address is ever produced");
    host.stop();
}

#[test]
fn remote_content_and_outside_roots_need_permissions_the_extension_does_not_have() {
    let fixture = setup();
    let extension = install(&fixture, "webview-blocked-remote");
    let Some(host) = start(&fixture, &extension) else {
        eprintln!("no Node.js on this machine: skipped");
        return;
    };
    let results = run(&host, "sampleWebviewRemote.open");
    let lines: Vec<&str> = results
        .as_array()
        .expect("list")
        .iter()
        .filter_map(Value::as_str)
        .collect();
    assert_eq!(
        lines[0],
        "roots: Permission 'filesystemOutsideWorkspace' is required for this webview resource."
    );
    assert!(
        lines[1].starts_with("asWebviewUri: The file is outside this webview's localResourceRoots"),
        "{}",
        lines[1]
    );
    // The page keeps its remote references; the application's sanitizer is what removes them.
    fixture.events.wait_for("html", |events| {
        events.named("webview/html").iter().any(|h| {
            h["html"]
                .as_str()
                .is_some_and(|t| t.contains("https://example.com"))
        })
    });
    host.stop();
}

#[test]
fn a_disposed_panel_says_so_once_and_can_no_longer_be_used() {
    let fixture = setup();
    let extension = install(&fixture, "webview-dispose");
    let Some(host) = start(&fixture, &extension) else {
        eprintln!("no Node.js on this machine: skipped");
        return;
    };
    run(&host, "sampleWebviewDispose.open");
    let id = fixture.events.named("webview/create")[0]["id"]
        .as_str()
        .expect("id")
        .to_string();
    let outcome = run(&host, "sampleWebviewDispose.close");
    assert_eq!(
        outcome,
        json!("postMessage after dispose: false; html after dispose: Webview is disposed")
    );
    assert_eq!(fixture.events.named("webview/dispose").len(), 1);
    assert_eq!(fixture.events.named("webview/dispose")[0]["id"], json!(id));

    // The user closing the tab of a live panel reaches the extension as onDidDispose, and nothing is sent back.
    run(&host, "sampleWebviewDispose.open");
    let second = fixture.events.named("webview/create")[1]["id"]
        .as_str()
        .expect("id")
        .to_string();
    host.notify("host/webviewDisposed", json!({ "id": second }))
        .expect("notify");
    std::thread::sleep(Duration::from_millis(300));
    assert_eq!(fixture.events.named("webview/dispose").len(), 1);
    let log = host.log().read();
    assert!(log.contains("onDidDispose fired"), "{log}");
    assert!(!log.contains("message after dispose"), "{log}");

    // Deactivating disposes a panel that is still open (an extension that is disabled loses its pages).
    run(&host, "sampleWebviewDispose.open");
    host.request("host/deactivate", json!({ "id": extension.id }), WAIT)
        .expect("deactivate");
    fixture
        .events
        .wait_for("the dispose on deactivate", |events| {
            events.named("webview/dispose").len() >= 2
        });
    host.stop();
}

#[test]
fn unsupported_webview_features_fail_with_the_clear_message_and_a_bad_message_is_refused() {
    let fixture = setup();
    let extension = install(&fixture, "webview-unsupported-api-still-clear");
    let Some(host) = start(&fixture, &extension) else {
        eprintln!("no Node.js on this machine: skipped");
        return;
    };
    let results = run(&host, "sampleWebviewUnsupported.run");
    let lines: Vec<String> = results
        .as_array()
        .expect("list")
        .iter()
        .map(|v| v.as_str().unwrap_or_default().to_string())
        .collect();
    for (label, api) in [
        ("commandUris", "WebviewOptions.enableCommandUris"),
        ("portMapping", "WebviewOptions.portMapping"),
        ("serializer", "window.registerWebviewPanelSerializer"),
        ("webviewView", "window.registerWebviewViewProvider"),
    ] {
        let expected =
            format!("{label}: VS Code API '{api}' is not supported by OpenMind Studio yet.");
        assert!(lines.contains(&expected), "{expected} not in {lines:?}");
    }
    assert!(
        lines
            .iter()
            .any(|l| l.starts_with("nonJson: A webview message must be JSON-serializable")),
        "{lines:?}"
    );
    host.stop();
}

#[test]
fn as_webview_uri_refuses_every_way_out_and_accepts_the_extension_own_files() {
    let fixture = setup();
    let extension = install(&fixture, "webview-path-tricks");
    let Some(host) = start(&fixture, &extension) else {
        eprintln!("no Node.js on this machine: skipped");
        return;
    };
    let results = run(&host, "sampleWebviewTricks.run");
    for name in ["parent", "unc", "uncSlashes", "http", "data", "javascript"] {
        let text = results[name].as_str().expect("text");
        assert!(text.starts_with("blocked: "), "{name}: {text}");
    }
    // A percent-encoded `..` is never decoded: it is only an odd file name inside the root, and Rust refuses the
    // read later because that file doesn't exist.
    let encoded = results["encoded"].as_str().expect("text");
    assert!(encoded.starts_with("allowed: "), "{encoded}");
    let inside = results["inside"].as_str().expect("text");
    assert!(
        inside.starts_with("allowed: openmind-webview-resource://panel/"),
        "{inside}"
    );
    host.stop();
}

#[test]
fn retain_context_is_reported_per_panel_and_a_long_title_is_passed_on_whole() {
    let fixture = setup();
    let extension = install(&fixture, "webview-state-counter");
    let Some(host) = start(&fixture, &extension) else {
        eprintln!("no Node.js on this machine: skipped");
        return;
    };
    run(&host, "sampleWebviewCounter.retained");
    run(&host, "sampleWebviewCounter.plain");
    run(&host, "sampleWebviewCounter.longTitle");
    fixture.events.wait_for("creates", |events| {
        events.named("webview/create").len() == 3
    });
    let creates = fixture.events.named("webview/create");
    assert_eq!(creates[0]["retain"], json!(true));
    assert_eq!(creates[1]["retain"], json!(false));
    assert!(creates[2]["title"].as_str().expect("title").len() > 60);
    assert_eq!(creates[0]["enableScripts"], json!(true));
    host.stop();
}
