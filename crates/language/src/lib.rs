//! OpenMind Studio's language and project support (Milestone 14), Tauri-agnostic and side-effect free.
//!
//! What it does: recognises languages by file name ([`registry`]), detects the kind of project a folder holds
//! ([`project`], [`detect`]), generates the run/build/test/lint/format commands that folder supports
//! ([`commands`]), looks for the tools those need without running anything ([`tools`], [`format`], [`lsp`]) and
//! renders a command for a terminal ([`shell`]). What it never does: run a tool, install anything, change PATH or
//! read outside the folder it is given. Support levels are stated honestly per language; a tool or platform that is
//! missing is reported with a reason, never hidden behind a button that does nothing.

pub mod commands;
mod detect;
pub mod format;
pub mod lsp;
pub mod project;
pub mod registry;
pub mod service;
pub mod shell;
pub mod tools;

pub use commands::{Category, Command};
pub use project::{Confidence, Detection, Project, StackGroup};
pub use registry::{language_for, LanguageDef, LANGUAGES};
pub use service::{
    file_status, workspace_status, CommandStatus, FileStatus, ProjectStatus, WorkspaceStatus,
};
pub use shell::{typed_line, ShellStyle};
pub use tools::{Os, Source, ToolEnv, ToolStatus};
