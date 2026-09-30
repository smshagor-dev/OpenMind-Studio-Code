//! The Unified Download Broker in the app: the package gateway (started with the app — a loopback bind, nothing is
//! contacted), start-up recovery of `<app>/temp`, the `openmind-fetch` launchers in `<app>/shims`, the settings that point
//! the tools of processes OpenMind starts at the gateway, and the progress the UI shows (`broker:progress`).

use std::collections::VecDeque;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, RwLock};
use std::time::{Duration, Instant};

use openmind_broker::env::{launchers, npm_rc_text, process_env, Endpoints, Inherited, Skipped};
use openmind_broker::gateway::UreqUpstream;
use openmind_broker::staging::{now_secs, PARTIAL_MAX_AGE};
use openmind_broker::{
    Broker, BrokerEvent, Gateway, GatewayConfig, Phase, RecoveryReport, Staging,
};
use openmind_runtime_manager::UreqClient;
use serde::Serialize;
use tauri::{AppHandle, Emitter, State};

use crate::app_state::AppState;

/// The most recent operations kept for the Downloads list.
const RECENT: usize = 50;

pub struct BrokerRuntime {
    gateway: Option<Gateway>,
    /// Why the gateway isn't running (it couldn't bind a port).
    problem: Option<String>,
    temp_dir: PathBuf,
    shims_dir: PathBuf,
    recent: Arc<Mutex<VecDeque<BrokerEvent>>>,
    recovery: Arc<Mutex<Option<RecoveryReport>>>,
    /// The folders launchers put first on PATH (OpenMind's shims, bundled tools, portable runtimes): the Git that answers
    /// credential requests is looked up there first, like a terminal would.
    tool_dirs: Arc<RwLock<Vec<PathBuf>>>,
    /// OpenMind's npm configuration for this run (`<app>/temp/config/npmrc`), when it could be written.
    npm_rc: Option<PathBuf>,
}

/// Writes OpenMind's npm configuration for this run (the gateway's npm port and token) next to the staging folders.
fn write_npm_rc(temp_dir: &Path, gateway: &Gateway) -> Option<PathBuf> {
    let dir = temp_dir.join("config");
    let file = dir.join("npmrc");
    let endpoints = Endpoints {
        port: gateway.port(),
        npm_port: gateway.npm_port(),
        token: gateway.token().to_string(),
        npm_rc: None,
    };
    let written =
        std::fs::create_dir_all(&dir).and_then(|()| std::fs::write(&file, npm_rc_text(&endpoints)));
    match written {
        Ok(()) => Some(file),
        Err(err) => {
            tracing::warn!(%err, "npm configuration for the gateway not written; npm isn't routed");
            None
        }
    }
}

/// Progress events at most every 250 ms per operation, plus every change of phase.
fn throttled(
    app: AppHandle,
    recent: Arc<Mutex<VecDeque<BrokerEvent>>>,
) -> impl Fn(&BrokerEvent) + Send + Sync {
    let last: Mutex<Option<(u64, Phase, Instant)>> = Mutex::new(None);
    move |event: &BrokerEvent| {
        if let Ok(mut list) = recent.lock() {
            match list.iter_mut().find(|e| e.id == event.id) {
                Some(slot) => *slot = event.clone(),
                None => {
                    list.push_front(event.clone());
                    list.truncate(RECENT);
                }
            }
        }
        let emit = match last.lock() {
            Ok(mut last) => {
                let due = match *last {
                    Some((id, phase, at)) => {
                        id != event.id
                            || phase != event.phase
                            || at.elapsed() >= Duration::from_millis(250)
                    }
                    None => true,
                };
                if due {
                    *last = Some((event.id, event.phase, Instant::now()));
                }
                due
            }
            Err(_) => true,
        };
        if emit {
            let _ = app.emit("broker:progress", event);
        }
    }
}

fn write_launchers(dir: &Path) {
    if let Err(err) = std::fs::create_dir_all(dir) {
        tracing::warn!(%err, "shims folder not created");
        return;
    }
    for (name, text) in launchers() {
        let file = dir.join(name);
        if std::fs::read_to_string(&file).is_ok_and(|current| current == text) {
            continue;
        }
        if let Err(err) = std::fs::write(&file, text) {
            tracing::warn!(%err, file = %file.display(), "launcher not written");
        }
    }
}

impl BrokerRuntime {
    /// Starts the gateway on 127.0.0.1 and recovers `<app>/temp` in the background. Nothing is downloaded.
    pub fn start(app: &AppHandle, root: &Path, go_proxy: &str) -> Self {
        let temp_dir = root.join("temp");
        let shims_dir = root.join("shims");
        let recent = Arc::new(Mutex::new(VecDeque::new()));
        let recovery = Arc::new(Mutex::new(None));
        {
            let staging = Staging::new(&temp_dir);
            let recovery = Arc::clone(&recovery);
            std::thread::spawn(move || {
                let report = staging.recover(now_secs(), PARTIAL_MAX_AGE);
                if let Ok(mut slot) = recovery.lock() {
                    *slot = Some(report);
                }
            });
        }
        write_launchers(&shims_dir);
        let broker = Broker::new(
            Staging::new(&temp_dir),
            Arc::new(UreqClient::new()),
            Arc::new(throttled(app.clone(), Arc::clone(&recent))),
        );
        let mut config = GatewayConfig::default();
        let go_proxy = go_proxy.trim();
        if go_proxy.starts_with("https://") {
            config.go_proxy = go_proxy.split(',').next().unwrap_or(go_proxy).to_string();
        }
        let tool_dirs = Arc::new(RwLock::new(Vec::new()));
        let credentials = Arc::new(crate::commands::git_credentials::GitCredentialHelper::new(
            Arc::clone(&tool_dirs),
        ));
        let (gateway, problem) = match Gateway::start_with(
            Arc::new(broker),
            Arc::new(UreqUpstream),
            config,
            credentials,
        ) {
            Ok(gateway) => (Some(gateway), None),
            Err(err) => {
                tracing::error!(%err, "the package gateway could not start");
                (None, Some(err.to_string()))
            }
        };
        let npm_rc = gateway
            .as_ref()
            .and_then(|gateway| write_npm_rc(&temp_dir, gateway));
        BrokerRuntime {
            npm_rc,
            gateway,
            problem,
            temp_dir,
            shims_dir,
            recent,
            recovery,
            tool_dirs,
        }
    }

    /// The folders a launcher puts first on PATH (called whenever one is built).
    pub fn set_tool_dirs(&self, dirs: &[PathBuf]) {
        if let Ok(mut current) = self.tool_dirs.write() {
            if current.as_slice() != dirs {
                *current = dirs.to_vec();
            }
        }
    }

    /// The Go module proxy the gateway fetches from: the user's `network.goProxy` (https only) or proxy.golang.org.
    /// Applies at once, also for terminals that are already open.
    pub fn set_go_proxy(&self, setting: &str) {
        let Some(gateway) = &self.gateway else { return };
        let first = setting.trim().split(',').next().unwrap_or_default().trim();
        let upstream = if first.starts_with("https://") {
            first
        } else {
            "https://proxy.golang.org/"
        };
        gateway.set_go_proxy(upstream);
    }

    pub fn endpoints(&self) -> Option<Endpoints> {
        self.gateway.as_ref().map(|gateway| Endpoints {
            port: gateway.port(),
            npm_port: gateway.npm_port(),
            token: gateway.token().to_string(),
            npm_rc: self.npm_rc.clone(),
        })
    }

    /// `<app>/shims`: first on the PATH of processes OpenMind starts (`openmind-fetch`).
    pub fn shims_dir(&self) -> &Path {
        &self.shims_dir
    }

    pub fn temp_dir(&self) -> &Path {
        &self.temp_dir
    }

    pub fn problem(&self) -> Option<&str> {
        self.problem.as_deref()
    }

    pub fn cancel(&self, id: u64) -> bool {
        self.gateway.as_ref().is_some_and(|g| g.broker().cancel(id))
    }

    /// Stops the gateway and every download (app close). Partial downloads stay for the next run.
    pub fn stop(&self) {
        if let Some(gateway) = &self.gateway {
            gateway.stop();
        }
    }

    pub fn recent(&self) -> Vec<BrokerEvent> {
        self.recent
            .lock()
            .map(|list| list.iter().cloned().collect())
            .unwrap_or_default()
    }

    pub fn recovery(&self) -> Option<RecoveryReport> {
        self.recovery.lock().ok().and_then(|slot| slot.clone())
    }
}

/// The Composer the `composer` launcher in `<app>/shims` runs: the first one on the launcher's PATH after OpenMind's own
/// shims (OpenMind's portable Composer, then a system or user one). `OPENMIND_REAL_COMPOSER` is for cmd/PowerShell;
/// `OPENMIND_REAL_COMPOSER_SH` the extension-less script next to it for Git Bash, when there is one.
pub(crate) fn real_composer(dirs: &[PathBuf], shims: &Path) -> Vec<(String, String)> {
    let found = dirs
        .iter()
        .filter(|dir| dir.as_path() != shims)
        .find_map(|dir| {
            ["composer.cmd", "composer.bat", "composer.exe"]
                .iter()
                .map(|name| dir.join(name))
                .find(|file| file.is_file())
        });
    let Some(found) = found else {
        return Vec::new();
    };
    let mut vars = vec![(
        "OPENMIND_REAL_COMPOSER".to_string(),
        found.display().to_string(),
    )];
    let script = found.with_extension("");
    if script.is_file() {
        vars.push((
            "OPENMIND_REAL_COMPOSER_SH".to_string(),
            script.display().to_string(),
        ));
    }
    vars
}

/// The gateway settings for a process OpenMind starts, and the tools left on their own configuration. Empty when the
/// user turned the gateway off or it isn't running.
pub(crate) fn gateway_env(
    state: &AppState,
    enabled: bool,
) -> (Vec<(String, String)>, Vec<Skipped>) {
    let Some(endpoints) = state.broker.endpoints().filter(|_| enabled) else {
        return (Vec::new(), Vec::new());
    };
    let env = process_env(&endpoints, &Inherited::current());
    (env.vars, env.skipped)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BrokerStatus {
    /// The user setting `network.gateway.enabled`.
    enabled: bool,
    running: bool,
    problem: Option<String>,
    port: Option<u16>,
    npm_port: Option<u16>,
    temp_dir: String,
    shims_dir: String,
    /// Tools the gateway leaves alone because the user configured them.
    skipped: Vec<Skipped>,
    recent: Vec<BrokerEvent>,
    recovery: Option<RecoveryReport>,
}

pub(crate) fn status_of(state: &AppState, enabled: bool) -> BrokerStatus {
    let broker = &state.broker;
    let endpoints = broker.endpoints();
    let (_, skipped) = gateway_env(state, enabled);
    BrokerStatus {
        enabled,
        running: endpoints.is_some(),
        problem: broker.problem().map(str::to_string),
        port: endpoints.as_ref().map(|e| e.port),
        npm_port: endpoints.as_ref().map(|e| e.npm_port),
        temp_dir: broker.temp_dir().display().to_string(),
        shims_dir: broker.shims_dir().display().to_string(),
        skipped,
        recent: broker.recent(),
        recovery: broker.recovery(),
    }
}

/// The gateway's state and the recent downloads (local reads only).
#[tauri::command]
pub async fn broker_status(state: State<'_, AppState>) -> Result<BrokerStatus, String> {
    let enabled = crate::commands::network::read_config(&state).gateway_enabled;
    Ok(status_of(&state, enabled))
}

/// Stops a running download (its partial file is kept to resume).
#[tauri::command]
pub async fn broker_cancel(id: u64, state: State<'_, AppState>) -> Result<bool, String> {
    Ok(state.broker.cancel(id))
}
