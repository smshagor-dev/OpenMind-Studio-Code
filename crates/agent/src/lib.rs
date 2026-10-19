//! The OpenMindAI Agent: a coding agent that works in the open folder with tools — read, list, find and search files,
//! edit, write and delete them, run commands — over any model that speaks the OpenAI-compatible chat format with tool
//! calls (the local Nemotron engine, or a configured provider). Tauri-agnostic: the app is the [`AgentHost`] that shows
//! events and asks the user.
//!
//! Rules this crate keeps: every path stays inside the open folder (links followed; `.git` is never changed); a change
//! is prepared first so the user approves exactly what will be written; by default every change and command asks;
//! deletions go to the Recycle Bin; a file edited in the editor but not saved is never changed; each turn's changes can
//! be undone.

mod context;
pub mod options;
pub use options::SessionOptions;
pub mod client;
pub mod diff;
pub mod events;
pub mod external;
pub mod paths;
pub mod policy;
pub mod prompt;
pub mod session;
mod text_calls;
pub mod textfile;
pub mod tools;
pub mod wire;

pub use client::{HttpModel, ModelClient};
pub use events::{AgentEvent, Decision, PermissionRequest};
pub use paths::Workspace;
pub use policy::Mode;
pub use prompt::{system_prompt, PromptFacts};
pub use session::{AgentHost, Session, TurnInput};
pub use tools::CommandEnv;

pub mod capabilities;
