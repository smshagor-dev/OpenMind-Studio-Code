//! OpenMind Studio's formatting backend (Milestone 15.2), Tauri-agnostic.
//!
//! It formats *text* (the editor's in-memory buffer), never a file on disk: a built-in JSON/JSONC formatter
//! ([`json`]), a runner that pipes the text through an external formatter's stdin/stdout with a time limit and a
//! process-tree kill ([`run`]), the nearest-project lookup that gives that runner its working folder ([`project`]),
//! and the resolver that decides which formatter a file gets and says why when there is none ([`resolve`]).
//! Nothing is installed, downloaded or written; the machine's PATH is only read.

pub mod json;
pub mod project;
pub mod resolve;
pub mod run;

/// Files larger than this are not formatted (a formatter on a huge file freezes the editor for no benefit).
pub const MAX_FORMAT_BYTES: usize = 2_000_000;
