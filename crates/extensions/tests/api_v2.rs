//! Milestone 18 against a real Node.js (skipped when the machine has none): webview views, terminals, tasks, file
//! system providers, secrets, `findFiles`, file watchers, text editor commands and formatting providers. The test plays
//! the application: it answers the host's requests the way the app does and records what the host asked for.

use std::collections::HashMap;
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
struct App {
    host: Mutex<Option<Arc<ExtensionHost>>>,
    requests: Mutex<Vec<(String, Value)>>,
    notifications: Mutex<Vec<(String, Value)>>,
    secrets: Mutex<HashMap<(String, String), String>>,
}

impl App {
    fn answer(&self, method: &str, params: &Value) -> Result<Value, String> {
        let text = |key: &str| {
            params
                .get(key)
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_string()
        };
        Ok(match method {
            "terminal/create" => json!({ "pid": 4242 }),
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

    fn requests_named(&self, name: &str) -> Vec<Value> {
        self.requests
            .lock()
            .expect("lock")
            .iter()
            .filter(|(method, _)| method == name)
            .map(|(_, params)| params.clone())
            .collect()
    }

    fn notifications_named(&self, name: &str) -> Vec<Value> {
        self.notifications
            .lock()
            .expect("lock")
            .iter()
            .filter(|(method, _)| method == name)
            .map(|(_, params)| params.clone())
            .collect()
    }

    fn wait_for(&self, what: &str, condition: impl Fn(&App) -> bool) {
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

struct Fixture {
    _dir: tempfile::TempDir,
    paths: ExtensionPaths,
    app: Arc<App>,
    host: Arc<ExtensionHost>,
    extension: InstalledExtension,
}

fn setup() -> Option<Fixture> {
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

fn run(fixture: &Fixture, command: &str, args: Value) -> Value {
    fixture
        .host
        .request(
            "host/executeCommand",
            json!({ "command": command, "args": args }),
            WAIT,
        )
        .unwrap_or_else(|err| panic!("{command}: {err}"))
}

#[test]
fn a_webview_view_resolves_only_when_shown_and_talks_both_ways() {
    let Some(fixture) = setup() else {
        return;
    };
    assert!(
        fixture.app.notifications_named("webview/create").is_empty(),
        "nothing is drawn before the view is shown"
    );
    let resolved = fixture
        .host
        .request(
            "host/resolveWebviewView",
            json!({ "view": "sampleV2.panel" }),
            WAIT,
        )
        .expect("resolve");
    let id = resolved["id"].as_str().expect("id").to_string();
    assert!(id.starts_with(&format!("{}#wvv-", fixture.extension.id)));
    let created = fixture.app.notifications_named("webview/create");
    assert_eq!(created[0]["placement"], "view");
    assert_eq!(created[0]["view"], "sampleV2.panel");
    fixture.app.wait_for("html", |app| {
        app.notifications_named("webview/html")
            .iter()
            .any(|n| n["html"].as_str().is_some_and(|h| h.contains("Board")))
    });
    // Asking again gives the same webview.
    let again = fixture
        .host
        .request(
            "host/resolveWebviewView",
            json!({ "view": "sampleV2.panel" }),
            WAIT,
        )
        .expect("again");
    assert_eq!(again["id"], json!(id));
    // A view nobody provides is simply empty.
    let none = fixture
        .host
        .request(
            "host/resolveWebviewView",
            json!({ "view": "other.view" }),
            WAIT,
        )
        .expect("none");
    assert_eq!(none["id"], Value::Null);
    fixture
        .host
        .notify(
            "host/webviewMessage",
            json!({ "id": id, "message": "{\"ping\":1}" }),
        )
        .expect("message");
    fixture.app.wait_for("pong", |app| {
        app.notifications_named("webview/postMessage")
            .iter()
            .any(|n| n["message"] == json!("{\"pong\":1}"))
    });
    // Deactivating disposes the view's webview.
    fixture
        .host
        .request(
            "host/deactivate",
            json!({ "id": fixture.extension.id }),
            WAIT,
        )
        .expect("deactivate");
    assert!(fixture
        .app
        .notifications_named("webview/dispose")
        .iter()
        .any(|n| n["id"] == json!(id)));
    fixture.host.stop();
}

#[test]
fn a_terminal_is_created_by_a_command_and_every_command_line_is_asked_for() {
    let Some(fixture) = setup() else {
        return;
    };
    assert!(
        fixture.app.requests_named("terminal/create").is_empty(),
        "no terminal at activation"
    );
    assert_eq!(
        run(&fixture, "sampleV2.openTerminal", json!([])),
        json!("Sample v2")
    );
    let created = fixture.app.requests_named("terminal/create");
    assert_eq!(created.len(), 1);
    assert_eq!(created[0]["extension"], json!(fixture.extension.id));
    assert!(created[0]["cwd"]
        .as_str()
        .expect("cwd")
        .ends_with("My Site"));
    assert_eq!(run(&fixture, "sampleV2.echo", json!([])), json!(true));
    let sent = fixture.app.requests_named("terminal/sendText");
    assert_eq!(sent[0]["text"], "echo hello from sample v2");
    assert_eq!(sent[0]["addNewLine"], true);
    let info = run(&fixture, "sampleV2.terminalInfo", json!([]));
    assert_eq!(info, json!({ "pid": 4242, "count": 1 }));
    let id = created[0]["id"].clone();
    fixture
        .host
        .notify("host/terminalClosed", json!({ "id": id, "exitCode": 0 }))
        .expect("closed");
    fixture.app.wait_for("close event", |_| true);
    let seen = run(&fixture, "sampleV2.events", json!([]));
    assert!(seen.to_string().contains("opened:Sample v2"), "{seen}");
    assert!(seen.to_string().contains("closed:Sample v2:0"), "{seen}");
    let bad = run(&fixture, "sampleV2.badTerminal", json!([]));
    assert_eq!(
        bad,
        json!("VS Code API 'TerminalOptions.shellPath' is not supported by OpenMind Studio yet.")
    );
    // Even though the extension caught the error, the use is logged against it (its details page lists it).
    let logged = fixture.app.notifications_named("log/output");
    assert!(
        logged
            .iter()
            .any(|n| n["extension"] == "openmind-samples.sample-api-v2"
                && n["text"]
                    .as_str()
                    .unwrap_or_default()
                    .contains("'TerminalOptions.shellPath' is not supported")),
        "{logged:?}"
    );
    fixture.host.stop();
}

#[test]
fn tasks_are_listed_on_request_and_run_only_through_the_app() {
    let Some(fixture) = setup() else {
        return;
    };
    let provided = fixture
        .host
        .request("host/provideTasks", json!({}), WAIT)
        .expect("provide");
    let task = &provided["tasks"][0];
    assert_eq!(task["name"], "build");
    assert_eq!(task["commandLine"], "npm run build");
    assert_eq!(task["group"], "build");
    assert_eq!(task["env"], json!({ "MODE": "ci" }));
    assert_eq!(task["problemMatchers"], json!(["$tsc"]));
    assert_eq!(task["cwdInsideFolder"], true);
    assert_eq!(run(&fixture, "sampleV2.runTask", json!([])), json!("build"));
    let executed = fixture.app.requests_named("tasks/execute");
    assert_eq!(executed.len(), 1);
    assert_eq!(executed[0]["task"]["commandLine"], "npm run build");
    let handle = executed[0]["task"]["handle"].clone();
    fixture
        .host
        .notify("host/taskEnded", json!({ "handle": handle, "exitCode": 0 }))
        .expect("ended");
    fixture.app.wait_for("task events", |_| true);
    let seen = run(&fixture, "sampleV2.events", json!([])).to_string();
    assert!(
        seen.contains("taskStarted:build") && seen.contains("taskEnded:build"),
        "{seen}"
    );
    assert_eq!(
        run(&fixture, "sampleV2.customTask", json!([])),
        json!("VS Code API 'CustomExecution' is not supported by OpenMind Studio yet.")
    );
    fixture.host.stop();
}

#[test]
fn a_file_system_provider_serves_its_scheme_read_only_and_stays_inside_it() {
    let Some(fixture) = setup() else {
        return;
    };
    let fs = |op: &str, path: &str| {
        fixture
            .host
            .request(
                "host/fs",
                json!({ "scheme": "memfs", "op": op, "path": path, "base64": "eA==" }),
                WAIT,
            )
            .map_err(|err| err.to_string())
    };
    let stat = fs("stat", "/hello.txt").expect("stat");
    assert_eq!(stat["type"], 1);
    assert_eq!(stat["readonly"], true);
    let dir = fs("readDirectory", "/").expect("dir");
    assert!(dir["entries"].to_string().contains("hello.txt"));
    let file = fs("readFile", "/docs/./readme.md").expect("read");
    assert_eq!(file["base64"], "IyBSZWFkbWU=");
    let missing = fs("readFile", "/nope.txt").expect_err("missing");
    assert!(missing.contains("FileNotFound"), "{missing}");
    let denied = fs("writeFile", "/new.txt").expect_err("read-only");
    assert!(denied.contains("NoPermissions"), "{denied}");
    let escape = fs("readFile", "/docs/../../etc/passwd").expect_err("escape");
    assert!(escape.contains("leaves"), "{escape}");
    let other = fixture
        .host
        .request(
            "host/fs",
            json!({ "scheme": "nope", "op": "stat", "path": "/" }),
            WAIT,
        )
        .map_err(|err| err.to_string())
        .expect_err("unknown scheme");
    assert!(other.contains("No file system provider"), "{other}");
    // Through the extension's own API: a read works, a write is refused before the provider is called.
    let read = run(&fixture, "sampleV2.readMem", json!(["memfs:/hello.txt"]));
    assert_eq!(read["text"], "Hello from memfs");
    assert_eq!(
        run(&fixture, "sampleV2.readMem", json!(["memfs:/gone.txt"]))["error"],
        "FileNotFound"
    );
    assert_eq!(
        run(&fixture, "sampleV2.writeMem", json!([])),
        json!("NoPermissions|0")
    );
    // Opening a memfs document shows it read-only in the app.
    let opened = run(&fixture, "sampleV2.openMem", json!([]));
    assert_eq!(opened["text"], "# Readme");
    assert_eq!(opened["language"], "markdown");
    let shown = fixture.app.requests_named("ui/showVirtualDocument");
    assert_eq!(shown[0]["uri"], "memfs:///docs/readme.md");
    assert_eq!(shown[0]["readonly"], true);
    fixture.host.stop();
}

#[test]
fn secrets_are_asked_for_under_the_extension_s_own_id() {
    let Some(fixture) = setup() else {
        return;
    };
    assert_eq!(
        run(&fixture, "sampleV2.secretStore", json!(["s3cret"])),
        json!(true)
    );
    assert_eq!(
        run(&fixture, "sampleV2.secretGet", json!([])),
        json!("s3cret")
    );
    let stored = fixture.app.requests_named("secrets/store");
    assert_eq!(stored[0]["extension"], json!(fixture.extension.id));
    assert_eq!(stored[0]["key"], "token");
    assert_eq!(
        run(&fixture, "sampleV2.secretDelete", json!([])),
        json!(true)
    );
    assert_eq!(run(&fixture, "sampleV2.secretGet", json!([])), Value::Null);
    // Secrets never travel as notifications (only as requests the app answers itself).
    assert!(!fixture
        .app
        .notifications
        .lock()
        .expect("lock")
        .iter()
        .any(|(_, params)| params.to_string().contains("s3cret")));
    fixture.host.stop();
}

#[test]
fn workspace_files_watchers_editor_commands_and_formatters() {
    let Some(fixture) = setup() else {
        return;
    };
    let found = run(&fixture, "sampleV2.findFiles", json!([]));
    assert_eq!(found.as_array().map(Vec::len), Some(2));
    let asked = fixture.app.requests_named("workspace/findFiles");
    assert_eq!(asked[0]["include"]["pattern"], "**/*.ts");
    assert_eq!(asked[0]["exclude"]["pattern"], "**/skip/**");
    assert_eq!(asked[0]["maxResults"], 10);

    assert_eq!(run(&fixture, "sampleV2.watch", json!([])), json!(true));
    let root = fixture.paths.root.join("My Site");
    let ts = root.join("src").join("new.ts").display().to_string();
    let md = root.join("notes.md").display().to_string();
    fixture
        .host
        .notify(
            "host/filesChanged",
            json!({ "created": [ts, md], "changed": [], "deleted": [ts] }),
        )
        .expect("files");
    let events = run(&fixture, "sampleV2.watched", json!([])).to_string();
    assert!(
        events.contains("create:") && events.contains("new.ts"),
        "{events}"
    );
    assert!(!events.contains("notes.md"), "{events}");
    assert!(events.contains("delete:"), "{events}");

    // A formatting provider is announced like any language feature and answers with edits.
    let registered = fixture.app.notifications_named("languages/registered");
    let formatter = registered
        .iter()
        .find(|n| n["kind"] == "formatting")
        .expect("formatting provider");
    let file = root.join("a.txt").display().to_string();
    fixture
        .host
        .notify(
            "host/documentOpened",
            json!({ "path": file, "text": "hello", "languageId": "plaintext", "version": 1 }),
        )
        .expect("open");
    let edits = fixture
        .host
        .request(
            "host/provide",
            json!({ "handle": formatter["handle"], "path": file, "options": { "tabSize": 2, "insertSpaces": true } }),
            WAIT,
        )
        .expect("format");
    assert_eq!(edits[0]["newText"], "HELLO");
    assert_eq!(edits[0]["range"]["startLine"], 0);

    // registerTextEditorCommand edits the active editor through the usual edit request.
    fixture
        .host
        .notify(
            "host/activeEditorChanged",
            json!({ "editor": { "path": file, "selections": [{ "anchorLine": 0, "anchorColumn": 0, "activeLine": 0, "activeColumn": 5 }] } }),
        )
        .expect("active");
    run(&fixture, "sampleV2.shout", json!([]));
    let edits = fixture.app.requests_named("editor/applyEdits");
    assert_eq!(edits[0]["edits"][0]["text"], "HELLO");
    fixture.host.stop();
}

#[test]
fn extension_api_exposes_activation_exports_only_after_activation_finishes() {
    let Some(fixture) = setup() else { return; };
    let state = run(&fixture, "sampleV2.extensionState", json!([]));
    assert_eq!(state["found"], true);
    assert_eq!(state["active"], true);
    assert_eq!(state["exportsReady"], true);
    assert_eq!(state["uri"], "file");
    let activated = run(&fixture, "sampleV2.activateExtension", json!([]));
    assert_eq!(activated["active"], true);
    assert_eq!(activated["ready"], true);
    assert_eq!(activated["listed"], true);
    fixture.host.stop();
}

#[test]
fn extension_list_change_event_fires_when_host_reregisters_a_package() {
    let Some(fixture) = setup() else { return; };
    assert_eq!(run(&fixture, "sampleV2.extensionChangeCount", json!([])), json!(0));
    fixture.host.request(
        "host/register",
        json!({ "extension": host_descriptor(&fixture.paths, &fixture.extension, Some("test")) }),
        WAIT,
    ).expect("register");
    assert_eq!(run(&fixture, "sampleV2.extensionChangeCount", json!([])), json!(1));
    fixture.host.stop();
}

#[test]
fn language_selector_matching_uses_vscode_style_scores() {
    let Some(fixture) = setup() else { return; };
    let result = run(&fixture, "sampleV2.languageMatch", json!([]));
    assert_eq!(result["exact"], 10);
    assert_eq!(result["wildcard"], 5);
    assert_eq!(result["mismatch"], 0);
    assert_eq!(result["glob"], 10);
    assert_eq!(result["brace"], 10);
    assert_eq!(result["otherFile"], 0);
    assert_eq!(result["relative"], 10);
    fixture.host.stop();
}

#[test]
fn language_tooling_value_types_are_available_to_extensions() {
    let Some(fixture) = setup() else { return; };
    let values = run(&fixture, "sampleV2.languageValues", json!([]));
    assert_eq!(values["action"], "Apply correction");
    assert_eq!(values["quickfixContains"], true);
    assert_eq!(values["sourceVsRefactor"], false);
    assert_eq!(values["lensResolved"], true);
    assert_eq!(values["linkTarget"], "https");
    assert_eq!(values["childKind"], 11);
    assert_eq!(values["foldingKind"], "region");
    assert_eq!(values["signatureParameters"], 1);
    fixture.host.stop();
}

#[test]
fn vscode_snippet_builders_append_tabstops_and_placeholders() {
    let Some(fixture) = setup() else { return; };
    let snippet = run(&fixture, "sampleV2.snippetBuilders", json!([]));
    assert_eq!(snippet, json!("start $1${2:name}"));
    fixture.host.stop();
}

#[test]
fn vscode_snippet_builders_escape_literal_text_choices_and_variables() {
    let Some(fixture) = setup() else { return; };
    let value = run(&fixture, "sampleV2.snippetEscaping", json!([]));
    assert_eq!(value, json!(r"price \$10\}${1|red\,blue,a\|b|}${TM_FILENAME:a\$b}"));
    fixture.host.stop();
}

#[test]
fn vscode_markdown_literal_text_is_escaped_and_code_fences_are_safe() {
    let Some(fixture) = setup() else { return; };
    let result = run(&fixture, "sampleV2.markdownSafety", json!([]));
    assert_eq!(result["trusted"], false);
    assert_eq!(result["html"], false);
    assert_eq!(result["escaped"], true);
    assert_eq!(result["codeFence"], true);
    fixture.host.stop();
}

#[test]
fn vscode_cancellation_token_notifies_only_once() {
    let Some(fixture) = setup() else { return; };
    let result = run(&fixture, "sampleV2.cancellationToken", json!([]));
    assert_eq!(result["events"], 1);
    assert_eq!(result["cancelled"], true);
    fixture.host.stop();
}

#[test]
fn diagnostic_collection_foreach_receives_uri_diagnostics_and_collection() {
    let Some(fixture) = setup() else { return; };
    let result = run(&fixture, "sampleV2.diagnosticCollection", json!([]));
    assert_eq!(result["received"]["scheme"], "file");
    assert_eq!(result["received"]["count"], 1);
    assert_eq!(result["received"]["same"], true);
    assert_eq!(result["hits"], 1);
    assert_eq!(result["present"], true);
    assert_eq!(result["removed"], true);
    fixture.host.stop();
}

#[test]
fn vscode_file_uri_decodes_query_and_unc_network_share() {
    let Some(fixture) = setup() else { return; };
    let result = run(&fixture, "sampleV2.uriRoundtrip", json!([]));
    assert_eq!(result["path"], "/C:/My Files/hello.ts");
    assert_eq!(result["query"], "mode=read only");
    assert_eq!(result["fragment"], "anchor one");
    assert_eq!(result["shareAuthority"], "server");
    assert_eq!(result["sharePath"], "/share/hello.ts");
    assert_eq!(result["shareFsPath"], "//server/share/hello.ts");
    assert_eq!(result["escapedPath"], true);
    fixture.host.stop();
}

#[test]
fn vscode_uri_factory_strict_parse_and_formatting_are_available() {
    let Some(fixture) = setup() else { return; };
    let result = run(&fixture, "sampleV2.uriFactory", json!([]));
    assert_eq!(result["formatted"], "memfs://local/folder/space%20name");
    assert_eq!(result["unencoded"], "memfs://local/folder/space name");
    assert_eq!(result["strictFailed"], true);
    assert_eq!(result["changed"], "memfs://local/other");
    fixture.host.stop();
}

#[test]
fn vscode_cancellation_constants_and_error_are_available() {
    let Some(fixture) = setup() else { return; };
    let result = run(&fixture, "sampleV2.cancellationStatics", json!([]));
    assert_eq!(result["none"], false);
    assert_eq!(result["cancelled"], true);
    assert_eq!(result["notified"], true);
    assert_eq!(result["errorName"], "Canceled");
    fixture.host.stop();
}

#[test]
fn vscode_event_emitter_disposal_during_dispatch_is_respected() {
    let Some(fixture) = setup() else { return; };
    let result = run(&fixture, "sampleV2.eventDisposal", json!([]));
    assert_eq!(result["count"], 2);
    assert_eq!(result["skipped"], 0);
    fixture.host.stop();
}

#[test]
fn vscode_position_and_range_option_overloads_preserve_originals() {
    let Some(fixture) = setup() else { return; };
    let result = run(&fixture, "sampleV2.positionOverloads", json!([]));
    assert_eq!(result["original"], 4);
    assert_eq!(result["changed"], 8);
    assert_eq!(result["movedLine"], 5);
    assert_eq!(result["movedColumn"], 5);
    assert_eq!(result["changedEnd"], 8);
    assert_eq!(result["samePosition"], true);
    assert_eq!(result["sameRange"], true);
    fixture.host.stop();
}

#[test]
fn vscode_diagnostic_tags_and_trigger_constants_reach_extension_host() {
    let Some(fixture) = setup() else { return; };
    let result = run(&fixture, "sampleV2.diagnosticTags", json!([]));
    assert_eq!(result["first"], 1);
    assert_eq!(result["second"], 2);
    assert_eq!(result["related"], "declared here");
    assert_eq!(result["trigger"], 0);
    assert_eq!(result["actionTrigger"], 2);
    let notifications = fixture.app.notifications_named("diagnostics/set");
    assert!(notifications.iter().any(|notice|
        notice["diagnostics"][0]["tags"] == json!([1, 2])
    ));
    fixture.host.stop();
}
