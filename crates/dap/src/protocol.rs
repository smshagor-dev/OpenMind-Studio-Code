//! The Debug Adapter Protocol messages OpenMind uses: the request arguments it sends and the
//! parts of events/responses it reads (stopped, stack frames, scopes, variables, evaluate,
//! output). Everything is parsed defensively — an adapter that leaves a field out gives a
//! plain default, never a panic.

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

/// The client capabilities announced to the adapter.
pub fn initialize_arguments(adapter_id: &str) -> Value {
    json!({
        "clientID": "openmind-studio",
        "clientName": "OpenMind Studio",
        "adapterID": adapter_id,
        "locale": "en",
        "linesStartAt1": true,
        "columnsStartAt1": true,
        "pathFormat": "path",
        "supportsVariableType": true,
        "supportsVariablePaging": false,
        "supportsRunInTerminalRequest": false,
        "supportsStartDebuggingRequest": true,
        "supportsProgressReporting": false,
        "supportsInvalidatedEvent": false
    })
}

/// A breakpoint as the UI keeps it: a line, and optionally a condition, a hit count or a log message (a logpoint).
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SourceBreakpoint {
    pub line: u32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub condition: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub hit_condition: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub log_message: Option<String>,
}

impl SourceBreakpoint {
    pub fn at(line: u32) -> Self {
        Self {
            line,
            ..Self::default()
        }
    }
}

pub fn set_breakpoints_arguments(path: &str, breakpoints: &[SourceBreakpoint]) -> Value {
    json!({
        "source": { "path": path },
        "breakpoints": breakpoints,
        "lines": breakpoints.iter().map(|b| b.line).collect::<Vec<_>>(),
        "sourceModified": false
    })
}

/// What the adapter said it can do (its `initialize` answer), as far as the UI needs it.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Capabilities {
    pub conditional_breakpoints: bool,
    pub hit_conditional_breakpoints: bool,
    pub log_points: bool,
    pub loaded_sources: bool,
    pub modules: bool,
}

impl Capabilities {
    pub fn from_initialize(body: &Value) -> Self {
        let flag = |key: &str| body.get(key).and_then(Value::as_bool).unwrap_or(false);
        Self {
            conditional_breakpoints: flag("supportsConditionalBreakpoints"),
            hit_conditional_breakpoints: flag("supportsHitConditionalBreakpoints"),
            log_points: flag("supportsLogPoints"),
            loaded_sources: flag("supportsLoadedSourcesRequest"),
            modules: flag("supportsModulesRequest"),
        }
    }

    /// Both sessions' abilities (js-debug's child session reports what its launcher doesn't).
    pub fn merge(&mut self, other: &Self) {
        self.conditional_breakpoints |= other.conditional_breakpoints;
        self.hit_conditional_breakpoints |= other.hit_conditional_breakpoints;
        self.log_points |= other.log_points;
        self.loaded_sources |= other.loaded_sources;
        self.modules |= other.modules;
    }
}

pub fn thread_arguments(thread_id: i64) -> Value {
    json!({ "threadId": thread_id })
}

pub fn disconnect_arguments(terminate_debuggee: bool) -> Value {
    json!({ "terminateDebuggee": terminate_debuggee, "restart": false })
}

/// What the user can ask a stopped or running program to do.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Control {
    Continue,
    Pause,
    StepOver,
    StepInto,
    StepOut,
}

impl Control {
    pub fn parse(name: &str) -> Option<Control> {
        Some(match name {
            "continue" => Control::Continue,
            "pause" => Control::Pause,
            "stepOver" => Control::StepOver,
            "stepInto" => Control::StepInto,
            "stepOut" => Control::StepOut,
            _ => return None,
        })
    }

    /// The DAP request that does it.
    pub fn command(self) -> &'static str {
        match self {
            Control::Continue => "continue",
            Control::Pause => "pause",
            Control::StepOver => "next",
            Control::StepInto => "stepIn",
            Control::StepOut => "stepOut",
        }
    }
}

/// The requests the UI may send while a session runs — only reads about the paused program.
pub const ALLOWED_UI_REQUESTS: &[&str] = &[
    "threads",
    "stackTrace",
    "scopes",
    "variables",
    "evaluate",
    "loadedSources",
    "modules",
];

pub fn is_allowed_ui_request(command: &str) -> bool {
    ALLOWED_UI_REQUESTS.contains(&command)
}

fn text(value: &Value, key: &str) -> Option<String> {
    value.get(key).and_then(Value::as_str).map(str::to_string)
}

fn number(value: &Value, key: &str) -> Option<i64> {
    value.get(key).and_then(Value::as_i64)
}

/// A `stopped` event.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Stopped {
    pub reason: String,
    pub thread_id: Option<i64>,
    pub description: Option<String>,
    pub text: Option<String>,
    pub all_threads_stopped: bool,
}

pub fn parse_stopped(body: &Value) -> Stopped {
    Stopped {
        reason: text(body, "reason").unwrap_or_else(|| "pause".into()),
        thread_id: number(body, "threadId"),
        description: text(body, "description"),
        text: text(body, "text"),
        all_threads_stopped: body
            .get("allThreadsStopped")
            .and_then(Value::as_bool)
            .unwrap_or(false),
    }
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StackFrame {
    pub id: i64,
    pub name: String,
    /// 1-based.
    pub line: u32,
    pub column: u32,
    /// The file, when the frame has one on disk.
    pub path: Option<String>,
    pub source_name: Option<String>,
    /// `subtle`/`deemphasize` for frames inside the runtime itself.
    pub hint: Option<String>,
}

fn is_disk_path(path: &str) -> bool {
    // Node's internals come as `<node_internals>/...`; they aren't files the editor can open.
    !path.starts_with('<') && !path.contains("://")
}

pub fn parse_stack_frames(body: &Value) -> Vec<StackFrame> {
    body.get("stackFrames")
        .and_then(Value::as_array)
        .map(|frames| {
            frames
                .iter()
                .filter_map(|frame| {
                    let source = frame.get("source");
                    let path = source
                        .and_then(|s| text(s, "path"))
                        .filter(|path| is_disk_path(path));
                    Some(StackFrame {
                        id: number(frame, "id")?,
                        name: text(frame, "name").unwrap_or_default(),
                        line: number(frame, "line").unwrap_or(0).max(0) as u32,
                        column: number(frame, "column").unwrap_or(0).max(0) as u32,
                        path,
                        source_name: source.and_then(|s| text(s, "name")),
                        hint: text(frame, "presentationHint")
                            .or_else(|| source.and_then(|s| text(s, "presentationHint"))),
                    })
                })
                .collect()
        })
        .unwrap_or_default()
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Scope {
    pub name: String,
    pub variables_reference: i64,
    pub expensive: bool,
}

pub fn parse_scopes(body: &Value) -> Vec<Scope> {
    body.get("scopes")
        .and_then(Value::as_array)
        .map(|scopes| {
            scopes
                .iter()
                .filter_map(|scope| {
                    Some(Scope {
                        name: text(scope, "name")?,
                        variables_reference: number(scope, "variablesReference")?,
                        expensive: scope
                            .get("expensive")
                            .and_then(Value::as_bool)
                            .unwrap_or(false),
                    })
                })
                .collect()
        })
        .unwrap_or_default()
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Variable {
    pub name: String,
    pub value: String,
    #[serde(rename = "type")]
    pub type_name: Option<String>,
    /// Non-zero when the value has children to expand.
    pub variables_reference: i64,
    pub evaluate_name: Option<String>,
}

pub fn parse_variables(body: &Value) -> Vec<Variable> {
    body.get("variables")
        .and_then(Value::as_array)
        .map(|variables| {
            variables
                .iter()
                .filter_map(|variable| {
                    Some(Variable {
                        name: text(variable, "name")?,
                        value: text(variable, "value").unwrap_or_default(),
                        type_name: text(variable, "type"),
                        variables_reference: number(variable, "variablesReference").unwrap_or(0),
                        evaluate_name: text(variable, "evaluateName"),
                    })
                })
                .collect()
        })
        .unwrap_or_default()
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Evaluated {
    pub result: String,
    #[serde(rename = "type")]
    pub type_name: Option<String>,
    pub variables_reference: i64,
}

pub fn parse_evaluate(body: &Value) -> Evaluated {
    Evaluated {
        result: text(body, "result").unwrap_or_default(),
        type_name: text(body, "type"),
        variables_reference: number(body, "variablesReference").unwrap_or(0),
    }
}

/// `evaluate` request arguments (the debug console and watch use context `repl` / `watch`).
pub fn evaluate_arguments(expression: &str, frame_id: Option<i64>, context: &str) -> Value {
    let mut arguments = json!({ "expression": expression, "context": context });
    if let (Some(frame), Some(map)) = (frame_id, arguments.as_object_mut()) {
        map.insert("frameId".into(), json!(frame));
    }
    arguments
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Output {
    /// `stdout`, `stderr`, `console`, `important`, `telemetry`, ...
    pub category: String,
    pub text: String,
}

pub fn parse_output(body: &Value) -> Output {
    Output {
        category: text(body, "category").unwrap_or_else(|| "console".into()),
        text: text(body, "output").unwrap_or_default(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn initialize_declares_what_the_client_can_do() {
        let args = initialize_arguments("python");
        assert_eq!(args["adapterID"], "python");
        assert_eq!(args["linesStartAt1"], true);
        assert_eq!(args["pathFormat"], "path");
        assert_eq!(args["supportsRunInTerminalRequest"], false);
        assert_eq!(args["supportsStartDebuggingRequest"], true);
    }

    #[test]
    fn breakpoints_go_out_as_lines_of_one_source() {
        let logpoint = SourceBreakpoint {
            line: 10,
            condition: Some("x > 1".into()),
            hit_condition: None,
            log_message: Some("x is {x}".into()),
        };
        let args =
            set_breakpoints_arguments("C:/My Site/app.py", &[SourceBreakpoint::at(3), logpoint]);
        assert_eq!(args["source"]["path"], "C:/My Site/app.py");
        assert_eq!(args["breakpoints"][1]["line"], 10);
        assert_eq!(args["breakpoints"][1]["condition"], "x > 1");
        assert_eq!(args["breakpoints"][1]["logMessage"], "x is {x}");
        assert!(args["breakpoints"][0].get("condition").is_none());
        assert!(args["breakpoints"][1].get("hitCondition").is_none());
        assert_eq!(args["lines"], json!([3, 10]));
        // No breakpoints for a file = an empty list, which clears it in the adapter.
        assert_eq!(
            set_breakpoints_arguments("a.py", &[])["breakpoints"],
            json!([])
        );
    }

    #[test]
    fn capabilities_come_from_the_initialize_answer() {
        let debugpy = Capabilities::from_initialize(&json!({
            "supportsConditionalBreakpoints": true, "supportsHitConditionalBreakpoints": true,
            "supportsLogPoints": true, "supportsModulesRequest": true
        }));
        assert!(debugpy.log_points && debugpy.modules && !debugpy.loaded_sources);
        let mut merged = Capabilities::default();
        merged.merge(&debugpy);
        merged.merge(&Capabilities::from_initialize(
            &json!({"supportsLoadedSourcesRequest": true}),
        ));
        assert!(merged.loaded_sources && merged.conditional_breakpoints);
        assert!(is_allowed_ui_request("loadedSources") && is_allowed_ui_request("modules"));
        assert!(!is_allowed_ui_request("launch"));
    }

    #[test]
    fn controls_map_to_dap_requests() {
        assert_eq!(
            Control::parse("stepOver").map(Control::command),
            Some("next")
        );
        assert_eq!(
            Control::parse("stepInto").map(Control::command),
            Some("stepIn")
        );
        assert_eq!(
            Control::parse("stepOut").map(Control::command),
            Some("stepOut")
        );
        assert_eq!(
            Control::parse("continue").map(Control::command),
            Some("continue")
        );
        assert_eq!(Control::parse("pause").map(Control::command), Some("pause"));
        assert_eq!(Control::parse("terminate"), None);
    }

    #[test]
    fn a_stopped_event_is_parsed_with_defaults() {
        let stopped = parse_stopped(&json!({
            "reason": "breakpoint", "threadId": 1, "allThreadsStopped": true, "hitBreakpointIds": [0]
        }));
        assert_eq!(stopped.reason, "breakpoint");
        assert_eq!(stopped.thread_id, Some(1));
        assert!(stopped.all_threads_stopped);
        let bare = parse_stopped(&json!({}));
        assert_eq!(bare.reason, "pause");
        assert_eq!(bare.thread_id, None);
        assert!(!bare.all_threads_stopped);
    }

    #[test]
    fn a_stack_trace_keeps_files_and_drops_runtime_internals_as_paths() {
        let frames = parse_stack_frames(&json!({ "stackFrames": [
            { "id": 7, "name": "greet", "line": 2, "column": 5,
              "source": { "name": "t.py", "path": "C:\\My Site\\t.py" } },
            { "id": 8, "name": "<anonymous>", "line": 1854, "column": 1,
              "source": { "name": "loader", "path": "<node_internals>/internal/modules/cjs/loader", "presentationHint": "deemphasize" } },
            { "name": "no id" }
        ]}));
        assert_eq!(frames.len(), 2);
        assert_eq!(frames[0].path.as_deref(), Some("C:\\My Site\\t.py"));
        assert_eq!((frames[0].line, frames[0].column), (2, 5));
        assert_eq!(frames[1].path, None);
        assert_eq!(frames[1].hint.as_deref(), Some("deemphasize"));
        assert!(parse_stack_frames(&Value::Null).is_empty());
    }

    #[test]
    fn scopes_and_variables_are_parsed() {
        let scopes = parse_scopes(&json!({ "scopes": [
            { "name": "Locals", "variablesReference": 3, "expensive": false },
            { "name": "Globals", "variablesReference": 4, "expensive": true },
            { "variablesReference": 5 }
        ]}));
        assert_eq!(scopes.len(), 2);
        assert!(scopes[1].expensive);
        let variables = parse_variables(&json!({ "variables": [
            { "name": "name", "value": "'x'", "type": "str", "variablesReference": 0 },
            { "name": "items", "value": "list", "variablesReference": 12, "evaluateName": "items" },
            { "value": "nameless" }
        ]}));
        assert_eq!(variables.len(), 2);
        assert_eq!(variables[0].type_name.as_deref(), Some("str"));
        assert_eq!(variables[1].variables_reference, 12);
        assert_eq!(variables[1].evaluate_name.as_deref(), Some("items"));
    }

    #[test]
    fn evaluate_takes_a_frame_and_a_context_and_returns_a_result() {
        let args = evaluate_arguments("a + b", Some(4), "repl");
        assert_eq!(args["expression"], "a + b");
        assert_eq!(args["frameId"], 4);
        assert_eq!(args["context"], "repl");
        assert!(evaluate_arguments("x", None, "watch")
            .get("frameId")
            .is_none());
        let result =
            parse_evaluate(&json!({ "result": "3", "type": "number", "variablesReference": 0 }));
        assert_eq!(result.result, "3");
        assert_eq!(result.type_name.as_deref(), Some("number"));
    }

    #[test]
    fn output_events_default_to_the_console_category() {
        let out = parse_output(&json!({ "category": "stdout", "output": "hi\n" }));
        assert_eq!(
            (out.category.as_str(), out.text.as_str()),
            ("stdout", "hi\n")
        );
        assert_eq!(parse_output(&json!({ "output": "x" })).category, "console");
    }

    #[test]
    fn only_reads_about_the_paused_program_reach_the_adapter() {
        for command in ["stackTrace", "scopes", "variables", "evaluate", "threads"] {
            assert!(is_allowed_ui_request(command));
        }
        for command in [
            "launch",
            "disconnect",
            "setBreakpoints",
            "terminate",
            "attach",
        ] {
            assert!(!is_allowed_ui_request(command));
        }
    }
}
