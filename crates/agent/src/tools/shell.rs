//! The agent's terminal for one conversation, as in Claude Code: the working directory carries over from one command to
//! the next (a `cd` stays in effect), and long-running programs (a dev server, a watcher) can run in the background while
//! the agent goes on — it reads their new output and stops them when it wants. Every background program runs in its own
//! process tree (a Job Object on Windows) and is killed with the conversation, so nothing outlives it. The working
//! directory never leaves the project folder.

use std::path::{Path, PathBuf};
use std::process::Child;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{mpsc, Arc, Mutex, PoisonError};
use std::time::Instant;

use super::command::{self, Output, Planned};
use super::{Outcome, ToolContext};
use crate::paths::Workspace;

/// Background programs one conversation may run at once.
const MAX_JOBS: usize = 6;
/// What one `command_output` call hands the model.
const MODEL_CHARS: usize = 12_000;

struct Job {
    id: String,
    command: String,
    child: Child,
    #[cfg(windows)]
    tree: openmind_process::ProcessTree,
    output: Arc<Mutex<Output>>,
    _pumps: Vec<mpsc::Receiver<()>>,
    /// Bytes of output already handed to the model (counted over everything ever written).
    seen: usize,
    started: Instant,
    exit: Option<Option<i32>>,
}

impl Job {
    fn kill(&mut self) {
        #[cfg(windows)]
        self.tree.terminate();
        #[cfg(unix)]
        command::terminate_group(self.child.id());
        let _ = self.child.kill();
        let _ = self.child.wait();
    }

    /// `None` while running; the exit code (if any) once it ended.
    fn status(&mut self) -> Option<Option<i32>> {
        if self.exit.is_none() {
            match self.child.try_wait() {
                Ok(Some(status)) => self.exit = Some(status.code()),
                Ok(None) => {}
                Err(_) => self.exit = Some(None),
            }
        }
        self.exit
    }
}

#[derive(Default)]
pub struct Shell {
    /// The working directory for the next command; `None` = the project folder.
    cwd: Mutex<Option<PathBuf>>,
    jobs: Mutex<Vec<Job>>,
    next: AtomicUsize,
}

impl Shell {
    pub fn new() -> Self {
        Self::default()
    }

    /// Where the next command starts: the remembered directory while it still exists inside the project.
    pub fn cwd(&self, ws: &Workspace) -> PathBuf {
        let remembered = self
            .cwd
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .clone();
        remembered
            .filter(|dir| dir.is_dir() && inside(ws, dir))
            .unwrap_or_else(|| ws.root().to_path_buf())
    }

    /// Remembers where a command ended. Returns a note for the model when the directory had to be reset.
    pub fn set_cwd(&self, ws: &Workspace, dir: &Path) -> Option<String> {
        let mut cwd = self.cwd.lock().unwrap_or_else(PoisonError::into_inner);
        let canonical = dunce_canonical(dir);
        if canonical.as_deref().is_some_and(|d| inside(ws, d)) {
            *cwd = canonical.filter(|d| d != ws.root());
            None
        } else {
            *cwd = None;
            Some("The command ended outside the project folder; the next command starts in the project folder.".into())
        }
    }

    /// Starts `planned` in the background and returns at once with its id.
    pub fn start(&self, planned: &Planned, ctx: &ToolContext<'_>) -> Outcome {
        let mut jobs = self.jobs.lock().unwrap_or_else(PoisonError::into_inner);
        let running = jobs
            .iter_mut()
            .map(|job| job.status())
            .filter(Option::is_none)
            .count();
        if running >= MAX_JOBS {
            return Outcome::failed(format!(
                "{running} background commands are already running. Stop one with kill_command first."
            ));
        }
        let cwd = self.cwd(ctx.ws);
        let spawned = match command::spawn(&planned.command, &cwd, ctx, false) {
            Ok(spawned) => spawned,
            Err(message) => return Outcome::failed(message),
        };
        let id = format!("bg-{}", self.next.fetch_add(1, Ordering::Relaxed) + 1);
        jobs.retain(|job| {
            job.exit.is_none() || job.seen < job.output.lock().map_or(0, |o| o.total())
        });
        jobs.push(Job {
            id: id.clone(),
            command: planned.command.clone(),
            child: spawned.child,
            #[cfg(windows)]
            tree: spawned.tree,
            output: spawned.output,
            _pumps: spawned.pumps,
            seen: 0,
            started: Instant::now(),
            exit: None,
        });
        let at = ctx.ws.relative(&cwd);
        let place = if at.is_empty() || at == "." {
            String::new()
        } else {
            format!(" in {at}")
        };
        Outcome::done(
            format!(
                "Started in the background as {id}{place}. Read what it prints with command_output (id \"{id}\") and \
                 stop it with kill_command when it is no longer needed."
            ),
            format!("Running in the background as {id}"),
        )
    }

    /// New output of a background command since the last look, and whether it still runs.
    pub fn output(&self, id: &str) -> Outcome {
        let mut jobs = self.jobs.lock().unwrap_or_else(PoisonError::into_inner);
        let Some(job) = jobs.iter_mut().find(|job| job.id == id) else {
            return Outcome::failed(unknown(id));
        };
        let status = job.status();
        let (fresh, total) = {
            let output = job.output.lock().unwrap_or_else(PoisonError::into_inner);
            (output.since(job.seen), output.total())
        };
        job.seen = total;
        let text = command::strip_ansi(&String::from_utf8_lossy(&fresh));
        let text = text.trim_end();
        let state = match status {
            None => format!(
                "{id} is running ({:.0} s)",
                job.started.elapsed().as_secs_f32()
            ),
            Some(Some(code)) => format!("{id} ended with exit code {code}"),
            Some(None) => format!("{id} ended"),
        };
        let body = if text.is_empty() {
            "(no new output)".to_string()
        } else {
            command::shorten(text, MODEL_CHARS)
        };
        Outcome {
            ok: true,
            for_model: format!("{state}: {}\n{body}", job.command),
            summary: state,
            ..Outcome::default()
        }
    }

    /// Stops a background command and everything it started.
    pub fn kill(&self, id: &str) -> Outcome {
        let mut jobs = self.jobs.lock().unwrap_or_else(PoisonError::into_inner);
        let Some(job) = jobs.iter_mut().find(|job| job.id == id) else {
            return Outcome::failed(unknown(id));
        };
        if job.status().is_some() {
            return Outcome::done(
                format!("{id} had already ended."),
                format!("{id} had already ended"),
            );
        }
        job.kill();
        job.exit = Some(None);
        Outcome::done(
            format!("Stopped {id} ({}).", job.command),
            format!("Stopped {id}"),
        )
    }

    /// Stops every background command (the conversation ends, or the app closes).
    pub fn kill_all(&self) {
        let mut jobs = self.jobs.lock().unwrap_or_else(PoisonError::into_inner);
        for job in jobs.iter_mut() {
            if job.status().is_none() {
                job.kill();
            }
        }
        jobs.clear();
    }

    /// Background commands still running (ids and commands), for the model's reference.
    pub fn running(&self) -> Vec<(String, String)> {
        let mut jobs = self.jobs.lock().unwrap_or_else(PoisonError::into_inner);
        jobs.iter_mut()
            .filter_map(|job| {
                job.status()
                    .is_none()
                    .then(|| (job.id.clone(), job.command.clone()))
            })
            .collect()
    }
}

impl Drop for Shell {
    fn drop(&mut self) {
        self.kill_all();
    }
}

fn unknown(id: &str) -> String {
    format!("There is no background command \"{id}\". Background commands are started with run_command and run_in_background.")
}

fn inside(ws: &Workspace, dir: &Path) -> bool {
    let key = |p: &Path| {
        let text = p.to_string_lossy().replace('\\', "/");
        if cfg!(windows) {
            text.to_lowercase()
        } else {
            text
        }
    };
    let root = key(ws.root());
    let dir = key(dir);
    dir == root || dir.starts_with(&format!("{}/", root.trim_end_matches('/')))
}

/// The canonical form of a directory without Windows' `\\?\` prefix.
fn dunce_canonical(dir: &Path) -> Option<PathBuf> {
    let canonical = std::fs::canonicalize(dir).ok()?;
    let text = canonical.to_string_lossy();
    Some(match text.strip_prefix(r"\\?\") {
        Some(rest) if !rest.starts_with("UNC\\") => PathBuf::from(rest),
        _ => canonical,
    })
}
