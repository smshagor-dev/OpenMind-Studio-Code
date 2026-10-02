//! The set of language servers: starts each on first use (for a file inside
//! the open workspace), keeps its documents in sync, forwards allowed requests,
//! and stops it — politely first, then by killing its whole process tree.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, MutexGuard, Weak};
use std::time::Duration;

use serde::Serialize;
use serde_json::Value;

use crate::bundle::Bundle;
use crate::docs::DocumentSync;
use crate::error::LspError;
use crate::install;
use crate::language::language_id;
use crate::node::NodeExecutable;
use crate::process::{pump_lines, spawn, SpawnSpec};
use crate::protocol::{
    initialize_params, is_allowed_request, parse_capabilities, parse_diagnostics, Capabilities,
    PublishedDiagnostics,
};
use crate::registry::{package_by_id, Runtime, ServerDef, Source, PACKAGES, SERVERS};
use crate::session::{Session, SessionEvents, Workspace};
use crate::unpack;
use crate::uri::path_to_uri;

const INITIALIZE_TIMEOUT: Duration = Duration::from_secs(60);
const SHUTDOWN_TIMEOUT: Duration = Duration::from_millis(1500);

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum LogLevel {
    Info,
    Warning,
    Error,
}

/// What the manager reports to the app around it (which turns it into UI events and log files).
pub trait LspEvents: Send + Sync + 'static {
    fn diagnostics(&self, server: &str, published: PublishedDiagnostics);
    fn log(&self, server: &str, level: LogLevel, text: &str);
    /// A server's state changed (started, stopped, crashed, installing, ...).
    fn status_changed(&self);
}

/// Everything needed to start a server for a workspace.
#[derive(Debug, Clone)]
pub struct StartContext {
    pub app_root: PathBuf,
    pub workspace: PathBuf,
    /// The Node.js for Node-based servers (`None`: only native servers can start).
    pub node: Option<NodeExecutable>,
    /// The Python executable for Python-package servers (`None`: they cannot start).
    pub python: Option<PythonExecutable>,
    /// The Runtime Manager's folders, put first on the *server's* PATH only.
    pub path_prepend: Vec<PathBuf>,
    pub vars: Vec<(String, String)>,
}

#[derive(Debug, Clone)]
pub struct PythonExecutable {
    pub path: PathBuf,
    pub label: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "state", rename_all = "camelCase")]
pub enum ServerState {
    Stopped,
    Installing,
    Starting,
    Running,
    Error { message: String },
}

/// The live part of a server's status.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeStatus {
    #[serde(flatten)]
    pub state: ServerState,
    pub workspace: Option<String>,
    pub node: Option<String>,
    pub capabilities: Option<Capabilities>,
    pub open_documents: usize,
    pub pid: Option<u32>,
}

struct Running {
    session: Arc<Session>,
    process: Mutex<crate::process::ServerProcess>,
    docs: Mutex<DocumentSync>,
    capabilities: Capabilities,
    workspace: PathBuf,
    node_label: String,
    pid: u32,
    stopping: Arc<AtomicBool>,
}

struct Slot {
    state: ServerState,
    running: Option<Arc<Running>>,
}

struct Inner {
    slots: Mutex<HashMap<&'static str, Slot>>,
    /// One start/stop at a time per server, so concurrent first opens start it once.
    gates: HashMap<&'static str, Mutex<()>>,
    /// One unpack at a time per package (JSON, CSS and HTML share one).
    unpack_gates: HashMap<&'static str, Mutex<()>>,
    events: Arc<dyn LspEvents>,
    verbose: AtomicBool,
}

#[derive(Clone)]
pub struct LspManager {
    inner: Arc<Inner>,
}

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

impl LspManager {
    pub fn new(events: Arc<dyn LspEvents>) -> Self {
        let slots = SERVERS
            .iter()
            .map(|server| {
                (
                    server.id,
                    Slot {
                        state: ServerState::Stopped,
                        running: None,
                    },
                )
            })
            .collect();
        let gates = SERVERS
            .iter()
            .map(|server| (server.id, Mutex::new(())))
            .collect();
        let unpack_gates = PACKAGES
            .iter()
            .map(|package| (package.id, Mutex::new(())))
            .collect();
        Self {
            inner: Arc::new(Inner {
                slots: Mutex::new(slots),
                gates,
                unpack_gates,
                events,
                verbose: AtomicBool::new(false),
            }),
        }
    }

    pub fn set_verbose(&self, verbose: bool) {
        self.inner.verbose.store(verbose, Ordering::Relaxed);
    }

    pub fn verbose(&self) -> bool {
        self.inner.verbose.load(Ordering::Relaxed)
    }

    pub fn status(&self, server_id: &str) -> RuntimeStatus {
        let slots = lock(&self.inner.slots);
        let Some(slot) = slots.get(server_id) else {
            return idle_status(ServerState::Stopped);
        };
        match &slot.running {
            Some(running) => RuntimeStatus {
                state: slot.state.clone(),
                workspace: Some(running.workspace.display().to_string()),
                node: Some(running.node_label.clone()),
                capabilities: Some(running.capabilities.clone()),
                open_documents: lock(&running.docs).open_count(),
                pid: Some(running.pid),
            },
            None => idle_status(slot.state.clone()),
        }
    }

    fn set_state(&self, server_id: &str, state: ServerState) {
        if let Some(slot) = lock(&self.inner.slots).get_mut(server_id) {
            slot.state = state;
        }
        self.inner.events.status_changed();
    }

    fn running_of(&self, server_id: &str) -> Option<Arc<Running>> {
        lock(&self.inner.slots)
            .get(server_id)
            .and_then(|slot| slot.running.clone())
    }

    fn log(&self, server_id: &str, level: LogLevel, text: &str) {
        self.inner.events.log(server_id, level, text);
    }

    /// The running server for `def` in `context`'s workspace, starting it if needed.
    fn ensure_running(
        &self,
        def: &'static ServerDef,
        context: &StartContext,
    ) -> Result<Arc<Running>, LspError> {
        let gate = self.inner.gates.get(def.id).ok_or(LspError::Unsupported)?;
        let _guard = lock(gate);
        if let Some(running) = self.running_of(def.id) {
            if running.session.is_alive() && running.workspace == context.workspace {
                return Ok(running);
            }
            self.stop_locked(def.id);
        }
        self.set_state(def.id, ServerState::Starting);
        match self.launch(def, context) {
            Ok(running) => {
                if let Some(slot) = lock(&self.inner.slots).get_mut(def.id) {
                    slot.running = Some(Arc::clone(&running));
                }
                self.set_state(def.id, ServerState::Running);
                self.log(
                    def.id,
                    LogLevel::Info,
                    &format!(
                        "{} started (pid {}) for {} using {}.",
                        def.name,
                        running.pid,
                        context.workspace.display(),
                        running.node_label
                    ),
                );
                Ok(running)
            }
            Err(err) => {
                self.log(def.id, LogLevel::Error, &err.to_string());
                let state = match err {
                    LspError::NotInstalled | LspError::NodeMissing => ServerState::Stopped,
                    _ => ServerState::Error {
                        message: err.to_string(),
                    },
                };
                self.set_state(def.id, state);
                Err(err)
            }
        }
    }

    fn launch(
        &self,
        def: &'static ServerDef,
        context: &StartContext,
    ) -> Result<Arc<Running>, LspError> {
        let package = package_by_id(def.package).ok_or(LspError::Unsupported)?;
        let entry =
            install::entry_path(&context.app_root, def, package).ok_or(LspError::NotInstalled)?;
        // (program, arguments, folders for the server's PATH, label, variables of this runtime)
        let (program, args, path_prepend, runtime_label, mut vars) = match def.runtime {
            Runtime::Node => {
                let node = context.node.as_ref().ok_or(LspError::NodeMissing)?;
                (
                    node.path.clone(),
                    vec![entry.display().to_string()],
                    node.path
                        .parent()
                        .map(|dir| vec![dir.to_path_buf()])
                        .unwrap_or_default(),
                    node.label(),
                    Vec::new(),
                )
            }
            Runtime::Native => (
                entry,
                Vec::new(),
                Vec::new(),
                "native program".to_string(),
                Vec::new(),
            ),
            Runtime::PythonModule => {
                let python = context.python.as_ref().ok_or_else(|| {
                    LspError::StartFailed(
                        "Python was not found. Install Python from the Runtime Manager.".into(),
                    )
                })?;
                let path = install::package_dir(&context.app_root, package);
                (
                    python.path.clone(),
                    vec!["-m".into(), def.entry.into()],
                    python
                        .path
                        .parent()
                        .map(|dir| vec![dir.to_path_buf()])
                        .unwrap_or_default(),
                    python.label.clone(),
                    vec![
                        ("PYTHONPATH".to_string(), path.display().to_string()),
                        ("PYTHONNOUSERSITE".to_string(), "1".to_string()),
                    ],
                )
            }
        };
        vars.splice(0..0, context.vars.iter().cloned());
        vars.extend(
            def.env
                .iter()
                .map(|(key, value)| ((*key).to_string(), (*value).to_string())),
        );
        let command = SpawnSpec {
            program,
            args,
            cwd: context.workspace.clone(),
            vars,
            path_prepend,
        };
        self.launch_with(def, context, command, runtime_label)
    }

    /// Starts `command` (the server's own arguments and the Runtime Manager's PATH folders are added here).
    fn launch_with(
        &self,
        def: &'static ServerDef,
        context: &StartContext,
        mut command: SpawnSpec,
        runtime_label: String,
    ) -> Result<Arc<Running>, LspError> {
        command
            .args
            .extend(def.args.iter().map(|arg| (*arg).to_string()));
        command
            .path_prepend
            .extend(context.path_prepend.iter().cloned());
        let spawned = spawn(&command)?;
        let pid = spawned.process.id();
        let stopping = Arc::new(AtomicBool::new(false));
        let stderr_manager = self.clone();
        let stderr_id = def.id;
        let _ = pump_lines(spawned.stderr, move |line| {
            stderr_manager.log(stderr_id, LogLevel::Warning, line);
        });
        let workspace_name = context.workspace.file_name().map_or_else(
            || "workspace".to_string(),
            |n| n.to_string_lossy().into_owned(),
        );
        let root_uri = path_to_uri(&context.workspace.display().to_string());
        let session = Session::start(
            spawned.stdout,
            spawned.stdin,
            Workspace {
                root_uri: root_uri.clone(),
                root_name: workspace_name.clone(),
            },
            Arc::new(Adapter {
                server: def.id,
                inner: Arc::downgrade(&self.inner),
                stopping: Arc::clone(&stopping),
            }),
        );
        let mut process = spawned.process;
        let init = session.request(
            "initialize",
            &initialize_params(
                std::process::id(),
                &root_uri,
                &workspace_name,
                def.init_options,
            ),
            INITIALIZE_TIMEOUT,
        );
        let capabilities = match init {
            Ok(result) => parse_capabilities(&result),
            Err(err) => {
                stopping.store(true, Ordering::SeqCst);
                process.kill();
                return Err(LspError::StartFailed(format!("initialize failed: {err}")));
            }
        };
        if session
            .notify("initialized", &Value::Object(Default::default()))
            .is_err()
        {
            stopping.store(true, Ordering::SeqCst);
            process.kill();
            return Err(LspError::StartFailed(
                "the server closed right after initialize".into(),
            ));
        }
        for method in def.after_initialized {
            let _ = session.notify(method, &Value::Null);
        }
        Ok(Arc::new(Running {
            session,
            process: Mutex::new(process),
            docs: Mutex::new(DocumentSync::default()),
            capabilities,
            workspace: context.workspace.clone(),
            node_label: runtime_label,
            pid,
            stopping,
        }))
    }

    /// Gives `server` the editor's text of `path` (opening the file in the server on first use).
    pub fn sync_document(
        &self,
        def: &'static ServerDef,
        context: &StartContext,
        path: &str,
        text: &str,
    ) -> Result<(), LspError> {
        let language = language_id(path).ok_or(LspError::Unsupported)?;
        let running = self.ensure_running(def, context)?;
        let mut docs = lock(&running.docs);
        let (method, params) = docs.sync(path, language, text);
        running.session.notify(method, &params)
    }

    pub fn save_document(&self, server_id: &str, path: &str) {
        if let Some(running) = self.running_of(server_id) {
            if let Some((method, params)) = lock(&running.docs).save(path) {
                let _ = running.session.notify(method, &params);
            }
        }
    }

    pub fn close_document(&self, server_id: &str, path: &str) {
        if let Some(running) = self.running_of(server_id) {
            if let Some((method, params)) = lock(&running.docs).close(path) {
                let _ = running.session.notify(method, &params);
            }
        }
    }

    /// One of the allowed editor requests, against a running server.
    pub fn request(
        &self,
        server_id: &str,
        method: &str,
        params: &Value,
        timeout: Duration,
    ) -> Result<Value, LspError> {
        if !is_allowed_request(method) {
            return Err(LspError::Refused(method.to_string()));
        }
        let running = self.running_of(server_id).ok_or(LspError::NotRunning)?;
        running.session.request(method, params, timeout)
    }

    /// Stops one server: `shutdown`/`exit`, then its process tree is killed.
    pub fn stop(&self, server_id: &str) {
        let Some(gate) = self.inner.gates.get(server_id) else {
            return;
        };
        let _guard = lock(gate);
        self.stop_locked(server_id);
    }

    fn stop_locked(&self, server_id: &str) {
        let running = lock(&self.inner.slots)
            .get_mut(server_id)
            .and_then(|slot| slot.running.take());
        if let Some(running) = running {
            running.stopping.store(true, Ordering::SeqCst);
            running.session.shutdown(SHUTDOWN_TIMEOUT);
            lock(&running.process).kill();
            self.log(server_id, LogLevel::Info, "Language server stopped.");
        }
        self.set_state(server_id, ServerState::Stopped);
    }

    /// Stops every server (workspace change, app close).
    pub fn stop_all(&self) {
        for server in SERVERS {
            if self.running_of(server.id).is_some() {
                self.stop(server.id);
            }
        }
    }

    /// How many servers are running.
    pub fn running_count(&self) -> usize {
        lock(&self.inner.slots)
            .values()
            .filter(|slot| slot.running.is_some())
            .count()
    }

    /// Makes `def`'s package ready from the offline bundle when it isn't installed
    /// (or was unpacked from a different pack). Returns whether it unpacked anything.
    /// Every server of the package shows "installing" meanwhile.
    pub fn prepare_bundled(
        &self,
        def: &'static ServerDef,
        app_root: &std::path::Path,
        bundle: &Bundle,
    ) -> Result<bool, LspError> {
        let package = package_by_id(def.package).ok_or(LspError::Unsupported)?;
        let Some(pack) = bundle.pack_for(package) else {
            return Ok(false);
        };
        let gate = self
            .inner
            .unpack_gates
            .get(package.id)
            .ok_or(LspError::Unsupported)?;
        let _guard = lock(gate);
        if install::is_installed(app_root, def, package)
            && unpack::is_current(app_root, package, pack)
        {
            return Ok(false);
        }
        if self.running_of(def.id).is_some() {
            // Never replace the files of a server that is running.
            return Ok(false);
        }
        let members: Vec<&'static str> = SERVERS
            .iter()
            .filter(|server| server.package == package.id)
            .map(|server| server.id)
            .collect();
        for id in &members {
            self.set_state(id, ServerState::Installing);
        }
        self.log(
            def.id,
            LogLevel::Info,
            &format!("Unpacking the bundled {} (offline)…", package.contents),
        );
        let outcome = unpack::unpack(app_root, bundle, pack, package);
        let next = match &outcome {
            Ok(()) => ServerState::Stopped,
            Err(err) => ServerState::Error {
                message: err.to_string(),
            },
        };
        for id in &members {
            self.set_state(id, next.clone());
        }
        match outcome {
            Ok(()) => {
                self.log(def.id, LogLevel::Info, "Ready.");
                Ok(true)
            }
            Err(err) => {
                self.log(def.id, LogLevel::Error, &err.to_string());
                Err(err)
            }
        }
    }

    /// Installs the package `def` belongs to. Every server in it shows "installing" meanwhile.
    pub fn install_package(
        &self,
        def: &'static ServerDef,
        app_root: &std::path::Path,
        node: &NodeExecutable,
    ) -> Result<(), LspError> {
        self.install_package_env(def, app_root, node, &[])
    }

    /// [`Self::install_package`] with extra variables for npm (the proxy the user configured).
    pub fn install_package_env(
        &self,
        def: &'static ServerDef,
        app_root: &std::path::Path,
        node: &NodeExecutable,
        env: &[(String, String)],
    ) -> Result<(), LspError> {
        let package = package_by_id(def.package).ok_or(LspError::Unsupported)?;
        if !matches!(package.source, Source::Npm { .. }) {
            return Err(LspError::InstallFailed(
                "This language server is not installed with npm.".into(),
            ));
        }
        let members: Vec<&'static str> = SERVERS
            .iter()
            .filter(|server| server.package == package.id)
            .map(|server| server.id)
            .collect();
        {
            let mut slots = lock(&self.inner.slots);
            if members.iter().any(|id| {
                slots
                    .get(id)
                    .is_some_and(|slot| slot.state == ServerState::Installing)
            }) {
                return Err(LspError::InstallFailed("It is already installing.".into()));
            }
            for id in &members {
                if let Some(slot) = slots.get_mut(id) {
                    slot.state = ServerState::Installing;
                }
            }
        }
        self.inner.events.status_changed();
        self.log(
            def.id,
            LogLevel::Info,
            &format!("Installing {} with {}...", package.contents, node.label()),
        );
        let sink = self.clone();
        let sink_id = def.id;
        let outcome = install::install(app_root, package, node, env, move |line| {
            sink.log(sink_id, LogLevel::Info, line);
        });
        let next = match &outcome {
            Ok(()) => ServerState::Stopped,
            Err(err) => ServerState::Error {
                message: err.to_string(),
            },
        };
        for id in &members {
            self.set_state(id, next.clone());
        }
        match &outcome {
            Ok(()) => self.log(def.id, LogLevel::Info, "Installed."),
            Err(err) => self.log(def.id, LogLevel::Error, &err.to_string()),
        }
        outcome
    }

    pub fn install_python_package_env(
        &self,
        def: &'static ServerDef,
        app_root: &std::path::Path,
        python: &PythonExecutable,
        env: &[(String, String)],
    ) -> Result<(), LspError> {
        let package = package_by_id(def.package).ok_or(LspError::Unsupported)?;
        if !matches!(package.source, Source::Python { .. }) {
            return Err(LspError::InstallFailed(
                "This language server is not installed with Python.".into(),
            ));
        }
        let members: Vec<&'static str> = SERVERS
            .iter()
            .filter(|server| server.package == package.id)
            .map(|server| server.id)
            .collect();
        {
            let mut slots = lock(&self.inner.slots);
            if members.iter().any(|id| {
                slots
                    .get(id)
                    .is_some_and(|slot| slot.state == ServerState::Installing)
            }) {
                return Err(LspError::InstallFailed("It is already installing.".into()));
            }
            for id in &members {
                if let Some(slot) = slots.get_mut(id) {
                    slot.state = ServerState::Installing;
                }
            }
        }
        self.inner.events.status_changed();
        self.log(
            def.id,
            LogLevel::Info,
            &format!("Installing {} with {}...", package.contents, python.label),
        );
        let sink = self.clone();
        let sink_id = def.id;
        let outcome = install::install_python(app_root, package, &python.path, env, move |line| {
            sink.log(sink_id, LogLevel::Info, line);
        });
        let next = match &outcome {
            Ok(()) => ServerState::Stopped,
            Err(err) => ServerState::Error {
                message: err.to_string(),
            },
        };
        for id in &members {
            self.set_state(id, next.clone());
        }
        match &outcome {
            Ok(()) => self.log(def.id, LogLevel::Info, "Installed."),
            Err(err) => self.log(def.id, LogLevel::Error, &err.to_string()),
        }
        outcome
    }
}

fn idle_status(state: ServerState) -> RuntimeStatus {
    RuntimeStatus {
        state,
        workspace: None,
        node: None,
        capabilities: None,
        open_documents: 0,
        pid: None,
    }
}

/// Hears one server's notifications and its end.
struct Adapter {
    server: &'static str,
    inner: Weak<Inner>,
    stopping: Arc<AtomicBool>,
}

impl SessionEvents for Adapter {
    fn notification(&self, method: &str, params: &Value) {
        let Some(inner) = self.inner.upgrade() else {
            return;
        };
        match method {
            "textDocument/publishDiagnostics" => {
                if let Some(published) = parse_diagnostics(params) {
                    inner.events.diagnostics(self.server, published);
                }
            }
            "window/logMessage" | "window/showMessage" => {
                let text = params.get("message").and_then(Value::as_str).unwrap_or("");
                let kind = params.get("type").and_then(Value::as_u64).unwrap_or(3);
                let level = match kind {
                    1 => LogLevel::Error,
                    2 => LogLevel::Warning,
                    _ => LogLevel::Info,
                };
                // Type 4 is "log": protocol chatter, kept out unless verbose logging is on.
                if kind < 4 || inner.verbose.load(Ordering::Relaxed) {
                    inner.events.log(self.server, level, text);
                }
            }
            _ => {}
        }
    }

    fn closed(&self) {
        if self.stopping.load(Ordering::SeqCst) {
            return;
        }
        let Some(inner) = self.inner.upgrade() else {
            return;
        };
        let manager = LspManager { inner };
        manager.log(
            self.server,
            LogLevel::Error,
            "The language server stopped unexpectedly. Restart it from Language Tools.",
        );
        if let Some(slot) = lock(&manager.inner.slots).get_mut(self.server) {
            slot.running = None;
            slot.state = ServerState::Error {
                message: "The language server stopped unexpectedly.".into(),
            };
        }
        manager.inner.events.status_changed();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::registry::server_by_id;

    #[derive(Default)]
    struct Recorder {
        logs: Mutex<Vec<(String, LogLevel, String)>>,
        changes: std::sync::atomic::AtomicUsize,
    }

    impl LspEvents for Recorder {
        fn diagnostics(&self, _: &str, _: PublishedDiagnostics) {}
        fn log(&self, server: &str, level: LogLevel, text: &str) {
            lock(&self.logs).push((server.to_string(), level, text.to_string()));
        }
        fn status_changed(&self) {
            self.changes.fetch_add(1, Ordering::SeqCst);
        }
    }

    fn context(root: &std::path::Path) -> StartContext {
        StartContext {
            app_root: root.to_path_buf(),
            workspace: root.join("My Site"),
            node: Some(NodeExecutable {
                path: root.join("node.exe"),
                source: crate::node::NodeSource::Portable,
            }),
            python: None,
            path_prepend: vec![],
            vars: vec![],
        }
    }

    #[test]
    fn a_server_that_is_not_installed_reports_it_and_stays_stopped() {
        let root = tempfile::tempdir().expect("tempdir");
        let events = Arc::new(Recorder::default());
        let manager = LspManager::new(events.clone());
        let def = server_by_id("typescript").expect("server");
        let err = manager
            .sync_document(def, &context(root.path()), "C:/My Site/a.ts", "let a;")
            .expect_err("not installed");
        assert!(matches!(err, LspError::NotInstalled));
        assert_eq!(err.to_string(), "Language server is not installed yet.");
        assert_eq!(manager.status("typescript").state, ServerState::Stopped);
        assert_eq!(manager.running_count(), 0);
    }

    #[test]
    fn a_start_that_fails_after_install_is_an_error_state_with_the_reason() {
        let root = tempfile::tempdir().expect("tempdir");
        let def = server_by_id("python").expect("server");
        let package = package_by_id(def.package).expect("package");
        // "Installed" (the entry script exists) but the node executable doesn't.
        let entry = install::package_dir(root.path(), package).join(def.entry);
        std::fs::create_dir_all(entry.parent().expect("parent")).expect("mkdir");
        std::fs::write(&entry, b"").expect("entry");
        std::fs::create_dir_all(root.path().join("My Site")).expect("workspace");
        let events = Arc::new(Recorder::default());
        let manager = LspManager::new(events.clone());
        let err = manager
            .sync_document(def, &context(root.path()), "C:/My Site/a.py", "x = 1")
            .expect_err("no node");
        assert!(matches!(err, LspError::StartFailed(_)));
        assert!(matches!(
            manager.status("python").state,
            ServerState::Error { .. }
        ));
        assert!(lock(&events.logs)
            .iter()
            .any(|(id, level, _)| id == "python" && *level == LogLevel::Error));
        assert!(events.changes.load(Ordering::SeqCst) >= 2);
    }

    #[test]
    fn requests_that_are_not_editor_features_are_refused_before_anything_else() {
        let manager = LspManager::new(Arc::new(Recorder::default()));
        let err = manager
            .request(
                "typescript",
                "workspace/executeCommand",
                &Value::Null,
                Duration::from_secs(1),
            )
            .expect_err("refused");
        assert!(matches!(err, LspError::Refused(_)));
        let err = manager
            .request(
                "typescript",
                "textDocument/hover",
                &Value::Null,
                Duration::from_secs(1),
            )
            .expect_err("not running");
        assert!(matches!(err, LspError::NotRunning));
    }

    #[test]
    fn stopping_a_server_that_never_ran_is_harmless_and_unknown_ids_are_ignored() {
        let manager = LspManager::new(Arc::new(Recorder::default()));
        manager.stop("php");
        manager.stop("no-such-server");
        manager.stop_all();
        assert_eq!(manager.status("php").state, ServerState::Stopped);
        assert_eq!(manager.status("no-such-server").state, ServerState::Stopped);
    }

    #[test]
    fn verbose_logging_is_off_until_asked_for() {
        let manager = LspManager::new(Arc::new(Recorder::default()));
        assert!(!manager.verbose());
        manager.set_verbose(true);
        assert!(manager.verbose());
    }

    /// A bundle in `root/lsp` whose `yaml` pack holds `files`.
    fn yaml_bundle(root: &std::path::Path, files: &[&str]) -> Bundle {
        let src = root.join("pack source");
        for name in files {
            let path = src.join(name);
            std::fs::create_dir_all(path.parent().expect("parent")).expect("mkdir");
            std::fs::write(path, "// server").expect("write");
        }
        let packs = crate::bundle::bundle_dir(root).join("packs");
        std::fs::create_dir_all(&packs).expect("mkdir");
        let zip = packs.join("yaml-1.zip");
        crate::pack::create_pack(&src, &zip).expect("pack");
        let json = format!(
            r#"{{"format":"openmind-lsp-bundle","version":1,"platform":"windows-x64",
            "packs":[{{"package":"yaml","revision":"1","contents":"yaml","file":"packs/yaml-1.zip",
            "sha256":"{}","size":{}}}]}}"#,
            unpack::sha256_file(&zip).expect("sha"),
            std::fs::metadata(&zip).expect("meta").len()
        );
        std::fs::write(crate::bundle::bundle_dir(root).join("bundle.json"), json).expect("json");
        crate::bundle::load(root).expect("ok").expect("bundle")
    }

    #[test]
    fn a_bundled_server_is_unpacked_once_and_a_bad_pack_is_an_error_state() {
        let root = tempfile::tempdir().expect("tempdir");
        let def = server_by_id("yaml").expect("server");
        let events = Arc::new(Recorder::default());
        let manager = LspManager::new(events.clone());
        let bundle = yaml_bundle(root.path(), &[def.entry]);
        if !bundle.platform_supported() {
            return; // The bundle is Windows x64 only.
        }
        assert!(manager
            .prepare_bundled(def, root.path(), &bundle)
            .expect("unpack"));
        assert_eq!(manager.status("yaml").state, ServerState::Stopped);
        assert!(!manager
            .prepare_bundled(def, root.path(), &bundle)
            .expect("ready"));
        assert!(lock(&events.logs)
            .iter()
            .any(|(_, _, text)| text.contains("offline")));
        // A server whose package the bundle doesn't carry is left alone.
        let css = server_by_id("css").expect("css");
        assert!(!manager
            .prepare_bundled(css, root.path(), &bundle)
            .expect("no pack"));

        let other = tempfile::tempdir().expect("tempdir");
        let broken = yaml_bundle(other.path(), &["readme.txt"]);
        assert!(manager.prepare_bundled(def, other.path(), &broken).is_err());
        assert!(matches!(
            manager.status("yaml").state,
            ServerState::Error { .. }
        ));
    }

    #[test]
    fn installing_without_npm_is_an_error_state_and_can_be_retried() {
        let root = tempfile::tempdir().expect("tempdir");
        let def = server_by_id("php").expect("server");
        let manager = LspManager::new(Arc::new(Recorder::default()));
        let node = context(root.path()).node.expect("node");
        assert!(manager.install_package(def, root.path(), &node).is_err());
        assert!(matches!(
            manager.status("php").state,
            ServerState::Error { .. }
        ));
        // Not stuck in "installing": a second attempt runs (and fails the same way).
        assert!(matches!(
            manager.install_package(def, root.path(), &node),
            Err(LspError::InstallFailed(text)) if text.contains("npm")
        ));
    }
}
