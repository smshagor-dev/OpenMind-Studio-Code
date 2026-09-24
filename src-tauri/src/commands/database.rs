//! MariaDB, phpMyAdmin and Composer project commands for the PHP Server window.
//! Every process is a normal child of this app (no Windows service), bound to
//! 127.0.0.1, started only by an explicit command, and killed with the app.
//! The backend is the one truth about what is running: both windows read it
//! through `*_status` and re-read it on the `*:changed` events.

use std::fs::OpenOptions;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use openmind_db::EditorSettingsRepository;
use openmind_runner::{
    composer_plan, mariadb_admin_plan, mariadb_init_plan, mariadb_start_plan, php_server_plan,
    port_is_free, portable_version, render_mariadb_config, render_phpmyadmin_config,
    run_to_completion, server_url, AdminAction, ComposerAction, EventSink, MariaDbPaths,
    PhpServerRequest, RunError, RunEvent, RunEventKind, RunInfo, RunRegistry, MARIADB_USER,
};
use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, State};

use crate::app_state::AppState;
use crate::commands::run::environment;

const PASSWORD_KEY: &str = "mariadb.rootPassword";
const SECRET_KEY: &str = "phpmyadmin.secret";

/// A started service: what every window shows for it.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ServiceInfo {
    pub run: RunInfo,
    pub port: u16,
    /// Where it can be opened in a browser, when it speaks http.
    pub url: Option<String>,
    /// MariaDB: it answered a ping. (Always true for the others.)
    pub ready: bool,
    /// The service's own version (MariaDB 11.8.9, phpMyAdmin 5.2.3).
    pub version: Option<String>,
    /// phpMyAdmin: the PHP version it was started with (it keeps it after a switch).
    pub php_version: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MariaDbStatus {
    pub initialized: bool,
    pub running: Option<ServiceInfo>,
    pub data_dir: String,
    pub log_dir: String,
    pub config_file: String,
    pub has_password: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Credentials {
    pub username: String,
    pub password: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectInfo {
    pub is_dir: bool,
    pub has_composer_json: bool,
}

async fn setting(state: &AppState, key: &str) -> Option<String> {
    EditorSettingsRepository::new(state.db.pool())
        .get(key)
        .await
        .ok()
        .flatten()
}

async fn save_setting(state: &AppState, key: &str, value: &str) -> Result<(), String> {
    EditorSettingsRepository::new(state.db.pool())
        .set(key, value)
        .await
        .map_err(|err| err.to_string())
}

/// `len` random letters and digits from the operating system's generator.
fn random_alphanumeric(len: usize) -> Result<String, String> {
    const ALPHABET: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
    let mut out = String::with_capacity(len);
    while out.len() < len {
        let mut bytes = [0u8; 64];
        getrandom::fill(&mut bytes).map_err(|err| format!("no random source: {err}"))?;
        // 248 = 62 * 4: drop the rest so every character is equally likely.
        for byte in bytes.into_iter().filter(|b| *b < 248) {
            if out.len() < len {
                out.push(char::from(ALPHABET[usize::from(byte) % ALPHABET.len()]));
            }
        }
    }
    Ok(out)
}

fn append_log(path: &Path, text: &str) {
    if let Some(dir) = path.parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    if let Ok(mut file) = OpenOptions::new().create(true).append(true).open(path) {
        let _ = writeln!(file, "{text}");
    }
}

/// The active, healthy install of runtime `kind`: (version, folder).
async fn active_install(state: &AppState, kind: &str) -> Option<(String, PathBuf)> {
    let list = state.runtime.list().await.ok()?;
    let status = list.into_iter().find(|entry| entry.id == kind)?;
    let entry = status
        .installed
        .into_iter()
        .find(|entry| entry.active && entry.healthy)?;
    Some((entry.version, PathBuf::from(entry.path)))
}

fn app_paths(state: &AppState) -> MariaDbPaths {
    MariaDbPaths::new(&state.app_root)
}

/// The sink for a long-running service: logs every line to `log`, forwards
/// it to the windows, and clears the service's info when it exits.
fn service_sink(
    app: &AppHandle,
    event_name: &'static str,
    changed_name: &'static str,
    log: Option<PathBuf>,
    clear: fn(&AppState),
) -> EventSink {
    let app = app.clone();
    Arc::new(move |event: RunEvent| {
        if let Some(log) = &log {
            match &event.event {
                RunEventKind::Output { line, .. } => append_log(log, line),
                RunEventKind::Started { command_line, .. } => {
                    append_log(log, &format!("[start] {command_line}"));
                }
                RunEventKind::Exited { code, stopped, .. } => {
                    append_log(
                        log,
                        &format!("[exit] code {code:?}, stopped by user: {stopped}"),
                    );
                }
            }
        }
        if matches!(event.event, RunEventKind::Exited { .. }) {
            clear(&app.state::<AppState>());
            let _ = app.emit(changed_name, ());
        }
        if let Err(err) = app.emit(event_name, event) {
            tracing::error!(?err, "failed to emit a service event");
        }
    })
}

fn clear_db(state: &AppState) {
    if let Ok(mut info) = state.db_info.lock() {
        *info = None;
    }
}

fn clear_pma(state: &AppState) {
    if let Ok(mut info) = state.pma_info.lock() {
        *info = None;
    }
}

fn running_info(
    registry: &RunRegistry,
    slot: &std::sync::Mutex<Option<ServiceInfo>>,
) -> Option<ServiceInfo> {
    if registry.active().is_empty() {
        return None;
    }
    slot.lock().ok()?.clone()
}

// --- MariaDB ---

#[tauri::command]
pub async fn mariadb_status(state: State<'_, AppState>) -> Result<MariaDbStatus, String> {
    let paths = app_paths(&state);
    Ok(MariaDbStatus {
        initialized: paths.is_initialized(),
        running: running_info(&state.db_server, &state.db_info),
        data_dir: paths.data_dir.to_string_lossy().into_owned(),
        log_dir: paths.log_dir.to_string_lossy().into_owned(),
        config_file: paths.config_file.to_string_lossy().into_owned(),
        has_password: setting(&state, PASSWORD_KEY).await.is_some(),
    })
}

/// The root user and the password OpenMind generated when it initialized the
/// database (kept in the local SQLite settings; the portable data folder is
/// as private as the rest of the app folder).
#[tauri::command]
pub async fn mariadb_credentials(state: State<'_, AppState>) -> Result<Credentials, String> {
    Ok(Credentials {
        username: MARIADB_USER.to_string(),
        password: setting(&state, PASSWORD_KEY).await,
    })
}

/// Creates the system tables in `data/mariadb` and gives `root` a generated
/// password. Refuses to touch an already initialized folder; a failed run
/// removes what it created so it can be tried again.
#[tauri::command]
pub async fn mariadb_initialize(app: AppHandle, state: State<'_, AppState>) -> Result<(), String> {
    let paths = app_paths(&state);
    if !state.db_server.active().is_empty() {
        return Err("Stop MariaDB before initializing it.".into());
    }
    if paths.is_initialized() {
        return Err("The database is already initialized.".into());
    }
    let password = random_alphanumeric(24)?;
    let environment = environment(&state).await;
    let plan = mariadb_init_plan(&environment, &paths, &password, std::env::var_os("PATH"))
        .map_err(|err| err.to_string())?;
    // A half-made folder from an earlier failure would confuse the initializer.
    let _ = std::fs::remove_dir_all(&paths.data_dir);
    std::fs::create_dir_all(&paths.data_dir).map_err(|err| err.to_string())?;
    append_log(&paths.log_file, &format!("[initialize] {}", plan.display));
    let done =
        tokio::task::spawn_blocking(move || run_to_completion(&plan, Duration::from_secs(240)))
            .await
            .map_err(|err| err.to_string())?
            .map_err(|err| err.to_string())?;
    append_log(&paths.log_file, done.output.trim_end());
    if !done.success() || !paths.is_initialized() {
        let _ = std::fs::remove_dir_all(&paths.data_dir);
        let tail: Vec<&str> = done.output.lines().rev().take(6).collect();
        return Err(format!(
            "Initializing the database failed{}: {}",
            if done.timed_out { " (timed out)" } else { "" },
            tail.into_iter().rev().collect::<Vec<_>>().join(" | ")
        ));
    }
    save_setting(&state, PASSWORD_KEY, &password).await?;
    let _ = app.emit("mariadb:changed", ());
    Ok(())
}

async fn write_mariadb_config(
    state: &AppState,
    paths: &MariaDbPaths,
    port: u16,
) -> Result<(), String> {
    let (_, install) = active_install(state, "mariadb").await.ok_or_else(|| {
        RunError::RuntimeMissing {
            runtime: "MariaDB".into(),
        }
        .to_string()
    })?;
    let text = render_mariadb_config(paths, &install, port).map_err(|err| err.to_string())?;
    std::fs::create_dir_all(&paths.config_dir).map_err(|err| err.to_string())?;
    std::fs::create_dir_all(&paths.log_dir).map_err(|err| err.to_string())?;
    std::fs::write(&paths.config_file, text).map_err(|err| err.to_string())
}

#[tauri::command]
pub async fn mariadb_start(
    port: u16,
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<ServiceInfo, String> {
    if !state.db_server.active().is_empty() {
        return Err("MariaDB is already running.".into());
    }
    let paths = app_paths(&state);
    let environment = environment(&state).await;
    let plan = mariadb_start_plan(&environment, &paths, std::env::var_os("PATH"))
        .map_err(|err| err.to_string())?;
    if !port_is_free(port) {
        return Err(RunError::PortInUse(port).to_string());
    }
    let password = setting(&state, PASSWORD_KEY)
        .await
        .ok_or("The database has no saved password — initialize it first.")?;
    write_mariadb_config(&state, &paths, port).await?;
    let sink = service_sink(
        &app,
        "mariadb:event",
        "mariadb:changed",
        Some(paths.log_file.clone()),
        clear_db,
    );
    let run = state
        .db_server
        .start(&plan, sink)
        .map_err(|err| err.to_string())?;
    let info = ServiceInfo {
        run,
        port,
        url: None,
        ready: false,
        version: portable_version(&plan.resolved),
        php_version: None,
    };
    if let Ok(mut slot) = state.db_info.lock() {
        *slot = Some(info.clone());
    }
    let _ = app.emit("mariadb:changed", ());
    spawn_ready_watch(app, environment, port, password);
    Ok(info)
}

/// Pings the server until it answers (then marks it ready) or it exits.
fn spawn_ready_watch(
    app: AppHandle,
    environment: openmind_runner::RunEnvironment,
    port: u16,
    password: String,
) {
    std::thread::spawn(move || {
        let Ok(ping) = mariadb_admin_plan(
            &environment,
            port,
            AdminAction::Ping,
            &password,
            std::env::var_os("PATH"),
        ) else {
            return;
        };
        for _ in 0..180 {
            let state = app.state::<AppState>();
            if state.db_server.active().is_empty() {
                return;
            }
            if run_to_completion(&ping, Duration::from_secs(5)).is_ok_and(|done| done.success()) {
                if let Ok(mut slot) = state.db_info.lock() {
                    if let Some(info) = slot.as_mut() {
                        info.ready = true;
                    }
                }
                let _ = app.emit("mariadb:changed", ());
                return;
            }
            std::thread::sleep(Duration::from_millis(500));
        }
    });
}

/// Asks MariaDB to shut down cleanly, then makes sure the process is gone.
pub fn stop_mariadb_blocking(app: &AppHandle) {
    let state = app.state::<AppState>();
    if state.db_server.active().is_empty() {
        return;
    }
    let port = state
        .db_info
        .lock()
        .ok()
        .and_then(|slot| slot.as_ref().map(|i| i.port));
    let password = tauri::async_runtime::block_on(setting(&state, PASSWORD_KEY));
    let environment = tauri::async_runtime::block_on(environment(&state));
    if let (Some(port), Some(password)) = (port, password) {
        if let Ok(plan) = mariadb_admin_plan(
            &environment,
            port,
            AdminAction::Shutdown,
            &password,
            std::env::var_os("PATH"),
        ) {
            let _ = run_to_completion(&plan, Duration::from_secs(15));
        }
    }
    for _ in 0..100 {
        if state.db_server.active().is_empty() {
            return;
        }
        std::thread::sleep(Duration::from_millis(100));
    }
    state.db_server.stop_all();
}

#[tauri::command]
pub async fn mariadb_stop(app: AppHandle) -> Result<(), String> {
    tokio::task::spawn_blocking(move || stop_mariadb_blocking(&app))
        .await
        .map_err(|err| err.to_string())
}

// --- phpMyAdmin ---

fn temp_dir(state: &AppState) -> PathBuf {
    state.app_root.join("cache").join("phpmyadmin")
}

/// Writes phpMyAdmin's `config.inc.php` (regenerated on every start).
async fn write_pma_config(state: &AppState, dir: &Path, mariadb_port: u16) -> Result<(), String> {
    let secret = match setting(state, SECRET_KEY).await {
        Some(secret) => secret,
        None => {
            let secret = random_alphanumeric(40)?;
            save_setting(state, SECRET_KEY, &secret).await?;
            secret
        }
    };
    let temp = temp_dir(state);
    std::fs::create_dir_all(&temp).map_err(|err| err.to_string())?;
    let text =
        render_phpmyadmin_config(&secret, mariadb_port, &temp).map_err(|err| err.to_string())?;
    std::fs::write(dir.join("config.inc.php"), text).map_err(|err| err.to_string())
}

#[tauri::command]
pub async fn pma_start(
    port: u16,
    mariadb_port: u16,
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<ServiceInfo, String> {
    if !state.pma.active().is_empty() {
        return Err("phpMyAdmin is already running.".into());
    }
    let (version, dir) = active_install(&state, "phpmyadmin").await.ok_or_else(|| {
        RunError::RuntimeMissing {
            runtime: "phpMyAdmin".into(),
        }
        .to_string()
    })?;
    let environment = environment(&state).await;
    let plan = php_server_plan(
        &PhpServerRequest {
            root: dir.clone(),
            port,
        },
        &environment,
        std::env::var_os("PATH"),
    )
    .map_err(|err| err.to_string())?;
    if !port_is_free(port) {
        return Err(RunError::PortInUse(port).to_string());
    }
    write_pma_config(&state, &dir, mariadb_port).await?;
    let log = state
        .app_root
        .join("logs")
        .join("phpmyadmin")
        .join("phpmyadmin.log");
    let sink = service_sink(&app, "pma:event", "pma:changed", Some(log), clear_pma);
    let run = state
        .pma
        .start(&plan, sink)
        .map_err(|err| err.to_string())?;
    let info = ServiceInfo {
        run,
        port,
        url: Some(server_url(port)),
        ready: true,
        version: Some(version),
        php_version: portable_version(&plan.resolved),
    };
    if let Ok(mut slot) = state.pma_info.lock() {
        *slot = Some(info.clone());
    }
    let _ = app.emit("pma:changed", ());
    Ok(info)
}

#[tauri::command]
pub fn pma_stop(state: State<'_, AppState>) {
    state.pma.stop_all();
}

#[tauri::command]
pub fn pma_status(state: State<'_, AppState>) -> Option<ServiceInfo> {
    running_info(&state.pma, &state.pma_info)
}

// --- Composer ---

#[tauri::command]
pub fn php_project_info(root: String) -> ProjectInfo {
    let path = Path::new(&root);
    ProjectInfo {
        is_dir: path.is_absolute() && path.is_dir(),
        has_composer_json: path.join("composer.json").is_file(),
    }
}

/// Runs `composer <action>` in `root` on the portable PHP; output arrives as
/// `composer:event`s and the run's end as `composer:changed`.
#[tauri::command]
pub async fn composer_run(
    action: ComposerAction,
    root: String,
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<RunInfo, String> {
    if !state.composer.active().is_empty() {
        return Err("A Composer command is already running.".into());
    }
    let (_, dir) = active_install(&state, "composer").await.ok_or_else(|| {
        RunError::RuntimeMissing {
            runtime: "Composer".into(),
        }
        .to_string()
    })?;
    let environment = environment(&state).await;
    let plan = composer_plan(
        action,
        Path::new(&root),
        &dir.join("composer.phar"),
        &state.app_root,
        &environment,
        std::env::var_os("PATH"),
    )
    .map_err(|err| err.to_string())?;
    let _ = std::fs::create_dir_all(state.app_root.join("data").join("composer"));
    let _ = std::fs::create_dir_all(state.app_root.join("cache").join("composer"));
    let sink = service_sink(&app, "composer:event", "composer:changed", None, |_| {});
    let run = state
        .composer
        .start(&plan, sink)
        .map_err(|err| err.to_string())?;
    let _ = app.emit("composer:changed", ());
    Ok(run)
}

#[tauri::command]
pub fn composer_stop(state: State<'_, AppState>) {
    state.composer.stop_all();
}

#[tauri::command]
pub fn composer_status(state: State<'_, AppState>) -> Vec<RunInfo> {
    state.composer.active()
}

/// Everything this file started dies with the app.
pub fn stop_all_services(app: &AppHandle) {
    let state = app.state::<AppState>();
    state.pma.stop_all();
    state.composer.stop_all();
    stop_mariadb_blocking(app);
}
