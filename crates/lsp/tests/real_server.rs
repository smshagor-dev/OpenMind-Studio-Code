//! Runs the real TypeScript language server, installed from the pinned lockfile
//! with a real Node.js/npm and the network. `cargo test -p openmind-lsp --test
//! real_server -- --ignored --nocapture`.

use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use openmind_lsp::install::is_installed;
use openmind_lsp::{
    package_by_id, resolve_node, server_by_id, LogLevel, LspEvents, LspManager,
    PublishedDiagnostics, ServerState, StartContext,
};
use serde_json::{json, Value};

#[derive(Default)]
struct Sink {
    diagnostics: Mutex<Vec<PublishedDiagnostics>>,
    logs: Mutex<Vec<String>>,
}

impl LspEvents for Sink {
    fn diagnostics(&self, _: &str, published: PublishedDiagnostics) {
        self.diagnostics.lock().expect("lock").push(published);
    }
    fn log(&self, server: &str, level: LogLevel, text: &str) {
        self.logs
            .lock()
            .expect("lock")
            .push(format!("[{server}] {level:?} {text}"));
    }
    fn status_changed(&self) {}
}

const SOURCE: &str = "const x: number = \"oops\";\nfunction add(a: number, b: number) {\nreturn a + b;\n}\nadd(1, 2);\n";

fn wait_for<T>(what: &str, mut probe: impl FnMut() -> Option<T>) -> T {
    let deadline = Instant::now() + Duration::from_secs(60);
    loop {
        if let Some(found) = probe() {
            return found;
        }
        assert!(Instant::now() < deadline, "timed out waiting for {what}");
        std::thread::sleep(Duration::from_millis(100));
    }
}

#[test]
#[ignore = "downloads the TypeScript language server and needs Node.js"]
fn the_typescript_server_installs_starts_and_answers() {
    let root = tempfile::tempdir().expect("tempdir");
    let app_root = root.path().join("Open Mind App");
    let workspace = root.path().join("My Site");
    std::fs::create_dir_all(&workspace).expect("workspace");
    let file = workspace.join("app.ts");
    std::fs::write(&file, SOURCE).expect("source");
    let path = file.display().to_string();

    let node = resolve_node(&[], std::env::var_os("PATH")).expect("node on PATH");
    let def = server_by_id("typescript").expect("server");
    let package = package_by_id(def.package).expect("package");
    let sink = Arc::new(Sink::default());
    let manager = LspManager::new(sink.clone());

    assert!(!is_installed(&app_root, def, package));
    manager
        .install_package(def, &app_root, &node)
        .expect("install");
    assert!(is_installed(&app_root, def, package));

    let context = StartContext {
        app_root: app_root.clone(),
        workspace: workspace.clone(),
        node: Some(node),
        path_prepend: vec![],
        vars: vec![],
    };
    manager
        .sync_document(def, &context, &path, SOURCE)
        .expect("sync");
    assert_eq!(manager.status("typescript").state, ServerState::Running);
    let pid = manager.status("typescript").pid.expect("pid");

    // Diagnostics: the wrong assignment is reported with a path that names the file.
    let published = wait_for("diagnostics", || {
        sink.diagnostics
            .lock()
            .expect("lock")
            .iter()
            .find(|d| !d.diagnostics.is_empty())
            .cloned()
    });
    assert!(published.path.to_lowercase().ends_with("my site/app.ts"));
    assert!(published.diagnostics[0].message.contains("not assignable"));
    assert_eq!(published.diagnostics[0].range.start.line, 0);

    let position = json!({ "line": 4, "character": 1 });
    let doc = json!({ "uri": openmind_lsp::path_to_uri(&path) });
    let ask = |method: &str, extra: Value| -> Value {
        let mut params = json!({ "textDocument": doc, "position": position });
        if let (Some(base), Some(more)) = (params.as_object_mut(), extra.as_object()) {
            base.extend(more.clone());
        }
        manager
            .request("typescript", method, &params, Duration::from_secs(30))
            .expect(method)
    };
    let hover = ask("textDocument/hover", json!({}));
    assert!(hover.to_string().contains("add"));
    let definition = ask("textDocument/definition", json!({}));
    assert_eq!(definition[0]["range"]["start"]["line"], 1);
    let references = ask(
        "textDocument/references",
        json!({ "context": { "includeDeclaration": true } }),
    );
    assert_eq!(references.as_array().map(Vec::len), Some(2));
    let rename = ask("textDocument/rename", json!({ "newName": "sum" }));
    assert!(rename.to_string().contains("sum"));
    let completion = ask(
        "textDocument/completion",
        json!({ "position": { "line": 4, "character": 0 } }),
    );
    assert!(completion.to_string().contains("add"));

    // A fixed file has no problems any more.
    let fixed = SOURCE.replace("\"oops\"", "1");
    manager
        .sync_document(def, &context, &path, &fixed)
        .expect("resync");
    wait_for("cleared diagnostics", || {
        sink.diagnostics
            .lock()
            .expect("lock")
            .last()
            .filter(|d| d.diagnostics.is_empty())
            .cloned()
    });

    manager.stop_all();
    assert_eq!(manager.status("typescript").state, ServerState::Stopped);
    std::thread::sleep(Duration::from_millis(500));
    #[cfg(windows)]
    {
        let out = std::process::Command::new("tasklist")
            .args(["/FI", &format!("PID eq {pid}"), "/NH"])
            .output()
            .expect("tasklist");
        assert!(
            !String::from_utf8_lossy(&out.stdout).contains(&pid.to_string()),
            "the server process is still running"
        );
    }
    println!("{}", sink.logs.lock().expect("lock").join("\n"));
}

/// Installs `server_id`, opens `file_name` with `source` and waits for a diagnostic
/// containing `expect`, then asks hover at `hover_at` and stops the server.
fn diagnoses(server_id: &str, file_name: &str, source: &str, expect: &str, hover_at: (u32, u32)) {
    let root = tempfile::tempdir().expect("tempdir");
    let app_root = root.path().join("Open Mind App");
    let workspace = root.path().join("My Site");
    std::fs::create_dir_all(&workspace).expect("workspace");
    let file = workspace.join(file_name);
    std::fs::write(&file, source).expect("source");
    let path = file.display().to_string();
    let node = resolve_node(&[], std::env::var_os("PATH")).expect("node on PATH");
    let def = server_by_id(server_id).expect("server");
    let sink = Arc::new(Sink::default());
    let manager = LspManager::new(sink.clone());
    if let Err(err) = manager.install_package(def, &app_root, &node) {
        let npm_log = std::fs::read_dir(app_root.join("cache").join("npm").join("_logs"))
            .ok()
            .and_then(|mut entries| entries.next())
            .and_then(|entry| std::fs::read_to_string(entry.ok()?.path()).ok())
            .unwrap_or_default();
        panic!(
            "install failed: {err}
{}
{npm_log}",
            sink.logs.lock().expect("lock").join(
                "
"
            )
        );
    }
    let context = StartContext {
        app_root,
        workspace,
        node: Some(node),
        path_prepend: vec![],
        vars: vec![],
    };
    manager
        .sync_document(def, &context, &path, source)
        .expect("sync");
    let published = wait_for("diagnostics", || {
        sink.diagnostics
            .lock()
            .expect("lock")
            .iter()
            .find(|d| d.diagnostics.iter().any(|x| x.message.contains(expect)))
            .cloned()
    });
    assert!(published
        .path
        .to_lowercase()
        .ends_with(&file_name.to_lowercase()));
    let hover = manager
        .request(
            server_id,
            "textDocument/hover",
            &json!({
                "textDocument": { "uri": openmind_lsp::path_to_uri(&path) },
                "position": { "line": hover_at.0, "character": hover_at.1 }
            }),
            Duration::from_secs(30),
        )
        .expect("hover");
    println!("{server_id} hover: {hover}");
    manager.stop_all();
    assert_eq!(manager.status(server_id).state, ServerState::Stopped);
}

#[test]
#[ignore = "downloads Pyright and needs Node.js"]
fn pyright_installs_starts_and_reports_a_type_error() {
    diagnoses(
        "python",
        "tool.py",
        "def add(a: int, b: int) -> int:\n    return a + b\n\nadd(1, \"two\")\n",
        "cannot be assigned",
        (0, 5),
    );
}

#[test]
#[ignore = "downloads Intelephense and needs Node.js"]
fn intelephense_installs_starts_and_reports_an_undefined_function() {
    diagnoses(
        "php",
        "index.php",
        "<?php\nfunction add($a, $b) { return $a + $b; }\nundefined_call();\n",
        "undefined_call",
        (1, 10),
    );
}

#[test]
#[ignore = "downloads the JSON/CSS/HTML servers and needs Node.js"]
fn the_web_servers_report_json_and_css_errors() {
    diagnoses(
        "json",
        "data.json",
        "{\"a\": 1,}\n",
        "Trailing comma",
        (0, 2),
    );
    diagnoses(
        "css",
        "style.css",
        "body {\n  padding: ;\n  margin: 0;\n}\n",
        "expected",
        (2, 4),
    );
}
