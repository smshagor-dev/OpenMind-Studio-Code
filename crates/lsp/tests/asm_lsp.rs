//! Runs the real asm-lsp: `OPENMIND_TEST_ASM_LSP` names a folder holding `asm-lsp.exe` and its DLLs (an unpacked
//! install) and `OPENMIND_TEST_NASM` the `nasm.exe` its problems come from.
//! `cargo test -p openmind-lsp --test asm_lsp -- --ignored --nocapture`

use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use openmind_lsp::install::is_installed;
use openmind_lsp::{
    package_by_id, server_by_id, LogLevel, LspError, LspEvents, LspManager, PublishedDiagnostics,
    ServerState, StartContext,
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
    let deadline = Instant::now() + Duration::from_secs(30);
    loop {
        if let Some(found) = probe() {
            return found;
        }
        assert!(Instant::now() < deadline, "timed out waiting for {what}");
        std::thread::sleep(Duration::from_millis(100));
    }
}

const HELLO: &str = "        default rel\n        global  main\n        extern  printf\n        section .text\nmain:\n        mov     rax, 1\n        ret\n";
const BROKEN: &str =
    "        global  main\n        section .text\nmain:\n        movv    eax, 1\n        ret\n";

fn copy_dir(from: &Path, to: &Path) {
    std::fs::create_dir_all(to).expect("dir");
    for entry in std::fs::read_dir(from).expect("read") {
        let entry = entry.expect("entry");
        if entry.path().is_file() {
            std::fs::copy(entry.path(), to.join(entry.file_name())).expect("copy");
        }
    }
}

#[test]
#[ignore = "needs asm-lsp (OPENMIND_TEST_ASM_LSP) and NASM (OPENMIND_TEST_NASM)"]
fn asm_lsp_keeps_running_through_edits_and_answers_hover_symbols_and_problems() {
    let (Some(server_dir), Some(nasm)) = (
        std::env::var_os("OPENMIND_TEST_ASM_LSP").map(PathBuf::from),
        std::env::var_os("OPENMIND_TEST_NASM").map(PathBuf::from),
    ) else {
        eprintln!("skipped: OPENMIND_TEST_ASM_LSP / OPENMIND_TEST_NASM are not set");
        return;
    };
    let root = tempfile::tempdir().expect("tempdir");
    let app_root = root.path().join("Open Mind App");
    let workspace = root.path().join("My Asm");
    std::fs::create_dir_all(&workspace).expect("workspace");
    let file = workspace.join("hello world.asm");
    std::fs::write(&file, HELLO).expect("source");
    let path = file.display().to_string();

    let def = server_by_id("assembly").expect("server");
    let package = package_by_id(def.package).expect("package");
    copy_dir(
        &server_dir,
        &app_root
            .join("language-servers")
            .join(package.id)
            .join(package.revision),
    );
    assert!(is_installed(&app_root, def, package));
    // The configuration the app writes (see `openmind_runner::assembly::asm_lsp_config`), in a folder of its own.
    let config_root = app_root.join("settings").join("asm-lsp");
    std::fs::create_dir_all(&config_root).expect("config dir");
    let nasm = nasm.display().to_string().replace('\\', "/");
    std::fs::write(
        config_root.join(".asm-lsp.toml"),
        format!("[default_config]\nversion = \"0.10.1\"\nassembler = \"nasm\"\ninstruction_set = \"x86-64\"\n\n[default_config.opts]\ncompiler = \"{nasm}\"\ncompile_flags_txt = [\"-f\", \"win64\", \"-o\", \"NUL\"]\ndiagnostics = true\ndefault_diagnostics = true\n"),
    )
    .expect("config");

    // asm-lsp creates an empty `%APPDATA%\asm-lsp` while it looks for a global configuration: the test removes it again
    // when it made it (as the app does at shutdown).
    let appdata_folder =
        std::env::var_os("APPDATA").map(|appdata| PathBuf::from(appdata).join("asm-lsp"));
    let folder_existed = appdata_folder
        .as_ref()
        .is_some_and(|folder| folder.exists());
    let sink = Arc::new(Sink::default());
    let manager = LspManager::new(sink.clone());
    let context = StartContext {
        app_root,
        workspace: workspace.clone(),
        node: None,
        python: None,
        path_prepend: vec![],
        vars: vec![],
        config_root: Some(config_root),
    };
    manager
        .sync_document(def, &context, &path, HELLO)
        .expect("open");
    // The regression: asm-lsp exits on a change without a range. Edits must keep it running.
    for text in [
        HELLO.replace("rax, 1", "rax, 2"),
        format!("{HELLO}; done\r\n"),
        HELLO.to_string(),
    ] {
        manager
            .sync_document(def, &context, &path, &text)
            .expect("change");
    }
    std::thread::sleep(Duration::from_secs(1));
    assert_eq!(
        manager.status("assembly").state,
        ServerState::Running,
        "{:?}",
        sink.logs.lock().expect("lock")
    );

    let doc = json!({ "uri": openmind_lsp::path_to_uri(&path) });
    let ask = |method: &str, line: u32, character: u32| -> Value {
        let params =
            json!({ "textDocument": doc, "position": { "line": line, "character": character } });
        wait_for(method, || {
            manager
                .request("assembly", method, &params, Duration::from_secs(10))
                .ok()
                .filter(|answer| !answer.is_null())
        })
    };
    let hover = ask("textDocument/hover", 5, 10);
    assert!(hover.to_string().to_lowercase().contains("mov"), "{hover}");
    let symbols = ask("textDocument/documentSymbol", 0, 0);
    assert!(symbols.to_string().contains("main"), "{symbols}");
    // `mov rax, 1` → `main` is defined on line 4 (Go to Definition from the `global main` line).
    let definition = ask("textDocument/definition", 1, 17);
    assert!(
        definition.to_string().contains("\"line\":4"),
        "{definition}"
    );
    if manager
        .status("assembly")
        .capabilities
        .is_some_and(|caps| caps.workspace_symbol)
    {
        let found = manager
            .request(
                "assembly",
                "workspace/symbol",
                &json!({ "query": "main" }),
                Duration::from_secs(10),
            )
            .expect("workspace symbols");
        assert!(found.to_string().contains("main"), "{found}");
    }
    // Positions past a line's end used to make asm-lsp panic and exit (it slices the line at the column). Every
    // line of the real example is asked about beyond its end: the requests are moved inside the text and the server
    // keeps running.
    let example = include_str!("../../../examples/assembly/hello.asm");
    manager
        .sync_document(def, &context, &path, example)
        .expect("example");
    let pid = manager.status("assembly").pid;
    for (line, text) in example.lines().enumerate() {
        for method in ["textDocument/hover", "textDocument/definition"] {
            let position = json!({ "line": line, "character": text.len() + 8 });
            let answer = manager.request(
                "assembly",
                method,
                &json!({ "textDocument": doc, "position": position }),
                Duration::from_secs(10),
            );
            assert!(
                !matches!(answer, Err(LspError::Closed | LspError::NotRunning)),
                "{method} past the end of line {line}: {answer:?}"
            );
        }
    }
    let past_the_end = manager.request(
        "assembly",
        "textDocument/hover",
        &json!({ "textDocument": doc, "position": { "line": 999, "character": 40 } }),
        Duration::from_secs(10),
    );
    assert!(
        !matches!(past_the_end, Err(LspError::Closed | LspError::NotRunning)),
        "{past_the_end:?}"
    );
    assert_eq!(
        manager.status("assembly").pid,
        pid,
        "the same asm-lsp process answered everything"
    );
    manager
        .sync_document(def, &context, &path, HELLO)
        .expect("change back");
    std::thread::sleep(Duration::from_millis(500));
    assert_eq!(
        manager.status("assembly").state,
        ServerState::Running,
        "{:?}",
        sink.logs.lock().expect("lock")
    );

    // Problems come from NASM on save (asm-lsp reads the saved file).
    std::fs::write(&file, BROKEN).expect("broken");
    manager
        .sync_document(def, &context, &path, BROKEN)
        .expect("change");
    manager.save_document("assembly", &path);
    let problem = wait_for("a NASM problem", || {
        sink.diagnostics
            .lock()
            .expect("lock")
            .iter()
            .flat_map(|published| published.diagnostics.clone())
            .find(|diagnostic| diagnostic.message.to_lowercase().contains("instruction"))
    });
    assert_eq!(problem.range.start.line, 3, "{problem:?}");
    manager.stop_all();
    if let (Some(folder), false) = (appdata_folder, folder_existed) {
        let _ = std::fs::remove_dir(folder);
    }
}
