//! Local language models for the OpenMindAI Agent: which NVIDIA Nemotron builds exist (a pinned catalog), which of
//! them fit this PC, downloading one (checksum-verified, resumable, through the user's proxy) and running it with
//! llama.cpp's `llama-server` on 127.0.0.1. Tauri-agnostic: the app supplies the folders and forwards progress.
//!
//! Nothing here runs by itself: hardware is read when asked, a download starts on a click, the engine starts when the
//! agent is used and stops with the app.

pub mod catalog;
pub mod download;
pub mod error;
pub mod fit;
pub mod hardware;
pub mod server;
pub mod store;

pub use catalog::{Catalog, ModelEntry, ModelFile};
pub use error::{human_bytes, LlmError};
pub use fit::{fit, recommended, Fit, FitLevel};
pub use hardware::{detect, Gpu, Hardware};
pub use server::{Engine, EngineConfig, Health};
pub use store::{LocalModel, ModelState, ModelStore};
