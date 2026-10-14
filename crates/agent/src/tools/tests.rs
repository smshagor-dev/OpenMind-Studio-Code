use std::fs;
use std::sync::atomic::AtomicBool;

use super::*;
use crate::paths::Workspace;

struct Fixture {
    _dir: tempfile::TempDir,
    ws: Workspace,
    env: CommandEnv,
    cancel: AtomicBool,
    unsaved: Vec<std::path::PathBuf>,
}

impl Fixture {
    fn new() -> Self {
        let dir = tempfile::tempdir().expect("tmp");
        let root = dir.path().join("my app");
        fs::create_dir_all(root.join("src")).expect("mkdir");
        fs::write(
            root.join("src/main.py"),
            "def add(a, b):\r\n    return a - b\r\n\r\nprint(add(2, 3))\r\n",
        )
        .expect("write");
        fs::write(root.join("README.md"), "# App\n").expect("write");
        let ws = Workspace::new(&root).expect("ws");
        Self {
            _dir: dir,
            ws,
            env: CommandEnv::default(),
            cancel: AtomicBool::new(false),
            unsaved: Vec::new(),
        }
    }

    fn ctx(&self) -> ToolContext<'_> {
        ToolContext {
            ws: &self.ws,
            env: &self.env,
            cancel: &self.cancel,
            unsaved: &self.unsaved,
        }
    }

    fn run(&self, name: &str, args: serde_json::Value) -> Outcome {
        let prepared = prepare(name, &args.to_string(), &self.ctx(), false);
        execute(prepared, &self.ctx())
    }
}

#[test]
fn read_file_numbers_lines_and_pages() {
    let f = Fixture::new();
    let out = f.run("read_file", json!({"path": "src/main.py"}));
    assert!(out.ok);
    assert!(out.for_model.contains("     2\t    return a - b"));
    assert_eq!(out.summary, "Read 4 lines");
    let page = f.run(
        "read_file",
        json!({"path": "src/main.py", "offset": 2, "limit": 1}),
    );
    assert!(page
        .for_model
        .contains("[2 more lines; read again with offset 3"));
}

#[test]
fn edit_file_changes_one_line_and_keeps_crlf() {
    let f = Fixture::new();
    let prepared = prepare(
        "edit_file",
        &json!({"path": "src/main.py", "old_string": "return a - b", "new_string": "return a + b"})
            .to_string(),
        &f.ctx(),
        false,
    );
    assert_eq!(prepared.kind, ToolKind::Edit);
    assert_eq!(prepared.target, "src/main.py");
    let diff = prepared.diff.clone().expect("diff");
    assert_eq!((diff.added, diff.removed), (1, 1));
    let out = execute(prepared, &f.ctx());
    assert!(out.ok, "{}", out.summary);
    assert_eq!(out.summary, "Added 1 line, removed 1 line");
    let bytes = fs::read(f.ws.root().join("src/main.py")).expect("read");
    assert_eq!(
        bytes,
        b"def add(a, b):\r\n    return a + b\r\n\r\nprint(add(2, 3))\r\n"
    );
    let change = out.change.expect("change");
    assert_eq!(change.kind, ChangeKind::Modified);
    assert!(change.before.expect("before").starts_with(b"def add"));
}

#[test]
fn an_edit_is_refused_when_the_file_changed_after_it_was_shown() {
    let f = Fixture::new();
    let prepared = prepare(
        "edit_file",
        &json!({"path": "README.md", "old_string": "# App", "new_string": "# My App"}).to_string(),
        &f.ctx(),
        false,
    );
    fs::write(f.ws.root().join("README.md"), "# App\nsaved by the user\n").expect("write");
    let out = execute(prepared, &f.ctx());
    assert!(!out.ok);
    assert!(out.summary.contains("changed after the edit was prepared"));
    assert_eq!(
        fs::read_to_string(f.ws.root().join("README.md")).expect("read"),
        "# App\nsaved by the user\n"
    );
}

#[test]
fn files_with_unsaved_editor_changes_are_left_alone() {
    let mut f = Fixture::new();
    let readme = f.ws.root().join("README.md");
    f.unsaved = vec![std::path::PathBuf::from(
        readme.to_string_lossy().to_uppercase(),
    )];
    let out = f.run(
        "edit_file",
        json!({"path": "README.md", "old_string": "# App", "new_string": "# X"}),
    );
    #[cfg(windows)]
    assert!(out.summary.contains("unsaved changes"), "{}", out.summary);
    #[cfg(not(windows))]
    let _ = out;
    f.unsaved = vec![readme];
    let delete = execute(
        prepare(
            "delete_file",
            &json!({"path": "README.md"}).to_string(),
            &f.ctx(),
            false,
        ),
        &f.ctx(),
    );
    assert!(delete.summary.contains("unsaved changes"));
    assert!(f.ws.root().join("README.md").exists());
}

#[test]
fn ambiguous_or_missing_text_is_explained_to_the_model() {
    let f = Fixture::new();
    fs::write(f.ws.root().join("x.txt"), "a\na\n").expect("write");
    let twice = f.run(
        "edit_file",
        json!({"path": "x.txt", "old_string": "a", "new_string": "b"}),
    );
    assert!(twice.for_model.contains("appears 2 times"));
    let all = f.run(
        "edit_file",
        json!({"path": "x.txt", "old_string": "a", "new_string": "b", "replace_all": true}),
    );
    assert!(all.ok);
    let missing = f.run(
        "edit_file",
        json!({"path": "x.txt", "old_string": "zzz", "new_string": "b"}),
    );
    assert!(missing.for_model.contains("was not found"));
}

#[test]
fn write_file_creates_folders_inside_the_project_only() {
    let f = Fixture::new();
    let out = f.run(
        "write_file",
        json!({"path": "src/utils/math.py", "content": "PI = 3.14\n"}),
    );
    assert!(out.ok);
    assert_eq!(
        out.change.as_ref().map(|c| c.kind),
        Some(ChangeKind::Created)
    );
    assert_eq!(
        fs::read_to_string(f.ws.root().join("src/utils/math.py")).expect("read"),
        "PI = 3.14\n"
    );
    let outside = f.run("write_file", json!({"path": "../evil.txt", "content": "x"}));
    assert!(!outside.ok);
    assert!(outside.summary.contains("outside the open folder"));
    let git = f.run(
        "write_file",
        json!({"path": ".git/hooks/pre-commit", "content": "x"}),
    );
    assert!(!git.ok);
}

#[test]
fn delete_is_prepared_with_what_was_there() {
    let f = Fixture::new();
    let prepared = prepare(
        "delete_file",
        &json!({"path": "README.md"}).to_string(),
        &f.ctx(),
        false,
    );
    assert_eq!(prepared.kind, ToolKind::Delete);
    assert_eq!(prepared.diff.as_ref().map(|d| d.removed), Some(1));
    assert!(!prepared.is_finished());
    let none = prepare(
        "delete_file",
        &json!({"path": "nope.txt"}).to_string(),
        &f.ctx(),
        false,
    );
    assert!(none.is_finished());
}

#[test]
fn plan_mode_refuses_every_change() {
    let f = Fixture::new();
    for (name, args) in [
        (
            "edit_file",
            json!({"path": "README.md", "old_string": "#", "new_string": "##"}),
        ),
        ("write_file", json!({"path": "a.txt", "content": "x"})),
        ("delete_file", json!({"path": "README.md"})),
        ("run_command", json!({"command": "echo hi"})),
    ] {
        let prepared = prepare(name, &args.to_string(), &f.ctx(), true);
        let out = execute(prepared, &f.ctx());
        assert!(out.summary.contains("Plan mode"), "{name}");
    }
    let specs = specs(true);
    let names: Vec<&str> = specs
        .as_array()
        .expect("array")
        .iter()
        .filter_map(|s| {
            s.pointer("/function/name")
                .and_then(serde_json::Value::as_str)
        })
        .collect();
    assert!(names.contains(&"read_file") && !names.contains(&"edit_file"));
}

#[test]
fn listing_finding_and_searching_stay_in_the_project() {
    let f = Fixture::new();
    fs::create_dir_all(f.ws.root().join("node_modules/x")).expect("mkdir");
    fs::write(f.ws.root().join("node_modules/x/index.py"), "return a - b").expect("write");
    let listed = f.run("list_dir", json!({}));
    assert!(listed.for_model.contains("src/"));
    assert!(listed.for_model.contains("node_modules/ (not opened"));
    let found = f.run("find_files", json!({"pattern": "**/*.py"}));
    assert_eq!(found.for_model, "src/main.py");
    let hits = f.run("search", json!({"query": "a - b"}));
    assert!(hits.for_model.contains("src/main.py:2:"));
    assert!(!hits.for_model.contains("node_modules"));
}

#[test]
fn broken_arguments_and_unknown_tools_get_a_clear_answer() {
    let f = Fixture::new();
    let bad = execute(prepare("read_file", "{not json", &f.ctx(), false), &f.ctx());
    assert!(bad.for_model.contains("not a JSON object"));
    let unknown = f.run("format_disk", json!({}));
    assert!(unknown.for_model.contains("no tool called"));
}

#[cfg(windows)]
#[test]
fn run_command_runs_in_the_project_folder_and_reports_the_exit_code() {
    let f = Fixture::new();
    let out = f.run(
        "run_command",
        json!({"command": "Write-Output \"bāṅlā ok\"; (Get-Location).Path"}),
    );
    assert!(out.ok, "{}", out.for_model);
    assert!(out.for_model.contains("bāṅlā ok"));
    assert!(out.for_model.contains("my app"));
    let failed = f.run("run_command", json!({"command": "cmd /c exit 3"}));
    assert!(!failed.ok);
    assert!(failed.summary.starts_with("Exit code 3"));
}

#[test]
fn todos_are_passed_to_the_panel() {
    let f = Fixture::new();
    let out = f.run(
        "todo_write",
        json!({"todos": [{"content": "Fix add", "status": "completed"}, {"content": "Run tests", "status": "pending"}]}),
    );
    assert_eq!(out.todos.map(|t| t.len()), Some(2));
}
