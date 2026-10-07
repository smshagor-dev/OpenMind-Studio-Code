//! Language server events to the windows (`lsp:diagnostics`, `lsp:log`), per-server log files under `logs/lsp/`, and a
//! server's life-cycle change into the canonical state (the language-server domain).

use std::io::Write;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use openmind_lsp::{LogLevel, LspEvents, PublishedDiagnostics};
use serde::Serialize;
use tauri::{AppHandle, Emitter};

use crate::app_state::AppState;

/// A log file over this size is moved aside (`.old`) so it can't grow without bound.
const MAX_LOG_BYTES: u64 = 2 * 1024 * 1024;

/// Turns manager events into UI events and per-server log files under `logs/lsp/`.
pub struct Sink {
    app: AppHandle,
    log_dir: PathBuf,
}

impl Sink {
    pub fn new(app: AppHandle, logs_dir: &Path) -> Self {
        Self {
            app,
            log_dir: logs_dir.join("lsp"),
        }
    }

    fn append(&self, server: &str, level: LogLevel, text: &str) {
        if std::fs::create_dir_all(&self.log_dir).is_err() {
            return;
        }
        let path = self.log_dir.join(format!("{server}.log"));
        if std::fs::metadata(&path).is_ok_and(|meta| meta.len() > MAX_LOG_BYTES) {
            let _ = std::fs::rename(&path, self.log_dir.join(format!("{server}.old.log")));
        }
        let seconds = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map_or(0, |elapsed| elapsed.as_secs());
        let line = format!(
            "{:02}:{:02}:{:02} [{level:?}] {text}\n",
            seconds / 3600 % 24,
            seconds / 60 % 60,
            seconds % 60
        );
        if let Ok(mut file) = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(path)
        {
            let _ = file.write_all(line.as_bytes());
        }
    }
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct DiagnosticsEvent {
    server: String,
    #[serde(flatten)]
    published: PublishedDiagnostics,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct LogEvent {
    server: String,
    level: LogLevel,
    text: String,
}

impl LspEvents for Sink {
    fn diagnostics(&self, server: &str, published: PublishedDiagnostics) {
        let _ = self.app.emit(
            "lsp:diagnostics",
            DiagnosticsEvent {
                server: server.to_string(),
                published,
            },
        );
    }

    fn log(&self, server: &str, level: LogLevel, text: &str) {
        self.append(server, level, text);
        let _ = self.app.emit(
            "lsp:log",
            LogEvent {
                server: server.to_string(),
                level,
                text: text.to_string(),
            },
        );
    }

    fn status_changed(&self) {
        crate::state::refresh_soon(&self.app, &[crate::state::Domain::LanguageServers]);
    }
}

pub(super) fn log_path(state: &AppState, server: &str) -> PathBuf {
    state
        .paths
        .logs_dir
        .join("lsp")
        .join(format!("{server}.log"))
}
