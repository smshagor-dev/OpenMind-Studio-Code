//! The extension host process: a separate Node.js program (`host/host.js`) that runs extension code. It is
//! never started inside the app's window or in this process; the two talk JSON-RPC 2.0 over stdio with
//! Content-Length framing (the same framing the language servers use). The whole process tree lives in a Job
//! Object, so closing the app — or a crash — leaves no `node` behind.

use std::collections::HashMap;
use std::ffi::OsString;
use std::io::{BufReader, Write};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicI64, Ordering};
use std::sync::mpsc::{self, Sender};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::Duration;

use openmind_lsp::jsonrpc::{self, Incoming};
use openmind_lsp::node::{resolve_node, NodeExecutable, NodeSource};
use openmind_lsp::process::{pump_lines, spawn, ServerProcess, SpawnSpec};
use serde_json::{json, Value};

use crate::error::ExtensionError;
use crate::hostlog::HostLog;
use crate::paths::ExtensionPaths;

const HOST_JS: &str = include_str!("../host/host.js");
const VSCODE_JS: &str = include_str!("../host/vscode.js");
const GUARD_JS: &str = include_str!("../host/guard.js");
const TREEVIEWS_JS: &str = include_str!("../host/treeviews.js");
const EDITORS_JS: &str = include_str!("../host/editors.js");
const STATUSBAR_JS: &str = include_str!("../host/statusbar.js");
const WEBVIEWS_JS: &str = include_str!("../host/webviews.js");
const TERMINALS_JS: &str = include_str!("../host/terminals.js");
const UNSUPPORTED_JS: &str = include_str!("../host/unsupported.js");
const TASKS_JS: &str = include_str!("../host/tasks.js");
const FSPROVIDER_JS: &str = include_str!("../host/fsprovider.js");
const WORKSPACE_JS: &str = include_str!("../host/workspace.js");
const LANGUAGES_JS: &str = include_str!("../host/languages.js");

const READY_TIMEOUT: Duration = Duration::from_secs(15);
const SHUTDOWN_TIMEOUT: Duration = Duration::from_secs(3);

/// What the host does towards the app. Implemented by the Tauri layer (it forwards to the window).
pub trait HostEvents: Send + Sync + 'static {
    /// The host asks something and waits for `respond` (a message box, a quick pick...).
    fn request(&self, id: Value, method: &str, params: Value);
    /// Logs, command registrations, diagnostics...
    fn notification(&self, method: &str, params: Value);
    /// The process ended. `reason` is `None` for an orderly stop.
    fn exited(&self, reason: Option<String>);
}

/// Which Node runs the host: OpenMind's portable Node; the machine's only when the user allowed it.
pub fn resolve_host_node(
    portable_dirs: &[PathBuf],
    system_path: Option<OsString>,
    allow_system: bool,
) -> Result<NodeExecutable, ExtensionError> {
    let found = resolve_node(portable_dirs, allow_system.then_some(system_path).flatten())
        .map_err(|_| ExtensionError::NodeMissing)?;
    debug_assert!(allow_system || found.source == NodeSource::Portable);
    Ok(found)
}

pub struct HostStart {
    pub node: NodeExecutable,
    /// The Runtime Manager's folders and variables, for the *host's* environment only.
    pub path_prepend: Vec<PathBuf>,
    pub vars: Vec<(String, String)>,
}

type Waiting = Sender<Result<Value, String>>;

struct Inner {
    writer: Mutex<std::process::ChildStdin>,
    process: Mutex<ServerProcess>,
    pending: Mutex<HashMap<i64, Waiting>>,
    next_id: AtomicI64,
    alive: AtomicBool,
    stopping: AtomicBool,
    log: Arc<HostLog>,
    events: Arc<dyn HostEvents>,
}

/// A running extension host.
pub struct ExtensionHost {
    inner: Arc<Inner>,
    node_label: String,
    pid: u32,
}

impl ExtensionHost {
    /// Writes the host's files, starts it and waits until it says it is ready.
    pub fn start(
        paths: &ExtensionPaths,
        start: HostStart,
        events: Arc<dyn HostEvents>,
    ) -> Result<Self, ExtensionError> {
        write_host_files(paths)?;
        let log = Arc::new(HostLog::new(paths.host_log.clone()));
        let spec = SpawnSpec {
            program: start.node.path.clone(),
            args: vec![paths.host_dir.join("host.js").to_string_lossy().to_string()],
            cwd: paths.host_dir.clone(),
            vars: start.vars,
            path_prepend: start.path_prepend,
        };
        let spawned = spawn(&spec).map_err(|err| ExtensionError::Host(err.to_string()))?;
        let pid = spawned.process.id();
        let node_label = start.node.label();
        log.line(&format!("host: starting with {node_label} (pid {pid})"));

        let inner = Arc::new(Inner {
            writer: Mutex::new(spawned.stdin),
            process: Mutex::new(spawned.process),
            pending: Mutex::new(HashMap::new()),
            next_id: AtomicI64::new(1),
            alive: AtomicBool::new(true),
            stopping: AtomicBool::new(false),
            log: Arc::clone(&log),
            events,
        });

        let stderr_log = Arc::clone(&log);
        pump_lines(spawned.stderr, move |line| {
            stderr_log.line(&format!("host stderr: {line}"))
        });

        let (ready_tx, ready_rx) = mpsc::channel::<()>();
        let reader_inner = Arc::clone(&inner);
        let stdout = spawned.stdout;
        thread::spawn(move || read_loop(reader_inner, BufReader::new(stdout), ready_tx));

        let host = Self {
            inner,
            node_label,
            pid,
        };
        if ready_rx.recv_timeout(READY_TIMEOUT).is_err() {
            host.kill();
            return Err(ExtensionError::Host(
                "The extension host didn't start (no ready signal).".to_string(),
            ));
        }
        Ok(host)
    }

    pub fn pid(&self) -> u32 {
        self.pid
    }

    pub fn node_label(&self) -> &str {
        &self.node_label
    }

    pub fn is_alive(&self) -> bool {
        self.inner.alive.load(Ordering::SeqCst)
    }

    pub fn log(&self) -> &HostLog {
        &self.inner.log
    }

    /// A request to the host; waits for its answer.
    pub fn request(
        &self,
        method: &str,
        params: Value,
        timeout: Duration,
    ) -> Result<Value, ExtensionError> {
        if !self.is_alive() {
            return Err(ExtensionError::HostNotRunning);
        }
        let id = self.inner.next_id.fetch_add(1, Ordering::SeqCst);
        let (tx, rx) = mpsc::channel();
        lock(&self.inner.pending).insert(id, tx);
        if let Err(err) = self.write(&jsonrpc::request_message(id, method, &params)) {
            lock(&self.inner.pending).remove(&id);
            return Err(err);
        }
        match rx.recv_timeout(timeout) {
            Ok(Ok(value)) => Ok(value),
            Ok(Err(message)) => Err(ExtensionError::Host(message)),
            Err(mpsc::RecvTimeoutError::Timeout) => {
                lock(&self.inner.pending).remove(&id);
                Err(ExtensionError::HostTimeout)
            }
            Err(mpsc::RecvTimeoutError::Disconnected) => Err(ExtensionError::HostNotRunning),
        }
    }

    pub fn notify(&self, method: &str, params: Value) -> Result<(), ExtensionError> {
        if !self.is_alive() {
            return Err(ExtensionError::HostNotRunning);
        }
        self.write(&jsonrpc::notification_message(method, &params))
    }

    /// Answers a request the host made (`HostEvents::request`).
    pub fn respond(&self, id: &Value, answer: Result<Value, String>) -> Result<(), ExtensionError> {
        let message = match answer {
            Ok(result) => jsonrpc::response_message(id, result),
            Err(message) => jsonrpc::error_response(id, -32000, &message),
        };
        self.write(&message)
    }

    fn write(&self, message: &Value) -> Result<(), ExtensionError> {
        let mut writer = lock(&self.inner.writer);
        jsonrpc::write_message(&mut *writer, message)
            .and_then(|()| writer.flush())
            .map_err(|_| ExtensionError::HostNotRunning)
    }

    /// Asks the extensions to deactivate, then ends the process and everything it started.
    pub fn stop(&self) {
        if self.inner.stopping.swap(true, Ordering::SeqCst) {
            return;
        }
        if self.is_alive() {
            let _ = self.request("host/shutdown", json!({}), SHUTDOWN_TIMEOUT);
        }
        self.kill();
        self.inner.log.line("host: stopped");
    }

    fn kill(&self) {
        self.inner.stopping.store(true, Ordering::SeqCst);
        lock(&self.inner.process).kill();
        self.inner.alive.store(false, Ordering::SeqCst);
    }
}

impl Drop for ExtensionHost {
    fn drop(&mut self) {
        self.kill();
    }
}

fn lock<T>(mutex: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    mutex
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
}

fn read_loop(
    inner: Arc<Inner>,
    mut reader: BufReader<std::process::ChildStdout>,
    ready: Sender<()>,
) {
    let mut failure: Option<String> = None;
    loop {
        let message = match jsonrpc::read_frame(&mut reader) {
            Ok(Some(message)) => message,
            Ok(None) => break,
            Err(err) => {
                failure = Some(err.to_string());
                break;
            }
        };
        match jsonrpc::classify(message) {
            Ok(Incoming::Response { id, result }) => {
                if let Some(waiting) = lock(&inner.pending).remove(&id) {
                    let _ = waiting.send(result.map_err(|err| err.message));
                }
            }
            Ok(Incoming::Request { id, method, params }) => {
                inner.events.request(id, &method, params)
            }
            Ok(Incoming::Notification { method, params }) => {
                on_notification(&inner, &ready, &method, params);
            }
            Err(err) => inner
                .log
                .line(&format!("host: ignoring a bad message: {err}")),
        }
    }
    let orderly = inner.stopping.load(Ordering::SeqCst);
    inner.alive.store(false, Ordering::SeqCst);
    lock(&inner.pending).clear();
    let reason = (!orderly)
        .then(|| failure.unwrap_or_else(|| "The extension host stopped unexpectedly.".to_string()));
    inner.log.line(&match &reason {
        Some(reason) => format!("host: exited unexpectedly ({reason})"),
        None => "host: exited".to_string(),
    });
    inner.events.exited(reason);
}

fn on_notification(inner: &Inner, ready: &Sender<()>, method: &str, params: Value) {
    match method {
        "host/ready" => {
            let _ = ready.send(());
        }
        "log/output" => {
            let text = |key: &str| {
                params
                    .get(key)
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .to_string()
            };
            inner.log.line(&format!(
                "[{}] {}: {}",
                text("extension"),
                text("channel"),
                text("text")
            ));
            inner.events.notification(method, params);
        }
        _ => inner.events.notification(method, params),
    }
}

/// Writes `host.js` and `vscode.js` under `extensions/cache/host/` (only when they changed).
fn write_host_files(paths: &ExtensionPaths) -> Result<(), ExtensionError> {
    std::fs::create_dir_all(&paths.host_dir).map_err(|err| {
        ExtensionError::io(format!("Couldn't create {}", paths.host_dir.display()), err)
    })?;
    for (name, content) in [
        ("host.js", HOST_JS),
        ("vscode.js", VSCODE_JS),
        ("guard.js", GUARD_JS),
        ("treeviews.js", TREEVIEWS_JS),
        ("editors.js", EDITORS_JS),
        ("statusbar.js", STATUSBAR_JS),
        ("webviews.js", WEBVIEWS_JS),
        ("terminals.js", TERMINALS_JS),
        ("unsupported.js", UNSUPPORTED_JS),
        ("tasks.js", TASKS_JS),
        ("fsprovider.js", FSPROVIDER_JS),
        ("workspace.js", WORKSPACE_JS),
        ("languages.js", LANGUAGES_JS),
    ] {
        let file = paths.host_dir.join(name);
        if std::fs::read_to_string(&file).is_ok_and(|current| current == content) {
            continue;
        }
        std::fs::write(&file, content)
            .map_err(|err| ExtensionError::io(format!("Couldn't write {}", file.display()), err))?;
    }
    Ok(())
}

/// What the host is told about one extension when it (re)starts or the extension is enabled.
pub fn host_descriptor(
    paths: &ExtensionPaths,
    extension: &crate::store::InstalledExtension,
    workspace_key: Option<&str>,
) -> Value {
    json!({
        "id": extension.id,
        "path": extension.path,
        "main": extension.manifest.main,
        "manifest": extension.manifest,
        "globalStorage": paths.global_storage(&extension.id),
        "workspaceStorage": workspace_key.map(|key| paths.workspace_storage(&extension.id, key)),
        "logPath": paths.extension_logs(&extension.id),
        "permissions": extension.permissions.accepted,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn no_node_is_the_documented_error() {
        let dir = tempfile::tempdir().expect("tempdir");
        let err = resolve_host_node(&[dir.path().to_path_buf()], None, false).expect_err("no node");
        assert_eq!(
            err.to_string(),
            "Node.js runtime is required for extension host."
        );
    }

    #[test]
    fn a_system_node_is_only_used_when_allowed() {
        let dir = tempfile::tempdir().expect("tempdir");
        let name = if cfg!(windows) { "node.exe" } else { "node" };
        std::fs::write(dir.path().join(name), b"").expect("node");
        let system = std::env::join_paths([dir.path()]).expect("path");
        assert!(resolve_host_node(&[], Some(system.clone()), false).is_err());
        let node = resolve_host_node(&[], Some(system), true).expect("allowed");
        assert_eq!(node.source, NodeSource::System);
        assert!(node.label().starts_with("System Node.js at"));
    }

    #[test]
    fn the_portable_node_wins_even_when_the_system_one_is_allowed() {
        let portable = tempfile::tempdir().expect("tempdir");
        let system = tempfile::tempdir().expect("tempdir");
        let name = if cfg!(windows) { "node.exe" } else { "node" };
        std::fs::write(portable.path().join(name), b"").expect("node");
        std::fs::write(system.path().join(name), b"").expect("node");
        let node = resolve_host_node(
            &[portable.path().to_path_buf()],
            Some(std::env::join_paths([system.path()]).expect("path")),
            true,
        )
        .expect("node");
        assert_eq!(node.source, NodeSource::Portable);
    }
}
