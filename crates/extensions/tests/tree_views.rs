//! Tree views against a real Node.js (skipped when the machine has none): the `tree-view` sample contributes an
//! activity bar container, and its `TreeDataProvider` is driven through `host/tree` like the app does.

use std::path::Path;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use openmind_extensions::host::{host_descriptor, resolve_host_node, HostEvents, HostStart};
use openmind_extensions::{vsix, ExtensionHost, ExtensionPaths, ExtensionStore};
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

    fn wait_for(&self, name: &str, count: usize) {
        let started = Instant::now();
        while started.elapsed() < WAIT {
            if self.named(name).len() >= count {
                return;
            }
            std::thread::sleep(Duration::from_millis(20));
        }
        panic!("timed out waiting for {count} {name}");
    }
}

fn tree(host: &ExtensionHost, op: &str, handle: Option<&str>) -> Value {
    host.request(
        "host/tree",
        json!({ "view": "sampleTasks.list", "op": op, "handle": handle }),
        WAIT,
    )
    .unwrap_or_else(|err| panic!("host/tree {op}: {err}"))
}

#[test]
fn a_tree_view_lists_expands_refreshes_and_runs_its_item_command() {
    let Ok(node) = resolve_host_node(&[], std::env::var_os("PATH"), true) else {
        eprintln!("no Node.js on this machine: skipped");
        return;
    };
    let dir = tempfile::tempdir().expect("tempdir");
    let paths = ExtensionPaths::new(&dir.path().join("Open Mind").join("extensions"));
    paths.ensure().expect("layout");
    let store = ExtensionStore::new(paths.clone());
    let fixture = Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/tree-view");
    let package = paths.cache.join("tree-view.vsix");
    vsix::pack(&fixture, &package).expect("pack");
    let extension = store.install(&package, false).expect("install");

    // What the manifest contributes: one activity bar icon with a tree and a (not supported) webview view.
    let views = &extension.manifest.contributes.views;
    assert_eq!(views.containers[0].title, "Sample Tasks");
    assert_eq!(views.containers[0].icon.as_deref(), Some("media/tasks.svg"));
    assert_eq!(views.tree_count(), 1);
    assert_eq!(views.webview_count(), 1);
    // "%sampleTasks.board%" comes from package.nls.json, as in VS Code.
    assert_eq!(views.containers[0].views[1].name, "Board");
    assert!(extension
        .activation_events
        .iter()
        .any(|event| event == "onView:sampleTasks.list"));

    let events = Arc::new(Recorder::default());
    let host = ExtensionHost::start(
        &paths,
        HostStart {
            node,
            path_prepend: Vec::new(),
            vars: Vec::new(),
        },
        events.clone(),
    )
    .expect("host starts");
    host.request(
        "host/init",
        json!({
            "extensions": [host_descriptor(&paths, &extension, Some("test"))],
            "configuration": {},
            "workspaceFolders": [],
            "documents": [],
        }),
        WAIT,
    )
    .expect("init");

    // Before activation there is no provider; opening the view (onView) activates the extension.
    assert!(host
        .request(
            "host/tree",
            json!({ "view": "sampleTasks.list", "op": "children" }),
            WAIT
        )
        .is_err());
    host.request("host/activate", json!({ "id": extension.id }), WAIT)
        .expect("activate");
    events.wait_for("views/registered", 1);
    assert_eq!(
        events.named("views/registered")[0]["view"],
        json!("sampleTasks.list")
    );
    assert_eq!(
        tree(&host, "children", None),
        json!([]),
        "empty: the app shows the welcome text"
    );

    host.request(
        "host/executeCommand",
        json!({ "command": "sampleTasks.add", "args": [] }),
        WAIT,
    )
    .expect("add");
    events.wait_for("views/changed", 1);
    events.wait_for("views/title", 1);
    assert_eq!(
        events.named("views/title")[0]["description"],
        json!("1 open")
    );

    let roots = tree(&host, "children", None);
    let task = &roots[0];
    assert_eq!(task["label"], json!("Task 1"));
    assert_eq!(task["description"], json!("2 steps"));
    assert_eq!(task["tooltip"], json!("Task: Task 1"));
    assert_eq!(task["collapsible"], json!(1));
    assert_eq!(task["icon"], json!({ "file": "media/tasks.svg" }));
    assert_eq!(task["hasCommand"], json!(true));

    let handle = task["handle"].as_str().expect("handle");
    let steps = tree(&host, "children", Some(handle));
    assert_eq!(steps[0]["label"], json!("Plan"));
    assert_eq!(steps[0]["icon"], json!({ "theme": "circle-outline" }));
    assert_eq!(steps[0]["hasCommand"], json!(false));
    assert_eq!(
        tree(&host, "children", None)[0]["handle"],
        json!(handle),
        "handles are stable"
    );

    assert_eq!(tree(&host, "click", Some(handle)), json!({ "ran": true }));
    events.wait_for("ui/showMessage", 1);
    assert_eq!(
        events.named("ui/showMessage")[0]["message"],
        json!("Opened Task 1")
    );
    assert_eq!(tree(&host, "expand", Some(handle)), json!({ "ok": true }));

    // Deactivating disposes the tree view: the app is told, and the view has no provider again.
    host.request("host/deactivate", json!({ "id": extension.id }), WAIT)
        .expect("deactivate");
    events.wait_for("views/unregistered", 1);
    assert!(host
        .request(
            "host/tree",
            json!({ "view": "sampleTasks.list", "op": "children" }),
            WAIT
        )
        .is_err());
    host.stop();
}
