//! Formats real text with the formatters of a prepared offline bundle, through the same path Format Document takes:
//! the packs are unpacked (SHA256-checked) into a fresh app folder, the tool lookup gets the bundled folders and the
//! Prettier launcher (on the bundle's own Node.js), the system PATH is empty, `candidates` + `choose` pick the
//! formatter and `run_stdin` runs it. Every language must come back formatted by a *bundled* tool.
//!
//! ```text
//! pnpm lsp:bundle
//! set OPENMIND_LSP_BUNDLE=<repo>\lsp-bundle
//! cargo test -p openmind-format --test bundled_formatters -- --ignored --nocapture
//! ```

use std::collections::HashMap;
use std::path::PathBuf;
use std::time::Duration;

use openmind_format::resolve::{candidates, choose, FormatterSource, Mode, Policy};
use openmind_format::run::{run_stdin, Job};
use openmind_language::language_for;
use openmind_language::registry::by_id;
use openmind_language::tools::{Os, ToolEnv};
use openmind_lsp::bundle::load_dir;
use openmind_lsp::tools::{ensure_unpacked, ready_tools};

const POLICY: Policy = Policy {
    project: true,
    bundled: true,
    system: false,
};

/// (file name, messy text, text the formatted result must contain, expected tool)
const CASES: &[(&str, &str, &str, &str)] = &[
    (
        "index.html",
        "<div><p>hi</p><p>there</p></div>",
        "<div>\n",
        "prettier",
    ),
    (
        "site.css",
        "a{color:red;margin:0}",
        "a {\n  color: red;",
        "prettier",
    ),
    (
        "app.ts",
        "const x={a:1,b:2}",
        "const x = { a: 1, b: 2 };",
        "prettier",
    ),
    (
        "App.tsx",
        "const A=()=><div className=\"a\">hi</div>",
        "const A = () =>",
        "prettier",
    ),
    ("data.json", "{\"a\":1,\"b\":[1,2]}", "\"a\": 1", "prettier"),
    ("notes.md", "#   Title\n*  item", "# Title", "prettier"),
    ("ci.yml", "a:   1\nb:    [1,2]", "a: 1", "prettier"),
    (
        "index.php",
        "<?php\nfunction f($a,$b){return $a+$b;}",
        "function f($a, $b)",
        "prettier",
    ),
    (
        "run.sh",
        "if [ -f x ];then echo hi;fi",
        "if [ -f x ]; then",
        "prettier",
    ),
    (
        "Dockerfile",
        "FROM node:20\nRUN   apt-get update &&    apt-get install -y git",
        "RUN apt-get update && apt-get install",
        "prettier",
    ),
    ("pom.xml", "<a><b>1</b><c/></a>", "<c />", "prettier"),
    (
        "query.sql",
        "select a,b from t where x=1",
        "select\n",
        "prettier",
    ),
    ("Cargo.toml", "a=1\n[b]\nc=\"d\"", "a = 1", "prettier"),
    (
        "Main.java",
        "class A{void f(){int x=1;}}",
        "class A {",
        "prettier",
    ),
    (
        "App.svelte",
        "<script>let a=1</script><p>{a}</p>",
        "let a = 1;",
        "prettier",
    ),
    (
        "main.py",
        "x=[1,2 ,3]\ndef f( a ):\n  return a",
        "x = [1, 2, 3]",
        "ruff",
    ),
    (
        "main.go",
        "package main\nfunc main(){x:=1\n_=x}",
        "func main() {",
        "gofmt",
    ),
    (
        "main.c",
        "int main(){return 0;}",
        "int main() { return 0; }",
        "clang-format",
    ),
    (
        "main.cpp",
        "int main(){int x=1;return x;}",
        "int x = 1;",
        "clang-format",
    ),
    (
        "Program.cs",
        "class A{void F(){int x=1;}}",
        "class A {",
        "clang-format",
    ),
    (
        "init.lua",
        "local a={1,2}\nif a then print( 'x' ) end",
        "local a = { 1, 2 }",
        "stylua",
    ),
];

fn env_with_bundle(app: &std::path::Path) -> ToolEnv {
    let dir = std::env::var_os("OPENMIND_LSP_BUNDLE")
        .map(PathBuf::from)
        .expect("set OPENMIND_LSP_BUNDLE to a prepared lsp-bundle folder (pnpm lsp:bundle)");
    let bundle = load_dir(&dir).expect("valid").expect("bundle.json present");
    let problems = ensure_unpacked(app, &bundle);
    assert!(problems.is_empty(), "{problems:?}");
    let node = bundle.node_path().expect("bundled node");
    let mut env = ToolEnv {
        os: Os::current(),
        project_dirs: vec![],
        bundled_dirs: vec![],
        launchers: HashMap::new(),
        portable_dirs: vec![],
        // No system tools at all: everything must come from the bundle.
        system_dirs: vec![],
        pathext: vec![".exe".into(), ".cmd".into(), ".bat".into()],
        vars: HashMap::new(),
    };
    for tool in ready_tools(app, Some(&node)) {
        if let Some(dir) = tool.dir {
            env.bundled_dirs.push(dir);
        }
        if let Some(launcher) = tool.launcher {
            env.launchers.insert(tool.tool.to_string(), launcher);
        }
    }
    env
}

#[test]
#[ignore = "needs a prepared offline LSP bundle (OPENMIND_LSP_BUNDLE)"]
fn every_bundled_formatter_formats_its_languages() {
    let root = tempfile::tempdir().expect("tempdir");
    let app = root.path().join("Open Mind App");
    let workspace = root.path().join("My Project");
    std::fs::create_dir_all(&workspace).expect("workspace");
    let env = env_with_bundle(&app);
    let mut failures = Vec::new();
    for (name, text, expect, tool) in CASES {
        let file = workspace.join(name);
        let file_arg = file.display().to_string();
        let language = language_for(&file_arg).expect(name);
        let list = candidates(language, &file_arg, &env, &POLICY);
        let chosen = match choose(language.name, &list, None) {
            Ok(chosen) => chosen,
            Err(reason) => {
                failures.push(format!("{name}: no formatter: {reason}"));
                continue;
            }
        };
        if chosen.info.id != *tool
            || chosen.info.source != Some(FormatterSource::Bundled)
            || chosen.info.mode != Mode::Stdin
        {
            failures.push(format!("{name}: chose {:?}", chosen.info));
            continue;
        }
        let job = Job {
            argv: &chosen.argv,
            cwd: &workspace,
            input: text,
            timeout: Duration::from_secs(60),
            path_prepend: &[],
        };
        match run_stdin(&job) {
            Ok(out) if out.contains(expect) && out != *text => {
                println!("{name}: formatted by bundled {tool}");
            }
            Ok(out) => failures.push(format!("{name}: unexpected output {out:?}")),
            Err(err) => failures.push(format!("{name}: {err}")),
        }
    }
    assert!(failures.is_empty(), "{}", failures.join("\n"));
    // Every language that got a bundled formatter in Milestone 18 is covered above.
    for id in [
        "php",
        "shellscript",
        "dockerfile",
        "xml",
        "sql",
        "toml",
        "java",
        "csharp",
        "lua",
    ] {
        assert!(by_id(id).is_some(), "{id}");
    }
}
