//! Language Server Protocol client: the registry of language servers, the
//! offline LSP bundle, finding Node.js, installing servers from pinned lockfiles, running them as child
//! processes (a job object kills the whole tree), the JSON-RPC session, and
//! document synchronization. Knows nothing about Tauri: the app supplies an
//! `LspEvents` sink and turns results into UI events.

pub mod bundle;
pub mod docs;
pub mod error;
pub mod install;
pub mod jsonrpc;
pub mod language;
pub mod manager;
pub mod native;
pub mod node;
pub mod pack;
pub mod process;
pub mod protocol;
pub mod registry;
pub mod session;
pub mod symbols;
pub mod unpack;
pub mod uri;

pub use error::LspError;
pub use language::language_id;
pub use manager::{
    LogLevel, LspEvents, LspManager, PythonExecutable, RuntimeStatus, ServerState, StartContext,
};
pub use native::{native_download, NativeDownload};
pub use node::{resolve_lsp_node, resolve_node, NodeExecutable, NodeSource};
pub use protocol::{Capabilities, Diagnostic, PublishedDiagnostics};
pub use registry::{
    package_by_id, server_by_id, server_for_path, summaries, Runtime, ServerDef, ServerSummary,
    Source,
};
pub use uri::{path_to_uri, uri_to_path};
