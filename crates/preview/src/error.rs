use thiserror::Error;

/// Why a preview could not be produced. The messages are shown to the user as they are.
#[derive(Debug, Error)]
pub enum PreviewError {
    #[error("That is not a valid file path.")]
    InvalidPath,
    #[error("The file doesn't exist.")]
    NotFound,
    #[error("That is not a regular file.")]
    NotAFile,
    #[error("The file is {size} bytes, more than the {limit} byte preview limit.")]
    TooLarge { size: u64, limit: u64 },
    #[error("This file appears to be binary and cannot be previewed safely.")]
    Binary,
    #[error("{0}")]
    Malformed(String),
    #[error("Couldn't read the file: {0}")]
    Io(String),
}
