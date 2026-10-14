//! The one local engine of the app: started for the model a conversation uses, kept while it is used, restarted when
//! another model is chosen, stopped with the app. Loading a model can take a while; the panel is told what happens.

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Mutex, PoisonError};
use std::time::{Duration, Instant};

use openmind_llm::{Engine, EngineConfig, Health, ModelEntry, ModelStore};
use serde::Serialize;

/// The largest model can take minutes to read from a slow disk.
const LOAD_LIMIT: Duration = Duration::from_secs(15 * 60);

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EngineEvent {
    #[serde(rename = "type")]
    pub kind: &'static str,
    /// `loading`, `ready` or `failed`.
    pub state: &'static str,
    pub model: String,
    pub message: Option<String>,
}

pub struct Connection {
    pub base_url: String,
    pub key: String,
}

#[derive(Default)]
pub struct EngineSlot {
    engine: Mutex<Option<Engine>>,
}

impl EngineSlot {
    /// The model the engine runs now, if it runs.
    pub fn running_model(&self) -> Option<String> {
        let mut slot = self.engine.lock().unwrap_or_else(PoisonError::into_inner);
        let engine = slot.as_mut()?;
        engine.exited().is_none().then(|| engine.alias.clone())
    }

    pub fn stop(&self) {
        if let Some(mut engine) = self
            .engine
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .take()
        {
            engine.stop();
        }
    }

    /// The engine running `model`, started (and waited for) when needed.
    pub fn ensure(
        &self,
        program: &Path,
        store: &ModelStore,
        model: &ModelEntry,
        log_dir: &Path,
        cancel: &AtomicBool,
        notify: &dyn Fn(EngineEvent),
    ) -> Result<Connection, String> {
        let mut slot = self.engine.lock().unwrap_or_else(PoisonError::into_inner);
        if let Some(engine) = slot.as_mut() {
            if engine.alias == model.id
                && engine.exited().is_none()
                && engine.health() == Health::Ready
            {
                return Ok(Connection {
                    base_url: engine.base_url(),
                    key: engine.key().to_string(),
                });
            }
        }
        if let Some(mut old) = slot.take() {
            old.stop();
        }
        let entry = store.ready_entry(model).map_err(|e| e.to_string())?;
        let event = |state: &'static str, message: Option<String>| EngineEvent {
            kind: "engine",
            state,
            model: model.id.clone(),
            message,
        };
        notify(event("loading", None));
        let config = EngineConfig {
            program: program.to_path_buf(),
            model: entry,
            alias: model.id.clone(),
            context_tokens: model.context_tokens,
            log_file: log_dir.join("llama-server.log"),
        };
        let mut engine = Engine::start(&config).map_err(|e| {
            notify(event("failed", Some(e.to_string())));
            e.to_string()
        })?;
        let started = Instant::now();
        loop {
            if cancel.load(Ordering::Relaxed) {
                engine.stop();
                return Err("cancelled".into());
            }
            if let Some(code) = engine.exited() {
                let message = format!(
                    "The engine stopped while loading {} (exit code {code}). {}",
                    model.name,
                    last_error_line(&engine.log_tail(30))
                );
                notify(event("failed", Some(message.clone())));
                return Err(message);
            }
            if engine.health() == Health::Ready {
                break;
            }
            if started.elapsed() > LOAD_LIMIT {
                engine.stop();
                let message = format!("{} did not finish loading in 15 minutes.", model.name);
                notify(event("failed", Some(message.clone())));
                return Err(message);
            }
            std::thread::sleep(Duration::from_millis(300));
        }
        tracing::info!(model = %model.id, seconds = started.elapsed().as_secs_f32(), "local model ready");
        notify(event("ready", None));
        let connection = Connection {
            base_url: engine.base_url(),
            key: engine.key().to_string(),
        };
        *slot = Some(engine);
        Ok(connection)
    }
}

/// The engine's own explanation from its log (out of memory, a model it can't read ...).
fn last_error_line(log: &str) -> String {
    log.lines()
        .rev()
        .find(|line| {
            let lower = line.to_lowercase();
            lower.contains("error") || lower.contains("failed") || lower.contains("out of memory")
        })
        .map(|line| line.trim().to_string())
        .unwrap_or_default()
}

/// `llama-server.exe` inside the engine's install folder.
pub fn program_in(dir: PathBuf) -> PathBuf {
    let name = if cfg!(windows) {
        "llama-server.exe"
    } else {
        "llama-server"
    };
    dir.join(name)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_engines_own_error_is_found_in_its_log() {
        let log = "load_model: loading\nggml_vulkan: Device memory allocation failed: out of memory\nexit";
        assert!(last_error_line(log).contains("out of memory"));
        assert_eq!(last_error_line("all good"), "");
    }

    #[test]
    fn an_idle_slot_runs_nothing() {
        let slot = EngineSlot::default();
        assert_eq!(slot.running_model(), None);
        slot.stop();
    }
}
