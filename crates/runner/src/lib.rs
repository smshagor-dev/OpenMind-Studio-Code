//! Run Code: decide whether the active file can be run, resolve which
//! interpreter runs it (portable runtime first, system only as a fallback),
//! and run it as a managed child process whose output is streamed and whose
//! whole process tree dies on Stop or on app shutdown. Nothing goes through a
//! shell: a run is an argument list, so a file name can't become a command.

pub mod display;
pub mod error;
pub mod kind;
pub mod plan;
pub mod runtime;
pub mod session;
pub mod template;

pub use display::{command_line, shell_command_line, ShellStyle};
pub use error::RunError;
pub use kind::{detect, Detection, RunnableKind};
pub use plan::{plan, RunPlan, RunRequest};
pub use runtime::{RunEnvironment, RuntimeSource};
pub use session::{EventSink, RunEvent, RunEventKind, RunInfo, RunRegistry, Stream};

#[cfg(test)]
mod tests;
