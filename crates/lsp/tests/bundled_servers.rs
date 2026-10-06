//! Runs every server of a prepared offline LSP bundle the way the app does: the
//! pack is unpacked (SHA256-checked) into a fresh app folder, Node-based servers
//! run on the bundle's own `node.exe`, and each server's PATH holds nothing but
//! System32 — so no system Node, npm, Python, Rust or C++ toolchain is used and
//! nothing is downloaded. Each server must give a real answer.
//!
//! ```text
//! pnpm lsp:bundle
//! set OPENMIND_LSP_BUNDLE=E:\Code Editor\lsp-bundle
//! cargo test -p openmind-lsp --test bundled_servers -- --ignored --nocapture
//! ```

use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use openmind_lsp::bundle::{load_dir, Bundle};
use openmind_lsp::install::is_installed;
use openmind_lsp::unpack::unpacked_from;
use openmind_lsp::{
    package_by_id, path_to_uri, resolve_lsp_node, server_by_id, LogLevel, LspEvents, LspManager,
    NodeSource, PublishedDiagnostics, Runtime, ServerState, StartContext,
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

enum Check {
    /// A published diagnostic whose message contains this text.
    Diagnostic(&'static str),
    /// A request at (line, character) whose answer contains this text.
    Answer(&'static str, (u32, u32), &'static str),
}

fn bundle() -> Bundle {
    let dir = std::env::var_os("OPENMIND_LSP_BUNDLE")
        .map(PathBuf::from)
        .expect("set OPENMIND_LSP_BUNDLE to a prepared lsp-bundle folder (pnpm lsp:bundle)");
    load_dir(&dir).expect("valid").expect("bundle.json present")
}

fn wait_for<T>(what: &str, mut probe: impl FnMut() -> Option<T>) -> T {
    let deadline = Instant::now() + Duration::from_secs(90);
    loop {
        if let Some(found) = probe() {
            return found;
        }
        assert!(Instant::now() < deadline, "timed out waiting for {what}");
        std::thread::sleep(Duration::from_millis(200));
    }
}

fn system32_only() -> String {
    let root = std::env::var("SystemRoot").unwrap_or_else(|_| r"C:\Windows".into());
    format!(r"{root}\System32")
}

fn run(server_id: &str, file_name: &str, source: &str, check: Check) {
    let bundle = bundle();
    let root = tempfile::tempdir().expect("tempdir");
    let app_root = root.path().join("Open Mind App");
    let workspace = root.path().join("My Project");
    std::fs::create_dir_all(&workspace).expect("workspace");
    let file = workspace.join(file_name);
    std::fs::write(&file, source).expect("source");
    let path = file.display().to_string();

    let def = server_by_id(server_id).expect("server");
    let package = package_by_id(def.package).expect("package");
    let sink = Arc::new(Sink::default());
    let manager = LspManager::new(sink.clone());

    assert!(!is_installed(&app_root, def, package));
    assert!(manager
        .prepare_bundled(def, &app_root, &bundle)
        .expect("unpack"));
    assert!(is_installed(&app_root, def, package));
    assert!(unpacked_from(&app_root, package).is_some());
    // A second call finds it ready and does nothing.
    assert!(!manager
        .prepare_bundled(def, &app_root, &bundle)
        .expect("again"));

    let node = resolve_lsp_node(bundle.node_path(), &[], None).expect("bundled node");
    assert_eq!(node.source, NodeSource::Bundled);
    let context = StartContext {
        app_root: app_root.clone(),
        workspace: workspace.clone(),
        node: (def.runtime == Runtime::Node).then_some(node),
        python: None,
        path_prepend: vec![],
        vars: vec![("PATH".into(), system32_only())],
        config_root: None,
    };
    manager
        .sync_document(def, &context, &path, source)
        .unwrap_or_else(|err| {
            panic!(
                "{server_id}: {err}\n{}",
                sink.logs.lock().expect("lock").join("\n")
            )
        });
    assert_eq!(manager.status(server_id).state, ServerState::Running);

    match check {
        Check::Diagnostic(text) => {
            let found = wait_for(&format!("{server_id} diagnostic \"{text}\""), || {
                sink.diagnostics
                    .lock()
                    .expect("lock")
                    .iter()
                    .flat_map(|published| published.diagnostics.clone())
                    .find(|diagnostic| diagnostic.message.contains(text))
            });
            println!("{server_id}: {}", found.message);
        }
        Check::Answer(method, (line, character), text) => {
            let params = json!({
                "textDocument": { "uri": path_to_uri(&path) },
                "position": { "line": line, "character": character },
            });
            let answer: Value = wait_for(&format!("{server_id} {method} with \"{text}\""), || {
                manager
                    .request(server_id, method, &params, Duration::from_secs(30))
                    .ok()
                    .filter(|answer| answer.to_string().contains(text))
            });
            let shown = answer.to_string();
            println!("{server_id}: {}", &shown[..shown.len().min(160)]);
        }
    }
    manager.stop_all();
    assert_eq!(manager.running_count(), 0);
}

macro_rules! bundled {
    ($name:ident, $server:literal, $file:literal, $source:expr, $check:expr) => {
        #[test]
        #[ignore = "needs a prepared offline LSP bundle (OPENMIND_LSP_BUNDLE)"]
        fn $name() {
            run($server, $file, $source, $check);
        }
    };
}

bundled!(
    typescript_reports_a_type_error,
    "typescript",
    "app.ts",
    "const x: number = \"oops\";\n",
    Check::Diagnostic("not assignable")
);
bundled!(
    pyright_reports_a_type_error,
    "python",
    "m.py",
    "x: int = \"a\"\n",
    Check::Diagnostic("not assignable")
);
bundled!(
    json_reports_a_trailing_comma,
    "json",
    "data.json",
    "{\"a\": 1,}\n",
    Check::Diagnostic("Trailing comma")
);
bundled!(
    css_reports_an_unknown_property,
    "css",
    "a.css",
    "a { colr: red; }\n",
    Check::Diagnostic("Unknown property")
);
bundled!(
    html_answers_hover,
    "html",
    "index.html",
    "<div></div>\n",
    Check::Answer("textDocument/hover", (0, 2), "div")
);
bundled!(
    yaml_reports_a_syntax_error,
    "yaml",
    "config.yaml",
    "a: [1, 2\nb: c\n",
    Check::Diagnostic("")
);
bundled!(
    bash_lists_a_function,
    "bash",
    "build.sh",
    "#!/bin/bash\ngreet() {\n  echo hi\n}\ngreet\n",
    Check::Answer("textDocument/documentSymbol", (0, 0), "greet")
);
bundled!(
    dockerfile_needs_a_from,
    "dockerfile",
    "Dockerfile",
    "RUN echo hi\n",
    Check::Diagnostic("FROM")
);
bundled!(
    rust_analyzer_lists_functions,
    "rust",
    "main.rs",
    "fn main() {}\nfn helper() -> u32 { 1 }\n",
    Check::Answer("textDocument/documentSymbol", (0, 0), "helper")
);
bundled!(
    clangd_reports_an_undeclared_name,
    "clangd",
    "main.cpp",
    "int main() { return undefined_name; }\n",
    Check::Diagnostic("undeclared identifier")
);
