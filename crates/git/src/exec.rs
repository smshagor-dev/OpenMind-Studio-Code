//! Runs one Git command as a child process (argument list, no shell), with a
//! time limit, and puts it in a job object so it and anything it spawned die
//! together when it is stopped or the app shuts down.

use std::io::Read;
use std::path::Path;
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};

use crate::error::GitError;

/// What a finished Git command printed.
#[derive(Debug, Clone)]
pub struct Output {
    pub code: Option<i32>,
    pub stdout: Vec<u8>,
    pub stderr: String,
}

impl Output {
    pub fn success(&self) -> bool {
        self.code == Some(0)
    }

    pub fn stdout_text(&self) -> String {
        String::from_utf8_lossy(&self.stdout).into_owned()
    }
}

#[cfg(windows)]
type Tree = Arc<openmind_process::ProcessTree>;
#[cfg(not(windows))]
type Tree = ();

/// The Git commands that are running right now, so shutdown can stop them.
#[derive(Clone, Default)]
pub struct GitRegistry {
    running: Arc<Mutex<Vec<(u64, Tree)>>>,
    next: Arc<AtomicU64>,
}

impl GitRegistry {
    fn add(&self, tree: Tree) -> u64 {
        let id = self.next.fetch_add(1, Ordering::Relaxed);
        if let Ok(mut running) = self.running.lock() {
            running.push((id, tree));
        }
        id
    }

    fn remove(&self, id: u64) {
        if let Ok(mut running) = self.running.lock() {
            running.retain(|(entry, _)| *entry != id);
        }
    }

    /// How many Git commands are running.
    pub fn active(&self) -> usize {
        self.running
            .lock()
            .map(|running| running.len())
            .unwrap_or(0)
    }

    /// Kills every running Git command (and what it started). Called on app close.
    pub fn stop_all(&self) {
        let Ok(mut running) = self.running.lock() else {
            return;
        };
        #[cfg(windows)]
        for (_, tree) in running.iter() {
            tree.terminate();
        }
        running.clear();
    }
}

#[cfg(windows)]
fn track(registry: &GitRegistry, child: &std::process::Child) -> Option<u64> {
    use std::os::windows::io::AsRawHandle;
    let tree = openmind_process::ProcessTree::new().ok()?;
    tree.assign(child.as_raw_handle()).ok()?;
    Some(registry.add(Arc::new(tree)))
}

#[cfg(not(windows))]
fn track(_registry: &GitRegistry, _child: &std::process::Child) -> Option<u64> {
    None
}

fn drain<R: Read + Send + 'static>(pipe: Option<R>) -> thread::JoinHandle<Vec<u8>> {
    thread::spawn(move || {
        let mut bytes = Vec::new();
        if let Some(mut pipe) = pipe {
            let _ = pipe.read_to_end(&mut bytes);
        }
        bytes
    })
}

/// Runs `exe args` in `cwd`. Never prompts: a remote that wants a password
/// fails instead of waiting for input nobody can give.
pub fn run(
    exe: &Path,
    cwd: &Path,
    args: &[String],
    timeout: Duration,
    registry: &GitRegistry,
) -> Result<Output, GitError> {
    let mut command = Command::new(exe);
    command
        .args(args)
        .current_dir(cwd)
        .env("GIT_TERMINAL_PROMPT", "0")
        .env("GCM_INTERACTIVE", "never")
        .env("GIT_OPTIONAL_LOCKS", "0")
        .env("GIT_EDITOR", "true")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    }
    let mut child = command
        .spawn()
        .map_err(|err| GitError::StartFailed(err.to_string()))?;
    let tracked = track(registry, &child);
    let stdout = drain(child.stdout.take());
    let stderr = drain(child.stderr.take());

    let deadline = Instant::now() + timeout;
    let outcome = loop {
        match child.try_wait() {
            Ok(Some(status)) => break Ok(status.code()),
            Ok(None) if Instant::now() >= deadline => {
                let _ = child.kill();
                let _ = child.wait();
                break Err(GitError::Timeout);
            }
            Ok(None) => thread::sleep(Duration::from_millis(10)),
            Err(err) => break Err(GitError::StartFailed(err.to_string())),
        }
    };
    if let Some(id) = tracked {
        registry.remove(id);
    }
    let code = outcome?;
    Ok(Output {
        code,
        stdout: stdout.join().unwrap_or_default(),
        stderr: String::from_utf8_lossy(&stderr.join().unwrap_or_default())
            .trim_end()
            .to_string(),
    })
}
