//! Workspace search. Two engines share one result shape: a plain, cancellable, symlink-safe walk over the disk
//! (`walk`, used while no index exists), and the persistent local index (`index`, Milestone 12: file names, text via a
//! trigram full-text index, symbols), which answers without touching the workspace.

pub mod error;
pub mod find;
pub mod index;
pub mod matcher;
pub mod query;
pub mod registry;
pub mod walk;

pub use error::SearchError;
pub use matcher::LineMatch;
pub use query::{SearchQuery, ALWAYS_EXCLUDED_DIRS};
pub use registry::SearchRegistry;
pub use walk::{search, FileMatches, SearchOutcome, MAX_FILE_BYTES};

#[cfg(test)]
mod tests;
