//! Workspace text search: a plain, cancellable, symlink-safe walk that skips
//! heavy folders, binary and huge files, and reports matches the way Monaco
//! addresses text. No index yet — that belongs to the later indexed-search
//! milestone; this is the real, working search the UI needs now.

pub mod error;
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
