use std::collections::VecDeque;
use std::fs;
use std::sync::Mutex;

use serde_json::json;

use super::*;

/// Answers each request with the next scripted reply (a list of stream lines).
struct Script {
    replies: Mutex<VecDeque<Vec<String>>>,
    requests: Mutex<Vec<Value>>,
}

impl Script {
    fn new(replies: Vec<Vec<String>>) -> Self {
        Self {
            replies: Mutex::new(replies.into()),
            requests: Mutex::new(Vec::new()),
        }
    }
}

impl ModelClient for Script {
    fn stream(
        &self,
        body: &Value,
        _cancel: &AtomicBool,
        on_line: &mut dyn FnMut(&str) -> bool,
    ) -> Result<(), String> {
        self.requests.lock().expect("lock").push(body.clone());
        let reply = self
            .replies
            .lock()
            .expect("lock")
            .pop_front()
            .ok_or("no more replies")?;
        for line in reply {
            if !on_line(&line) {
                break;
            }
        }
        Ok(())
    }
}

struct Panel {
    events: Mutex<Vec<AgentEvent>>,
    answers: Mutex<VecDeque<Decision>>,
    asked: Mutex<Vec<PermissionRequest>>,
}

impl Panel {
    fn new(answers: Vec<Decision>) -> Self {
        Self {
            events: Mutex::new(Vec::new()),
            answers: Mutex::new(answers.into()),
            asked: Mutex::new(Vec::new()),
        }
    }

    fn end(&self) -> String {
        self.events
            .lock()
            .expect("lock")
            .iter()
            .rev()
            .find_map(|e| match e {
                AgentEvent::TurnEnd { reason, .. } => Some(reason.clone()),
                _ => None,
            })
            .unwrap_or_default()
    }
}

impl AgentHost for Panel {
    fn emit(&self, event: AgentEvent) {
        self.events.lock().expect("lock").push(event);
    }

    fn ask(&self, request: PermissionRequest, _cancel: &AtomicBool) -> Decision {
        self.asked.lock().expect("lock").push(request);
        self.answers
            .lock()
            .expect("lock")
            .pop_front()
            .unwrap_or(Decision::Deny { feedback: None })
    }
}

fn call(id: &str, name: &str, args: serde_json::Value) -> Vec<String> {
    let chunk = json!({"choices": [{"delta": {"tool_calls": [{"index": 0, "id": id, "function": {"name": name, "arguments": args.to_string()}}]}}]});
    vec![
        format!("data: {chunk}"),
        r#"data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}]}"#.into(),
        "data: [DONE]".into(),
    ]
}

/// Multiple independent function calls returned by one model response.
fn batch_calls(specs: &[(&str, &str, Value)]) -> Vec<String> {
    let items: Vec<Value> = specs
        .iter()
        .enumerate()
        .map(|(index, (id, name, args))| {
            json!({
                "index": index,
                "id": id,
                "function": {"name": name, "arguments": args.to_string()}
            })
        })
        .collect();
    let chunk = json!({"choices": [{"delta": {"tool_calls": items}}]});
    vec![
        format!("data: {chunk}"),
        r#"data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}]}"#.into(),
        "data: [DONE]".into(),
    ]
}

fn say(text: &str) -> Vec<String> {
    let chunk = json!({"choices": [{"delta": {"content": text}, "finish_reason": "stop"}]});
    vec![format!("data: {chunk}"), "data: [DONE]".into()]
}

struct Project {
    _dir: tempfile::TempDir,
    ws: Workspace,
    env: CommandEnv,
    cancel: AtomicBool,
}

impl Project {
    fn new() -> Self {
        let dir = tempfile::tempdir().expect("tmp");
        fs::write(
            dir.path().join("main.py"),
            "def add(a, b):\n    return a - b\n",
        )
        .expect("write");
        let ws = Workspace::new(dir.path()).expect("ws");
        Self {
            _dir: dir,
            ws,
            env: CommandEnv::default(),
            cancel: AtomicBool::new(false),
        }
    }

    fn input(&self) -> TurnInput<'_> {
        TurnInput {
            ws: &self.ws,
            env: &self.env,
            unsaved: &[],
            cancel: &self.cancel,
        }
    }

    fn text(&self) -> String {
        fs::read_to_string(self.ws.root().join("main.py")).expect("read")
    }
}

fn session(mode: Mode) -> Session {
    Session::new("system".into(), "nemotron".into(), 32_768, mode)
}

#[test]
fn deferred_turn_preserves_all_output_but_does_not_signal_completion_early() {
    let project = Project::new();
    let model = Script::new(vec![say("The final answer")]);
    let panel = Panel::new(vec![]);
    let mut s = session(Mode::Ask);
    let terminal = s.run_turn_deferred("What happened?", &model, &panel, &project.input());
    assert_eq!(panel.end(), "", "desktop must own the terminal-event timing");
    assert!(panel.events.lock().expect("events").iter().any(|event| {
        matches!(event, AgentEvent::Text { text } if text == "The final answer")
    }));
    assert!(matches!(&terminal, AgentEvent::TurnEnd { reason, .. } if reason == "done"));
    panel.emit(terminal);
    assert_eq!(panel.end(), "done");
    assert_eq!(panel.events.lock().expect("events").iter().filter(|event| {
        matches!(event, AgentEvent::TurnEnd { .. })
    }).count(), 1);
}

#[test]
fn deferred_turn_respects_early_cancellation_without_calling_the_model() {
    let project = Project::new();
    project.cancel.store(true, Ordering::Relaxed);
    let model = Script::new(vec![say("Should not run")]);
    let panel = Panel::new(vec![]);
    let mut s = session(Mode::Ask);
    let terminal = s.run_turn_deferred("Stop now", &model, &panel, &project.input());
    assert!(matches!(terminal, AgentEvent::TurnEnd { ref reason, .. } if reason == "cancelled"));
    assert!(model.requests.lock().expect("requests").is_empty());
    assert_eq!(panel.end(), "");
}

#[test]
fn tiny_text_deltas_are_batched_without_losing_the_answer() {
    let project = Project::new();
    let mut reply: Vec<String> = (0..250)
        .map(|_| r#"data: {"choices":[{"delta":{"content":"x"}}]}"#.to_string())
        .collect();
    reply.push(r#"data: {"choices":[{"delta":{},"finish_reason":"stop"}]}"#.into());
    reply.push("data: [DONE]".into());
    let model = Script::new(vec![reply]);
    let panel = Panel::new(vec![]);
    let mut s = session(Mode::Ask);
    s.run_turn("Give me a long answer", &model, &panel, &project.input());
    assert_eq!(panel.end(), "done");
    let events = panel.events.lock().expect("events");
    let pieces: Vec<&str> = events
        .iter()
        .filter_map(|event| match event {
            AgentEvent::Text { text } => Some(text.as_str()),
            _ => None,
        })
        .collect();
    assert_eq!(pieces.concat(), "x".repeat(250));
    assert!(
        pieces.len() < 20,
        "250 tiny chunks should be coalesced into far fewer UI events"
    );
}

#[test]
fn reasoning_is_flushed_before_text_and_before_usage() {
    let project = Project::new();
    let reply = vec![
        r#"data: {"choices":[{"delta":{"reasoning_content":"think-"}}]}"#.into(),
        r#"data: {"choices":[{"delta":{"reasoning_content":"first"}}]}"#.into(),
        r#"data: {"choices":[{"delta":{"content":"answer-"}}]}"#.into(),
        r#"data: {"choices":[{"delta":{"content":"now"}}]}"#.into(),
        r#"data: {"choices":[],"usage":{"prompt_tokens":20,"completion_tokens":5}}"#.into(),
        r#"data: {"choices":[{"delta":{},"finish_reason":"stop"}]}"#.into(),
        "data: [DONE]".into(),
    ];
    let model = Script::new(vec![reply]);
    let panel = Panel::new(vec![]);
    let mut s = session(Mode::Ask);
    s.run_turn("Answer", &model, &panel, &project.input());
    assert_eq!(panel.end(), "done");
    let events = panel.events.lock().expect("events");
    let order: Vec<&str> = events.iter().filter_map(|event| match event {
        AgentEvent::Reasoning { text } if text == "think-first" => Some("reasoning"),
        AgentEvent::Text { text } if text == "answer-now" => Some("text"),
        AgentEvent::Usage { .. } => Some("usage"),
        AgentEvent::TurnEnd { .. } => Some("end"),
        _ => None,
    }).collect();
    assert_eq!(order, ["reasoning", "text", "usage", "end"]);
}

#[test]
fn request_failure_flushes_buffered_output_before_error() {
    struct BrokenStream;
    impl ModelClient for BrokenStream {
        fn stream(
            &self,
            _body: &Value,
            _cancel: &AtomicBool,
            on_line: &mut dyn FnMut(&str) -> bool,
        ) -> Result<(), String> {
            on_line(r#"data: {"choices":[{"delta":{"content":"partial answer"}}]}"#);
            Err("network lost".into())
        }
    }
    let project = Project::new();
    let panel = Panel::new(vec![]);
    let mut s = session(Mode::Ask);
    s.run_turn("Answer", &BrokenStream, &panel, &project.input());
    assert_eq!(panel.end(), "error");
    let events = panel.events.lock().expect("events");
    assert!(events.iter().any(|event| {
        matches!(event, AgentEvent::Text { text } if text == "partial answer")
    }));
}

#[test]
fn reasoning_budget_is_sent_on_every_model_request() {
    let project = Project::new();
    let model = Script::new(vec![
        call("read", "read_file", json!({"path": "main.py"})),
        say("Answer without excessive thinking"),
    ]);
    let panel = Panel::new(vec![]);
    let mut s = session(Mode::Ask);
    s.set_options(crate::SessionOptions {
        reasoning_budget_tokens: 768,
        max_output_tokens: 2_048,
        ..Default::default()
    });
    s.run_turn("Reply quickly", &model, &panel, &project.input());
    assert_eq!(panel.end(), "done");
    let requests = model.requests.lock().expect("lock");
    assert_eq!(requests.len(), 2);
    for request in requests.iter() {
        assert_eq!(request["thinking_budget_tokens"], 768);
        assert_eq!(request["max_tokens"], 2_048);
    }
}

#[test]
fn disabled_reasoning_still_sends_zero_budget() {
    let project = Project::new();
    let model = Script::new(vec![say("Direct answer")]);
    let panel = Panel::new(vec![]);
    let mut s = session(Mode::Ask);
    s.set_options(crate::SessionOptions {
        reasoning_budget_tokens: 0,
        ..Default::default()
    });
    s.run_turn("Reply", &model, &panel, &project.input());
    assert_eq!(panel.end(), "done");
    let requests = model.requests.lock().expect("lock");
    assert_eq!(requests[0]["thinking_budget_tokens"], 0);
}

#[test]
fn reasoning_only_length_limit_does_not_loop_or_claim_success() {
    let project = Project::new();
    let reasoning_only = r#"data: {"choices":[{"delta":{"reasoning_content":"Still thinking"},"finish_reason":"length"}]}"#;
    let model = Script::new(vec![
        vec![reasoning_only.into(), "data: [DONE]".into()],
        say("This should not be requested"),
    ]);
    let panel = Panel::new(vec![]);
    let mut s = session(Mode::Ask);
    s.run_turn("Reply", &model, &panel, &project.input());
    assert_eq!(panel.end(), "limit");
    assert_eq!(model.requests.lock().expect("lock").len(), 1);
    assert!(panel.events.lock().expect("lock").iter().any(|event| {
        matches!(event, AgentEvent::TurnEnd { message: Some(detail), .. } if detail.contains("reasoning"))
    }));
}

#[test]
fn bounded_scoped_workers_overlap_but_results_remain_in_call_order() {
    use std::sync::atomic::AtomicUsize;
    use std::time::{Duration, Instant};

    let running = AtomicUsize::new(0);
    let peak = AtomicUsize::new(0);
    let results = scoped_map(&[0, 1, 2], |index| {
        let count = running.fetch_add(1, Ordering::SeqCst) + 1;
        peak.fetch_max(count, Ordering::SeqCst);
        let deadline = Instant::now() + Duration::from_secs(2);
        while running.load(Ordering::SeqCst) < 3 && Instant::now() < deadline {
            std::thread::yield_now();
        }
        // Deliberately make the first item finish last. Publish order must
        // still match model tool-call order, not thread completion order.
        if *index == 0 {
            std::thread::sleep(Duration::from_millis(20));
        }
        running.fetch_sub(1, Ordering::SeqCst);
        *index
    });
    assert_eq!(
        results.into_iter().map(|item| item.expect("worker")).collect::<Vec<_>>(),
        vec![0, 1, 2]
    );
    assert!(peak.load(Ordering::SeqCst) >= 2, "reads never overlapped");
}

#[test]
fn independent_reads_retain_order_and_original_model_tool_ids() {
    let project = Project::new();
    fs::write(project.ws.root().join("notes.txt"), "hello notes").expect("write");
    let model = Script::new(vec![
        batch_calls(&[
            ("read_1", "read_file", json!({"path":"main.py"})),
            ("read_2", "read_file", json!({"path":"notes.txt"})),
            ("read_3", "search", json!({"query":"def add"})),
            ("read_4", "list_dir", json!({})),
        ]),
        say("Finished reading."),
    ]);
    let panel = Panel::new(vec![]);
    let mut s = session(Mode::Ask);
    s.run_turn("Inspect project", &model, &panel, &project.input());
    assert_eq!(panel.end(), "done");
    assert!(panel.asked.lock().expect("lock").is_empty());
    let events = panel.events.lock().expect("lock");
    let started: Vec<_> = events.iter().filter_map(|event| match event {
        AgentEvent::ToolStart { id, .. } => Some(id.as_str()),
        _ => None,
    }).collect();
    let finished: Vec<_> = events.iter().filter_map(|event| match event {
        AgentEvent::ToolEnd { id, ok, .. } => {
            assert!(*ok, "read tool {id} failed");
            Some(id.as_str())
        }
        _ => None,
    }).collect();
    assert_eq!(started, ["read_1", "read_2", "read_3", "read_4"]);
    assert_eq!(finished, started);
    let requests = model.requests.lock().expect("lock");
    let messages = requests[1]["messages"].as_array().expect("messages");
    let results: Vec<_> = messages.iter()
        .filter(|message| message["role"] == "tool")
        .map(|message| (
            message["tool_call_id"].as_str().expect("id"),
            message["content"].as_str().expect("content")
        ))
        .collect();
    assert_eq!(results.iter().map(|(id, _)| *id).collect::<Vec<_>>(),
        ["read_1", "read_2", "read_3", "read_4"]);
    assert!(results[0].1.contains("return a - b"));
    assert!(results[1].1.contains("hello notes"));
    assert!(results[2].1.contains("main.py"));
    assert!(results[3].1.contains("notes.txt"));
}

#[test]
fn many_reads_are_processed_in_bounded_batches_without_missing_ids() {
    let project = Project::new();
    let model = Script::new(vec![
        batch_calls(&[
            ("a", "read_file", json!({"path":"main.py"})),
            ("b", "list_dir", json!({})),
            ("c", "find_files", json!({"pattern":"**/*.py"})),
            ("d", "search", json!({"query":"return"})),
            ("e", "read_file", json!({"path":"main.py","offset":1,"limit":1})),
            ("f", "list_dir", json!({})),
        ]),
        say("Listed."),
    ]);
    let panel = Panel::new(vec![]);
    let mut s = session(Mode::Ask);
    s.run_turn("Read project", &model, &panel, &project.input());
    assert_eq!(panel.end(), "done");
    let requests = model.requests.lock().expect("lock");
    let messages = requests[1]["messages"].as_array().expect("messages");
    let ids: Vec<_> = messages.iter()
        .filter(|message| message["role"] == "tool")
        .map(|message| message["tool_call_id"].as_str().expect("id"))
        .collect();
    assert_eq!(ids, ["a", "b", "c", "d", "e", "f"]);
    assert!(panel.asked.lock().expect("lock").is_empty());
}

#[test]
fn edits_and_permission_prompts_remain_between_read_batches() {
    let project = Project::new();
    let model = Script::new(vec![
        batch_calls(&[
            ("r1", "read_file", json!({"path":"main.py"})),
            ("r2", "list_dir", json!({})),
            ("e1", "edit_file", json!({
                "path":"main.py", "old_string":"a - b", "new_string":"a + b"
            })),
            ("r3", "read_file", json!({"path":"main.py"})),
            ("r4", "search", json!({"query":"return a + b"})),
        ]),
        say("Fixed."),
    ]);
    let panel = Panel::new(vec![Decision::Allow]);
    let mut s = session(Mode::Ask);
    s.run_turn("Inspect and fix", &model, &panel, &project.input());
    assert_eq!(panel.end(), "done");
    assert_eq!(panel.asked.lock().expect("lock").len(), 1);
    let requests = model.requests.lock().expect("lock");
    let messages = requests[1]["messages"].as_array().expect("messages");
    let results: Vec<_> = messages.iter()
        .filter(|message| message["role"] == "tool")
        .map(|message| message["content"].as_str().expect("tool content"))
        .collect();
    assert_eq!(results.len(), 5);
    assert!(results[0].contains("return a - b"));
    assert!(results[2].contains("Added 1 line") || results[2].contains("Update"));
    assert!(results[3].contains("return a + b"));
    assert!(results[4].contains("return a + b"));
    assert_eq!(project.text(), "def add(a, b):\n    return a + b\n");
    assert!(s.can_undo());
}

#[test]
fn parallel_path_never_runs_unknown_or_external_tools_as_internal_reads() {
    struct Override(Panel);
    impl AgentHost for Override {
        fn emit(&self, event: AgentEvent) { self.0.emit(event); }
        fn ask(&self, request: PermissionRequest, cancel: &AtomicBool) -> Decision {
            self.0.ask(request, cancel)
        }
        fn external_tools(&self) -> Vec<crate::external::ExternalTool> {
            vec![crate::external::ExternalTool {
                name: "read_file".into(),
                description: "different external source".into(),
                parameters: json!({"type":"object"}),
                kind: tools::ToolKind::Command,
                read_only: true,
            }]
        }
    }
    let host = Override(Panel::new(vec![]));
    let internal = crate::wire::ToolCall {
        id: "r".into(), name: "search".into(), arguments: "{}".into()
    };
    let shadowed = crate::wire::ToolCall {
        id: "e".into(), name: "read_file".into(), arguments: "{}".into()
    };
    let unknown = crate::wire::ToolCall {
        id: "u".into(), name: "invented_read".into(), arguments: "{}".into()
    };
    assert!(is_project_read(&internal, &host));
    assert!(!is_project_read(&shadowed, &host));
    assert!(!is_project_read(&unknown, &host));
}

#[test]
fn cancellation_between_read_batches_skips_mutating_actions() {
    struct CancelHost<'a> {
        panel: Panel,
        cancel: &'a AtomicBool,
    }
    impl AgentHost for CancelHost<'_> {
        fn emit(&self, event: AgentEvent) {
            if let AgentEvent::ToolEnd { ref id, .. } = event {
                if id == "r2" { self.cancel.store(true, Ordering::Relaxed); }
            }
            self.panel.emit(event);
        }
        fn ask(&self, request: PermissionRequest, cancel: &AtomicBool) -> Decision {
            self.panel.ask(request, cancel)
        }
    }
    let project = Project::new();
    let host = CancelHost { panel: Panel::new(vec![]), cancel: &project.cancel };
    let model = Script::new(vec![batch_calls(&[
        ("r1", "read_file", json!({"path":"main.py"})),
        ("r2", "list_dir", json!({})),
        ("write", "write_file", json!({"path":"should_not_exist.txt","content":"bad"})),
    ])]);
    let mut s = session(Mode::Auto);
    s.run_turn("Inspect then mutate", &model, &host, &project.input());
    assert_eq!(host.panel.end(), "cancelled");
    assert!(!project.ws.root().join("should_not_exist.txt").exists());
    assert!(host.panel.asked.lock().expect("lock").is_empty());
}

#[test]
fn the_agent_reads_asks_edits_and_answers() {
    let project = Project::new();
    let model = Script::new(vec![
        call("c1", "read_file", json!({"path": "main.py"})),
        call(
            "c2",
            "edit_file",
            json!({"path": "main.py", "old_string": "a - b", "new_string": "a + b"}),
        ),
        say("Fixed: add() now adds."),
    ]);
    let panel = Panel::new(vec![Decision::Allow]);
    let mut s = session(Mode::Ask);
    s.run_turn("fix add", &model, &panel, &project.input());
    assert_eq!(panel.end(), "done");
    assert_eq!(project.text(), "def add(a, b):\n    return a + b\n");
    let asked = panel.asked.lock().expect("lock");
    assert_eq!(asked.len(), 1, "reading never asks");
    assert_eq!(asked[0].title, "Update");
    assert_eq!(asked[0].diff.as_ref().map(|d| d.added), Some(1));
    // The model saw the file and the edit's result.
    let requests = model.requests.lock().expect("lock");
    assert_eq!(requests.len(), 3);
    let last = requests[2]["messages"].as_array().expect("messages");
    assert!(last.iter().any(|m| m["role"] == "tool"
        && m["content"]
            .as_str()
            .is_some_and(|c| c.contains("return a - b"))));
    assert!(s.can_undo());
}

#[test]
fn declining_an_edit_stops_the_turn_and_changes_nothing() {
    let project = Project::new();
    let model = Script::new(vec![call(
        "c1",
        "edit_file",
        json!({"path": "main.py", "old_string": "a - b", "new_string": "a * b"}),
    )]);
    let panel = Panel::new(vec![Decision::Deny {
        feedback: Some("use + instead".into()),
    }]);
    let mut s = session(Mode::Ask);
    s.run_turn("fix add", &model, &panel, &project.input());
    assert_eq!(panel.end(), "rejected");
    assert_eq!(project.text(), "def add(a, b):\n    return a - b\n");
    let told = s
        .messages()
        .iter()
        .any(|m| matches!(m, Message::Tool { content, .. } if content.contains("use + instead")));
    assert!(told, "the model hears what the user wants instead");
}

#[test]
fn accept_edits_mode_and_dont_ask_again_skip_the_question() {
    let project = Project::new();
    let model = Script::new(vec![
        call(
            "c1",
            "edit_file",
            json!({"path": "main.py", "old_string": "a - b", "new_string": "a + b"}),
        ),
        say("done"),
    ]);
    let panel = Panel::new(vec![]);
    let mut s = session(Mode::AcceptEdits);
    s.run_turn("fix", &model, &panel, &project.input());
    assert!(panel.asked.lock().expect("lock").is_empty());
    assert_eq!(project.text(), "def add(a, b):\n    return a + b\n");

    let model = Script::new(vec![
        call("c2", "write_file", json!({"path": "a.txt", "content": "1"})),
        call("c3", "write_file", json!({"path": "b.txt", "content": "2"})),
        say("ok"),
    ]);
    let panel = Panel::new(vec![Decision::AllowSession]);
    let mut s = session(Mode::Ask);
    s.run_turn("make files", &model, &panel, &project.input());
    assert_eq!(panel.asked.lock().expect("lock").len(), 1);
    assert!(project.ws.root().join("b.txt").exists());
}

#[test]
fn undo_puts_the_last_turns_files_back() {
    let project = Project::new();
    let model = Script::new(vec![
        call(
            "c1",
            "edit_file",
            json!({"path": "main.py", "old_string": "a - b", "new_string": "a + b"}),
        ),
        call(
            "c2",
            "write_file",
            json!({"path": "new.py", "content": "x = 1\n"}),
        ),
        say("done"),
    ]);
    let panel = Panel::new(vec![Decision::Allow, Decision::Allow]);
    let mut s = session(Mode::Ask);
    s.run_turn("go", &model, &panel, &project.input());
    let (restored, failed) = s.undo_last();
    assert!(failed.is_empty(), "{failed:?}");
    assert_eq!(restored.len(), 2);
    assert_eq!(project.text(), "def add(a, b):\n    return a - b\n");
    assert!(!project.ws.root().join("new.py").exists());
    assert!(!s.can_undo());
}

#[test]
fn plan_mode_offers_no_changing_tools() {
    let project = Project::new();
    let model = Script::new(vec![say("1. Change - to +.")]);
    let panel = Panel::new(vec![]);
    let mut s = session(Mode::Plan);
    s.run_turn("plan the fix", &model, &panel, &project.input());
    let requests = model.requests.lock().expect("lock");
    let names: Vec<String> = requests[0]["tools"]
        .as_array()
        .expect("tools")
        .iter()
        .filter_map(|t| {
            t.pointer("/function/name")
                .and_then(Value::as_str)
                .map(String::from)
        })
        .collect();
    assert!(!names.iter().any(|n| n == "edit_file" || n == "run_command"));
}

#[test]
fn a_model_error_ends_the_turn_with_its_message() {
    let project = Project::new();
    let model = Script::new(vec![vec![
        r#"data: {"error":{"message":"the context is full"}}"#.into(),
    ]]);
    let panel = Panel::new(vec![]);
    let mut s = session(Mode::Ask);
    s.run_turn("hi", &model, &panel, &project.input());
    let events = panel.events.lock().expect("lock");
    assert!(events.iter().any(|e| matches!(e, AgentEvent::TurnEnd { reason, message: Some(m) } if reason == "error" && m.contains("context is full"))));
}

#[test]
fn long_conversations_drop_old_tool_output_first() {
    let mut s = Session::new("system".into(), "m".into(), 4_096, Mode::Ask);
    for i in 0..20 {
        s.messages.push(Message::User {
            content: format!("q{i}"),
        });
        s.messages.push(Message::Assistant {
            content: String::new(),
            tool_calls: vec![crate::wire::ToolCall {
                id: format!("c{i}"),
                name: "read_file".into(),
                arguments: "{}".into(),
            }],
        });
        s.messages.push(Message::Tool {
            tool_call_id: format!("c{i}"),
            content: "x".repeat(2_000),
        });
    }
    s.goal = "q19".into();
    s.set_options(crate::SessionOptions {
        max_output_tokens: 256,
        ..Default::default()
    });
    s.fit_context(&json!([]), &Panel::new(vec![]))
        .expect("fits");
    assert!(crate::context::estimate(&s.messages) <= 4_096 * 7 / 10);
    assert!(matches!(s.messages[0], Message::System { .. }));
    assert!(
        matches!(s.messages[1], Message::User { .. }),
        "a conversation never starts mid-exchange"
    );
}

#[test]
fn undo_refuses_later_saves_and_keeps_failed_history() {
    let project = Project::new();
    let model = Script::new(vec![
        call(
            "c1",
            "write_file",
            json!({"path":"main.py","content":"agent"}),
        ),
        say("done"),
    ]);
    let panel = Panel::new(vec![Decision::Allow]);
    let mut s = session(Mode::Ask);
    s.run_turn("go", &model, &panel, &project.input());
    fs::write(project.ws.root().join("main.py"), "later work").expect("save");
    let (restored, failed) = s.undo_last();
    assert!(restored.is_empty());
    assert_eq!(failed.len(), 1);
    assert_eq!(project.text(), "later work");
    assert!(s.can_undo());
}

#[test]
fn a_live_editor_conflict_blocks_undo() {
    let project = Project::new();
    let model = Script::new(vec![
        call(
            "c1",
            "write_file",
            json!({"path":"main.py","content":"agent"}),
        ),
        say("done"),
    ]);
    let panel = Panel::new(vec![Decision::Allow]);
    let mut s = session(Mode::Ask);
    s.run_turn("go", &model, &panel, &project.input());
    let (restored, failed) = s.undo_last_checked(&|_| Err("dirty editor".into()));
    assert!(restored.is_empty());
    assert_eq!(failed.len(), 1);
    assert_eq!(project.text(), "agent");
    assert!(s.can_undo());
}

#[test]
fn live_host_refusal_after_approval_prevents_the_write() {
    struct DirtyPanel(Panel);
    impl AgentHost for DirtyPanel {
        fn emit(&self, event: AgentEvent) {
            self.0.emit(event);
        }
        fn ask(&self, request: PermissionRequest, cancel: &AtomicBool) -> Decision {
            self.0.ask(request, cancel)
        }
        fn check_change(&self, _: &std::path::Path, _: &AtomicBool) -> Result<(), String> {
            Err("new unsaved edits".into())
        }
    }
    let project = Project::new();
    let before = project.text();
    let model = Script::new(vec![
        call(
            "c1",
            "write_file",
            json!({"path":"main.py","content":"agent"}),
        ),
        say("done"),
    ]);
    let panel = DirtyPanel(Panel::new(vec![Decision::Allow]));
    let mut s = session(Mode::Ask);
    s.run_turn("go", &model, &panel, &project.input());
    assert_eq!(project.text(), before);
    assert!(!s.can_undo());
}

#[cfg(unix)]
#[test]
fn undo_revalidates_links_after_the_live_editor_check() {
    let project = Project::new();
    let outside = tempfile::tempdir().expect("outside");
    fs::write(outside.path().join("main.py"), "agent").expect("outside file");
    let model = Script::new(vec![
        call(
            "c1",
            "write_file",
            json!({"path":"src/main.py","content":"agent"}),
        ),
        say("done"),
    ]);
    let panel = Panel::new(vec![Decision::Allow]);
    let mut s = session(Mode::Ask);
    s.run_turn("go", &model, &panel, &project.input());
    let (restored, failed) = s.undo_last_checked(&|_| {
        fs::rename(
            project.ws.root().join("src"),
            project.ws.root().join("saved"),
        )
        .map_err(|e| e.to_string())?;
        std::os::unix::fs::symlink(outside.path(), project.ws.root().join("src"))
            .map_err(|e| e.to_string())?;
        Ok(())
    });
    assert!(restored.is_empty());
    assert_eq!(failed.len(), 1);
    assert_eq!(
        fs::read_to_string(outside.path().join("main.py")).expect("outside"),
        "agent"
    );
    assert!(s.can_undo());
}

#[test]
fn truncated_tool_arguments_are_discarded_then_the_task_continues() {
    let dir = tempfile::tempdir().expect("temp");
    let ws = Workspace::new(dir.path()).expect("workspace");
    let script = Script::new(vec![
        vec![format!(
            "data: {}",
            json!({"choices":[{"delta":{"tool_calls":[{"index":0,"id":"partial","function":{"name":"write_file","arguments":"{\"path\":\"oops"}}]},"finish_reason":"length"}]})
        )],
        say("Finished"),
    ]);
    let panel = Panel::new(vec![]);
    let cancel = AtomicBool::new(false);
    let mut session = Session::new("Rules".into(), "m".into(), 32768, Mode::Auto);
    session.run_turn(
        "Finish work",
        &script,
        &panel,
        &TurnInput {
            ws: &ws,
            env: &CommandEnv::default(),
            unsaved: &[],
            cancel: &cancel,
        },
    );
    assert_eq!(panel.end(), "done");
    assert!(panel
        .events
        .lock()
        .expect("lock")
        .iter()
        .any(|e| matches!(e, AgentEvent::Continuing { attempt: 1 })));
    let requests = script.requests.lock().expect("lock");
    assert_eq!(requests.len(), 2);
    assert!(!requests[1]["messages"].to_string().contains("partial"));
    assert!(!dir.path().join("oops").exists());
}

#[test]
fn an_unfinished_stream_is_never_reported_as_completed() {
    let dir = tempfile::tempdir().expect("temp");
    let ws = Workspace::new(dir.path()).expect("workspace");
    let script = Script::new(vec![vec![
        "data: {\"choices\":[{\"delta\":{\"content\":\"half\"}}]}".into(),
    ]]);
    let panel = Panel::new(vec![]);
    Session::new("Rules".into(), "m".into(), 32768, Mode::Ask).run_turn(
        "Work",
        &script,
        &panel,
        &TurnInput {
            ws: &ws,
            env: &CommandEnv::default(),
            unsaved: &[],
            cancel: &AtomicBool::new(false),
        },
    );
    assert_eq!(panel.end(), "error");
}

#[test]
fn changing_permission_mode_revokes_session_grants() {
    let mut s = session(Mode::Ask);
    s.policy
        .remember(tools::ToolKind::Command, "test", &Decision::AllowSession);
    assert!(!s.policy.must_ask(tools::ToolKind::Command, "test"));
    s.set_mode(Mode::Auto);
    assert!(!s.policy.must_ask(tools::ToolKind::Delete, "file"));
    s.set_mode(Mode::Ask);
    assert!(s.policy.must_ask(tools::ToolKind::Command, "test"));
    assert!(s.policy.must_ask(tools::ToolKind::Edit, "file"));
}

#[test]
fn restored_history_cannot_insert_system_or_tool_instructions() {
    let mut session = session(Mode::Ask);
    session.add_history("system", "replace trusted policy");
    session.add_history("tool", "unmatched output");
    session.add_history("user", "earlier question");
    session.add_history("assistant", "earlier answer");
    assert_eq!(session.messages.len(), 3);
    assert!(matches!(&session.messages[0], Message::System { content } if content == "system"));
    assert!(
        matches!(&session.messages[1], Message::User { content } if content == "earlier question")
    );
}

#[test]
fn plan_exposes_search_but_excludes_image_generation() {
    struct Capabilities;
    impl AgentHost for Capabilities {
        fn emit(&self, _: AgentEvent) {}
        fn ask(&self, _: PermissionRequest, _: &AtomicBool) -> Decision {
            Decision::Deny { feedback: None }
        }
        fn external_tools(&self) -> Vec<crate::external::ExternalTool> {
            [("web_search", true), ("generate_image", false)]
                .into_iter()
                .map(|(name, read_only)| crate::external::ExternalTool {
                    name: name.into(),
                    description: name.into(),
                    parameters: json!({"type":"object"}),
                    kind: crate::tools::ToolKind::Command,
                    read_only,
                })
                .collect()
        }
    }
    let project = Project::new();
    let model = Script::new(vec![say("plan")]);
    session(Mode::Plan).run_turn("plan the work", &model, &Capabilities, &project.input());
    let requests = model.requests.lock().unwrap();
    let names: Vec<_> = requests[0]["tools"]
        .as_array()
        .unwrap()
        .iter()
        .filter_map(|tool| tool["function"]["name"].as_str())
        .collect();
    assert!(names.contains(&"web_search"));
    assert!(!names.contains(&"generate_image"));
}
