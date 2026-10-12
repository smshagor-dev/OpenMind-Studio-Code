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

    /// Another OpenMind — on this computer or another one sharing the `runtimes/` folder — is installing, repairing or
    /// removing this version right now.
    #[error("{kind} {version} is being changed by OpenMind Studio on another computer (or in another window)")]
    BusyElsewhere { kind: String, version: String },

    /// The version's files are open (a terminal, a run or a server using it, on this computer or another one), so it
    /// can't be removed; nothing was removed.
    #[error(
        "{kind} {version} can't be changed: you don't have permission to write to {folder} (in a shared installation,          ask whoever manages it)"
    )]
    NoWriteAccess {
        kind: String,
        version: String,
        folder: String,
    },

    #[error("{kind} {version} is in use, so it was not removed")]
    InUse { kind: String, version: String },

    #[error("refusing to download over an insecure connection: {0}")]
    InsecureUrl(String),

    #[error("download failed: {0}")]
    Download(String),

    /// A network failure with its category (DNS, proxy authentication, TLS ...), so the UI can say what to do.
    #[error("download failed ({}): {}", .0.problem.label(), .0.detail)]
    Network(openmind_network::problem::NetError),

    #[error("checksum mismatch: expected {expected}, got {actual}")]
    ChecksumMismatch { expected: String, actual: String },

    #[error("the archive is not safe to extract: {0}")]
    UnsafeArchive(String),

    #[error("the archive is not a valid runtime: {0}")]
    InvalidArchive(String),

    #[error("setup step \"{description}\" failed: {detail}")]
    PostInstall { description: String, detail: String },

    /// An add-on can't be installed or removed; the text says why.
    #[error("{0}")]
    Addon(String),

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

fn network_recovery(problem: openmind_network::problem::NetProblem) -> &'static str {
    use openmind_network::problem::NetProblem as P;
    match problem {
        P::ProxyAuthRequired => "The proxy asks for a user name and password. Enter them in Network: Proxy Settings, then try again.",
        P::ProxyUnavailable => "The proxy could not be reached. Check the proxy address in Network: Proxy Settings, or import the file from a USB drive (Network: Import Offline Package).",
        P::Dns => "The server's name could not be found. On a network that only allows a proxy, set the proxy in Network: Proxy Settings; offline, import the file with Network: Import Offline Package.",
        P::Tls => "The secure connection was refused (a network that inspects HTTPS can cause this). Nothing was downloaded. Import the file with Network: Import Offline Package, or ask the network administrator.",
        P::Blocked => "The network or the server refused this address. Import the file from another computer with Network: Import Offline Package.",
        _ => "Check the connection and try again — a partial download is resumed, not restarted. Offline, import the file with Network: Import Offline Package.",
    }
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
            Self::Network(error) => network_recovery(error.problem),
            Self::Download(_) => {
                "Check your internet connection and try again — a partial download is resumed, not restarted."
            }
            Self::ChecksumMismatch { .. } => {
                "The file didn't match its expected checksum and was discarded. Try again; if it keeps failing, the runtime definition or mirror may be out of date."
            }
            Self::UnsafeArchive(_) | Self::InvalidArchive(_) => {
                "The download was rejected and nothing was installed. Try again, or update the runtime definition."
            }
            Self::PostInstall { .. } => {
                "Nothing was installed. Try again; if it keeps failing, check that security software isn't blocking the runtime from starting."
            }
            Self::InsecureUrl(_) | Self::InvalidManifest(_) => {
                "Fix or remove the runtime definition under settings/runtime-manifests."
            }
            Self::UnsupportedPlatform { .. } => {
                "Choose another version, or add a definition for this platform under settings/runtime-manifests."
            }
            Self::Busy { .. } => "Wait for the current operation on this runtime to finish.",
            Self::BusyElsewhere { .. } => {
                "Wait until it finishes there, then refresh the Runtime Manager: the result is shared with this computer."
            }
            Self::InUse { .. } => {
                "Close the terminals, runs and servers that use it — also on other computers sharing this installation — then try again. It still works as before."
            }
            Self::NoWriteAccess { .. } => {
                "Runtimes of a shared installation are managed by whoever may write to its folder (the teacher, IT). You can still use the runtimes that are installed."
            }
            Self::NotInstalled { .. } => "Install it first.",
            Self::Addon(_) => "Refresh the Runtime Manager; the runtime version itself is unchanged.",
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
