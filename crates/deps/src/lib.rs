//! Project dependencies and environments (Milestone 22.6), Tauri-agnostic and side-effect free: `inspect` reads a
//! workspace's manifests (Python, Node, Composer, Cargo, Maven/Gradle, CMake) into what is declared, installed and
//! missing, and `plan` turns a user's request into the exact command that would do it. Nothing here runs a program or
//! writes a file; manifests are treated as untrusted input (size-capped, links not followed, names validated).

mod builds;
pub mod files;
pub mod inspect;
pub mod model;
pub mod node;
pub mod others;
pub mod plan;
pub mod python;

pub use inspect::inspect;
pub use model::*;
pub use plan::{command_line, plan, Network, Op, Plan, PlanContext, PlanError, Resolved};
