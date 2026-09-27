//! Drives the real debug adapters. Ignored by default: they need a Python/Node on PATH and the
//! adapters unpacked (set `OPENMIND_DEBUGPY_DIR` to the folder that contains `debugpy/`, and
//! `OPENMIND_JSDEBUG_DIR` to the extracted `js-debug/` folder). Example:
//! `cargo test -p openmind-dap --test real_debug -- --ignored --nocapture`.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use openmind_dap::{
    default_configs, evaluate_arguments, parse_evaluate, parse_scopes, parse_stack_frames,
    parse_variables, resolve_interpreter, Control, DapEvents, DapManager, RunSnapshot, RunState,
    StartRequest, Target,
};
use openmind_lsp::LogLevel;
use serde_json::{json, Value};

#[derive(Default)]
struct Sink {
    states: Mutex<Vec<RunSnapshot>>,
    events: Mutex<Vec<(String, Value)>>,
    logs: Mutex<Vec<String>>,
}

impl DapEvents for Sink {
    fn event(&self, name: &str, body: &Value) {
        self.events
            .lock()
            .expect("lock")
            .push((name.into(), body.clone()));
    }
    fn state(&self, snapshot: &RunSnapshot) {
        self.states.lock().expect("lock").push(snapshot.clone());
    }
    fn log(&self, _: LogLevel, text: &str) {
        self.logs.lock().expect("lock").push(text.into());
    }
}

fn wait_for(what: &str, mut probe: impl FnMut() -> bool) {
    let deadline = Instant::now() + Duration::from_secs(60);
    while !probe() {
        assert!(Instant::now() < deadline, "timed out waiting for {what}");
        std::thread::sleep(Duration::from_millis(100));
    }
}

fn state_of(manager: &DapManager) -> Option<RunState> {
    manager.snapshot().map(|snapshot| snapshot.state)
}

fn stdout_of(sink: &Sink) -> String {
    sink.events
        .lock()
        .expect("lock")
        .iter()
        .filter(|(name, body)| name == "output" && body["category"] == "stdout")
        .filter_map(|(_, body)| body["output"].as_str().map(str::to_string))
        .collect()
}

fn debug_file(
    target: Target,
    file_name: &str,
    source: &str,
    adapter_env: &str,
    break_line: u32,
    expect_var: &str,
) {
    let Some(adapter_dir) = std::env::var_os(adapter_env).map(PathBuf::from) else {
        eprintln!("{adapter_env} is not set; skipping");
        return;
    };
    let root = tempfile::tempdir().expect("tempdir");
    let workspace = root.path().join("My Site");
    std::fs::create_dir_all(&workspace).expect("workspace");
    let file = workspace.join(file_name);
    std::fs::write(&file, source).expect("source");
    let program = file.display().to_string();
    let interpreter =
        resolve_interpreter(target, &[], std::env::var_os("PATH")).expect("interpreter on PATH");
    let sink = Arc::new(Sink::default());
    let manager = DapManager::new(sink.clone());
    let mut config = default_configs(&program, Some(&workspace.display().to_string())).remove(0);
    config.cwd = Some(workspace.display().to_string());
    let mut breakpoints = HashMap::new();
    breakpoints.insert(
        program.clone(),
        vec![openmind_dap::SourceBreakpoint::at(break_line)],
    );
    manager
        .start(StartRequest {
            config,
            interpreter,
            adapter_dir,
            adapter_cwd: workspace.clone(),
            path_prepend: vec![],
            vars: vec![],
            breakpoints,
        })
        .expect("start");

    wait_for("the breakpoint", || {
        matches!(
            state_of(&manager),
            Some(RunState::Stopped { .. }) | Some(RunState::Terminated { .. })
        )
    });
    let Some(RunState::Stopped { stopped }) = state_of(&manager) else {
        panic!(
            "did not stop: {:?}\n{}",
            state_of(&manager),
            sink.logs.lock().expect("lock").join("\n")
        );
    };
    assert_eq!(stopped.reason, "breakpoint");
    let thread_id = stopped.thread_id.unwrap_or(0);

    let stack = manager
        .request("stackTrace", &json!({ "threadId": thread_id }))
        .expect("stackTrace");
    let frames = parse_stack_frames(&stack);
    assert_eq!(frames[0].line, break_line);
    assert!(frames[0]
        .path
        .as_deref()
        .is_some_and(|p| p.to_lowercase().ends_with(file_name)));
    let scopes = parse_scopes(
        &manager
            .request("scopes", &json!({ "frameId": frames[0].id }))
            .expect("scopes"),
    );
    let variables = parse_variables(
        &manager
            .request(
                "variables",
                &json!({ "variablesReference": scopes[0].variables_reference }),
            )
            .expect("variables"),
    );
    assert!(
        variables.iter().any(|v| v.name == expect_var),
        "{variables:?}"
    );
    let evaluated = parse_evaluate(
        &manager
            .request(
                "evaluate",
                &evaluate_arguments(expect_var, Some(frames[0].id), "repl"),
            )
            .expect("evaluate"),
    );
    assert!(!evaluated.result.is_empty());

    manager.control(Control::StepOver).expect("step over");
    wait_for("the step", || {
        matches!(state_of(&manager), Some(RunState::Stopped { .. }))
    });
    manager.control(Control::Continue).expect("continue");
    wait_for("the end", || {
        matches!(state_of(&manager), Some(RunState::Terminated { .. }))
    });
    assert!(matches!(
        state_of(&manager),
        Some(RunState::Terminated { error: None })
    ));
    assert!(
        stdout_of(&sink).contains("result"),
        "stdout: {}",
        stdout_of(&sink)
    );
    manager.stop();
    println!("{}", sink.logs.lock().expect("lock").join("\n"));
}

#[test]
#[ignore = "needs Python on PATH and debugpy unpacked"]
fn python_stops_at_a_breakpoint_steps_and_finishes() {
    debug_file(
        Target::Python,
        "tool.py",
        "def greet(name):\n    msg = \"hi \" + name\n    return msg\n\nvalue = greet(\"x\")\nprint(\"result\", value)\n",
        "OPENMIND_DEBUGPY_DIR",
        2,
        "name",
    );
}

#[test]
#[ignore = "needs Node on PATH and js-debug unpacked"]
fn node_stops_at_a_breakpoint_steps_and_finishes() {
    debug_file(
        Target::Node,
        "app.js",
        "function add(a, b) {\n  const s = a + b;\n  return s;\n}\nconst r = add(1, 2);\nconsole.log(\"result\", r);\n",
        "OPENMIND_JSDEBUG_DIR",
        2,
        "a",
    );
}

#[test]
#[ignore = "needs Python on PATH and debugpy unpacked"]
fn stopping_a_running_program_ends_it_and_the_adapter() {
    let Some(adapter_dir) = std::env::var_os("OPENMIND_DEBUGPY_DIR").map(PathBuf::from) else {
        return;
    };
    let root = tempfile::tempdir().expect("tempdir");
    let workspace = root.path().join("My Site");
    std::fs::create_dir_all(&workspace).expect("workspace");
    let file = workspace.join("loop.py");
    std::fs::write(&file, "import time\nwhile True:\n    time.sleep(0.2)\n").expect("source");
    let program = file.display().to_string();
    let interpreter =
        resolve_interpreter(Target::Python, &[], std::env::var_os("PATH")).expect("python");
    let sink = Arc::new(Sink::default());
    let manager = DapManager::new(sink.clone());
    let mut config = default_configs(&program, None).remove(0);
    config.cwd = Some(workspace.display().to_string());
    let snapshot = manager
        .start(StartRequest {
            config,
            interpreter,
            adapter_dir,
            adapter_cwd: workspace.clone(),
            path_prepend: vec![],
            vars: vec![],
            breakpoints: HashMap::new(),
        })
        .expect("start");
    let adapter_pid = snapshot.pid.expect("pid");
    wait_for("running", || {
        matches!(state_of(&manager), Some(RunState::Running))
    });
    manager.stop();
    assert!(matches!(
        state_of(&manager),
        Some(RunState::Terminated { .. })
    ));
    std::thread::sleep(Duration::from_millis(1500));
    #[cfg(windows)]
    {
        let out = std::process::Command::new("tasklist")
            .args(["/FI", &format!("PID eq {adapter_pid}"), "/NH"])
            .output()
            .expect("tasklist");
        assert!(!String::from_utf8_lossy(&out.stdout).contains(&adapter_pid.to_string()));
        let all = std::process::Command::new("wmic")
            .args([
                "process",
                "where",
                "name='python.exe'",
                "get",
                "CommandLine",
            ])
            .output();
        if let Ok(all) = all {
            assert!(
                !String::from_utf8_lossy(&all.stdout).contains("loop.py"),
                "the program is still running"
            );
        }
    }
}
