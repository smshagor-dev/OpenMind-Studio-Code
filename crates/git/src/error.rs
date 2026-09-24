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
    #[error("Authentication is required. Credential storage is not implemented yet.")]
    NeedsCredentials,
    #[error("{0}")]
    InvalidCloneUrl(String),
    #[error("{0}")]
    InvalidCloneDestination(String),
    /// Why a file can't be blamed (untracked, binary, too large, outside the repository).
    #[error("{0}")]
    NotBlamable(String),
    #[error("Not a valid commit id: {0}")]
    InvalidCommit(String),
    #[error("{0}")]
    Failed(String),
}
