use std::path::PathBuf;

/// Everything that can go wrong installing, reading or running extensions. Each message is written for the user.
#[derive(Debug, thiserror::Error)]
pub enum ExtensionError {
    #[error("Invalid extension manifest: {0}")]
    Manifest(String),
    #[error("This is not a valid .vsix file: {0}")]
    NotAVsix(String),
    #[error("The archive is not safe to extract: {0}")]
    UnsafeArchive(String),
    #[error("{0} is already installed.")]
    AlreadyInstalled(String),
    #[error("{0} is not installed.")]
    NotInstalled(String),
    #[error("{0}")]
    Refused(String),
    #[error("Node.js runtime is required for extension host.")]
    NodeMissing,
    #[error("The extension host isn't running.")]
    HostNotRunning,
    #[error("The extension host didn't answer in time.")]
    HostTimeout,
    #[error("Extension host: {0}")]
    Host(String),
    #[error("{context}: {source}")]
    Io {
        context: String,
        source: std::io::Error,
    },
    #[error("Couldn't use {path}: {reason}")]
    Path { path: PathBuf, reason: String },
}

impl ExtensionError {
    pub fn io(context: impl Into<String>, source: std::io::Error) -> Self {
        Self::Io {
            context: context.into(),
            source,
        }
    }
}
