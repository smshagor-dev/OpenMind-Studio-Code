//! The one local engine of the app: started for the model a conversation uses, kept while it is used, restarted when
//! another model is chosen, stopped with the app. Loading a model can take a while; the panel is told what happens.

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Mutex, MutexGuard, PoisonError};
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
    lease: Mutex<()>,
    engine: Mutex<Option<Engine>>,
    gpu_mode: Mutex<bool>,
    offloaded: Mutex<Option<u32>>,
}

impl EngineSlot {
    /// Held for the entire turn, deletion or manual stop, not only model loading.
    pub fn lease(&self) -> Result<MutexGuard<'_, ()>, String> {
        self.lease.try_lock().map_err(|_| "The local engine is in use by another agent operation. Wait for it to finish or stop that turn.".into())
    }
    /// The model the engine runs now, if it runs.
    pub fn running_model(&self) -> Option<String> {
        let mut slot = self.engine.lock().unwrap_or_else(PoisonError::into_inner);
        let engine = slot.as_mut()?;
        engine.exited().is_none().then(|| engine.alias.clone())
    }

    pub fn acceleration(&self) -> (bool, Option<u32>) {
        let slot = self.engine.lock().unwrap_or_else(PoisonError::into_inner);
        let requested = *self.gpu_mode.lock().unwrap_or_else(PoisonError::into_inner);
        let layers = if slot.is_some() {
            *self
                .offloaded
                .lock()
                .unwrap_or_else(PoisonError::into_inner)
        } else {
            None
        };
        (requested, layers)
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
        use_gpu: bool,
        program: &Path,
        store: &ModelStore,
        model: &ModelEntry,
        log_dir: &Path,
        cancel: &AtomicBool,
        notify: &dyn Fn(EngineEvent),
    ) -> Result<Connection, String> {
        let mut slot = self.engine.lock().unwrap_or_else(PoisonError::into_inner);
        if let Some(engine) = slot.as_mut() {
            if *self.gpu_mode.lock().unwrap_or_else(PoisonError::into_inner) == use_gpu
                && engine.alias == model.id
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
        *self
            .offloaded
            .lock()
            .unwrap_or_else(PoisonError::into_inner) = None;
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
            use_gpu,
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
        *self.gpu_mode.lock().unwrap_or_else(PoisonError::into_inner) = use_gpu;
        *self
            .offloaded
            .lock()
            .unwrap_or_else(PoisonError::into_inner) = offloaded_layers(&engine.log_tail(500));
        *slot = Some(engine);
        Ok(connection)
    }
}

fn offloaded_layers(log: &str) -> Option<u32> {
    log.lines().rev().find_map(|line| {
        let tail = line.split("offloaded ").nth(1)?;
        tail.split('/').next()?.trim().parse::<u32>().ok()
    })
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
    fn gpu_offload_comes_from_the_engine_report_not_detected_capacity() {
        assert_eq!(
            offloaded_layers("load_tensors: offloaded 33/33 layers to GPU"),
            Some(33)
        );
        assert_eq!(
            offloaded_layers("load_tensors: offloaded 0/33 layers to GPU"),
            Some(0)
        );
        assert_eq!(offloaded_layers("Vulkan device: 8 GB VRAM"), None);
    }

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

#[cfg(test)]
mod lease_tests {
    use super::*;
    #[test]
    fn a_turn_excludes_model_switch_delete_and_stop_until_released() {
        let slot = EngineSlot::default();
        let lease = slot.lease().expect("first");
        assert!(slot.lease().is_err());
        drop(lease);
        assert!(slot.lease().is_ok());
    }
}
