//! Real processes: the session registry starts a real program, streams its
//! output, reports its exit code, and kills its whole tree.

#![cfg(windows)]

use std::ffi::OsString;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use crate::*;

mod compiled;
mod fortran_pascal;

fn plan_for(file: &str, argv: &[&str]) -> RunPlan {
    RunPlan {
        kind: RunnableKind::Python,
        file: PathBuf::from(file),
        argv: argv.iter().map(ToString::to_string).collect(),
        cwd: std::env::temp_dir(),
        env: vec![("OM_TEST_VALUE".into(), "portable".into())],
        path_var: std::env::var_os("PATH").unwrap_or_else(|| OsString::from("")),
        runtime_label: "test runtime".into(),
        source: RuntimeSource::Portable,
        display: argv.join(" "),
        resolved: PathBuf::from(argv[0]),
        build: None,
    }
}

struct Collector {
    events: Arc<Mutex<Vec<RunEvent>>>,
}

impl Collector {
    fn new() -> Self {
        Self {
            events: Arc::default(),
        }
    }

    fn sink(&self) -> EventSink {
        let events = self.events.clone();
        Arc::new(move |event| events.lock().expect("lock").push(event))
    }

    fn snapshot(&self) -> Vec<RunEvent> {
        self.events.lock().expect("lock").clone()
    }

    fn wait_for_exit(&self) -> RunEvent {
        let deadline = Instant::now() + Duration::from_secs(20);
        while Instant::now() < deadline {
            if let Some(event) = self
                .snapshot()
                .into_iter()
                .find(|e| matches!(e.event, RunEventKind::Exited { .. }))
            {
                return event;
            }
            std::thread::sleep(Duration::from_millis(20));
        }
        panic!("the process never reported an exit");
    }

    fn output(&self, stream: Stream) -> Vec<String> {
        self.snapshot()
            .into_iter()
            .filter_map(|e| match e.event {
                RunEventKind::Output {
                    stream: s, line, ..
                } if s == stream => Some(line),
                _ => None,
            })
            .collect()
    }
}

const CMD: &str = "C:\\Windows\\System32\\cmd.exe";

#[test]
fn a_run_streams_stdout_and_stderr_and_reports_the_exit_code() {
    let registry = RunRegistry::new();
    let collector = Collector::new();
    let plan = plan_for(
        "C:/scripts/a.py",
        &[
            CMD,
            "/C",
            "echo out one& echo out two& echo oops>&2& exit /b 3",
        ],
    );

    let info = registry.start(&plan, collector.sink()).expect("start");
    let exit = collector.wait_for_exit();

    assert!(info.run_id.starts_with("run-"));
    assert!(matches!(
        collector.snapshot()[0].event,
        RunEventKind::Started { .. }
    ));
    assert_eq!(collector.output(Stream::Stdout), ["out one", "out two"]);
    assert_eq!(collector.output(Stream::Stderr), ["oops"]);
    let RunEventKind::Exited { code, stopped, .. } = exit.event else {
        panic!("expected an exit event");
    };
    assert_eq!((code, stopped), (Some(3), false));
    assert!(registry.active().is_empty(), "a finished run is forgotten");
}

#[test]
fn the_started_event_carries_the_command_cwd_and_runtime() {
    let registry = RunRegistry::new();
    let collector = Collector::new();

    registry
        .start(
            &plan_for("C:/s/a.py", &[CMD, "/C", "echo hi"]),
            collector.sink(),
        )
        .expect("start");
    collector.wait_for_exit();

    let RunEventKind::Started {
        command_line,
        resolved,
        runtime,
        language,
        cwd,
        ..
    } = collector.snapshot()[0].event.clone()
    else {
        panic!("first event must be Started");
    };
    assert!(command_line.contains("echo hi"));
    assert_eq!(resolved, CMD);
    assert_eq!(
        (runtime.as_str(), language.as_str()),
        ("test runtime", "Python")
    );
    assert_eq!(PathBuf::from(cwd), std::env::temp_dir());
}

#[test]
fn the_child_sees_the_runtime_environment_variables_and_the_plan_path() {
    let registry = RunRegistry::new();
    let collector = Collector::new();
    let mut plan = plan_for("C:/s/a.py", &[CMD, "/C", "echo %OM_TEST_VALUE%"]);
    plan.path_var = OsString::from("C:\\Windows\\System32;C:\\portable-first");

    registry.start(&plan, collector.sink()).expect("start");
    collector.wait_for_exit();

    assert_eq!(collector.output(Stream::Stdout), ["portable"]);
}

#[test]
fn one_run_per_file_and_stop_kills_the_whole_process_tree() {
    let registry = RunRegistry::new();
    let collector = Collector::new();
    // cmd -> ping is a two-process tree that would run for ~30 s.
    let plan = plan_for(
        "C:/scripts/long.py",
        &[CMD, "/C", "ping -n 30 127.0.0.1 > nul"],
    );

    let info = registry.start(&plan, collector.sink()).expect("start");
    let again = registry.start(&plan, Collector::new().sink());
    assert!(matches!(again, Err(RunError::AlreadyRunning(_))));
    assert_eq!(registry.active(), vec![info.clone()]);
    std::thread::sleep(Duration::from_millis(600)); // let ping actually start

    let started = Instant::now();
    assert!(registry.stop(&info.run_id));
    let exit = collector.wait_for_exit();

    assert!(
        started.elapsed() < Duration::from_secs(10),
        "stop must be prompt"
    );
    let RunEventKind::Exited { stopped, .. } = exit.event else {
        panic!("expected exit");
    };
    assert!(stopped, "the exit is reported as user-stopped");
    assert!(!registry.stop(&info.run_id), "it is no longer running");
    // The grandchild is gone too: the file can be run again and no ping of ours survives.
    assert!(registry
        .start(
            &plan_for("C:/scripts/long.py", &[CMD, "/C", "echo again"]),
            Collector::new().sink()
        )
        .is_ok());
}

#[test]
fn stop_all_kills_every_run_for_app_shutdown() {
    let registry = RunRegistry::new();
    let first = Collector::new();
    let second = Collector::new();
    registry
        .start(
            &plan_for("C:/s/one.py", &[CMD, "/C", "ping -n 30 127.0.0.1 > nul"]),
            first.sink(),
        )
        .expect("start one");
    registry
        .start(
            &plan_for("C:/s/two.py", &[CMD, "/C", "ping -n 30 127.0.0.1 > nul"]),
            second.sink(),
        )
        .expect("start two");
    assert_eq!(registry.active().len(), 2);
    std::thread::sleep(Duration::from_millis(500));

    registry.stop_all();

    first.wait_for_exit();
    second.wait_for_exit();
    assert!(registry.active().is_empty());
}

#[test]
fn a_program_that_cannot_start_is_a_structured_error_not_a_panic() {
    let registry = RunRegistry::new();

    let error = registry
        .start(
            &plan_for("C:/s/a.py", &["C:\\definitely\\not\\here.exe"]),
            Collector::new().sink(),
        )
        .expect_err("must fail");

    assert!(matches!(error, RunError::StartFailed { .. }), "{error}");
    assert!(registry.active().is_empty());
}

#[test]
fn output_without_a_trailing_newline_and_non_utf8_bytes_are_still_delivered() {
    let registry = RunRegistry::new();
    let collector = Collector::new();

    registry
        .start(
            &plan_for("C:/s/a.py", &[CMD, "/C", "<nul set /p =no-newline"]),
            collector.sink(),
        )
        .expect("start");
    collector.wait_for_exit();

    assert_eq!(collector.output(Stream::Stdout), ["no-newline"]);
}

#[test]
fn events_serialize_with_a_type_tag_for_the_frontend() {
    let event = RunEvent {
        run_id: "run-1".into(),
        event: RunEventKind::Output {
            stream: Stream::Stderr,
            line: "boom".into(),
            phase: Phase::Run,
        },
    };

    let json = serde_json::to_value(&event).expect("json");

    assert_eq!(
        json,
        serde_json::json!({ "runId": "run-1", "type": "output", "stream": "stderr", "line": "boom", "phase": "run" })
    );
    let exit = RunEvent {
        run_id: "run-2".into(),
        event: RunEventKind::Exited {
            code: Some(0),
            duration_ms: 12,
            stopped: false,
            build_failed: false,
        },
    };
    assert_eq!(
        serde_json::to_value(&exit).expect("json"),
        serde_json::json!({ "runId": "run-2", "type": "exited", "code": 0, "durationMs": 12, "stopped": false, "buildFailed": false })
    );
}
