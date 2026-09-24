//! Git client: resolves the Git executable (OpenMind's portable Git first,
//! the system's only when allowed and labelled), runs Git commands as
//! argument lists in a job object, and turns their output into the data the
//! Source Control view shows. No shell, no prompts, nothing destructive
//! without an explicit, confirmed call.

pub mod args;
pub mod blame;
pub mod client;
pub mod clone;
pub mod error;
pub mod exe;
pub mod exec;
pub mod extras;
pub mod history;
pub mod path;
pub mod stash;
pub mod status;

pub use blame::BlameLine;
pub use client::{require_confirmed, Branch, DiffSides, GitClient, Identity, LogEntry, LogSink};
pub use clone::{default_folder_name, validate_destination, validate_url};
pub use error::GitError;
pub use exe::{find_system, resolve, GitExecutable, GitSource};
pub use exec::GitRegistry;
pub use history::{Commit, CommitFile};
pub use path::{relative_to_root, repo_relative};
pub use stash::StashEntry;
pub use status::{parse_status, ChangeKind, FileChange, RepoStatus};
