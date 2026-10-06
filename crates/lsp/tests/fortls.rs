//! Runs the real fortls, installed with pip from the pinned requirements (network) by the Python named in
//! `OPENMIND_TEST_PYTHON` (else `python` on PATH): `cargo test -p openmind-lsp --test fortls -- --ignored --nocapture`.

use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use openmind_lsp::install::is_installed;
use openmind_lsp::{
    package_by_id, server_by_id, LogLevel, LspEvents, LspManager, PublishedDiagnostics,
    PythonExecutable, ServerState, StartContext,
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

const MODULE: &str = "module shapes\n  implicit none\ncontains\n  real function area(r)\n    real, intent(in) :: r\n    area = 3.14159 * r * r\n  end function area\nend module shapes\n";
const MAIN: &str = "program main\n  use shapes\n  implicit none\n  real :: x\n  x = area(2.0)\n  print *, x\nend program main\n";

#[test]
#[ignore = "downloads fortls with pip and needs Python"]
fn fortls_installs_starts_and_navigates_between_files() {
    let root = tempfile::tempdir().expect("tempdir");
    let app_root = root.path().join("Open Mind App");
    let workspace = root.path().join("My Fortran");
    std::fs::create_dir_all(&workspace).expect("workspace");
    std::fs::write(workspace.join("shapes.f90"), MODULE).expect("module");
    let main = workspace.join("main.f90");
    std::fs::write(&main, MAIN).expect("main");
    let path = main.display().to_string();

    let python = PythonExecutable {
        path: std::env::var_os("OPENMIND_TEST_PYTHON")
            .map_or_else(|| PathBuf::from("python"), PathBuf::from),
        label: "test Python".into(),
    };
    let def = server_by_id("fortran").expect("server");
    let package = package_by_id(def.package).expect("package");
    let sink = Arc::new(Sink::default());
    let manager = LspManager::new(sink.clone());
    manager
        .install_python_package_env(def, &app_root, &python, &[])
        .expect("install");
    assert!(is_installed(&app_root, def, package));

    let context = StartContext {
        app_root,
        workspace: workspace.clone(),
        node: None,
        python: Some(python),
        path_prepend: vec![],
        vars: vec![],
        config_root: None,
    };
    manager
        .sync_document(def, &context, &path, MAIN)
        .expect("sync");
    // The server must still be up after its start-up (it used to exit at once on an unknown `--stdio`).
    std::thread::sleep(Duration::from_secs(2));
    assert_eq!(
        manager.status("fortran").state,
        ServerState::Running,
        "{:?}",
        sink.logs.lock().expect("lock")
    );

    let doc = json!({ "uri": openmind_lsp::path_to_uri(&path) });
    let ask = |method: &str, line: u32, character: u32, extra: Value| -> Value {
        let mut params =
            json!({ "textDocument": doc, "position": { "line": line, "character": character } });
        if let (Some(base), Some(more)) = (params.as_object_mut(), extra.as_object()) {
            base.extend(more.clone());
        }
        wait_for(method, || {
            manager
                .request("fortran", method, &params, Duration::from_secs(30))
                .ok()
                .filter(|answer| !answer.is_null())
        })
    };

    // `area` on line 5 is defined in the other file.
    let definition = ask("textDocument/definition", 4, 7, json!({}));
    assert!(
        definition.to_string().contains("shapes.f90"),
        "{definition}"
    );
    assert_eq!(
        definition["range"]["start"]["line"]
            .as_u64()
            .or(definition[0]["range"]["start"]["line"].as_u64()),
        Some(3)
    );
    let hover = ask("textDocument/hover", 4, 7, json!({}));
    assert!(
        hover.to_string().to_lowercase().contains("function area"),
        "{hover}"
    );
    let symbols = ask("textDocument/documentSymbol", 0, 0, json!({}));
    assert!(symbols.to_string().contains("main"), "{symbols}");
    let completion = ask("textDocument/completion", 4, 7, json!({}));
    assert!(completion.to_string().contains("area"), "{completion}");

    // Workspace symbols (Ctrl+T): fortls offers them and finds `area` in the other file.
    let caps = manager
        .status("fortran")
        .capabilities
        .expect("capabilities");
    assert!(caps.workspace_symbol);
    let answer = manager
        .request(
            "fortran",
            "workspace/symbol",
            &json!({ "query": "area" }),
            Duration::from_secs(30),
        )
        .expect("workspace/symbol");
    let hits = openmind_lsp::symbols::parse_workspace_symbols(&answer, &workspace, "area");
    let area = hits
        .iter()
        .find(|hit| hit.name.eq_ignore_ascii_case("area"))
        .unwrap_or_else(|| panic!("{answer}"));
    assert!(area.relative_path.ends_with("shapes.f90"), "{area:?}");
    assert_eq!(area.kind, "function");
    assert_eq!(area.line, 4);

    let references = ask(
        "textDocument/references",
        4,
        7,
        json!({ "context": { "includeDeclaration": true } }),
    );
    assert!(
        references.as_array().is_some_and(|all| !all.is_empty()),
        "{references}"
    );

    // A variable declared twice is one of the problems fortls reports by itself.
    // fortls reads a saved file from disk, so the edit is written before the save is announced.
    let broken = MAIN.replace("  real :: x\n", "  real :: x\n  integer :: x\n");
    std::fs::write(&main, &broken).expect("save");
    manager
        .sync_document(def, &context, &path, &broken)
        .expect("resync");
    manager.save_document("fortran", &path);
    let published = wait_for("diagnostics", || {
        sink.diagnostics
            .lock()
            .expect("lock")
            .iter()
            .rev()
            .find(|d| !d.diagnostics.is_empty())
            .cloned()
    });
    assert!(
        published
            .diagnostics
            .iter()
            .any(|d| d.message == "Variable \"x\" declared twice in scope"),
        "{:?}",
        published.diagnostics
    );

    manager.stop_all();
    assert_eq!(manager.status("fortran").state, ServerState::Stopped);
    println!("{}", sink.logs.lock().expect("lock").join("\n"));
}
