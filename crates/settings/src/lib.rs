pub mod error;
pub mod window_state_service;

pub use error::SettingsError;
pub use window_state_service::{WindowStateService, MAIN_WINDOW_LABEL};
