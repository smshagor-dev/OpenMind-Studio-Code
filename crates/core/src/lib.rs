pub mod error;
pub mod paths;

pub use error::CoreError;
pub use paths::AppPaths;

/// Initialize structured logging for the application. Call exactly once,
/// from the composition root (`src-tauri`), before anything else runs.
pub fn init_logging() {
    use tracing_subscriber::{fmt, EnvFilter};

    let filter = EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new("info"));
    fmt().with_env_filter(filter).init();
}
