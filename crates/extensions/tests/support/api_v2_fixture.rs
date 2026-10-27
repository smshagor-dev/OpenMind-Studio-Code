//! The fake application and fixture of `api_v2.rs`: answers the host's requests the way the app does and records
//! what the host asked for.

use std::collections::HashMap;
use std::path::Path;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use openmind_extensions::host::{host_descriptor, resolve_host_node, HostEvents, HostStart};
use openmind_extensions::{
    vsix, ExtensionHost, ExtensionPaths, ExtensionStore, InstalledExtension,
};
use serde_json::{json, Value};

pub const WAIT: Duration = Duration::from_secs(20);

#[derive(Default)]
pub struct App {
    pub host: Mutex<Option<Arc<ExtensionHost>>>,
    pub requests: Mutex<Vec<(String, Value)>>,
    pub notifications: Mutex<Vec<(String, Value)>>,
    pub secrets: Mutex<HashMap<(String, String), String>>,
}

impl App {
    pub fn answer(&self, method: &str, params: &Value) -> Result<Value, String> {
        let text = |key: &str| {
            params
                .get(key)
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_string()
        };
        Ok(match method {
            "terminal/create" => json!({ "pid": 4242 }),
            // As the app's bridge does: a provider document becomes an open, virtual (not saved) document.
            "workspace/openVirtualTextDocument" => json!({
                "virtual": true,
                "native": true,
                "readonly": params["readonly"].as_bool().unwrap_or(true),
                "path": text("uri"),
                "languageId": text("languageId"),
                "version": params["version"].as_i64().unwrap_or(1),
                "text": text("text"),
                "isDirty": false,
            }),
            "terminal/sendText" => json!({ "sent": true }),
            "tasks/execute" => {
                // The app tells the host a task started before it answers (so `executeTask` returns its execution).
                let handle = params["task"]["handle"].clone();
                if let Some(host) = self.host.lock().expect("lock").as_ref() {
                    let _ = host.notify("host/taskStarted", json!({ "handle": handle, "pid": 7 }));
                }
                json!({ "started": true })
            }
            "secrets/store" => {
                self.secrets
                    .lock()
                    .expect("lock")
                    .insert((text("extension"), text("key")), text("value"));
                Value::Null
            }
            "secrets/get" => json!({
                "value": self.secrets.lock().expect("lock").get(&(text("extension"), text("key"))).cloned()
            }),
            "secrets/delete" => {
                self.secrets
                    .lock()
                    .expect("lock")
                    .remove(&(text("extension"), text("key")));
                Value::Null
            }
            "workspace/findFiles" => json!(["C:/w/a.ts", "C:/w/src/b.ts"]),
            "ui/showVirtualDocument" | "ui/showTextDocument" => json!({ "ok": true }),
            "editor/applyEdits" => json!({ "applied": true }),
            _ => return Err(format!("not answered in the test: {method}")),
        })
    }

    pub fn requests_named(&self, name: &str) -> Vec<Value> {
        self.requests
            .lock()
            .expect("lock")
            .iter()
            .filter(|(method, _)| method == name)
            .map(|(_, params)| params.clone())
            .collect()
    }

    pub fn notifications_named(&self, name: &str) -> Vec<Value> {
        self.notifications
            .lock()
            .expect("lock")
            .iter()
            .filter(|(method, _)| method == name)
            .map(|(_, params)| params.clone())
            .collect()
    }

    pub fn wait_for(&self, what: &str, condition: impl Fn(&App) -> bool) {
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

impl HostEvents for App {
    fn request(&self, id: Value, method: &str, params: Value) {
        self.requests
            .lock()
            .expect("lock")
            .push((method.to_string(), params.clone()));
        let answer = self.answer(method, &params);
        if let Some(host) = self.host.lock().expect("lock").as_ref() {
            let _ = host.respond(&id, answer);
        }
    }
    fn notification(&self, method: &str, params: Value) {
        self.notifications
            .lock()
            .expect("lock")
            .push((method.to_string(), params));
    }
    fn exited(&self, _reason: Option<String>) {}
}

pub struct Fixture {
    pub _dir: tempfile::TempDir,
    pub paths: ExtensionPaths,
    pub app: Arc<App>,
    pub host: Arc<ExtensionHost>,
    pub extension: InstalledExtension,
}

pub fn setup() -> Option<Fixture> {
    let node = resolve_host_node(&[], std::env::var_os("PATH"), true).ok()?;
    let dir = tempfile::tempdir().expect("tempdir");
    let paths = ExtensionPaths::new(&dir.path().join("Open Mind").join("extensions"));
    paths.ensure().expect("layout");
    let store = ExtensionStore::new(paths.clone());
    let fixtures = Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures");
    let package = paths.cache.join("api-v2.vsix");
    vsix::pack(&fixtures.join("api-v2"), &package).expect("pack");
    let extension = store.install(&package, false).expect("install");
    let app = Arc::new(App::default());
    let host = Arc::new(
        ExtensionHost::start(
            &paths,
            HostStart {
                node,
                path_prepend: Vec::new(),
                vars: Vec::new(),
            },
            app.clone(),
        )
        .expect("host starts"),
    );
    *app.host.lock().expect("lock") = Some(host.clone());
    let workspace = paths.root.join("My Site");
    host.request(
        "host/init",
        json!({
            "extensions": [host_descriptor(&paths, &extension, Some("test"))],
            "configuration": {},
            "workspaceFolders": [{ "path": workspace, "name": "My Site" }],
            // The user trusted this folder (tasks and other code against its files need that since workspace trust).
            "isTrusted": true,
            "documents": [],
        }),
        WAIT,
    )
    .expect("init");
    host.request("host/activate", json!({ "id": extension.id }), WAIT)
        .expect("activate");
    Some(Fixture {
        _dir: dir,
        paths,
        app,
        host,
        extension,
    })
}

pub fn run(fixture: &Fixture, command: &str, args: Value) -> Value {
    fixture
        .host
        .request(
            "host/executeCommand",
            json!({ "command": command, "args": args }),
            WAIT,
        )
        .unwrap_or_else(|err| panic!("{command}: {err}"))
}
