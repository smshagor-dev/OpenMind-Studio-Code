//! User and project tasks (Milestone 19): `.vscode/tasks.json` and `.openmind/tasks.json` read into tasks
//! (`file`), their `dependsOn` order (`graph`), what exactly each one runs (`plan`) and the problems in their output
//! (`matcher`). Tauri-agnostic and side-effect free: this crate reads text and builds plans; the app starts the
//! processes (in an integrated terminal, after the user confirms).

pub mod file;
pub mod graph;
pub mod matcher;
pub mod plan;

pub use file::{parse, DependsOrder, TaskDef, TaskFile, TaskGroup, TaskKind};
pub use graph::{execution_order, GraphError};
pub use matcher::{describe, problems, Diagnostic, MatcherInfo, Severity};
pub use plan::{plan, PlanError, TaskShell, TaskStep};

/// Where a folder's task files are, in the order they are listed.
pub const TASK_FILES: [&str; 2] = [".openmind/tasks.json", ".vscode/tasks.json"];
