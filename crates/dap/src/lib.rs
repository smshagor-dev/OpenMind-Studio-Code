//! Debug Adapter Protocol client: what can be debugged (Python with debugpy, Node.js with
//! js-debug), how each adapter is started, the DAP session over stdio or a loopback socket, and
//! the run manager that drives start-up, breakpoints, stepping and shutdown. Knows nothing about
//! Tauri: the app supplies a `DapEvents` sink and turns results into UI events.

pub mod adapter;
pub mod error;
pub mod launch;
pub mod manager;
pub mod protocol;
pub mod session;
pub mod target;
pub mod wire;

pub use adapter::{
    adapter_for, project_interpreter, readiness, resolve_interpreter, AdapterInfo, Interpreter,
    Readiness,
};
pub use error::DapError;
pub use launch::{parse_launch, Compound, Discovered, LaunchFile, LAUNCH_FILES};
pub use manager::{DapEvents, DapManager, RunSnapshot, RunState, StartRequest};
pub use protocol::{
    evaluate_arguments, parse_evaluate, parse_output, parse_scopes, parse_stack_frames,
    parse_stopped, parse_variables, Capabilities, Control, SourceBreakpoint,
};
pub use target::{default_configs, detect, LaunchConfig, Target};
