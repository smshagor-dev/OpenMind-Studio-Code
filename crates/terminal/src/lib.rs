pub mod error;
pub mod registry;
pub mod shell;

pub use error::TerminalError;
pub use registry::{
    default_environment, CreateTerminalRequest, TerminalRegistry, TerminalSessionInfo,
};
pub use shell::{default_shell, detect_shells, ShellInfo, ShellKind};
