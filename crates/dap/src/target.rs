//! What can be debugged: the target for a file, and the launch configuration that starts it.

use std::collections::BTreeMap;
use std::path::Path;

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::error::DapError;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Target {
    Python,
    Node,
    Php,
}

impl Target {
    pub fn label(self) -> &'static str {
        match self {
            Target::Python => "Python",
            Target::Node => "Node.js",
            Target::Php => "PHP",
        }
    }
}

/// The debug target for a file, by extension. TypeScript is not one: it would need a compiler
/// and source maps, so it is honestly "no debugger" rather than a half-working session.
pub fn detect(path: &str) -> Option<Target> {
    let name = path.rsplit(['/', '\\']).next().unwrap_or(path);
    let ext = name.rsplit_once('.')?.1.to_ascii_lowercase();
    match ext.as_str() {
        "py" | "pyw" => Some(Target::Python),
        "js" | "mjs" | "cjs" => Some(Target::Node),
        "php" | "phtml" => Some(Target::Php),
        _ => None,
    }
}

/// A launch configuration: what to run and where.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LaunchConfig {
    pub name: String,
    pub target: Target,
    /// The file to run (absolute).
    pub program: String,
    /// The working folder (absolute); the program's folder when absent.
    #[serde(default)]
    pub cwd: Option<String>,
    #[serde(default)]
    pub args: Vec<String>,
    #[serde(default)]
    pub stop_on_entry: bool,
    /// Variables set for the program (on top of the environment OpenMind gives it).
    #[serde(default)]
    pub env: BTreeMap<String, String>,
    /// Python only: step into library code too when false (default true).
    #[serde(default)]
    pub just_my_code: Option<bool>,
}

fn parent_of(path: &str) -> String {
    let cut = path.rfind(['/', '\\']).unwrap_or(0);
    path[..cut].to_string()
}

/// The configurations offered for `path`: one "current file" configuration for its target. The
/// working folder is the workspace, or the file's folder without one.
pub fn default_configs(path: &str, workspace: Option<&str>) -> Vec<LaunchConfig> {
    let Some(target) = detect(path) else {
        return Vec::new();
    };
    let cwd = workspace.map_or_else(|| parent_of(path), str::to_string);
    vec![LaunchConfig {
        name: format!("{}: Current File", target.label()),
        target,
        program: path.to_string(),
        cwd: Some(cwd),
        args: Vec::new(),
        stop_on_entry: false,
        env: BTreeMap::new(),
        just_my_code: None,
    }]
}

impl LaunchConfig {
    /// The folder the program runs in.
    pub fn working_dir(&self) -> String {
        self.cwd.clone().unwrap_or_else(|| parent_of(&self.program))
    }

    /// The program must be an existing file and the folder an existing folder.
    pub fn validate(&self) -> Result<(), DapError> {
        if !Path::new(&self.program).is_file() {
            return Err(DapError::BadProgram(self.program.clone()));
        }
        let cwd = self.working_dir();
        if !Path::new(&cwd).is_dir() {
            return Err(DapError::BadFolder(cwd));
        }
        Ok(())
    }

    /// The adapter-specific arguments of the `launch` request. `interpreter` is the Python/Node
    /// executable the program runs on.
    pub fn launch_arguments(&self, interpreter: &str) -> Result<Value, DapError> {
        let cwd = self.working_dir();
        match self.target {
            Target::Python => Ok(json!({
                "name": self.name,
                "type": "python",
                "request": "launch",
                "program": self.program,
                "cwd": cwd,
                "args": self.args,
                "python": interpreter,
                "console": "internalConsole",
                "redirectOutput": true,
                "env": self.env,
                "justMyCode": self.just_my_code.unwrap_or(true),
                "stopOnEntry": self.stop_on_entry,
                "subProcess": false
            })),
            Target::Node => Ok(json!({
                "name": self.name,
                "type": "pwa-node",
                "request": "launch",
                "program": self.program,
                "cwd": cwd,
                "args": self.args,
                "runtimeExecutable": interpreter,
                "env": self.env,
                "console": "internalConsole",
                "stopOnEntry": self.stop_on_entry,
                "skipFiles": ["<node_internals>/**"]
            })),
            Target::Php => Err(DapError::NotReady(
                "PHP debugging requires Xdebug and is not available yet.".into(),
            )),
        }
    }

    /// The `adapterID` sent in `initialize`.
    pub fn adapter_id(&self) -> &'static str {
        match self.target {
            Target::Python => "python",
            Target::Node | Target::Php => "pwa-node",
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn files_map_to_their_debug_target() {
        assert_eq!(detect("C:/My Site/tool.py"), Some(Target::Python));
        assert_eq!(detect(r"C:\My Site\run.pyw"), Some(Target::Python));
        assert_eq!(detect("a/b.JS"), Some(Target::Node));
        assert_eq!(detect("server.mjs"), Some(Target::Node));
        assert_eq!(detect("index.php"), Some(Target::Php));
        assert_eq!(detect("app.ts"), None);
        assert_eq!(detect("notes.txt"), None);
        assert_eq!(detect("Makefile"), None);
    }

    #[test]
    fn the_default_configuration_runs_the_current_file_in_the_workspace() {
        let configs = default_configs("C:/My Site/src/tool.py", Some("C:/My Site"));
        assert_eq!(configs.len(), 1);
        assert_eq!(configs[0].name, "Python: Current File");
        assert_eq!(configs[0].cwd.as_deref(), Some("C:/My Site"));
        assert!(!configs[0].stop_on_entry);
        let alone = default_configs(r"C:\My Site\src\app.js", None);
        assert_eq!(alone[0].name, "Node.js: Current File");
        assert_eq!(alone[0].cwd.as_deref(), Some(r"C:\My Site\src"));
        assert!(default_configs("notes.txt", None).is_empty());
    }

    #[test]
    fn python_launch_arguments_use_debugpy_and_the_given_interpreter() {
        let config = &default_configs("C:/My Site/tool.py", Some("C:/My Site"))[0];
        let args = config
            .launch_arguments("C:/Runtimes/python/python.exe")
            .expect("args");
        assert_eq!(args["type"], "python");
        assert_eq!(args["request"], "launch");
        assert_eq!(args["program"], "C:/My Site/tool.py");
        assert_eq!(args["cwd"], "C:/My Site");
        assert_eq!(args["python"], "C:/Runtimes/python/python.exe");
        assert_eq!(args["console"], "internalConsole");
        assert_eq!(args["justMyCode"], true);
        assert_eq!(config.adapter_id(), "python");
    }

    #[test]
    fn node_launch_arguments_use_js_debug_and_the_given_node() {
        let config = &default_configs("C:/My Site/app.js", Some("C:/My Site"))[0];
        let args = config
            .launch_arguments("C:/Runtimes/node/node.exe")
            .expect("args");
        assert_eq!(args["type"], "pwa-node");
        assert_eq!(args["runtimeExecutable"], "C:/Runtimes/node/node.exe");
        assert_eq!(args["console"], "internalConsole");
        assert_eq!(config.adapter_id(), "pwa-node");
    }

    #[test]
    fn php_says_why_it_cannot_be_debugged() {
        let config = &default_configs("C:/My Site/index.php", None)[0];
        let err = config.launch_arguments("php.exe").expect_err("php");
        assert_eq!(
            err.to_string(),
            "PHP debugging requires Xdebug and is not available yet."
        );
    }

    #[test]
    fn a_program_that_is_not_a_file_and_a_missing_folder_are_refused() {
        let dir = tempfile::tempdir().expect("tempdir");
        let folder = dir.path().join("My Site");
        std::fs::create_dir(&folder).expect("mkdir");
        let file = folder.join("tool.py");
        std::fs::write(&file, "print(1)").expect("file");
        let mut config = LaunchConfig {
            name: "x".into(),
            target: Target::Python,
            program: file.display().to_string(),
            cwd: Some(folder.display().to_string()),
            args: vec![],
            stop_on_entry: false,
            env: BTreeMap::new(),
            just_my_code: None,
        };
        assert!(config.validate().is_ok());
        config.program = folder.display().to_string();
        assert!(matches!(config.validate(), Err(DapError::BadProgram(_))));
        config.program = file.display().to_string();
        config.cwd = Some(dir.path().join("gone").display().to_string());
        assert!(matches!(config.validate(), Err(DapError::BadFolder(_))));
        config.cwd = None;
        assert_eq!(config.working_dir(), folder.display().to_string());
    }
}
