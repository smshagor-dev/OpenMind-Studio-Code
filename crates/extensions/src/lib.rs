//! OpenMind Studio's extension system: VSIX install, manifests, contribution points, activation events and
//! the extension host process. OpenMind Studio supports a VS Code API subset; nothing here is VS Code's code.

pub mod activation;
pub mod contributions;
pub mod error;
pub mod host;
pub mod hostlog;
pub mod manifest;
pub mod nls;
pub mod paths;
pub mod permissions;
pub mod settings;
pub mod store;
pub mod tasks;
pub mod views;
pub mod vsix;
pub mod webview;

pub use activation::{extensions_for, Trigger};
pub use error::ExtensionError;
pub use host::{host_descriptor, resolve_host_node, ExtensionHost, HostEvents, HostStart};
pub use hostlog::HostLog;
pub use manifest::{ActivationEvent, Manifest};
pub use paths::{workspace_key, ExtensionPaths};
pub use permissions::{Permission, PermissionSet};
pub use settings::{extras_for, theme_value};
pub use store::{
    preview, BrokenExtension, ExtensionStore, InstalledExtension, Listing, NODE_REQUIRED,
};
