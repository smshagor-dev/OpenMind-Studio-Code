//! The notebook "kernel": OpenMind Studio's own Python cell runner (`runner.py`), started with a Python the user
//! chose, in the notebook's folder, as a child process in a Job Object (so stopping it, or closing the app, ends it and
//! everything it started). It is not Jupyter: no IPython magics, no widgets, no rich display beyond text and PNG/JPEG
//! images; each cell's output arrives when the cell finishes. Nothing here starts on its own.

use std::collections::HashMap;
use std::io::{BufRead, BufReader, Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::mpsc::{channel, Sender};
use std::sync::{Arc, Mutex, MutexGuard};

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

/// The runner script, written next to the app's cache when a kernel starts.
pub const RUNNER_PY: &str = include_str!("runner.py");

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum KernelError {
    #[error("The Python runner could not start: {0}")]
    Start(String),
    #[error("The kernel stopped.{0}")]
    Stopped(String),
    #[error("The kernel is not running.")]
    NotRunning,
}

/// A Python the user can pick as the notebook's kernel.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct KernelCandidate {
    pub interpreter: String,
    pub label: String,
    /// `project`, `portable` or `system`.
    pub source: String,
    /// Whether `ipykernel` is installed next to it (for information: OpenMind doesn't use it yet).
    pub has_ipykernel: bool,
}

fn has_ipykernel(interpreter: &Path) -> bool {
    let Some(dir) = interpreter.parent() else {
        return false;
    };
    let candidates = [
        dir.join("Lib/site-packages/ipykernel"),
        dir.join("../Lib/site-packages/ipykernel"),
    ];
    candidates.iter().any(|path| path.is_dir())
}

fn candidate(path: PathBuf, label: String, source: &str) -> KernelCandidate {
    KernelCandidate {
        has_ipykernel: has_ipykernel(&path),
        interpreter: path.display().to_string(),
        label,
        source: source.into(),
    }
}

/// The Pythons found, best first: the project's virtual environment, OpenMind's portable Python, then the system's.
pub fn candidates(
    workspace: Option<&Path>,
    portable_dirs: &[PathBuf],
    system_path: Option<std::ffi::OsString>,
) -> Vec<KernelCandidate> {
    let exe = if cfg!(windows) {
        "python.exe"
    } else {
        "python3"
    };
    let scripts = if cfg!(windows) { "Scripts" } else { "bin" };
    let mut found = Vec::new();
    if let Some(workspace) = workspace {
        for env in [".venv", "venv"] {
            let path = workspace.join(env).join(scripts).join(exe);
            if path.is_file() {
                found.push(candidate(
                    path,
                    format!("Project environment ({env})"),
                    "project",
                ));
            }
        }
    }
    if let Some(path) = portable_dirs
        .iter()
        .map(|dir| dir.join(exe))
        .find(|p| p.is_file())
    {
        found.push(candidate(
            path,
            "OpenMind portable Python".into(),
            "portable",
        ));
    }
    let system: Vec<PathBuf> = system_path
        .map(|p| std::env::split_paths(&p).collect())
        .unwrap_or_default();
    if let Some(path) = system
        .iter()
        .map(|dir| dir.join(exe))
        .find(|p| p.is_file() && !p.to_string_lossy().contains("WindowsApps"))
    {
        let label = format!("System Python at {}", path.display());
        found.push(candidate(path, label, "system"));
    }
    found
}

/// How to start a kernel.
pub struct KernelSpec {
    pub interpreter: PathBuf,
    /// The notebook's folder.
    pub cwd: PathBuf,
    /// Where `runner.py` is written.
    pub runner_dir: PathBuf,
    pub path_prepend: Vec<PathBuf>,
    pub vars: Vec<(String, String)>,
}

/// One cell's result: the outputs to store in the notebook, and its execution count.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CellResult {
    pub ok: bool,
    pub execution_count: Option<i64>,
    pub outputs: Vec<Value>,
}

type Pending = Mutex<HashMap<u64, Sender<Value>>>;

/// A running kernel. Cheap to clone; every clone is the same process.
#[derive(Clone)]
pub struct Kernel {
    inner: Arc<Inner>,
}

struct Inner {
    stdin: Mutex<Option<ChildStdin>>,
    child: Mutex<Child>,
    #[cfg(windows)]
    tree: Option<openmind_process::ProcessTree>,
    pending: Arc<Pending>,
    alive: Arc<AtomicBool>,
    errors: Arc<Mutex<String>>,
    next: AtomicU64,
    pub interpreter: String,
}

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
}

fn command(spec: &KernelSpec, runner: &Path) -> Command {
    let mut command = Command::new(&spec.interpreter);
    command
        .args(["-u", "-X", "utf8"])
        .arg(runner)
        .current_dir(&spec.cwd)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .env("PYTHONIOENCODING", "utf-8")
        .env("PYTHONUNBUFFERED", "1");
    for (key, value) in &spec.vars {
        command.env(key, value);
    }
    if !spec.path_prepend.is_empty() {
        let existing = std::env::var_os("PATH")
            .map(|p| std::env::split_paths(&p).collect::<Vec<_>>())
            .unwrap_or_default();
        if let Ok(path) = std::env::join_paths(spec.path_prepend.iter().cloned().chain(existing)) {
            command.env("PATH", path);
        }
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    }
    command
}

fn read_answers(stdout: impl Read + Send + 'static, pending: Arc<Pending>, alive: Arc<AtomicBool>) {
    std::thread::spawn(move || {
        for line in BufReader::new(stdout).lines() {
            let Ok(line) = line else { break };
            let Ok(answer) = serde_json::from_str::<Value>(&line) else {
                continue;
            };
            let Some(id) = answer.get("id").and_then(Value::as_u64) else {
                continue;
            };
            if let Some(sender) = lock(&pending).remove(&id) {
                let _ = sender.send(answer);
            }
        }
        alive.store(false, Ordering::SeqCst);
        // Every waiting cell learns the kernel is gone.
        lock(&pending).clear();
    });
}

fn keep_errors(stderr: impl Read + Send + 'static, errors: Arc<Mutex<String>>) {
    std::thread::spawn(move || {
        for line in BufReader::new(stderr).lines().map_while(Result::ok) {
            let mut text = lock(&errors);
            text.push_str(&line);
            text.push('\n');
            if text.len() > 8192 {
                let cut = text.len() - 8192;
                text.drain(..cut);
            }
        }
    });
}

impl Kernel {
    /// Writes the runner and starts it with the chosen Python.
    pub fn start(spec: &KernelSpec) -> Result<Self, KernelError> {
        std::fs::create_dir_all(&spec.runner_dir)
            .map_err(|err| KernelError::Start(err.to_string()))?;
        let runner = spec.runner_dir.join("openmind_runner.py");
        std::fs::write(&runner, RUNNER_PY).map_err(|err| KernelError::Start(err.to_string()))?;
        let mut child = command(spec, &runner)
            .spawn()
            .map_err(|err| KernelError::Start(err.to_string()))?;
        #[cfg(windows)]
        let tree = {
            use std::os::windows::io::AsRawHandle;
            openmind_process::ProcessTree::new()
                .ok()
                .filter(|tree| tree.assign(child.as_raw_handle()).is_ok())
        };
        let stdin = child.stdin.take();
        let pending: Arc<Pending> = Arc::new(Mutex::new(HashMap::new()));
        let alive = Arc::new(AtomicBool::new(true));
        let errors = Arc::new(Mutex::new(String::new()));
        if let Some(stdout) = child.stdout.take() {
            read_answers(stdout, Arc::clone(&pending), Arc::clone(&alive));
        }
        if let Some(stderr) = child.stderr.take() {
            keep_errors(stderr, Arc::clone(&errors));
        }
        Ok(Self {
            inner: Arc::new(Inner {
                stdin: Mutex::new(stdin),
                child: Mutex::new(child),
                #[cfg(windows)]
                tree,
                pending,
                alive,
                errors,
                next: AtomicU64::new(1),
                interpreter: spec.interpreter.display().to_string(),
            }),
        })
    }

    pub fn interpreter(&self) -> &str {
        &self.inner.interpreter
    }

    pub fn is_alive(&self) -> bool {
        self.inner.alive.load(Ordering::SeqCst)
    }

    /// Runs `code` and waits for its result (a cell runs until it finishes or the kernel is stopped).
    pub fn execute(&self, code: &str) -> Result<CellResult, KernelError> {
        if !self.is_alive() {
            return Err(KernelError::NotRunning);
        }
        let id = self.inner.next.fetch_add(1, Ordering::SeqCst);
        let (sender, receiver) = channel();
        lock(&self.inner.pending).insert(id, sender);
        let line = format!("{}\n", json!({ "id": id, "code": code }));
        let written = lock(&self.inner.stdin).as_mut().map(|stdin| {
            stdin
                .write_all(line.as_bytes())
                .and_then(|()| stdin.flush())
        });
        if !matches!(written, Some(Ok(()))) {
            lock(&self.inner.pending).remove(&id);
            return Err(KernelError::NotRunning);
        }
        let answer = receiver.recv().map_err(|_| {
            let errors = lock(&self.inner.errors).trim().to_string();
            KernelError::Stopped(if errors.is_empty() {
                String::new()
            } else {
                format!(" {errors}")
            })
        })?;
        Ok(to_outputs(&answer))
    }

    /// Ends the runner and everything it started.
    pub fn stop(&self) {
        *lock(&self.inner.stdin) = None;
        #[cfg(windows)]
        if let Some(tree) = &self.inner.tree {
            tree.terminate();
        }
        let mut child = lock(&self.inner.child);
        let _ = child.kill();
        let _ = child.wait();
        self.inner.alive.store(false, Ordering::SeqCst);
    }
}

/// The runner's answer as nbformat outputs.
pub fn to_outputs(answer: &Value) -> CellResult {
    let count = answer.get("count").and_then(Value::as_i64);
    let mut outputs = Vec::new();
    for name in ["stdout", "stderr"] {
        if let Some(text) = answer
            .get(name)
            .and_then(Value::as_str)
            .filter(|t| !t.is_empty())
        {
            outputs.push(json!({ "output_type": "stream", "name": name, "text": text }));
        }
    }
    if let Some(data) = answer.get("result").filter(|r| r.is_object()) {
        outputs.push(json!({ "output_type": "execute_result", "execution_count": count, "data": data, "metadata": {} }));
    }
    if let Some(error) = answer.get("error").filter(|e| e.is_object()) {
        outputs.push(json!({
            "output_type": "error",
            "ename": error.get("ename").cloned().unwrap_or(Value::Null),
            "evalue": error.get("evalue").cloned().unwrap_or(Value::Null),
            "traceback": error.get("traceback").cloned().unwrap_or_else(|| json!([])),
        }));
    }
    CellResult {
        ok: answer.get("status").and_then(Value::as_str) == Some("ok"),
        execution_count: count,
        outputs,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn answers_become_notebook_outputs() {
        let ok = to_outputs(
            &json!({"status": "ok", "count": 2, "stdout": "hi\n", "stderr": "", "result": {"text/plain": "3"}}),
        );
        assert!(ok.ok);
        assert_eq!(ok.execution_count, Some(2));
        assert_eq!(ok.outputs.len(), 2);
        assert_eq!(ok.outputs[0]["name"], "stdout");
        assert_eq!(ok.outputs[1]["data"]["text/plain"], "3");
        let failed = to_outputs(
            &json!({"status": "error", "count": 3, "stdout": "", "stderr": "warn\n",
            "error": {"ename": "ZeroDivisionError", "evalue": "division by zero", "traceback": ["Traceback", "ZeroDivisionError"]}}),
        );
        assert!(!failed.ok);
        assert_eq!(failed.outputs[0]["name"], "stderr");
        assert_eq!(failed.outputs[1]["ename"], "ZeroDivisionError");
    }

    fn python() -> Option<PathBuf> {
        candidates(None, &[], std::env::var_os("PATH"))
            .into_iter()
            .next()
            .map(|c| PathBuf::from(c.interpreter))
    }

    #[test]
    fn a_real_python_runs_cells_in_one_namespace_and_stops() {
        let Some(interpreter) = python() else {
            eprintln!("no Python on this machine: skipped");
            return;
        };
        let dir = tempfile::tempdir().expect("tempdir");
        let spec = KernelSpec {
            interpreter,
            cwd: dir.path().to_path_buf(),
            runner_dir: dir.path().join("runner"),
            path_prepend: vec![],
            vars: vec![],
        };
        let kernel = Kernel::start(&spec).expect("start");
        let first = kernel
            .execute("x = 20\nprint('hello')\nx + 1")
            .expect("run");
        assert!(first.ok);
        assert_eq!(first.outputs[0]["text"], "hello\n");
        assert_eq!(first.outputs[1]["data"]["text/plain"], "21");
        let second = kernel.execute("1 / 0").expect("run");
        assert!(!second.ok);
        assert_eq!(second.outputs[0]["ename"], "ZeroDivisionError");
        let magic = kernel.execute("%timeit x").expect("run");
        assert!(magic.outputs[0]["evalue"]
            .as_str()
            .is_some_and(|e| e.contains("not supported")));
        let asks = kernel.execute("input('name?')").expect("run");
        assert!(asks.outputs[0]["evalue"]
            .as_str()
            .is_some_and(|e| e.contains("input()")));
        let later = kernel.execute("x * 2").expect("run");
        assert_eq!(later.outputs[0]["data"]["text/plain"], "40");
        kernel.stop();
        assert!(!kernel.is_alive());
        assert_eq!(kernel.execute("1"), Err(KernelError::NotRunning));
    }

    #[test]
    fn stopping_ends_a_running_cell() {
        let Some(interpreter) = python() else { return };
        let dir = tempfile::tempdir().expect("tempdir");
        let spec = KernelSpec {
            interpreter,
            cwd: dir.path().to_path_buf(),
            runner_dir: dir.path().join("r"),
            path_prepend: vec![],
            vars: vec![],
        };
        let kernel = Kernel::start(&spec).expect("start");
        let running = kernel.clone();
        let worker =
            std::thread::spawn(move || running.execute("import time\nwhile True: time.sleep(0.1)"));
        std::thread::sleep(std::time::Duration::from_millis(800));
        kernel.stop();
        let result = worker.join().expect("join");
        assert!(matches!(result, Err(KernelError::Stopped(_))));
    }
}
