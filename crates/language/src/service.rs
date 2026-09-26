//! The status of a workspace and of a file, put together from the registry, the detectors and the tool lookup. It is
//! what the Language / Project Status window shows: which projects were found, which commands each has and whether
//! they can run, which tools are on the computer, and — for a file — its language, language servers, formatters and
//! linters. Everything is a file lookup; nothing is run.

use std::path::Path;

use serde::Serialize;

use crate::commands::{Category, Command};
use crate::format::{options, FormatOption};
use crate::lsp::{candidates, LspCandidate};
use crate::project::{detect_projects, Project};
use crate::registry::{language_for, LanguageDef};
use crate::tools::{status_of, Os, ToolEnv, ToolStatus};

/// The tools listed for every workspace, project or not.
const GENERAL_TOOLS: &[&str] = &[
    "node",
    "npm",
    "pnpm",
    "yarn",
    "python",
    "pip",
    "php",
    "composer",
    "cargo",
    "rustc",
    "go",
    "java",
    "mvn",
    "gradle",
    "dotnet",
    "flutter",
    "dart",
    "adb",
    "ruby",
    "bundle",
    "docker",
    "powershell",
    "bash",
    "git",
    "cmake",
    "make",
];

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CommandStatus {
    #[serde(flatten)]
    pub command: Command,
    pub available: bool,
    /// Why it can't run right now (a platform limit or the missing tools with what to do).
    pub reason: Option<String>,
    pub missing: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectStatus {
    #[serde(flatten)]
    pub project: Project,
    pub title: String,
    pub tool_status: Vec<ToolStatus>,
    pub command_status: Vec<CommandStatus>,
    /// One sentence: what was found, and what is missing.
    pub summary: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceStatus {
    pub os: Os,
    pub projects: Vec<ProjectStatus>,
    pub tools: Vec<ToolStatus>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileStatus {
    pub path: String,
    pub language: Option<&'static LanguageDef>,
    /// The project (its root, relative) the file belongs to, when one does.
    pub project_root: Option<String>,
    pub lsp: Vec<LspCandidate>,
    pub formatters: Vec<FormatOption>,
    pub linters: Vec<FormatOption>,
}

/// Whether a command can run now, and if not, why.
pub fn command_status(command: &Command, env: &ToolEnv) -> CommandStatus {
    if let Some(reason) = &command.unavailable {
        return CommandStatus {
            command: command.clone(),
            available: false,
            reason: Some(reason.clone()),
            missing: Vec::new(),
        };
    }
    let missing: Vec<ToolStatus> = command
        .tools
        .iter()
        .map(|id| status_of(id, env))
        .filter(|status| status.found.is_none())
        .collect();
    let reason = missing.first().map(|first| {
        let names: Vec<&str> = missing.iter().map(|m| m.name.as_str()).collect();
        format!("{} not found. {}", names.join(", "), first.hint)
    });
    CommandStatus {
        command: command.clone(),
        available: missing.is_empty(),
        reason,
        missing: missing.into_iter().map(|m| m.id).collect(),
    }
}

fn summarize(project: &Project, tools: &[ToolStatus]) -> String {
    let found: Vec<&str> = tools
        .iter()
        .filter(|t| t.found.is_some())
        .map(|t| t.name.as_str())
        .collect();
    let missing: Vec<&str> = tools
        .iter()
        .filter(|t| t.found.is_none())
        .map(|t| t.name.as_str())
        .collect();
    let mut text = format!("Detected {}.", project.title());
    if !found.is_empty() {
        text.push_str(&format!(" Found: {}.", found.join(", ")));
    }
    if !missing.is_empty() {
        text.push_str(&format!(" Missing: {}.", missing.join(", ")));
    }
    if let Some(run) = project
        .commands
        .iter()
        .find(|c| matches!(c.category, Category::Dev | Category::Run))
    {
        text.push_str(&format!(
            " {}: {}.",
            if run.category == Category::Dev {
                "Dev"
            } else {
                "Run"
            },
            run.argv.join(" ")
        ));
    }
    text
}

/// Scans the workspace (bounded, no links followed) and resolves every tool the projects need.
pub fn workspace_status(root: &Path, base: &ToolEnv) -> WorkspaceStatus {
    let projects = detect_projects(root, base.os)
        .into_iter()
        .map(|project| {
            let env = base.for_project(&root.join(&project.root));
            let tool_status: Vec<ToolStatus> =
                project.tools.iter().map(|id| status_of(id, &env)).collect();
            let command_status = project
                .commands
                .iter()
                .map(|c| command_status(c, &env))
                .collect();
            ProjectStatus {
                title: project.title(),
                summary: summarize(&project, &tool_status),
                project,
                tool_status,
                command_status,
            }
        })
        .collect();
    WorkspaceStatus {
        os: base.os,
        projects,
        tools: GENERAL_TOOLS.iter().map(|id| status_of(id, base)).collect(),
    }
}

/// The project a workspace-relative path lives in: the one with the longest matching root.
pub fn project_of<'a>(
    relative_file: &str,
    projects: &'a [ProjectStatus],
) -> Option<&'a ProjectStatus> {
    projects
        .iter()
        .filter(|p| {
            p.project.root.is_empty() || relative_file.starts_with(&format!("{}/", p.project.root))
        })
        .max_by_key(|p| p.project.root.len())
}

/// What is known about one file: its language and the tools around it. `file` is absolute; `root` is the workspace.
pub fn file_status(
    root: &Path,
    file: &Path,
    base: &ToolEnv,
    workspace: &WorkspaceStatus,
) -> FileStatus {
    let path = file.to_string_lossy().replace('\\', "/");
    let relative = file
        .strip_prefix(root)
        .map(|p| p.to_string_lossy().replace('\\', "/"))
        .unwrap_or_default();
    let project = project_of(&relative, &workspace.projects);
    let env = match project {
        Some(p) => base.for_project(&root.join(&p.project.root)),
        None => base.clone(),
    };
    let language = language_for(&path);
    let (lsp, formatters, linters) = match language {
        Some(lang) => (
            candidates(lang.lsp, &env),
            options(lang, Category::Format, &file.to_string_lossy(), &env),
            options(lang, Category::Lint, &file.to_string_lossy(), &env),
        ),
        None => (Vec::new(), Vec::new(), Vec::new()),
    };
    FileStatus {
        path,
        language,
        project_root: project.map(|p| p.project.root.clone()),
        lsp,
        formatters,
        linters,
    }
}
