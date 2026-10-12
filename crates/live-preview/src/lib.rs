//! The built-in browser's file server: Run Code on an HTML file shows the page
//! the way a browser would, beside the editor. This crate serves one folder
//! (the open workspace, or the file's own folder) over HTTP on `127.0.0.1` so
//! relative links, `fetch` of local files and ES modules behave as they do on a
//! real web server, and adds a small console bridge to every HTML page so its
//! `console.*` output and errors reach the app. SCSS/Sass is compiled to CSS on request (`grass`, in process).
//!
//! What it never does: listen on anything but loopback, answer a request whose
//! `Host` isn't its own address (so a web page in the user's browser can't use
//! DNS rebinding to read the folder), send CORS headers, accept anything but
//! GET/HEAD, follow a path out of its folder (`..`, links pointing outside),
//! or write a file. Tauri-agnostic: the app decides when a server runs.

mod bridge;
mod mime;
mod request;
mod sass;
mod server;

pub use bridge::{inject_bridge, run_script_page, BRIDGE_PATH, RUN_SCRIPT_PATH};
pub use request::{resolve_path, Resolved};
pub use server::Server;

/// Why the server could not start or answer.
#[derive(Debug, thiserror::Error)]
pub enum PreviewError {
    #[error("The folder to serve doesn't exist: {0}")]
    MissingRoot(String),
    #[error("Couldn't start the built-in browser's server: {0}")]
    Bind(#[source] std::io::Error),
    #[error("The file is outside the folder the browser serves.")]
    Outside,
}
