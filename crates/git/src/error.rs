use thiserror::Error;

/// Everything that can go wrong in the Git client, worded for the user.
#[derive(Debug, Error, PartialEq, Eq)]
pub enum GitError {
    #[error("Git runtime is not installed yet.")]
    NotInstalled,
    #[error("This folder is not a Git repository.")]
    NotARepository,
    #[error("That path is outside the repository: {0}")]
    OutsideRepository(String),
    #[error("Invalid path: {0}")]
    InvalidPath(String),
    #[error("Enter a commit message.")]
    EmptyMessage,
    #[error("There are no staged changes to commit.")]
    NothingStaged,
    #[error("Invalid branch name: {0}")]
    InvalidBranchName(String),
    #[error("Enter both a name and an email address.")]
    InvalidIdentity,
    #[error("{0} needs confirmation.")]
    NotConfirmed(&'static str),
    #[error("Nothing to discard for {0}.")]
    NothingToDiscard(String),
    #[error("Git couldn't start: {0}")]
    StartFailed(String),
    #[error("Git took too long and was stopped.")]
    Timeout,
    #[error(
        "Git needs credentials for this remote. OpenMind doesn't store credentials yet, so use a remote that needs none or run the command in the terminal."
    )]
    NeedsCredentials,
    #[error("{0}")]
    Failed(String),
}
