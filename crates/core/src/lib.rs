pub mod data_scope;
pub mod error;
pub mod jsonc;
pub mod locale;
pub mod machine_identity;
pub mod machine_paths;
pub mod machine_signals;
pub mod path_env;
pub mod paths;
pub mod profile_lock;
pub mod vars;

pub use data_scope::DataScope;
pub use error::CoreError;
pub use machine_identity::MachineIdentity;
pub use machine_paths::MachineDataPaths;
pub use paths::AppPaths;

/// Initialize structured logging for the application. Call exactly once,
/// from the composition root (`src-tauri`), before anything else runs.
pub fn init_logging() {
    use tracing_subscriber::{fmt, EnvFilter};

    let filter = EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new("info"));
    fmt().with_env_filter(filter).init();
}

/// Like [`init_logging`], but writes to `<logs_dir>/openmind-studio.log` (started
/// fresh on every launch, so it can't grow without bound). The app is a GUI
/// program with no console, so stdout would go nowhere; if the file can't be
/// opened, logging falls back to stderr.
pub fn init_logging_to_file(logs_dir: &std::path::Path) {
    use tracing_subscriber::{fmt, EnvFilter};

    let file = std::fs::create_dir_all(logs_dir)
        .and_then(|()| std::fs::File::create(logs_dir.join("openmind-studio.log")));
    let Ok(file) = file else {
        init_logging();
        return;
    };
    let filter = EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new("info"));
    fmt()
        .with_env_filter(filter)
        .with_ansi(false)
        .with_writer(std::sync::Mutex::new(file))
        .init();
}
