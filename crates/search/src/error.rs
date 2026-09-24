use std::path::PathBuf;

#[derive(Debug, thiserror::Error)]
pub enum SearchError {
    #[error("\"{}\" is not a folder that can be searched", .0.display())]
    InvalidRoot(PathBuf),

    #[error("there is nothing to search for")]
    EmptyQuery,

    #[error("the search text isn't a valid pattern: {0}")]
    InvalidRegex(String),

    #[error("\"{pattern}\" isn't a valid file pattern: {reason}")]
    InvalidGlob { pattern: String, reason: String },
}
