//! The recorder (plays the application), fixture and helpers of `host.rs`.

use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use openmind_extensions::host::{host_descriptor, resolve_host_node, HostEvents, HostStart};
use openmind_extensions::{
    vsix, ExtensionHost, ExtensionPaths, ExtensionStore, InstalledExtension,
};
use serde_json::{json, Value};

pub const WAIT: Duration = Duration::from_secs(20);

#[derive(Default)]
pub struct Recorder {
    pub requests: Mutex<Vec<(Value, String, Value)>>,
    pub notifications: Mutex<Vec<(String, Value)>>,
    pub exits: Mutex<Vec<Option<String>>>,
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
    fn exited(&self, reason: Option<String>) {
        self.exits.lock().expect("lock").push(reason);
    }
}

impl Recorder {
    pub fn notifications_named(&self, name: &str) -> Vec<Value> {
        self.notifications
            .lock()
            .expect("lock")
            .iter()
            .filter(|(method, _)| method == name)
            .map(|(_, params)| params.clone())
            .collect()
    }

    pub fn wait_for(&self, what: &str, condition: impl Fn(&Recorder) -> bool) {
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

pub struct Fixture {
    pub _dir: tempfile::TempDir,
    pub paths: ExtensionPaths,
    pub store: ExtensionStore,
    pub events: Arc<Recorder>,
}

pub fn node() -> Option<openmind_lsp::node::NodeExecutable> {
    resolve_host_node(&[], std::env::var_os("PATH"), true).ok()
}

pub fn fixtures() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("tests")
        .join("fixtures")
}

pub fn setup() -> Fixture {
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

pub fn install(fixture: &Fixture, name: &str) -> InstalledExtension {
    let vsix_path = fixture.paths.cache.join(format!("{name}.vsix"));
    vsix::pack(&fixtures().join(name), &vsix_path).expect("pack");
    fixture.store.install(&vsix_path, false).expect("install")
}

pub fn descriptor(fixture: &Fixture, extension: &InstalledExtension) -> Value {
    host_descriptor(&fixture.paths, extension, Some("test"))
}

pub fn start(
    fixture: &Fixture,
    extensions: &[&InstalledExtension],
    configuration: Value,
) -> Option<ExtensionHost> {
    let node = node()?;
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
    let descriptors: Vec<Value> = extensions
        .iter()
        .map(|extension| descriptor(fixture, extension))
        .collect();
    host.request(
        "host/init",
        json!({
            "extensions": descriptors,
            "configuration": configuration,
            "workspaceFolders": [{ "path": fixture.paths.root.join("My Site"), "name": "My Site" }],
            "documents": [],
        }),
        WAIT,
    )
    .expect("init");
    Some(host)
}

pub fn run(host: &ExtensionHost, id: &str) {
    host.request("host/activate", json!({ "id": id }), WAIT)
        .unwrap_or_else(|err| panic!("activating {id}: {err}"));
}

pub fn call(host: &ExtensionHost, command: &str) -> Result<Value, String> {
    host.request(
        "host/executeCommand",
        json!({ "command": command, "args": [] }),
        WAIT,
    )
    .map_err(|err| err.to_string())
}

/// An extension made on the spot (`main.js` = `code`) and installed like any other.
pub fn install_inline(
    fixture: &Fixture,
    name: &str,
    manifest_extra: &str,
    code: &str,
) -> InstalledExtension {
    let folder = fixture.paths.cache.join(format!("inline-{name}"));
    std::fs::create_dir_all(&folder).expect("mkdir");
    std::fs::write(
        folder.join("package.json"),
        format!(r#"{{"name":"{name}","version":"1.0.0","publisher":"t","main":"./main.js"{manifest_extra}}}"#),
    )
    .expect("manifest");
    std::fs::write(folder.join("main.js"), code).expect("main");
    let vsix_path = fixture.paths.cache.join(format!("{name}.vsix"));
    vsix::pack(&folder, &vsix_path).expect("pack");
    fixture.store.install(&vsix_path, false).expect("install")
}
