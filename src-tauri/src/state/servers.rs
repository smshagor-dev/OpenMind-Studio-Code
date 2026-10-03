//! The global `servers` domain: OpenMind's managed servers with their ports, from the process registries the commands
//! already keep (no second registry). The PHP built-in server, MariaDB and phpMyAdmin are app-wide (one of each, like
//! XAMPP's control panel), so this state is shared by every window rather than tied to a folder.

use serde::Serialize;

use crate::app_state::AppState;
use crate::commands::mysql::MySqlStatus;
use crate::commands::php::PhpServerInfo;

/// What `php_server_status` and `mysql_status` return, together.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ServersState {
    /// The PHP built-in server while it runs (URL, port, PID, the PHP version it started with).
    php: Option<PhpServerInfo>,
    /// The MySQL service (MariaDB + phpMyAdmin): life-cycle state, each half's PID/port/URL, the error if any.
    mysql: MySqlStatus,
}

pub async fn read(state: &AppState) -> ServersState {
    let php = if state.php_server.active().is_empty() {
        None
    } else {
        state
            .php_server_info
            .lock()
            .ok()
            .and_then(|info| info.clone())
    };
    ServersState {
        php,
        mysql: crate::commands::mysql::status_of(state).await,
    }
}
