//! The extension host against a real Node.js (skipped when the machine has none) and the five sample
//! extensions in `tests/fixtures`, installed through real `.vsix` files into a folder with a space in it.

use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use openmind_extensions::host::{host_descriptor, resolve_host_node, HostEvents, HostStart};
use openmind_extensions::Permission;
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
    let extension = install(&fixture, "command-basic");
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
    let extension = install(&fixture, "configuration-basic");
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
    let bad = install(&fixture, "bad-activation");
    let good = install(&fixture, "command-basic");
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
        r#"{"name":"probe","version":"1.0.0","publisher":"t","main":"./main.js","openmindPermissions":["commands"]}"#,
    )
    .expect("manifest");
    std::fs::write(
        folder.join("main.js"),
        "const vscode = require('vscode');\nexports.activate = () => { try { vscode.debug.asDebugSourceUri({ sourceReference: 1 }); } catch (e) { globalThis.probeMessage = e.message; }\n vscode.commands.registerCommand('probe.message', () => globalThis.probeMessage); };",
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
        json!("VS Code API 'debug.asDebugSourceUri' is not supported by OpenMind Studio yet.")
    );
    host.stop();
}

#[test]
fn stopping_ends_the_process_and_reports_an_orderly_exit() {
    let fixture = setup();
    let extension = install(&fixture, "command-basic");
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
    let language = install(&fixture, "language-basic");
    let theme = install(&fixture, "theme-basic");
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

#[test]
fn an_ai_provider_extension_installs_as_data_and_its_contribution_moves_with_enable_disable() {
    let fixture = setup();
    let extension = install(&fixture, "ai-provider-basic");
    assert!(extension.runtime_requirement.is_none(), "no code, no host");
    let providers = &extension.manifest.contributes.ai_providers;
    assert_eq!(providers.len(), 2);
    assert_eq!(providers[0].kind, "openai-compatible");
    assert_eq!(providers[0].default_model.as_deref(), Some("sample-model"));
    assert_eq!(providers[1].kind, "local");
    assert!(extension
        .points
        .iter()
        .any(|point| point.point == "aiProviders" && point.count == 2));
    // The contribution is part of what the listing reports only while the extension is enabled.
    fixture
        .store
        .set_enabled(&extension.id, false)
        .expect("disable");
    let listed = fixture.store.list();
    let entry = listed
        .extensions
        .iter()
        .find(|e| e.id == extension.id)
        .expect("still listed");
    assert!(!entry.enabled);
    fixture
        .store
        .set_enabled(&extension.id, true)
        .expect("enable");
    assert!(fixture.store.list().extensions[0].enabled);
}

// ---- Milestone 10.1: the regression pack (permissions, cleanup, duplicates, throwing commands) ------------------------

fn run(host: &ExtensionHost, id: &str) {
    host.request("host/activate", json!({ "id": id }), WAIT)
        .unwrap_or_else(|err| panic!("activating {id}: {err}"));
}

fn call(host: &ExtensionHost, command: &str) -> Result<Value, String> {
    host.request(
        "host/executeCommand",
        json!({ "command": command, "args": [] }),
        WAIT,
    )
    .map_err(|err| err.to_string())
}

/// An extension made on the spot (`main.js` = `code`) and installed like any other.
fn install_inline(
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

#[test]
fn a_throwing_command_reports_its_error_and_the_host_and_extension_survive() {
    let fixture = setup();
    let extension = install(&fixture, "command-throws");
    let Some(host) = start(&fixture, &[&extension], json!({})) else {
        return;
    };
    run(&host, &extension.id);
    let err = call(&host, "sampleThrows.run").expect_err("throws");
    assert!(err.contains("boom from the command"), "{err}");
    assert!(host.is_alive());
    // Still registered and still failing the same way: nothing was torn down.
    assert!(call(&host, "sampleThrows.run").is_err());
    assert!(host
        .log()
        .read()
        .contains("Command 'sampleThrows.run' failed"));
    host.stop();
}

#[test]
fn an_unsupported_api_names_itself_and_is_logged_against_the_extension() {
    let fixture = setup();
    let extension = install(&fixture, "unsupported-api");
    let Some(host) = start(&fixture, &[&extension], json!({})) else {
        return;
    };
    run(&host, &extension.id);
    let err = call(&host, "sampleUnsupported.run").expect_err("unsupported");
    let message = "VS Code API 'debug.asDebugSourceUri' is not supported by OpenMind Studio yet.";
    assert!(err.contains(message), "{err}");
    let log = host.log().read();
    assert!(
        log.contains(&format!("[{}] error: {message}", extension.id)),
        "{log}"
    );
    assert!(host.is_alive());
    host.stop();
}

#[test]
fn an_extension_cannot_take_over_a_command_another_extension_owns() {
    let fixture = setup();
    let owner = install(&fixture, "command-basic");
    let duplicate = install(&fixture, "duplicate-command");
    let Some(host) = start(&fixture, &[&owner, &duplicate], json!({})) else {
        return;
    };
    run(&host, &owner.id);
    run(&host, &duplicate.id);
    let refused = call(&host, "sampleDuplicate.error").expect("error text");
    let refused = refused.as_str().unwrap_or_default();
    assert!(
        refused.contains("already registered by openmind-samples.sample-command")
            && refused.contains("can't replace another extension's command"),
        "{refused}"
    );
    let own = call(&host, "sampleDuplicate.selfError").expect("own");
    assert!(own
        .as_str()
        .unwrap_or_default()
        .contains("already registered by this extension"));
    // The owner's command is untouched.
    assert_eq!(
        call(&host, "sampleCommand.hello").expect("hello"),
        json!("hello")
    );
    // The listing says who keeps the shared command.
    let listing = fixture.store.list();
    let warned = listing
        .extensions
        .iter()
        .find(|e| e.id == duplicate.id)
        .expect("listed");
    assert!(
        warned
            .warnings
            .iter()
            .any(|w| w.contains("sampleCommand.hello")),
        "{:?}",
        warned.warnings
    );
    host.stop();
}

#[test]
fn privileged_apis_are_denied_without_their_permission_and_own_storage_is_free() {
    let fixture = setup();
    let extension = install(&fixture, "permission-denied");
    let Some(host) = start(&fixture, &[&extension], json!({})) else {
        return;
    };
    run(&host, &extension.id);
    let results = call(&host, "samplePermission.run").expect("ran");
    let lines: Vec<&str> = results
        .as_array()
        .expect("list")
        .iter()
        .filter_map(Value::as_str)
        .collect();
    let expected = [
        ("child_process", "processExecution"),
        ("http", "network"),
        ("fetch", "network"),
        ("fs outside", "filesystemOutsideWorkspace"),
        ("fs write", "filesystemOutsideWorkspace"),
        ("terminal", "terminal"),
        ("openExternal", "network"),
        ("settings", "settings"),
    ];
    for (label, permission) in expected {
        let line = lines
            .iter()
            .find(|line| line.starts_with(&format!("{label}: ")))
            .unwrap_or_else(|| panic!("{label} in {lines:?}"));
        assert_eq!(
            *line,
            format!("{label}: Permission '{permission}' is required for this extension API.")
        );
    }
    assert_eq!(
        call(&host, "samplePermission.own").expect("own"),
        json!("ok")
    );
    host.stop();
}

#[test]
fn accepted_permissions_open_exactly_that_api() {
    let fixture = setup();
    let extension = install_inline(
        &fixture,
        "allowed",
        r#","openmindPermissions":["processExecution","workspaceRead","commands"]"#,
        "const vscode = require('vscode');
         exports.activate = (c) => c.subscriptions.push(
           vscode.commands.registerCommand('allowed.run', async () => {
             const out = require('child_process').execFileSync(process.execPath, ['-v']).toString().trim();
             let network = 'allowed';
             try { require('http'); } catch (e) { network = e.message; }
             let read = 'allowed';
             try { await vscode.workspace.openTextDocument(process.execPath); } catch (e) { read = e.message; }
             return { node: out.startsWith('v'), network, read };
           }));",
    );
    assert_eq!(
        extension.permissions.accepted,
        vec![
            Permission::WorkspaceRead,
            Permission::Commands,
            Permission::ProcessExecution
        ]
    );
    let Some(host) = start(&fixture, &[&extension], json!({})) else {
        return;
    };
    run(&host, &extension.id);
    let result = call(&host, "allowed.run").expect("ran");
    assert_eq!(result["node"], json!(true));
    assert_eq!(
        result["network"],
        json!("Permission 'network' is required for this extension API.")
    );
    assert_eq!(
        result["read"],
        json!("Permission 'filesystemOutsideWorkspace' is required for this extension API.")
    );
    host.stop();
}

#[test]
fn an_extension_installed_before_permissions_existed_only_gets_inferred_ones() {
    let fixture = setup();
    let extension = install_inline(
        &fixture,
        "legacy",
        r#","openmindPermissions":["network"]"#,
        "exports.activate = () => {};",
    );
    std::fs::remove_file(
        extension
            .path
            .join(openmind_extensions::permissions::ACCEPTED_FILE),
    )
    .expect("remove");
    let again = fixture.store.find(&extension.id).expect("found");
    assert!(
        again.permissions.accepted.is_empty(),
        "{:?}",
        again.permissions
    );
    assert_eq!(again.permissions.requested, vec![Permission::Network]);
}

#[test]
fn deactivating_disposes_what_the_extension_forgot_to_and_a_closed_channel_stays_silent() {
    let fixture = setup();
    let extension = install_inline(
        &fixture,
        "cleanup",
        "",
        "const vscode = require('vscode');
         let channel;
         exports.activate = (c) => {
           channel = vscode.window.createOutputChannel('Lifecycle');
           channel.appendLine('one');
           // Neither is in context.subscriptions: the host must still clean them up.
           vscode.workspace.onDidChangeConfiguration(() => console.log('listener fired'));
           vscode.commands.registerCommand('cleanup.close', () => { channel.dispose(); channel.appendLine('two'); return 'closed'; });
           const d = new vscode.Disposable(() => { globalThis.disposed = (globalThis.disposed || 0) + 1; });
           d.dispose(); d.dispose();
           vscode.commands.registerCommand('cleanup.count', () => globalThis.disposed);
         };
         exports.deactivate = () => console.log('deactivate ran');",
    );
    // This extension asks for settings/commands nothing: give it what its code uses.
    let _ = &extension;
    let Some(host) = start(&fixture, &[&extension], json!({})) else {
        return;
    };
    // No permissions were requested and none are inferred, so registering fails: fix the manifest by asking.
    let err = host
        .request("host/activate", json!({ "id": extension.id }), WAIT)
        .expect_err("needs commands");
    assert!(
        err.to_string()
            .contains("Permission 'settings' is required"),
        "{err}"
    );
    host.stop();

    let fixture = setup();
    let extension = install_inline(
        &fixture,
        "cleanup",
        r#","openmindPermissions":["commands","settings"]"#,
        "const vscode = require('vscode');
         let channel;
         exports.activate = (c) => {
           channel = vscode.window.createOutputChannel('Lifecycle');
           channel.appendLine('one');
           vscode.workspace.onDidChangeConfiguration(() => console.log('listener fired'));
           vscode.commands.registerCommand('cleanup.close', () => { channel.dispose(); channel.appendLine('two'); return 'closed'; });
           const d = new vscode.Disposable(() => { globalThis.disposed = (globalThis.disposed || 0) + 1; });
           d.dispose(); d.dispose();
           vscode.commands.registerCommand('cleanup.count', () => globalThis.disposed);
         };
         exports.deactivate = () => console.log('deactivate ran');",
    );
    let Some(host) = start(&fixture, &[&extension], json!({})) else {
        return;
    };
    run(&host, &extension.id);
    assert_eq!(
        call(&host, "cleanup.count").expect("count"),
        json!(1),
        "a Disposable runs its callback once"
    );
    host.notify(
        "host/configurationChanged",
        json!({"values": {}, "changed": ["a.b"]}),
    )
    .expect("notify");
    assert_eq!(call(&host, "cleanup.count").expect("barrier"), json!(1));
    assert_eq!(host.log().read().matches("listener fired").count(), 1);
    assert_eq!(
        call(&host, "cleanup.close").expect("close"),
        json!("closed")
    );
    host.request("host/deactivate", json!({"id": extension.id}), WAIT)
        .expect("deactivate");
    host.notify(
        "host/configurationChanged",
        json!({"values": {}, "changed": ["a.b"]}),
    )
    .expect("notify");
    // A round trip after the notification, so it has been handled.
    assert!(
        call(&host, "cleanup.count").is_err(),
        "its commands went with it"
    );
    let log = host.log().read();
    assert_eq!(
        log.matches("listener fired").count(),
        1,
        "the listener was removed on deactivate: {log}"
    );
    assert!(log.contains("Lifecycle: one"));
    assert!(
        !log.contains("Lifecycle: two"),
        "a closed channel writes nothing: {log}"
    );
    assert!(log.contains("deactivate ran"));
    // It can be activated again in the same session.
    run(&host, &extension.id);
    assert_eq!(call(&host, "cleanup.count").expect("again"), json!(2));
    host.stop();
}

#[test]
fn process_exit_is_not_available_to_extensions() {
    let fixture = setup();
    let extension = install_inline(
        &fixture,
        "quitter",
        r#","openmindPermissions":["commands"]"#,
        "const vscode = require('vscode');
         exports.activate = (c) => c.subscriptions.push(vscode.commands.registerCommand('quitter.run', () => process.exit(1)));",
    );
    let Some(host) = start(&fixture, &[&extension], json!({})) else {
        return;
    };
    run(&host, &extension.id);
    let err = call(&host, "quitter.run").expect_err("refused");
    assert!(err.contains("process.exit() is not available"), "{err}");
    assert!(host.is_alive());
    host.stop();
}

#[test]
fn every_sample_installs_disables_enables_and_uninstalls_cleanly() {
    let fixture = setup();
    for name in [
        "command-basic",
        "command-throws",
        "configuration-basic",
        "language-basic",
        "snippets-basic",
        "theme-basic",
        "bad-activation",
        "unsupported-api",
        "duplicate-command",
        "permission-denied",
        "startup-star",
        "editor-edit-basic",
        "editor-edit-overlap",
        "statusbar-basic",
        "statusbar-dispose",
        "unsupported-api-still-clear",
        "ai-provider-basic",
        "webview-panel-basic",
        "webview-panel-message",
        "webview-local-resource",
        "webview-blocked-remote",
        "webview-dispose",
        "webview-unsupported-api-still-clear",
        "webview-state-counter",
        "webview-path-tricks",
    ] {
        let extension = install(&fixture, name);
        let id = extension.id.clone();
        assert!(
            fixture
                .store
                .set_enabled(&id, false)
                .expect("disable")
                .path
                .starts_with(&fixture.paths.disabled),
            "{name}"
        );
        assert!(!fixture.store.find(&id).expect("found").enabled);
        assert!(
            fixture
                .store
                .set_enabled(&id, true)
                .expect("enable")
                .path
                .starts_with(&fixture.paths.installed),
            "{name}"
        );
        let path = fixture.store.find(&id).expect("found").path;
        fixture.store.uninstall(&id).expect("uninstall");
        assert!(!path.exists(), "{name} left files behind");
    }
    assert!(fixture.store.list().extensions.is_empty());
    assert!(fixture.store.list().broken.is_empty());
}

