use std::path::PathBuf;

#[derive(Debug, thiserror::Error)]
pub enum RuntimeError {
    #[error("unknown runtime \"{0}\"")]
    UnknownRuntime(String),

    #[error("{kind} {version} isn't in the runtime manifest")]
    UnknownVersion { kind: String, version: String },

    #[error("{kind} {version} has no download for this platform ({platform})")]
    UnsupportedPlatform {
        kind: String,
        version: String,
        platform: String,
    },

    #[error("{kind} {version} is not installed")]
    NotInstalled { kind: String, version: String },

    #[error("{kind} {version} is already being changed by another operation")]
    Busy { kind: String, version: String },

    #[error("refusing to download over an insecure connection: {0}")]
    InsecureUrl(String),

    #[error("download failed: {0}")]
    Download(String),

    #[error("checksum mismatch: expected {expected}, got {actual}")]
    ChecksumMismatch { expected: String, actual: String },

    #[error("the archive is not safe to extract: {0}")]
    UnsafeArchive(String),

    #[error("the archive is not a valid runtime: {0}")]
    InvalidArchive(String),

    #[error("invalid runtime manifest: {0}")]
    InvalidManifest(String),

    #[error("\"{0}\" is not a valid runtime or version name")]
    InvalidName(String),

    #[error("file system error at {path}")]
    Io {
        path: PathBuf,
        #[source]
        source: std::io::Error,
    },

    #[error("database error")]
    Db(#[from] openmind_db::DbError),
}

impl RuntimeError {
    pub(crate) fn io(path: impl Into<PathBuf>, source: std::io::Error) -> Self {
        Self::Io {
            path: path.into(),
            source,
        }
    }

    /// What the user can do about this error, in plain words — shown next to
    /// the error in the Runtime Manager so a failure never dead-ends.
    pub fn recovery(&self) -> &'static str {
        match self {
            Self::Download(_) => {
                "Check your internet connection and try again — a partial download is resumed, not restarted."
            }
            Self::ChecksumMismatch { .. } => {
                "The file didn't match its expected checksum and was discarded. Try again; if it keeps failing, the runtime definition or mirror may be out of date."
            }
            Self::UnsafeArchive(_) | Self::InvalidArchive(_) => {
                "The download was rejected and nothing was installed. Try again, or update the runtime definition."
            }
            Self::InsecureUrl(_) | Self::InvalidManifest(_) => {
                "Fix or remove the runtime definition under settings/runtime-manifests."
            }
            Self::UnsupportedPlatform { .. } => {
                "Choose another version, or add a definition for this platform under settings/runtime-manifests."
            }
            Self::Busy { .. } => "Wait for the current operation on this runtime to finish.",
            Self::NotInstalled { .. } => "Install it first.",
            Self::Io { .. } => {
                "Close any terminal or program that is using this runtime, make sure the folder isn't read-only, then try again."
            }
            Self::UnknownRuntime(_) | Self::UnknownVersion { .. } | Self::InvalidName(_) => {
                "Refresh the list and choose a listed runtime and version."
            }
            Self::Db(_) => "Restart OpenMind Studio; if it keeps happening, the database may be locked or damaged.",
        }
    }

    /// The error plus its recovery advice, as one string for the UI.
    pub fn user_message(&self) -> String {
        format!("{self}. {}", self.recovery())
    }
}
