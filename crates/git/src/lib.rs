//! Git client: resolves the Git executable (OpenMind's portable Git first,
//! the system's only when allowed and labelled), runs Git commands as
//! argument lists in a job object, and turns their output into the data the
//! Source Control view shows. No shell, no prompts, nothing destructive
//! without an explicit, confirmed call.

pub mod args;
pub mod client;
pub mod error;
pub mod exe;
pub mod exec;
pub mod path;
pub mod status;

pub use client::{require_confirmed, Branch, DiffSides, GitClient, Identity, LogEntry, LogSink};
pub use error::GitError;
pub use exe::{find_system, resolve, GitExecutable, GitSource};
pub use exec::GitRegistry;
pub use path::repo_relative;
pub use status::{parse_status, ChangeKind, FileChange, RepoStatus};
