//! The Claude Code-style tools: several edits in one change, moving files, a terminal whose working directory carries
//! over, and background commands that are read and stopped later.

use std::time::{Duration, Instant};

use super::*;

#[test]
fn multi_edit_applies_every_edit_or_none() {
    let f = Fixture::new();
    let out = f.run(
        "multi_edit",
        json!({"path": "src/main.py", "edits": [
            {"old_string": "a - b", "new_string": "a + b"},
            {"old_string": "print(add(2, 3))", "new_string": "print(add(2, 40))"}
        ]}),
    );
    assert!(out.ok, "{}", out.for_model);
    let text = fs::read_to_string(f.ws.root().join("src/main.py")).expect("read");
    assert!(text.contains("a + b") && text.contains("add(2, 40)"));
    assert!(text.contains("\r\n"), "the file keeps its line endings");

    let before = fs::read(f.ws.root().join("src/main.py")).expect("read");
    let failed = f.run(
        "multi_edit",
        json!({"path": "src/main.py", "edits": [
            {"old_string": "a + b", "new_string": "a * b"},
            {"old_string": "not in the file", "new_string": "x"}
        ]}),
    );
    assert!(!failed.ok);
    assert!(
        failed.for_model.contains("Edit 2 of 2"),
        "{}",
        failed.for_model
    );
    assert_eq!(
        fs::read(f.ws.root().join("src/main.py")).expect("read"),
        before,
        "nothing was changed"
    );
}

#[test]
fn move_file_moves_into_new_folders_and_records_both_places_for_undo() {
    let f = Fixture::new();
    let out = f.run(
        "move_file",
        json!({"from": "README.md", "to": "docs/guide/README.md"}),
    );
    assert!(out.ok, "{}", out.for_model);
    assert!(!f.ws.root().join("README.md").exists());
    assert_eq!(
        fs::read_to_string(f.ws.root().join("docs/guide/README.md")).expect("read"),
        "# App\n"
    );
    let created = out.change.expect("the new place");
    assert_eq!(
        (created.kind, created.rel.as_str()),
        (ChangeKind::Created, "docs/guide/README.md")
    );
    let [moved_away] = out.more_changes.as_slice() else {
        panic!("one more change: the old place");
    };
    assert_eq!(moved_away.kind, ChangeKind::Deleted);
    assert_eq!(moved_away.before.as_deref(), Some(b"# App\n".as_slice()));
}

#[test]
fn move_file_never_overwrites_and_refuses_folders_unsaved_files_and_the_outside() {
    let mut f = Fixture::new();
    fs::write(f.ws.root().join("other.md"), "keep me").expect("write");
    let over = f.run("move_file", json!({"from": "README.md", "to": "other.md"}));
    assert!(!over.ok && over.for_model.contains("never overwritten"));
    assert_eq!(
        fs::read_to_string(f.ws.root().join("other.md")).expect("read"),
        "keep me"
    );
    assert!(
        !f.run("move_file", json!({"from": "src", "to": "source"}))
            .ok,
        "folders are not moved"
    );
    assert!(
        !f.run(
            "move_file",
            json!({"from": "README.md", "to": "../outside.md"})
        )
        .ok
    );
    assert!(
        !f.run("move_file", json!({"from": "missing.md", "to": "x.md"}))
            .ok
    );
    f.unsaved.push(f.ws.root().join("README.md"));
    let unsaved = f.run("move_file", json!({"from": "README.md", "to": "moved.md"}));
    assert!(!unsaved.ok && unsaved.for_model.contains("unsaved"));
    assert!(f.ws.root().join("README.md").exists());
}

#[test]
fn a_cd_carries_over_to_the_next_command_but_never_out_of_the_project() {
    let f = Fixture::new();
    let first = f.run("run_command", json!({"command": "cd src"}));
    assert!(first.ok, "{}", first.for_model);
    assert!(
        first.for_model.contains("The next command starts in src"),
        "{}",
        first.for_model
    );
    assert!(
        !first.for_model.contains("OPENMIND_CWD"),
        "the marker never reaches the model"
    );
    let second = f.run(
        "run_command",
        json!({"command": "echo here > made-here.txt"}),
    );
    assert!(second.ok, "{}", second.for_model);
    assert!(f.ws.root().join("src/made-here.txt").exists(), "ran in src");

    let out = f.run("run_command", json!({"command": "cd ../.."}));
    assert!(
        out.for_model.contains("outside the project folder"),
        "{}",
        out.for_model
    );
    let back = f.run("run_command", json!({"command": "echo root > at-root.txt"}));
    assert!(back.ok, "{}", back.for_model);
    assert!(
        f.ws.root().join("at-root.txt").exists(),
        "back in the project folder"
    );
}

fn wait_for(f: &Fixture, id: &str, wanted: &str) -> String {
    let started = Instant::now();
    let mut seen = String::new();
    while started.elapsed() < Duration::from_secs(20) {
        let out = f.run("command_output", json!({"id": id}));
        seen.push_str(&out.for_model);
        if seen.contains(wanted) {
            return seen;
        }
        std::thread::sleep(Duration::from_millis(200));
    }
    panic!("never saw {wanted:?} in {seen}");
}

#[test]
fn a_background_command_runs_on_its_output_is_read_in_parts_and_it_is_stopped() {
    let f = Fixture::new();
    let command = if cfg!(windows) {
        "Write-Output 'server ready'; Start-Sleep -Seconds 60"
    } else {
        "echo 'server ready'; sleep 60"
    };
    let started = Instant::now();
    let out = f.run(
        "run_command",
        json!({"command": command, "run_in_background": true}),
    );
    assert!(out.ok, "{}", out.for_model);
    assert!(
        started.elapsed() < Duration::from_secs(10),
        "returns at once"
    );
    assert!(out.for_model.contains("bg-1"));
    let seen = wait_for(&f, "bg-1", "server ready");
    assert!(seen.contains("is running"));
    let again = f.run("command_output", json!({"id": "bg-1"}));
    assert!(
        again.for_model.contains("(no new output)"),
        "only new output is handed over: {}",
        again.for_model
    );
    assert_eq!(f.shell.running().len(), 1);

    let stopped = f.run("kill_command", json!({"id": "bg-1"}));
    assert!(
        stopped.ok && stopped.summary.contains("Stopped bg-1"),
        "{}",
        stopped.for_model
    );
    assert!(f.shell.running().is_empty());
    assert!(f
        .run("command_output", json!({"id": "bg-1"}))
        .for_model
        .contains("ended"));
    assert!(!f.run("command_output", json!({"id": "bg-9"})).ok);
}

#[test]
fn stopping_the_shell_stops_its_background_commands() {
    let f = Fixture::new();
    let command = if cfg!(windows) {
        "Start-Sleep -Seconds 60"
    } else {
        "sleep 60"
    };
    let shell = Shell::new();
    let ctx = ToolContext {
        shell: &shell,
        ..f.ctx()
    };
    let prepared = prepare(
        "run_command",
        &json!({"command": command, "run_in_background": true}).to_string(),
        &ctx,
        false,
    );
    assert!(execute(prepared, &ctx).ok);
    assert_eq!(shell.running().len(), 1);
    shell.kill_all();
    assert!(shell.running().is_empty());
}

#[cfg(windows)]
#[test]
fn powershell_errors_reach_the_model_as_text_not_clixml() {
    let f = Fixture::new();
    let out = f.run(
        "run_command",
        json!({"command": "Write-Error 'boom here'; exit 3"}),
    );
    assert!(!out.ok);
    assert!(out.for_model.contains("boom here"), "{}", out.for_model);
    assert!(!out.for_model.contains("CLIXML"), "{}", out.for_model);
    assert!(
        !out.for_model.contains("OutputEncoding"),
        "no wrapper lines: {}",
        out.for_model
    );
    assert!(
        !out.for_model.contains("&lt;"),
        "unescaped: {}",
        out.for_model
    );
    assert!(out.summary.starts_with("Exit code 3"), "{}", out.summary);
}

/// Needs the internet: `cargo test -p openmind-agent real_web_fetch -- --ignored`.
#[test]
#[ignore = "fetches https://example.com over the network"]
fn real_web_fetch_reads_a_page_as_text() {
    let f = Fixture::new();
    let out = f.run("web_fetch", json!({"url": "http://example.com"}));
    assert!(out.ok, "{}", out.for_model);
    assert!(
        out.for_model.contains("Content of https://example.com"),
        "{}",
        out.for_model
    );
    assert!(
        out.for_model.contains("Example Domain"),
        "{}",
        out.for_model
    );
    assert!(!out.for_model.contains("<html"), "markup removed");
}
