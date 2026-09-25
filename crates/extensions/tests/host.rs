//! The extension host against a real Node.js (skipped when the machine has none) and the five sample
//! extensions in `tests/fixtures`, installed through real `.vsix` files into a folder with a space in it.

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
    exits: Mutex<Vec<Option<String>>>,
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
    fn notifications_named(&self, name: &str) -> Vec<Value> {
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

fn node() -> Option<openmind_lsp::node::NodeExecutable> {
    resolve_host_node(&[], std::env::var_os("PATH"), true).ok()
}

fn fixtures() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("tests")
        .join("fixtures")
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
    let vsix_path = fixture.paths.cache.join(format!("{name}.vsix"));
    vsix::pack(&fixtures().join(name), &vsix_path).expect("pack");
    fixture.store.install(&vsix_path, false).expect("install")
}

fn descriptor(fixture: &Fixture, extension: &InstalledExtension) -> Value {
    host_descriptor(&fixture.paths, extension, Some("test"))
}

fn start(
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

#[test]
fn the_command_extension_activates_lazily_registers_a_command_and_shows_a_message() {
    let fixture = setup();
    let extension = install(&fixture, "command");
    let Some(host) = start(&fixture, &[&extension], json!({})) else {
        eprintln!("no Node.js on this machine: skipped");
        return;
    };

    // Nothing runs until asked: the command isn't registered yet.
    let early = host.request(
        "host/executeCommand",
        json!({"command": "sampleCommand.hello"}),
        WAIT,
    );
    assert!(early.is_err());
    assert!(fixture
        .events
        .notifications_named("commands/registered")
        .is_empty());

    let activated = host
        .request(
            "host/activate",
            json!({"id": extension.id, "reason": "onCommand"}),
            WAIT,
        )
        .expect("activate");
    assert_eq!(activated["activated"], json!(true));
    let again = host
        .request("host/activate", json!({"id": extension.id}), WAIT)
        .expect("again");
    assert_eq!(
        again["activated"],
        json!(false),
        "activate runs once per session"
    );
    assert_eq!(
        fixture.events.notifications_named("commands/registered")[0]["command"],
        json!("sampleCommand.hello")
    );

    let answer = host
        .request(
            "host/executeCommand",
            json!({"command": "sampleCommand.hello", "args": []}),
            WAIT,
        )
        .expect("run");
    assert_eq!(answer, json!("hello"));
    fixture.events.wait_for("the message", |events| {
        !events.notifications_named("ui/showMessage").is_empty()
    });
    let message = &fixture.events.notifications_named("ui/showMessage")[0];
    assert_eq!(
        message["message"],
        json!("Hello from the sample command extension")
    );
    assert_eq!(message["severity"], json!("info"));

    host.request("host/deactivate", json!({"id": extension.id}), WAIT)
        .expect("deactivate");
    fixture.events.wait_for("the command to go", |events| {
        !events
            .notifications_named("commands/unregistered")
            .is_empty()
    });
    assert!(host
        .request(
            "host/executeCommand",
            json!({"command": "sampleCommand.hello"}),
            WAIT
        )
        .is_err());

    let log = host.log().read();
    assert!(
        log.contains("[openmind-samples.sample-command] Sample Command: sample-command activated"),
        "{log}"
    );
    assert!(log.contains("sample-command deactivated"), "{log}");
    host.stop();
}

#[test]
fn the_configuration_extension_reads_current_values_and_hears_changes() {
    let fixture = setup();
    let extension = install(&fixture, "configuration");
    let Some(host) = start(
        &fixture,
        &[&extension],
        json!({"sampleConfig.greeting": "Howdy", "sampleConfig.count": 3}),
    ) else {
        return;
    };
    host.request("host/activate", json!({"id": extension.id}), WAIT)
        .expect("activate");
    let first = host
        .request(
            "host/executeCommand",
            json!({"command": "sampleConfig.show"}),
            WAIT,
        )
        .expect("run");
    assert_eq!(first, json!("Howdy"));

    host.notify(
        "host/configurationChanged",
        json!({"values": {"sampleConfig.greeting": "Ahoy", "sampleConfig.count": 3}, "changed": ["sampleConfig.greeting"]}),
    )
    .expect("notify");
    fixture.events.wait_for("the change to be logged", |_| {
        host.log().read().contains("sampleConfig changed")
    });
    let second = host
        .request(
            "host/executeCommand",
            json!({"command": "sampleConfig.show"}),
            WAIT,
        )
        .expect("run");
    assert_eq!(second, json!("Ahoy"));
    host.stop();
}

#[test]
fn a_bad_extension_fails_alone_and_the_host_keeps_serving_others() {
    let fixture = setup();
    let bad = install(&fixture, "bad");
    let good = install(&fixture, "command");
    let Some(host) = start(&fixture, &[&bad, &good], json!({})) else {
        return;
    };
    let err = host
        .request("host/activate", json!({"id": bad.id}), WAIT)
        .expect_err("fails");
    assert!(
        err.to_string().contains("always fails to activate"),
        "{err}"
    );
    assert!(host.is_alive());
    assert!(host.log().read().contains("Activation failed"));

    // Nothing of the failed extension is left registered, and another one still works.
    assert!(host
        .request(
            "host/executeCommand",
            json!({"command": "sampleBad.run"}),
            WAIT
        )
        .is_err());
    host.request("host/activate", json!({"id": good.id}), WAIT)
        .expect("good activates");
    assert_eq!(
        host.request(
            "host/executeCommand",
            json!({"command": "sampleCommand.hello"}),
            WAIT
        )
        .expect("run"),
        json!("hello")
    );
    // The failed one may be tried again (its error is reported again, not swallowed).
    assert!(host
        .request("host/activate", json!({"id": bad.id}), WAIT)
        .is_err());
    host.stop();
}

#[test]
fn an_unsupported_vscode_api_fails_with_a_clear_message() {
    let fixture = setup();
    let folder = fixture.paths.cache.join("probe");
    std::fs::create_dir_all(&folder).expect("mkdir");
    std::fs::write(
        folder.join("package.json"),
        r#"{"name":"probe","version":"1.0.0","publisher":"t","main":"./main.js"}"#,
    )
    .expect("manifest");
    std::fs::write(
        folder.join("main.js"),
        "const vscode = require('vscode');\nexports.activate = () => { try { vscode.tasks.registerTaskProvider('x', {}); } catch (e) { globalThis.probeMessage = e.message; }\n vscode.commands.registerCommand('probe.message', () => globalThis.probeMessage); };",
    )
    .expect("main");
    let vsix_path = fixture.paths.cache.join("probe.vsix");
    vsix::pack(&folder, &vsix_path).expect("pack");
    let extension = fixture.store.install(&vsix_path, false).expect("install");
    let Some(host) = start(&fixture, &[&extension], json!({})) else {
        return;
    };
    host.request("host/activate", json!({"id": extension.id}), WAIT)
        .expect("activate");
    let message = host
        .request(
            "host/executeCommand",
            json!({"command": "probe.message"}),
            WAIT,
        )
        .expect("run");
    assert_eq!(
        message,
        json!("VS Code API 'tasks.registerTaskProvider' is not supported by OpenMind Studio yet.")
    );
    host.stop();
}

#[test]
fn stopping_ends_the_process_and_reports_an_orderly_exit() {
    let fixture = setup();
    let extension = install(&fixture, "command");
    let Some(host) = start(&fixture, &[&extension], json!({})) else {
        return;
    };
    host.request("host/activate", json!({"id": extension.id}), WAIT)
        .expect("activate");
    assert!(host.is_alive());
    host.stop();
    assert!(!host.is_alive());
    fixture.events.wait_for("the exit", |events| {
        !events.exits.lock().expect("lock").is_empty()
    });
    assert_eq!(
        fixture.events.exits.lock().expect("lock")[0],
        None,
        "an orderly stop has no error"
    );
    assert!(host.request("host/init", json!({}), WAIT).is_err());
    assert!(host.log().read().contains("host: stopped"));
}

#[test]
fn the_language_and_theme_extensions_install_as_data_and_need_no_host() {
    let fixture = setup();
    let language = install(&fixture, "language");
    let theme = install(&fixture, "theme");
    for extension in [&language, &theme] {
        assert!(extension.runtime_requirement.is_none(), "{}", extension.id);
        assert!(extension.points.iter().all(|point| point.count > 0));
    }
    assert_eq!(
        language.manifest.contributes.languages[0].id,
        "openmind-sample"
    );
    assert_eq!(language.manifest.contributes.snippets.len(), 1);
    assert_eq!(
        theme.manifest.contributes.themes[0].label,
        "OpenMind Sample Dark"
    );
    assert!(fixture
        .store
        .read_text(&theme.id, "themes/sample-dark.json")
        .expect("theme file")
        .contains("editor.background"));
    assert!(node().is_none() || fixture.events.exits.lock().expect("lock").is_empty());
}
