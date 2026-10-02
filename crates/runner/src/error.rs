use std::path::PathBuf;

/// Why a file can't be run (or a run couldn't start). Every variant reads as a
/// sentence the UI can show as-is, so a disabled Run button always has a real reason.
#[derive(Debug, thiserror::Error)]
pub enum RunError {
    #[error("Save the file before running.")]
    NotSaved,

    #[error("{0}")]
    NotRunnable(String),

    #[error("{runtime} runtime is not installed yet.")]
    RuntimeMissing { runtime: String },

    /// No compiler for a C/C++/Java/Rust file; the text says where to get one.
    #[error("{0}")]
    CompilerMissing(String),

    #[error("No TypeScript runner configured.")]
    NoTypeScriptRunner,

    #[error("\"{}\" was not found.", .0.display())]
    FileMissing(PathBuf),

    #[error("\"{}\" looks like a binary file, so it won't be run.", .0.display())]
    BinaryFile(PathBuf),

    #[error("\"{}\" is not a folder that exists.", .0.display())]
    BadWorkingDirectory(PathBuf),

    #[error("Select a valid folder first.")]
    BadServerRoot,

    #[error("Initialize the database first.")]
    MariaDbNotInitialized,

    #[error("This folder has no composer.json.")]
    NoComposerJson,

    #[error("Port {0} isn't allowed. Choose a port from 1024 to 65535.")]
    BadPort(u16),

    #[error("Port {0} is already in use. Choose another port or stop the program using it.")]
    PortInUse(u16),

    #[error("The run command isn't valid: {0}")]
    BadCommand(String),

    #[error(
        "The program arguments aren't valid: {0}. Change them with Run Code with Arguments..."
    )]
    BadArguments(String),

    #[error("\"{0}\" is already running. Stop it first.")]
    AlreadyRunning(String),

    #[error("Couldn't start \"{command}\": {reason}")]
    StartFailed { command: String, reason: String },
}
