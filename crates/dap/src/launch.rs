//! `launch.json` (`.vscode/launch.json` and `.openmind/launch.json`): the debug configurations a project defines.
//! Python (`debugpy`/`python`) and Node.js (`node`/`pwa-node`) `launch` configurations become [`LaunchConfig`]s;
//! everything else is listed with the reason it can't run (another debugger type, `attach`, compounds), and every
//! field that is ignored is named in the configuration's `notes`. Variables are expanded when the list is built, so a
//! configuration that needs the file in front says so up front.

use std::collections::BTreeMap;

use openmind_core::vars::{self, VarContext};
use serde::Serialize;
use serde_json::{Map, Value};

use crate::target::{LaunchConfig, Target};

/// One configuration of a `launch.json`.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Discovered {
    pub name: String,
    /// The `launch.json` it comes from.
    pub source: String,
    pub type_name: String,
    pub request: String,
    /// Ready to start (when `problem` is `None`).
    pub config: Option<LaunchConfig>,
    pub problem: Option<String>,
    pub notes: Vec<String>,
}

/// A `compounds` entry (several configurations at once).
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Compound {
    pub name: String,
    pub configurations: Vec<String>,
    pub problem: String,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LaunchFile {
    pub path: String,
    pub configurations: Vec<Discovered>,
    pub compounds: Vec<Compound>,
    pub error: Option<String>,
}

const FIELDS: &[&str] = &[
    "name",
    "type",
    "request",
    "program",
    "cwd",
    "args",
    "env",
    "stopOnEntry",
    "justMyCode",
    "console",
];
const IGNORED: &[(&str, &str)] = &[
    ("console", "output goes to the Debug Console (console is ignored)"),
    ("preLaunchTask", "preLaunchTask is not run: run the task first (Terminal > Run Task...)"),
    ("postDebugTask", "postDebugTask is not run"),
    ("python", "the Python interpreter is chosen by OpenMind (project .venv, then its portable Python, then the system's)"),
    ("runtimeExecutable", "the Node.js executable is chosen by OpenMind (its portable Node.js, then the system's)"),
    ("envFile", "envFile is not read; use env"),
    ("presentation", "presentation is ignored"),
    ("internalConsoleOptions", "internalConsoleOptions is ignored"),
    ("skipFiles", "skipFiles is ignored (Node.js internals are skipped)"),
    ("outFiles", "outFiles is ignored (no source maps)"),
    ("sourceMaps", "source maps are not supported"),
];

/// The target of a debugger type, or why it can't be debugged here. `extension_debuggers` names types extensions
/// contribute (type -> extension), so their configurations say who declared them.
fn target_of(
    type_name: &str,
    extension_debuggers: &BTreeMap<String, String>,
) -> Result<Target, String> {
    match type_name {
        "python" | "debugpy" => Ok(Target::Python),
        "node" | "pwa-node" | "node2" => Ok(Target::Node),
        "php" => Err("PHP debugging requires Xdebug and is not available yet.".into()),
        other => match extension_debuggers.get(other) {
            Some(extension) => Err(format!(
                "The debugger type \"{other}\" is declared by the extension {extension}, but OpenMind Studio can't run extension debug adapters yet."
            )),
            None => Err(format!(
                "The debugger type \"{other}\" is not supported: OpenMind Studio debugs Python (debugpy) and Node.js (js-debug)."
            )),
        },
    }
}

fn expand(text: &str, context: &VarContext) -> Result<String, String> {
    vars::expand(text, context).map_err(|err| err.to_string())
}

fn build(
    entry: &Map<String, Value>,
    target: Target,
    context: &VarContext,
    name: &str,
) -> Result<LaunchConfig, String> {
    let program = entry
        .get("program")
        .and_then(Value::as_str)
        .ok_or("This configuration has no program (module and attach configurations are not supported yet).")?;
    let folder = context.workspace_folder.clone().unwrap_or_default();
    let program = vars::absolute(&expand(program, context)?, &folder);
    let cwd = match entry.get("cwd").and_then(Value::as_str) {
        Some(cwd) => Some(vars::absolute(&expand(cwd, context)?, &folder)),
        None => context.workspace_folder.clone(),
    };
    let args = match entry.get("args") {
        Some(Value::Array(items)) => items
            .iter()
            .filter_map(Value::as_str)
            .map(|a| expand(a, context))
            .collect::<Result<Vec<_>, _>>()?,
        Some(Value::String(line)) => vec![expand(line, context)?],
        _ => Vec::new(),
    };
    let mut env = BTreeMap::new();
    if let Some(Value::Object(map)) = entry.get("env") {
        for (key, value) in map {
            if let Some(value) = value.as_str() {
                env.insert(key.clone(), expand(value, context)?);
            }
        }
    }
    Ok(LaunchConfig {
        name: name.to_string(),
        target,
        program,
        cwd,
        args,
        stop_on_entry: entry
            .get("stopOnEntry")
            .and_then(Value::as_bool)
            .unwrap_or(false),
        env,
        just_my_code: entry.get("justMyCode").and_then(Value::as_bool),
    })
}

fn discover(
    entry: &Map<String, Value>,
    source: &str,
    context: &VarContext,
    extension_debuggers: &BTreeMap<String, String>,
) -> Discovered {
    let name = entry
        .get("name")
        .and_then(Value::as_str)
        .unwrap_or("(unnamed)")
        .to_string();
    let type_name = entry
        .get("type")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string();
    let request = entry
        .get("request")
        .and_then(Value::as_str)
        .unwrap_or("launch")
        .to_string();
    let mut notes = Vec::new();
    for key in entry.keys() {
        if let Some((_, note)) = IGNORED.iter().find(|(field, _)| field == key) {
            notes.push((*note).to_string());
        } else if !FIELDS.contains(&key.as_str()) {
            notes.push(format!(
                "the field \"{key}\" is not supported and was ignored"
            ));
        }
    }
    let built = target_of(&type_name, extension_debuggers).and_then(|target| {
        if request == "launch" {
            build(entry, target, context, &name)
        } else {
            Err(format!("\"{request}\" configurations are not supported yet: OpenMind Studio starts programs (launch)."))
        }
    });
    let (config, problem) = match built {
        Ok(config) => (Some(config), None),
        Err(problem) => (None, Some(problem)),
    };
    Discovered {
        name,
        source: source.to_string(),
        type_name,
        request,
        config,
        problem,
        notes,
    }
}

/// Reads a `launch.json` found at `path`.
pub fn parse_launch(
    path: &str,
    text: &str,
    context: &VarContext,
    extension_debuggers: &BTreeMap<String, String>,
) -> LaunchFile {
    let mut file = LaunchFile {
        path: path.to_string(),
        configurations: Vec::new(),
        compounds: Vec::new(),
        error: None,
    };
    let root: Value = match serde_json::from_str(&openmind_core::jsonc::strip(text)) {
        Ok(value) => value,
        Err(err) => {
            file.error = Some(format!(
                "launch.json is not valid JSON (line {}, column {}).",
                err.line(),
                err.column()
            ));
            return file;
        }
    };
    let Some(entries) = root.get("configurations").and_then(Value::as_array) else {
        file.error = Some("launch.json has no \"configurations\" list.".into());
        return file;
    };
    for entry in entries.iter().filter_map(Value::as_object) {
        file.configurations
            .push(discover(entry, path, context, extension_debuggers));
    }
    for compound in root
        .get("compounds")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
    {
        file.compounds.push(Compound {
            name: compound.get("name").and_then(Value::as_str).unwrap_or("(unnamed)").to_string(),
            configurations: compound
                .get("configurations")
                .and_then(Value::as_array)
                .map(|items| items.iter().filter_map(Value::as_str).map(str::to_string).collect())
                .unwrap_or_default(),
            problem: "Compound configurations are not supported yet: OpenMind Studio runs one debug session at a time.".into(),
        });
    }
    file
}

/// Where a folder's launch files are, in the order they are listed.
pub const LAUNCH_FILES: [&str; 2] = [".openmind/launch.json", ".vscode/launch.json"];

#[cfg(test)]
mod tests {
    use super::*;

    const SAMPLE: &str = r#"{
      "version": "0.2.0",
      "configurations": [
        {"name": "Py: app", "type": "debugpy", "request": "launch", "program": "${workspaceFolder}/app.py",
         "args": ["--port", "8000"], "env": {"MODE": "${fileBasename}"}, "justMyCode": false, "console": "integratedTerminal"},
        {"name": "Node", "type": "node", "request": "launch", "program": "src/server.js", "cwd": "${workspaceFolder}/src", "preLaunchTask": "build"},
        {"name": "Attach", "type": "debugpy", "request": "attach", "port": 5678},
        {"name": "C++", "type": "cppdbg", "request": "launch", "program": "a.exe"},
        {"name": "Go", "type": "go", "request": "launch", "program": "."},
        {"name": "Input", "type": "python", "request": "launch", "program": "${input:pick}"},
        {"name": "Module", "type": "python", "request": "launch", "module": "flask"},
      ],
      "compounds": [{"name": "Both", "configurations": ["Py: app", "Node"]}]
    }"#;

    fn context() -> VarContext {
        VarContext {
            workspace_folder: Some("C:/My Work".into()),
            file: Some("C:/My Work/app.py".into()),
        }
    }

    #[test]
    fn python_and_node_launch_configurations_become_runnable() {
        let debuggers = BTreeMap::from([("go".to_string(), "golang.go".to_string())]);
        let file = parse_launch(
            "C:/My Work/.vscode/launch.json",
            SAMPLE,
            &context(),
            &debuggers,
        );
        assert_eq!(file.error, None);
        let py = &file.configurations[0];
        let config = py.config.as_ref().unwrap();
        assert_eq!(config.target, Target::Python);
        assert_eq!(config.program, "C:/My Work/app.py");
        assert_eq!(config.cwd.as_deref(), Some("C:/My Work"));
        assert_eq!(config.args, ["--port", "8000"]);
        assert_eq!(config.env.get("MODE").map(String::as_str), Some("app.py"));
        assert_eq!(config.just_my_code, Some(false));
        assert!(py.notes.iter().any(|n| n.contains("console")));
        let node = file.configurations[1].config.as_ref().unwrap();
        assert_eq!(node.target, Target::Node);
        assert_eq!(node.program, "C:/My Work/src/server.js");
        assert_eq!(node.cwd.as_deref(), Some("C:/My Work/src"));
        assert!(file.configurations[1]
            .notes
            .iter()
            .any(|n| n.contains("preLaunchTask")));
        assert_eq!(file.compounds[0].configurations, ["Py: app", "Node"]);
        assert!(file.compounds[0].problem.contains("one debug session"));
    }

    #[test]
    fn unsupported_configurations_say_why() {
        let debuggers = BTreeMap::from([("go".to_string(), "golang.go".to_string())]);
        let file = parse_launch("l.json", SAMPLE, &context(), &debuggers);
        let problem = |i: usize| file.configurations[i].problem.clone().unwrap_or_default();
        assert!(problem(2).contains("\"attach\""));
        assert!(problem(3).contains("\"cppdbg\" is not supported"));
        assert!(problem(4).contains("declared by the extension golang.go"));
        assert!(problem(5).contains("${input:pick}"));
        assert!(problem(6).contains("no program"));
        assert!(file.configurations[2]
            .notes
            .iter()
            .any(|n| n.contains("\"port\"")));
    }

    #[test]
    fn broken_files_say_why() {
        let none = BTreeMap::new();
        assert!(parse_launch("l.json", "{", &context(), &none)
            .error
            .unwrap()
            .contains("not valid JSON"));
        assert!(parse_launch("l.json", "{}", &context(), &none)
            .error
            .unwrap()
            .contains("configurations"));
    }
}
