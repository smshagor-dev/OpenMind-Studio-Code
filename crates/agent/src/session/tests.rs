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
    s.fit_context();
    assert!(estimate_tokens(&s.messages) <= 4_096 * 7 / 10);
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
