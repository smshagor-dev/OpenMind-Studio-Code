//! MySQL in the PHP Server window: one service for the local database workflow. Inside it are two processes — MariaDB
//! (the MySQL-compatible server) and phpMyAdmin (served by the portable PHP) — that start and stop together:
//!
//! Start: the runtimes are there → the database exists (created as root/root when it doesn't; an existing one is never
//! touched) → MariaDB on 127.0.0.1 → it answers a ping → phpMyAdmin → phpMyAdmin answers and reaches the database.
//! Only then is MySQL Running. Stop: phpMyAdmin first, then MariaDB's own clean shutdown (its process tree is ended only
//! if it doesn't exit within 10 s). Every process is a normal child of the app (no Windows service, no admin rights).
//! A fresh MariaDB install is initialized and test-started right away (`after_install`).

use std::io::{Read, Write};
use std::net::TcpStream;
use std::path::Path;
use std::time::{Duration, Instant};

use openmind_runner::{
    mariadb_admin_plan, mariadb_port_is_free, port_is_free, run_to_completion, AdminAction,
    MariaDbPaths, MARIADB_DEFAULT_PORTS, PHPMYADMIN_DEFAULT_PORTS,
};
use serde::Serialize;
use tauri::{AppHandle, Manager, State};

use crate::app_state::AppState;
use crate::commands::database::{
    app_paths, initialize_database, mark_ready, pma_log_file, pma_signs_in_by_itself,
    root_password, running_info, setting, spawn_mariadb, spawn_pma, stop_mariadb_blocking,
    ServiceInfo,
};
use crate::commands::run::environment;

/// How long MariaDB may take to accept connections after it was started.
const READY_TIMEOUT: Duration = Duration::from_secs(60);
/// How long phpMyAdmin may take to answer with a working page.
const PMA_TIMEOUT: Duration = Duration::from_secs(25);

/// What the stack is doing right now (the processes themselves are the rest of the truth).
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub enum Phase {
    #[default]
    Idle,
    Initializing,
    Starting,
    Stopping,
}

#[derive(Default)]
struct StackState {
    phase: Phase,
    /// Why the last start failed, until the next start or stop.
    error: Option<String>,
}

/// The MySQL service's own state in `AppState`.
#[derive(Default)]
pub struct MySqlStack {
    /// One start, stop, restart or post-install initialization at a time.
    op: tokio::sync::Mutex<()>,
    state: std::sync::Mutex<StackState>,
}

impl MySqlStack {
    fn snapshot(&self) -> (Phase, Option<String>) {
        self.state
            .lock()
            .map(|state| (state.phase, state.error.clone()))
            .unwrap_or_default()
    }

    fn set(&self, phase: Phase, error: Option<String>) {
        if let Ok(mut state) = self.state.lock() {
            state.phase = phase;
            state.error = error;
        }
    }
}

/// One status for the MySQL row, with the details behind it.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MySqlStatus {
    /// `notInstalled`, `initializing`, `starting`, `running`, `stopping`, `stopped` or `error`.
    pub state: &'static str,
    /// What isn't installed yet: "MariaDB", "phpMyAdmin", "PHP".
    pub missing: Vec<&'static str>,
    pub initialized: bool,
    /// What went wrong (a failed start, or one half of the stack running alone).
    pub error: Option<String>,
    pub mariadb: Option<ServiceInfo>,
    pub phpmyadmin: Option<ServiceInfo>,
    pub mariadb_version: Option<String>,
    pub phpmyadmin_version: Option<String>,
    /// phpMyAdmin signs in by itself (the default root/root); otherwise it shows its login page.
    pub auto_login: bool,
}

/// The one state the user sees, from the phase and what is running (pure, so every case is tested).
pub fn derive_state(
    phase: Phase,
    missing: bool,
    db: Option<&ServiceInfo>,
    pma: Option<&ServiceInfo>,
    error: Option<&str>,
) -> (&'static str, Option<String>) {
    match phase {
        Phase::Initializing => return ("initializing", None),
        Phase::Starting => return ("starting", None),
        Phase::Stopping => return ("stopping", None),
        Phase::Idle => {}
    }
    match (db, pma) {
        (Some(db), Some(_)) if db.ready => ("running", None),
        (Some(_), Some(_)) => ("starting", None),
        (Some(_), None) => (
            "error",
            Some(error.map_or_else(
                || "MariaDB is running, but phpMyAdmin isn't. Stop MySQL and start it again.".to_string(),
                str::to_string,
            )),
        ),
        (None, Some(_)) => (
            "error",
            Some(
                "phpMyAdmin is running, but MariaDB isn't (it stopped or never started). See the MariaDB log, then \
                 stop MySQL and start it again."
                    .to_string(),
            ),
        ),
        (None, None) => match error {
            Some(error) => ("error", Some(error.to_string())),
            None if missing => ("notInstalled", None),
            None => ("stopped", None),
        },
    }
}

/// The active, healthy versions of the stack's runtimes, from one Runtime Manager listing (a listing probes the
/// computer's own tools, so it is read once per status, not once per runtime).
struct StackRuntimes {
    mariadb: Option<String>,
    phpmyadmin: Option<String>,
    php: Option<String>,
}

impl StackRuntimes {
    async fn read(state: &AppState) -> Self {
        let list = state.runtime.list().await.ok().unwrap_or_default();
        let active = |kind: &str| {
            list.iter()
                .find(|status| status.id == kind)
                .and_then(|status| {
                    status
                        .installed
                        .iter()
                        .find(|entry| entry.active && entry.healthy)
                })
                .map(|entry| entry.version.clone())
        };
        Self {
            mariadb: active("mariadb"),
            phpmyadmin: active("phpmyadmin"),
            php: active("php"),
        }
    }

    fn missing(&self) -> Vec<&'static str> {
        [
            (&self.mariadb, "MariaDB"),
            (&self.phpmyadmin, "phpMyAdmin"),
            (&self.php, "PHP"),
        ]
        .into_iter()
        .filter(|(version, _)| version.is_none())
        .map(|(_, name)| name)
        .collect()
    }
}

pub(crate) async fn status_of(state: &AppState) -> MySqlStatus {
    let (phase, error) = state.mysql.snapshot();
    let runtimes = StackRuntimes::read(state).await;
    let missing = runtimes.missing();
    let db = running_info(&state.db_server, &state.db_info);
    let pma = running_info(&state.pma, &state.pma_info);
    let (word, error) = derive_state(
        phase,
        !missing.is_empty(),
        db.as_ref(),
        pma.as_ref(),
        error.as_deref(),
    );
    MySqlStatus {
        state: word,
        missing,
        initialized: app_paths(state).is_initialized(),
        error,
        mariadb_version: runtimes.mariadb,
        phpmyadmin_version: runtimes.phpmyadmin,
        mariadb: db,
        phpmyadmin: pma,
        auto_login: pma_signs_in_by_itself(state).await,
    }
}

fn changed(app: &AppHandle) {
    crate::state::servers_changed(app);
}

// --- Ports ---

/// A port the user chose (`{"port": n}` in `key`), if any.
async fn saved_port(state: &AppState, key: &str) -> Option<u16> {
    let text = setting(state, key).await?;
    let value: serde_json::Value = serde_json::from_str(&text).ok()?;
    value
        .get("port")?
        .as_u64()
        .and_then(|port| u16::try_from(port).ok())
}

/// The port the last start wrote into `my.ini` (so an existing setup keeps its port).
fn last_used_port(paths: &MariaDbPaths) -> Option<u16> {
    let text = std::fs::read_to_string(&paths.config_file).ok()?;
    text.lines()
        .find_map(|line| line.trim().strip_prefix("port="))
        .and_then(|port| port.trim().parse().ok())
}

/// The port to use: the user's own choice (must be free), else the first free of `preferred` (the port used last, then
/// the defaults). `taken` are ports this stack already uses.
pub fn choose_port(
    saved: Option<u16>,
    preferred: &[u16],
    taken: &[u16],
    is_free: impl Fn(u16) -> bool,
    what: &str,
) -> Result<u16, String> {
    if let Some(port) = saved {
        if taken.contains(&port) {
            return Err(format!("{what}'s port {port} is also used by the other part of MySQL. Choose another one in Config."));
        }
        return if is_free(port) {
            Ok(port)
        } else {
            Err(format!(
                "Port {port}, chosen for {what}, is already in use by another program. Stop that program or choose \
                 another port in Config."
            ))
        };
    }
    let mut tried = Vec::new();
    for port in preferred {
        if taken.contains(port) || tried.contains(port) {
            continue;
        }
        if is_free(*port) {
            return Ok(*port);
        }
        tried.push(*port);
    }
    let list: Vec<String> = tried.iter().map(u16::to_string).collect();
    Err(format!(
        "{what} has no free port: {} are all in use. Choose a port in Config.",
        list.join(", ")
    ))
}

// --- Readiness ---

/// The last `count` lines of a log file, for an error message.
fn log_tail(path: &Path, count: usize) -> String {
    let text = std::fs::read_to_string(path).unwrap_or_default();
    let lines: Vec<&str> = text
        .lines()
        .filter(|line| !line.trim().is_empty())
        .collect();
    lines[lines.len().saturating_sub(count)..].join(" | ")
}

/// Pings MariaDB until it accepts connections. Fails at once when the process ends or the password is refused.
fn wait_until_ready(app: &AppHandle, port: u16, password: &str) -> Result<(), String> {
    let state = app.state::<AppState>();
    let environment = tauri::async_runtime::block_on(environment(&state));
    let ping = mariadb_admin_plan(
        &environment,
        port,
        AdminAction::Ping,
        password,
        std::env::var_os("PATH"),
    )
    .map_err(|err| err.to_string())?;
    let log = app_paths(&state).log_file;
    let deadline = Instant::now() + READY_TIMEOUT;
    loop {
        if state.db_server.active().is_empty() {
            return Err(format!(
                "MariaDB stopped while starting. Its log ends with: {}",
                log_tail(&log, 6)
            ));
        }
        if let Ok(done) = run_to_completion(&ping, Duration::from_secs(5)) {
            if done.success() {
                return Ok(());
            }
            if done.output.contains("Access denied") {
                return Err(
                    "MariaDB is running, but it refused root's saved password, so MySQL can't be managed. Your \
                     databases were not changed."
                        .into(),
                );
            }
        }
        if Instant::now() >= deadline {
            return Err(format!(
                "MariaDB didn't accept connections within {} s. Its log ends with: {}",
                READY_TIMEOUT.as_secs(),
                log_tail(&log, 6)
            ));
        }
        std::thread::sleep(Duration::from_millis(500));
    }
}

/// One `GET` to phpMyAdmin: the status code and up to 4 MB of the body.
fn http_get(port: u16, path: &str) -> std::io::Result<(u16, String)> {
    let mut stream =
        TcpStream::connect_timeout(&([127, 0, 0, 1], port).into(), Duration::from_secs(3))?;
    stream.set_read_timeout(Some(Duration::from_secs(20)))?;
    write!(
        stream,
        "GET {path} HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nConnection: close\r\n\r\n"
    )?;
    let mut bytes = Vec::new();
    stream.take(4 * 1024 * 1024).read_to_end(&mut bytes)?;
    let text = String::from_utf8_lossy(&bytes).into_owned();
    let code = text
        .split(' ')
        .nth(1)
        .and_then(|code| code.parse().ok())
        .unwrap_or(0);
    Ok((code, text))
}

/// What phpMyAdmin shows when it can't reach or sign in to the database.
pub fn pma_page_problem(page: &str) -> Option<&'static str> {
    const SIGNS: [(&str, &str); 4] = [
        (
            "Cannot log in to the MySQL server",
            "phpMyAdmin can't sign in to MariaDB",
        ),
        (
            "mysqli::real_connect",
            "phpMyAdmin can't connect to MariaDB",
        ),
        (
            "Access denied for user",
            "MariaDB refused phpMyAdmin's login",
        ),
        (
            "The mysqli extension is missing",
            "the active PHP lacks the mysqli extension phpMyAdmin needs",
        ),
    ];
    SIGNS
        .iter()
        .find(|(sign, _)| page.contains(sign))
        .map(|(_, meaning)| *meaning)
}

/// Waits until phpMyAdmin answers with its own page and, when it signs in by itself, that the page shows no database
/// error (so it really reached MariaDB).
fn verify_pma(app: &AppHandle, port: u16) -> Result<(), String> {
    let deadline = Instant::now() + PMA_TIMEOUT;
    let mut last: String;
    loop {
        let state = app.state::<AppState>();
        if state.pma.active().is_empty() {
            return Err(format!(
                "its server stopped. Its log ends with: {}",
                log_tail(&pma_log_file(&state), 6)
            ));
        }
        match http_get(port, "/index.php") {
            Ok((code, page)) => {
                if let Some(problem) = pma_page_problem(&page) {
                    return Err(problem.to_string());
                }
                if matches!(code, 200 | 302 | 303) && page.contains("phpMyAdmin") {
                    return Ok(());
                }
                last = format!("it answered HTTP {code}");
            }
            Err(err) => last = err.to_string(),
        }
        if Instant::now() >= deadline {
            return Err(format!(
                "it didn't answer within {} s ({last})",
                PMA_TIMEOUT.as_secs()
            ));
        }
        std::thread::sleep(Duration::from_millis(400));
    }
}

async fn blocking<T: Send + 'static>(
    app: &AppHandle,
    job: impl FnOnce(&AppHandle) -> T + Send + 'static,
) -> Result<T, String> {
    let app = app.clone();
    tokio::task::spawn_blocking(move || job(&app))
        .await
        .map_err(|err| format!("stopped unexpectedly: {err}"))
}

// --- Lifecycle ---

/// The whole start sequence; the caller holds the operation lock and records the outcome.
async fn start_stack(app: &AppHandle, state: &AppState) -> Result<(), String> {
    let missing = StackRuntimes::read(state).await.missing();
    if !missing.is_empty() {
        return Err(format!(
            "Not installed yet: {}. Install it in the Runtime Manager (PHP Server window > Config).",
            missing.join(", ")
        ));
    }
    let paths = app_paths(state);
    if !paths.is_initialized() {
        state.mysql.set(Phase::Initializing, None);
        changed(app);
        initialize_database(state).await?;
    }
    state.mysql.set(Phase::Starting, None);
    changed(app);
    let password = root_password(state).await?;
    let db_port = match running_info(&state.db_server, &state.db_info) {
        Some(info) => info.port,
        None => {
            let mut preferred: Vec<u16> = last_used_port(&paths).into_iter().collect();
            preferred.extend(MARIADB_DEFAULT_PORTS);
            let port = choose_port(
                saved_port(state, "mariadb.config").await,
                &preferred,
                &[],
                mariadb_port_is_free,
                "MariaDB",
            )?;
            spawn_mariadb(app, state, port).await?.port
        }
    };
    let ready = {
        let password = password.clone();
        blocking(app, move |app| wait_until_ready(app, db_port, &password)).await?
    };
    if let Err(problem) = ready {
        blocking(app, stop_mariadb_blocking).await?;
        return Err(problem);
    }
    mark_ready(state);
    crate::state::servers_changed(app);
    // phpMyAdmin is (re)started so its config points at this MariaDB.
    state.pma.stop_all();
    let pma_port = choose_port(
        saved_port(state, "phpmyadmin.config").await,
        &PHPMYADMIN_DEFAULT_PORTS,
        &[db_port],
        port_is_free,
        "phpMyAdmin",
    )
    .map_err(|err| format!("MariaDB is running, but phpMyAdmin could not start: {err}"))?;
    spawn_pma(app, state, pma_port, db_port)
        .await
        .map_err(|err| format!("MariaDB is running, but phpMyAdmin could not start: {err}"))?;
    if let Err(problem) = blocking(app, move |app| verify_pma(app, pma_port)).await? {
        state.pma.stop_all();
        return Err(format!(
            "MariaDB is running, but phpMyAdmin isn't working: {problem}. See logs/phpmyadmin/phpmyadmin.log."
        ));
    }
    Ok(())
}

async fn stop_stack(app: &AppHandle, state: &AppState) -> Result<(), String> {
    state.mysql.set(Phase::Stopping, None);
    changed(app);
    state.pma.stop_all();
    blocking(app, stop_mariadb_blocking).await?;
    crate::state::servers_changed(app);
    crate::state::servers_changed(app);
    Ok(())
}

async fn finish(
    app: &AppHandle,
    state: &AppState,
    result: Result<(), String>,
) -> Result<MySqlStatus, String> {
    state.mysql.set(Phase::Idle, result.as_ref().err().cloned());
    changed(app);
    if let Err(error) = &result {
        tracing::warn!(%error, "MySQL stack");
    }
    result?;
    Ok(status_of(state).await)
}

/// MySQL > Start: the whole stack, Running only when MariaDB accepts connections and phpMyAdmin works.
#[tauri::command]
pub async fn mysql_start(
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<MySqlStatus, String> {
    let _op = state.mysql.op.lock().await;
    let result = start_stack(&app, &state).await;
    finish(&app, &state, result).await
}

/// MySQL > Stop: phpMyAdmin, then MariaDB's clean shutdown.
#[tauri::command]
pub async fn mysql_stop(app: AppHandle, state: State<'_, AppState>) -> Result<MySqlStatus, String> {
    let _op = state.mysql.op.lock().await;
    let result = stop_stack(&app, &state).await;
    finish(&app, &state, result).await
}

#[tauri::command]
pub async fn mysql_restart(
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<MySqlStatus, String> {
    let _op = state.mysql.op.lock().await;
    let mut result = stop_stack(&app, &state).await;
    if result.is_ok() {
        result = start_stack(&app, &state).await;
    }
    finish(&app, &state, result).await
}

/// Right after MariaDB is installed: creates the database (root / root) when there is none and test-starts it once
/// (start, ping, clean shutdown), so the first MySQL Start just works. An existing database is never touched.
pub async fn after_install(app: &AppHandle, state: &AppState) -> Result<(), String> {
    let _op = state.mysql.op.lock().await;
    if app_paths(state).is_initialized() || !state.db_server.active().is_empty() {
        return Ok(());
    }
    state.mysql.set(Phase::Initializing, None);
    changed(app);
    let result = initialize_and_verify(app, state).await;
    state.mysql.set(Phase::Idle, result.as_ref().err().cloned());
    changed(app);
    crate::state::servers_changed(app);
    result
}

async fn initialize_and_verify(app: &AppHandle, state: &AppState) -> Result<(), String> {
    initialize_database(state).await?;
    let paths = app_paths(state);
    let mut preferred: Vec<u16> = last_used_port(&paths).into_iter().collect();
    preferred.extend(MARIADB_DEFAULT_PORTS);
    let port = choose_port(
        saved_port(state, "mariadb.config").await,
        &preferred,
        &[],
        mariadb_port_is_free,
        "MariaDB",
    )?;
    let password = root_password(state).await?;
    spawn_mariadb(app, state, port).await?;
    let ready = blocking(app, move |app| wait_until_ready(app, port, &password)).await?;
    blocking(app, stop_mariadb_blocking).await?;
    ready.map_err(|problem| format!("The database was created, but a test start failed: {problem}"))
}

#[cfg(test)]
#[path = "mysql_tests.rs"]
mod tests;
