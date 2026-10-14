use std::path::PathBuf;

use thiserror::Error;

#[derive(Debug, Error)]
pub enum LlmError {
    #[error("the model catalog is damaged: {0}")]
    Catalog(String),
    #[error("there is no model called \"{0}\"")]
    UnknownModel(String),
    #[error("{0} is not downloaded yet")]
    NotDownloaded(String),
    #[error("not enough free disk space: {needed} needed, {free} free on the drive of {path}")]
    DiskFull {
        needed: String,
        free: String,
        path: PathBuf,
    },
    #[error("{0} is already being downloaded")]
    Busy(String),
    #[error("the download was cancelled")]
    Cancelled,
    #[error("the local model engine (llama.cpp) is not installed yet")]
    EngineMissing,
    #[error("the local model engine did not start: {0}")]
    EngineStart(String),
    #[error("{0}")]
    Download(String),
    #[error("file system error at {path}: {source}")]
    Io {
        path: PathBuf,
        source: std::io::Error,
    },
}

impl LlmError {
    pub fn io(path: impl Into<PathBuf>, source: std::io::Error) -> Self {
        Self::Io {
            path: path.into(),
            source,
        }
    }
}

/// A byte count as people read it: `2.6 GB`, `512 MB`.
pub fn human_bytes(bytes: u64) -> String {
    const GB: f64 = 1024.0 * 1024.0 * 1024.0;
    const MB: f64 = 1024.0 * 1024.0;
    let value = bytes as f64;
    if value >= GB {
        format!("{:.1} GB", value / GB)
    } else {
        format!("{:.0} MB", (value / MB).max(1.0))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bytes_read_like_people_write_them() {
        assert_eq!(human_bytes(2_837_072_864), "2.6 GB");
        assert_eq!(human_bytes(512 * 1024 * 1024), "512 MB");
        assert_eq!(human_bytes(10), "1 MB");
    }
}
