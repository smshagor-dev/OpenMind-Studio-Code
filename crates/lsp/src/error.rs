use thiserror::Error;

#[derive(Debug, Error)]
pub enum LspError {
    #[error("Language server is not installed yet.")]
    NotInstalled,
    #[error("Node.js runtime is not installed yet.")]
    NodeMissing,
    #[error("No language server supports this file type.")]
    Unsupported,
    #[error("The language server isn't running.")]
    NotRunning,
    #[error("The language server couldn't start: {0}")]
    StartFailed(String),
    #[error("The language server didn't answer in time.")]
    Timeout,
    #[error("The language server stopped.")]
    Closed,
    #[error("{0}")]
    Server(String),
    #[error("Invalid language server message: {0}")]
    Protocol(String),
    #[error("Not an allowed request: {0}")]
    Refused(String),
    #[error("Installing the language server failed: {0}")]
    InstallFailed(String),
}
