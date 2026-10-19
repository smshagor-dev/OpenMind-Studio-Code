//! Whole turns through the guard: repeats are answered or refused but never end the turn, a model that stops with
//! unfinished work is sent back to it, "nothing was applied" is reported, and the context budget is measured.

use super::*;

fn tool_results(model: &Script, request: usize) -> Vec<String> {
    let requests = model.requests.lock().expect("requests");
    requests[request]["messages"]
        .as_array()
        .expect("messages")
        .iter()
        .filter(|m| m["role"] == "tool")
        .map(|m| m["content"].as_str().unwrap_or_default().to_string())
        .collect()
}

fn last_user_message(model: &Script, request: usize) -> String {
    let requests = model.requests.lock().expect("requests");
    requests[request]["messages"]
        .as_array()
        .expect("messages")
        .iter()
        .rev()
        .find(|m| m["role"] == "user")
        .and_then(|m| m["content"].as_str())
        .unwrap_or_default()
        .to_string()
}

fn summaries(panel: &Panel, prefix: &str) -> usize {
    panel
        .events
        .lock()
        .expect("events")
        .iter()
        .filter(|e| matches!(e, AgentEvent::ToolEnd { summary, .. } if summary.starts_with(prefix)))
        .count()
}

fn todos(items: &[(&str, &str)]) -> Vec<String> {
    let list: Vec<Value> = items
        .iter()
        .map(|(content, status)| json!({"content": content, "status": status}))
        .collect();
    call("t", "todo_write", json!({ "todos": list }))
}

#[test]
fn repeated_reads_are_answered_then_refused_and_the_turn_still_finishes() {
    let project = Project::new();
    let read = || call("r", "read_file", json!({"path": "main.py"}));
    let model = Script::new(vec![
        read(),
        read(),
        read(),
        read(),
        say("main.py subtracts instead of adding."),
    ]);
    let panel = Panel::new(vec![]);
    let mut s = session(Mode::Ask);
    s.run_turn("Look at main.py", &model, &panel, &project.input());
    assert_eq!(panel.end(), "done");
    assert!(tool_results(&model, 1)[0].contains("return a - b"));
    assert!(tool_results(&model, 2)
        .last()
        .is_some_and(|t| t.contains("Not run again")));
    assert!(tool_results(&model, 3)
        .last()
        .is_some_and(|t| t.contains("repeating it can't help")));
    assert_eq!(summaries(&panel, "Already done"), 1);
    assert_eq!(summaries(&panel, "Not run: repeated"), 2);
    assert_eq!(model.requests.lock().expect("requests").len(), 5);
}

#[test]
fn a_turn_whose_changes_all_failed_says_nothing_was_applied() {
    let project = Project::new();
    let model = Script::new(vec![
        call(
            "e1",
            "edit_file",
            json!({"path": "main.py", "old_string": "nope", "new_string": "x"}),
        ),
        say("I fixed main.py."),
    ]);
    let panel = Panel::new(vec![]);
    let mut s = session(Mode::Ask);
    s.run_turn("Fix main.py", &model, &panel, &project.input());
    assert_eq!(panel.end(), "done");
    assert!(tool_results(&model, 1)[0].starts_with("Not applied: the file was not changed."));
    let events = panel.events.lock().expect("events");
    let unchanged = events
        .iter()
        .position(|e| matches!(e, AgentEvent::Unchanged { failed: 1 }));
    let end = events
        .iter()
        .position(|e| matches!(e, AgentEvent::TurnEnd { .. }));
    assert!(
        unchanged.is_some() && unchanged < end,
        "reported before the turn ends"
    );
    assert!(project.text().contains("a - b"));
}

#[test]
fn an_applied_change_is_not_reported_as_unchanged() {
    let project = Project::new();
    let model = Script::new(vec![
        call(
            "e1",
            "edit_file",
            json!({"path": "main.py", "old_string": "nope", "new_string": "x"}),
        ),
        call(
            "e2",
            "edit_file",
            json!({"path": "main.py", "old_string": "a - b", "new_string": "a + b"}),
        ),
        say("Fixed."),
    ]);
    let panel = Panel::new(vec![]);
    let mut s = session(Mode::AcceptEdits);
    s.run_turn("Fix main.py", &model, &panel, &project.input());
    assert_eq!(panel.end(), "done");
    assert!(project.text().contains("a + b"));
    assert!(!panel
        .events
        .lock()
        .expect("events")
        .iter()
        .any(|e| matches!(e, AgentEvent::Unchanged { .. })));
}

#[test]
fn edits_that_keep_failing_are_refused_without_ending_the_turn() {
    let project = Project::new();
    let edit = |n: u32| {
        call(
            &format!("e{n}"),
            "edit_file",
            json!({"path": "main.py", "old_string": format!("nope {n}"), "new_string": "x"}),
        )
    };
    let model = Script::new(vec![
        edit(1),
        edit(2),
        edit(3),
        edit(4),
        say("main.py could not be changed."),
    ]);
    let panel = Panel::new(vec![]);
    let mut s = session(Mode::AcceptEdits);
    s.run_turn("Fix main.py", &model, &panel, &project.input());
    assert_eq!(panel.end(), "done");
    assert!(tool_results(&model, 4)
        .last()
        .is_some_and(|t| t.contains("3 changes to main.py failed")));
    assert!(panel
        .events
        .lock()
        .expect("events")
        .iter()
        .any(|e| matches!(e, AgentEvent::Unchanged { failed: 3 })));
}

#[test]
fn stopping_with_open_items_on_the_task_list_sends_the_model_back_to_work() {
    let project = Project::new();
    let model = Script::new(vec![
        todos(&[("Fix add", "completed"), ("Run the tests", "pending")]),
        say("I fixed add."),
        todos(&[("Fix add", "completed"), ("Run the tests", "completed")]),
        say("Fixed add and ran the tests."),
    ]);
    let panel = Panel::new(vec![]);
    let mut s = session(Mode::Ask);
    s.run_turn("Fix add and test it", &model, &panel, &project.input());
    assert_eq!(panel.end(), "done");
    assert_eq!(model.requests.lock().expect("requests").len(), 4);
    let reminder = last_user_message(&model, 2);
    assert!(
        reminder.contains("unfinished items: Run the tests"),
        "{reminder}"
    );
}

#[test]
fn stopping_without_an_answer_is_sent_back_once_more() {
    let project = Project::new();
    let model = Script::new(vec![say(""), say("main.py has a subtraction bug.")]);
    let panel = Panel::new(vec![]);
    let mut s = session(Mode::Ask);
    s.run_turn(
        "What is wrong in main.py?",
        &model,
        &panel,
        &project.input(),
    );
    assert_eq!(panel.end(), "done");
    assert!(last_user_message(&model, 1).contains("You stopped without answering"));
}

#[test]
fn thinking_that_fills_the_output_is_told_to_act_twice_then_the_turn_pauses() {
    let project = Project::new();
    let thinking = || -> Vec<String> {
        vec![
            r#"data: {"choices":[{"delta":{"reasoning_content":"Still thinking"},"finish_reason":"length"}]}"#.into(),
            "data: [DONE]".into(),
        ]
    };
    let model = Script::new(vec![thinking(), thinking(), say("Done.")]);
    let panel = Panel::new(vec![]);
    let mut s = session(Mode::Ask);
    s.run_turn("Reply", &model, &panel, &project.input());
    assert_eq!(panel.end(), "done");
    assert!(last_user_message(&model, 1).contains("Stop planning now"));

    let model = Script::new(vec![
        thinking(),
        thinking(),
        thinking(),
        say("never requested"),
    ]);
    let panel = Panel::new(vec![]);
    let mut s = session(Mode::Ask);
    s.run_turn("Reply", &model, &panel, &project.input());
    assert_eq!(panel.end(), "limit");
    assert_eq!(model.requests.lock().expect("requests").len(), 3);
}

#[test]
fn a_tool_call_written_as_text_still_runs() {
    let project = Project::new();
    let model = Script::new(vec![
        say("<function=read_file> <parameter=path> main.py </parameter> </function> </tool_call>"),
        say("main.py subtracts."),
    ]);
    let panel = Panel::new(vec![]);
    let mut s = session(Mode::Ask);
    s.run_turn("Look at main.py", &model, &panel, &project.input());
    assert_eq!(panel.end(), "done");
    assert!(
        tool_results(&model, 1)[0].contains("return a - b"),
        "the call ran"
    );
    let requests = model.requests.lock().expect("requests");
    let assistant = requests[1]["messages"]
        .as_array()
        .expect("messages")
        .iter()
        .find(|m| m["role"] == "assistant")
        .expect("the answer with the call")
        .clone();
    assert_eq!(assistant["content"], "", "the markup is not kept as text");
    assert_eq!(assistant["tool_calls"][0]["function"]["name"], "read_file");
}

#[test]
fn a_moved_file_is_put_back_by_undo() {
    let project = Project::new();
    let model = Script::new(vec![
        call(
            "m",
            "move_file",
            json!({"from": "main.py", "to": "pkg/calc.py"}),
        ),
        say("Moved."),
    ]);
    let panel = Panel::new(vec![]);
    let mut s = session(Mode::AcceptEdits);
    s.run_turn(
        "Move main.py to pkg/calc.py",
        &model,
        &panel,
        &project.input(),
    );
    assert_eq!(panel.end(), "done");
    let root = project.ws.root().to_path_buf();
    assert!(root.join("pkg/calc.py").is_file() && !root.join("main.py").exists());
    let (restored, failed) = s.undo_last();
    assert!(failed.is_empty(), "{failed:?}");
    assert_eq!(restored.len(), 2);
    assert!(root.join("main.py").is_file() && !root.join("pkg/calc.py").exists());
    assert!(project.text().contains("a - b"));
}

#[test]
fn a_plan_mode_turn_says_nothing_was_changed() {
    let project = Project::new();
    let model = Script::new(vec![say("1. Change a - b to a + b in main.py.")]);
    let panel = Panel::new(vec![]);
    let mut s = session(Mode::Plan);
    s.run_turn("Plan the fix", &model, &panel, &project.input());
    assert_eq!(panel.end(), "done");
    assert!(panel
        .events
        .lock()
        .expect("events")
        .iter()
        .any(|e| matches!(e, AgentEvent::Unchanged { failed: 0 })));
}

#[test]
fn the_engines_real_prompt_size_scales_the_context_budget() {
    let project = Project::new();
    let mut reply = say("ok");
    reply.insert(
        1,
        r#"data: {"choices":[],"usage":{"prompt_tokens":40,"completion_tokens":1}}"#.into(),
    );
    let model = Script::new(vec![reply]);
    let panel = Panel::new(vec![]);
    let mut s = session(Mode::Ask);
    assert!((s.token_scale - 1.0).abs() < f64::EPSILON);
    s.run_turn("Hi", &model, &panel, &project.input());
    assert!(
        s.token_scale < 1.0,
        "fewer real tokens than estimated: {}",
        s.token_scale
    );
    assert!(s.token_scale >= 0.25, "never below the floor");
}
