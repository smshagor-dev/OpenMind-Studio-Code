use std::path::PathBuf;

/// Shared error type for `openmind-core`. Other crates define their own
/// error types and only reach for this one for the path/logging concerns
/// this crate owns.
#[derive(Debug, thiserror::Error)]
pub enum CoreError {
    #[error("failed to resolve the running executable's path")]
    ResolveExePath(#[source] std::io::Error),

    #[error("failed to create directory at {path}")]
    CreateDir {
        path: PathBuf,
        #[source]
        source: std::io::Error,
    },
}
