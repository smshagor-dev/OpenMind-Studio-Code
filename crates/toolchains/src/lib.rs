//! Bundled toolchain packs: the app-local tools (Git and Composer versions, debugpy, language servers, formatters,
//! linters) that live in `<app>/tools` and are listed in `tools/toolchains.json`.
//!
//! **This crate only reads.** It never downloads, never installs and never touches the system PATH; the folders it
//! reports (`Packs::injection`) are for the PATH of processes OpenMind itself starts. Whether a tool is "there" is
//! decided by looking for its program on disk, so nothing can be shown as installed when it is not.

pub mod catalog;
pub mod manifest;
pub mod packs;
pub mod verify;
pub mod version;

pub use catalog::{known, Category, Known, KNOWN};
pub use manifest::{Manifest, ManifestError, DEFAULT_MAX_VERSIONS};
pub use packs::{
    current_platform, load, manifest_path, Injection, Packs, ToolStatus, ToolView, VersionStatus,
    VersionView,
};
pub use verify::{verify, VerifyResult};
