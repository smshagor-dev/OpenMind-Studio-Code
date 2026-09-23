#[derive(Debug, thiserror::Error)]
pub enum TerminalError {
    #[error("no terminal session with id \"{0}\"")]
    NotFound(String),

    #[error("failed to spawn shell")]
    Spawn(#[source] anyhow::Error),

    #[error("failed to write to terminal")]
    Write(#[source] std::io::Error),

    #[error("failed to resize terminal")]
    Resize(#[source] anyhow::Error),

    #[error("requested shell is not available on this system")]
    ShellUnavailable,
}
