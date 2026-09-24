use std::collections::HashMap;
use std::io::Read;
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};

use serde::Serialize;

use crate::error::RunError;
use crate::plan::RunPlan;

/// How often the watcher thread checks whether the process has ended.
const POLL_INTERVAL: Duration = Duration::from_millis(25);
/// After the process ends, how long its output pipes get to drain.
const DRAIN_GRACE: Duration = Duration::from_millis(400);

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Stream {
    Stdout,
    Stderr,
}

#[derive(Debug, Clone, Serialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum RunEventKind {
    #[serde(rename_all = "camelCase")]
    Started {
        file: String,
        command_line: String,
        /// The absolute path of the interpreter that was started.
        resolved: String,
        cwd: String,
        runtime: String,
        language: String,
        pid: u32,
    },
    Output {
        stream: Stream,
        line: String,
    },
    #[serde(rename_all = "camelCase")]
    Exited {
        code: Option<i32>,
        duration_ms: u64,
        /// The user asked to stop it (so a missing exit code isn't a crash).
        stopped: bool,
    },
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RunEvent {
    pub run_id: String,
    #[serde(flatten)]
    pub event: RunEventKind,
}

pub type EventSink = Arc<dyn Fn(RunEvent) + Send + Sync>;

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RunInfo {
    pub run_id: String,
    pub file: String,
    pub pid: u32,
}

struct ActiveRun {
    info: RunInfo,
    child: Arc<Mutex<Child>>,
    stopped: Arc<AtomicBool>,
    #[cfg(windows)]
    tree: Option<Arc<openmind_process::ProcessTree>>,
}

impl ActiveRun {
    /// Kills the process and everything it started.
    fn kill(&self) {
        self.stopped.store(true, Ordering::SeqCst);
        #[cfg(windows)]
        if let Some(tree) = &self.tree {
            tree.terminate();
        }
        if let Ok(mut child) = self.child.lock() {
            let _ = child.kill();
        }
    }
}

/// The runs in progress: at most one per file, each in its own process tree,
/// all killed when the app shuts down.
#[derive(Clone, Default)]
pub struct RunRegistry {
    runs: Arc<Mutex<HashMap<String, ActiveRun>>>,
    counter: Arc<AtomicU64>,
}

impl RunRegistry {
    pub fn new() -> Self {
        Self::default()
    }

    /// Starts the plan's process and streams its output to `sink`. Nothing is
    /// run through a shell: the argument list goes straight to the OS.
    pub fn start(&self, plan: &RunPlan, sink: EventSink) -> Result<RunInfo, RunError> {
        let file_key = plan.file.to_string_lossy().into_owned();
        let mut runs = self.runs.lock().map_err(|_| busy(&file_key))?;
        if runs.values().any(|run| run.info.file == file_key) {
            return Err(RunError::AlreadyRunning(file_key));
        }

        let mut command = Command::new(&plan.argv[0]);
        command
            .args(&plan.argv[1..])
            .current_dir(&plan.cwd)
            .env("PATH", &plan.path_var)
            .envs(plan.env.iter().cloned())
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            command.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
        }
        let mut child = command.spawn().map_err(|err| RunError::StartFailed {
            command: plan.display.clone(),
            reason: err.to_string(),
        })?;
        let stdout = child.stdout.take();
        let stderr = child.stderr.take();
        let pid = child.id();

        #[cfg(windows)]
        let tree = assign_to_job(&child);

        let run_id = format!("run-{}", self.counter.fetch_add(1, Ordering::SeqCst) + 1);
        let info = RunInfo {
            run_id: run_id.clone(),
            file: file_key,
            pid,
        };
        let child = Arc::new(Mutex::new(child));
        let stopped = Arc::new(AtomicBool::new(false));
        runs.insert(
            run_id.clone(),
            ActiveRun {
                info: info.clone(),
                child: child.clone(),
                stopped: stopped.clone(),
                #[cfg(windows)]
                tree,
            },
        );
        drop(runs);

        sink(RunEvent {
            run_id: run_id.clone(),
            event: RunEventKind::Started {
                file: info.file.clone(),
                command_line: plan.display.clone(),
                resolved: plan.resolved.to_string_lossy().into_owned(),
                cwd: plan.cwd.to_string_lossy().into_owned(),
                runtime: plan.runtime_label.clone(),
                language: plan.kind.display_name().to_string(),
                pid,
            },
        });
        let readers: Vec<_> = [
            stdout.map(|pipe| pump(pipe, Stream::Stdout, &run_id, &sink)),
            stderr.map(|pipe| pump(pipe, Stream::Stderr, &run_id, &sink)),
        ]
        .into_iter()
        .flatten()
        .collect();
        self.watch(run_id, child, stopped, readers, sink);
        Ok(info)
    }

    /// Kills a run's whole process tree. `false` if it isn't running.
    pub fn stop(&self, run_id: &str) -> bool {
        let Ok(runs) = self.runs.lock() else {
            return false;
        };
        runs.get(run_id).is_some_and(|run| {
            run.kill();
            true
        })
    }

    /// Kills every run (app shutdown).
    pub fn stop_all(&self) {
        if let Ok(runs) = self.runs.lock() {
            for run in runs.values() {
                run.kill();
            }
        }
    }

    pub fn active(&self) -> Vec<RunInfo> {
        let mut infos: Vec<RunInfo> = self
            .runs
            .lock()
            .map(|runs| runs.values().map(|run| run.info.clone()).collect())
            .unwrap_or_default();
        infos.sort_by(|a, b| a.run_id.cmp(&b.run_id));
        infos
    }

    fn watch(
        &self,
        run_id: String,
        child: Arc<Mutex<Child>>,
        stopped: Arc<AtomicBool>,
        readers: Vec<thread::JoinHandle<()>>,
        sink: EventSink,
    ) {
        let runs = self.runs.clone();
        let started = Instant::now();
        thread::spawn(move || {
            let code = loop {
                let status = child.lock().ok().and_then(|mut c| c.try_wait().ok());
                match status {
                    Some(Some(status)) => break status.code(),
                    Some(None) => thread::sleep(POLL_INTERVAL),
                    None => break None,
                }
            };
            // Let what the process wrote before dying reach the sink first.
            let deadline = Instant::now() + DRAIN_GRACE;
            while Instant::now() < deadline && readers.iter().any(|r| !r.is_finished()) {
                thread::sleep(Duration::from_millis(10));
            }
            if let Ok(mut runs) = runs.lock() {
                runs.remove(&run_id);
            }
            sink(RunEvent {
                run_id,
                event: RunEventKind::Exited {
                    code,
                    duration_ms: u64::try_from(started.elapsed().as_millis()).unwrap_or(u64::MAX),
                    stopped: stopped.load(Ordering::SeqCst),
                },
            });
        });
    }
}

fn busy(file: &str) -> RunError {
    RunError::AlreadyRunning(file.to_string())
}

#[cfg(windows)]
fn assign_to_job(child: &Child) -> Option<Arc<openmind_process::ProcessTree>> {
    use std::os::windows::io::AsRawHandle;
    let tree = match openmind_process::ProcessTree::new() {
        Ok(tree) => tree,
        Err(err) => {
            tracing::warn!(
                ?err,
                "no job object for a run; only the process itself will be killed"
            );
            return None;
        }
    };
    match tree.assign(child.as_raw_handle()) {
        Ok(()) => Some(Arc::new(tree)),
        Err(err) => {
            tracing::warn!(?err, "couldn't put a run into its job object");
            None
        }
    }
}

/// Reads a pipe line by line (lossy UTF-8, `\r\n` trimmed) until it closes.
fn pump<R: Read + Send + 'static>(
    mut pipe: R,
    stream: Stream,
    run_id: &str,
    sink: &EventSink,
) -> thread::JoinHandle<()> {
    let run_id = run_id.to_string();
    let sink = sink.clone();
    thread::spawn(move || {
        let mut pending: Vec<u8> = Vec::new();
        let mut buffer = [0u8; 4096];
        let emit = |bytes: &[u8]| {
            let text = String::from_utf8_lossy(bytes);
            sink(RunEvent {
                run_id: run_id.clone(),
                event: RunEventKind::Output {
                    stream,
                    line: text.trim_end_matches(['\r', '\n']).to_string(),
                },
            });
        };
        loop {
            match pipe.read(&mut buffer) {
                Ok(0) | Err(_) => break,
                Ok(n) => {
                    pending.extend_from_slice(&buffer[..n]);
                    while let Some(newline) = pending.iter().position(|&b| b == b'\n') {
                        let line: Vec<u8> = pending.drain(..=newline).collect();
                        emit(&line);
                    }
                }
            }
        }
        if !pending.is_empty() {
            emit(&pending);
        }
    })
}
