pub mod error;
pub mod recent_files_service;
pub mod session_service;

pub use error::WorkspaceError;
pub use recent_files_service::{RecentFileInfo, RecentFilesService};
pub use session_service::{SessionService, SessionSnapshot};
