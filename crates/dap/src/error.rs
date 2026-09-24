use thiserror::Error;

#[derive(Debug, Error)]
pub enum DapError {
    #[error("No debugger is available for this file type.")]
    Unsupported,
    #[error("{0}")]
    NotReady(String),
    #[error("A debug session is already running.")]
    AlreadyRunning,
    #[error("There is no debug session.")]
    NoSession,
    #[error("The program to debug is not a file: {0}")]
    BadProgram(String),
    #[error("The working folder does not exist: {0}")]
    BadFolder(String),
    #[error("The debug adapter couldn't start: {0}")]
    StartFailed(String),
    #[error("The debug adapter didn't answer in time.")]
    Timeout,
    #[error("The debug adapter stopped.")]
    Closed,
    #[error("{0}")]
    Adapter(String),
    #[error("Invalid debug adapter message: {0}")]
    Protocol(String),
    #[error("Not an allowed request: {0}")]
    Refused(String),
}
