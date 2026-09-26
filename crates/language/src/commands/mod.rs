//! Run, build, test, lint and format commands for a detected project. Commands are *generated from what is in the
//! folder* (a `package.json` script, a `go.mod`, a Gradle wrapper): if nothing supports a command it is not
//! offered, and one that needs a tool or a platform that is missing is offered disabled with the reason. A command is
//! an argument list, never a shell string: it is typed into a terminal only when the user clicks it.

mod jvm;
mod node;
mod other;

use std::collections::BTreeSet;

use serde::Serialize;

use crate::project::{package_manager, Confidence, Detection, Dir, Project};
use crate::tools::Os;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Category {
    Run,
    Dev,
    Build,
    Test,
    Lint,
    Format,
    Install,
    Clean,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Command {
    pub id: String,
    pub label: String,
    pub category: Category,
    /// The program and its arguments.
    pub argv: Vec<String>,
    /// The folder to run in, relative to the workspace (`""` = the workspace).
    pub cwd: String,
    /// Tool ids that must be found for the command to work.
    pub tools: Vec<String>,
    /// The command downloads something (packages, images); it still runs only on a click.
    pub network: bool,
    pub note: Option<String>,
    /// Why the command can't be used on this computer regardless of tools (a platform limit).
    pub unavailable: Option<String>,
}

/// Builds a command; `cwd` is filled in by `assemble`.
pub(crate) fn cmd(
    id: &str,
    label: &str,
    category: Category,
    argv: &[&str],
    tools: &[&str],
) -> Command {
    Command {
        id: id.to_string(),
        label: label.to_string(),
        category,
        argv: argv.iter().map(|a| (*a).to_string()).collect(),
        cwd: String::new(),
        tools: tools.iter().map(|t| (*t).to_string()).collect(),
        network: false,
        note: None,
        unavailable: None,
    }
}

impl Command {
    pub(crate) fn network(mut self) -> Self {
        self.network = true;
        self
    }

    pub(crate) fn note(mut self, note: &str) -> Self {
        self.note = Some(note.to_string());
        self
    }

    pub(crate) fn unavailable(mut self, reason: &str) -> Self {
        self.unavailable = Some(reason.to_string());
        self
    }
}

/// A script or task name that can be put in a command safely.
pub(crate) fn safe_name(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= 60
        && name
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || "-_.:".contains(c))
        && !name.starts_with('-')
}

/// The tools a stack needs whether or not a command names them.
fn stack_tools(detections: &[Detection], pm: &str) -> Vec<&'static str> {
    let mut tools = Vec::new();
    for detection in detections {
        match detection.id.as_str() {
            "node" => tools.push("node"),
            "python" => tools.push("python"),
            "php" => tools.push("php"),
            "rust" => tools.extend(["cargo", "rustc"]),
            "go" => tools.push("go"),
            "maven" | "gradle" => tools.push("java"),
            "dotnet" => tools.push("dotnet"),
            "flutter" => tools.push("flutter"),
            "dart" => tools.push("dart"),
            "ruby" => tools.extend(["ruby", "bundle"]),
            "docker" | "docker-compose" => tools.push("docker"),
            "cmake" => tools.push("cmake"),
            "android" => tools.extend(["java", "android-sdk"]),
            "tauri" => tools.push("cargo"),
            _ => {}
        }
    }
    if detections.iter().any(|d| d.id == "node") {
        tools.push(match pm {
            "pnpm" => "pnpm",
            "yarn" => "yarn",
            "bun" => "bun",
            _ => "npm",
        });
    }
    tools
}

/// Turns what the detectors found in one folder into a project with its commands, tools and notes.
pub fn assemble(
    dir: &Dir,
    relative: String,
    name: String,
    detections: Vec<Detection>,
    os: Os,
) -> Project {
    let has = |id: &str| detections.iter().any(|d| d.id == id);
    let pm = has("node").then(|| package_manager(dir));
    let mut commands = Vec::new();
    if let Some(pm) = pm {
        commands.extend(node::commands(dir, pm, &detections, os));
    }
    commands.extend(jvm::commands(dir, &detections, os));
    commands.extend(other::commands(dir, &detections, os));
    let mut seen = BTreeSet::new();
    commands.retain(|c| seen.insert(c.id.clone()));
    for command in &mut commands {
        command.cwd = relative.clone();
    }
    let mut tools: Vec<String> = stack_tools(&detections, pm.unwrap_or("npm"))
        .into_iter()
        .map(str::to_string)
        .collect();
    for command in &commands {
        tools.extend(command.tools.iter().cloned());
    }
    let mut unique = BTreeSet::new();
    tools.retain(|t| unique.insert(t.clone()));
    let python_frameworks = detections
        .iter()
        .filter(|d| {
            ["django", "fastapi", "flask"].contains(&d.id.as_str())
                && d.confidence < Confidence::High
        })
        .count();
    let mut notes = other::notes(dir, &detections, os);
    let ambiguous = python_frameworks > 1;
    if ambiguous {
        notes.push(
            "More than one Python web framework is mentioned; check which one this project uses."
                .into(),
        );
    }
    Project {
        root: relative,
        name,
        detections,
        package_manager: pm.map(str::to_string),
        ambiguous,
        notes,
        tools,
        commands,
    }
}
