//! The one local engine of the app: started for the model a conversation uses, kept while it is used, restarted when
//! another model is chosen, stopped with the app. Loading a model can take a while; the panel is told what happens.

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Mutex, MutexGuard, PoisonError};
use std::time::{Duration, Instant};

use openmind_llm::{detect, Engine, EngineConfig, Hardware, Health, ModelEntry, ModelStore};
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
    pub context_tokens: u32,
}

/// llama.cpp's actual startup layer placement, not detected VRAM.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct Offload {
    layers: u32,
    total: u32,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GpuReport {
    pub requested: bool,
    /// "gpu", "partial", "cpuFallback", "cpu" or "unknown".
    pub mode: &'static str,
    pub offloaded_layers: Option<u32>,
    pub total_layers: Option<u32>,
}

fn gpu_mode(requested: bool, offload: Option<Offload>) -> &'static str {
    if !requested {
        return "cpu";
    }
    match offload {
        Some(Offload { layers: 0, .. }) => "cpuFallback",
        Some(Offload { layers, total }) if layers == total => "gpu",
        Some(_) => "partial",
        None => "unknown",
    }
}

#[derive(Default)]
pub struct EngineSlot {
    lease: Mutex<()>,
    engine: Mutex<Option<Engine>>,
    gpu_mode: Mutex<bool>,
    auto_context: Mutex<bool>,
    offload: Mutex<Option<Offload>>,
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

    pub fn running_context_tokens(&self) -> Option<u32> {
        let mut slot = self.engine.lock().unwrap_or_else(PoisonError::into_inner);
        let engine = slot.as_mut()?;
        engine.exited().is_none().then_some(engine.context_tokens)
    }

    /// Only show a placement report while the engine process is alive.
    pub fn gpu_report(&self) -> Option<GpuReport> {
        let mut slot = self.engine.lock().unwrap_or_else(PoisonError::into_inner);
        let engine = slot.as_mut()?;
        if engine.exited().is_some() {
            return None;
        }
        let requested = *self.gpu_mode.lock().unwrap_or_else(PoisonError::into_inner);
        let offload = *self.offload.lock().unwrap_or_else(PoisonError::into_inner);
        Some(GpuReport {
            requested,
            mode: gpu_mode(requested, offload),
            offloaded_layers: offload.map(|data| data.layers),
            total_layers: offload.map(|data| data.total),
        })
    }

    /// Preserve old overview shape for compatibility.
    pub fn acceleration(&self) -> (bool, Option<u32>) {
        match self.gpu_report() {
            Some(report) => (report.requested, report.offloaded_layers),
            None => (false, None),
        }
    }

    pub fn stop(&self) {
        let mut slot = self.engine.lock().unwrap_or_else(PoisonError::into_inner);
        if let Some(mut engine) = slot.take() {
            engine.stop();
        }
        *self.offload.lock().unwrap_or_else(PoisonError::into_inner) = None;
    }

    /// The engine running `model`, started (and waited for) when needed.
    #[allow(clippy::too_many_arguments)]
    pub fn ensure(
        &self,
        use_gpu: bool,
        requested_context_tokens: u32,
        estimated_input_tokens: usize,
        program: &Path,
        store: &ModelStore,
        model: &ModelEntry,
        log_dir: &Path,
        cancel: &AtomicBool,
        notify: &dyn Fn(EngineEvent),
    ) -> Result<Connection, String> {
        let mut slot = self.engine.lock().unwrap_or_else(PoisonError::into_inner);
        let automatic = requested_context_tokens == 0;
        let context_tokens = if automatic {
            automatic_context_tokens(model, &detect(), use_gpu, estimated_input_tokens)
        } else {
            effective_context_tokens(requested_context_tokens, model.context_tokens)
        };
        if let Some(engine) = slot.as_mut() {
            if *self.gpu_mode.lock().unwrap_or_else(PoisonError::into_inner) == use_gpu
                && *self.auto_context.lock().unwrap_or_else(PoisonError::into_inner) == automatic
                && engine.alias == model.id
                // Reuse a larger Auto window rather than repeatedly reloading the model.
                && context_allocation_matches(engine.context_tokens, context_tokens, automatic)
                && engine.exited().is_none()
                && engine.health() == Health::Ready
            {
                return Ok(Connection {
                    base_url: engine.base_url(),
                    key: engine.key().to_string(),
                    context_tokens: engine.context_tokens,
                });
            }
        }
        if let Some(mut old) = slot.take() {
            old.stop();
        }
        *self.offload.lock().unwrap_or_else(PoisonError::into_inner) = None;
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
            context_tokens,
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
        // --gpu-layers auto is a request, not a guarantee: inspect actual
        // placement from this process's startup log before reporting GPU use.
        let offload = offload_layers(&engine.log_tail(3_000));
        let status = gpu_mode(use_gpu, offload);
        let notice = if use_gpu {
            match status {
                "cpuFallback" => Some("GPU requested but llama.cpp offloaded no layers; running on CPU. Check the GPU backend, drivers and VRAM.".to_string()),
                "partial" => Some("Model partially offloaded to GPU; CPU layers may reduce generation speed.".to_string()),
                "unknown" => Some("GPU requested but llama.cpp did not report GPU layer placement; acceleration is unverified.".to_string()),
                _ => None,
            }
        } else {
            None
        };
        if let Some(warning) = &notice {
            tracing::warn!(model = %model.id, mode = status, "{warning}");
        }
        notify(event("ready", notice));
        let connection = Connection {
            base_url: engine.base_url(),
            key: engine.key().to_string(),
            context_tokens: engine.context_tokens,
        };
        *self.gpu_mode.lock().unwrap_or_else(PoisonError::into_inner) = use_gpu;
        *self.auto_context.lock().unwrap_or_else(PoisonError::into_inner) = automatic;
        *self.offload.lock().unwrap_or_else(PoisonError::into_inner) = offload;
        *slot = Some(engine);
        Ok(connection)
    }
}

// Keep the allocated KV cache aligned with SessionOptions::bounded.
fn effective_context_tokens(requested: u32, model_limit: u32) -> u32 {
    let ceiling = model_limit.max(1_024);
    if requested == 0 {
        ceiling
    } else {
        requested.clamp(1_024, ceiling)
    }
}

/// A manual window must match exactly. Auto reuses larger allocations until a
/// model or mode change, to avoid thrashing the local engine.
fn context_allocation_matches(allocated: u32, requested: u32, automatic: bool) -> bool {
    if automatic {
        allocated >= requested
    } else {
        allocated == requested
    }
}

/// Conservative memory-based tiers, not a prediction of exact KV-cache size.
/// The engine may still refuse a window on a memory-constrained system.
fn automatic_context_tokens(
    model: &ModelEntry,
    hardware: &Hardware,
    use_gpu: bool,
    estimated_input_tokens: usize,
) -> u32 {
    const GIB: u64 = 1024 * 1024 * 1024;
    // Reserve room for OS/editor, GPU buffers and KV cache.
    // Dedicated VRAM capacity is not currently free VRAM.
    let gpu_weights = if use_gpu && hardware.vram_bytes() >= 2 * GIB {
        model.size_bytes().min(hardware.vram_bytes().saturating_sub(GIB))
    } else {
        0
    };
    let ram_weights = model.size_bytes().saturating_sub(gpu_weights);
    let ram_room = hardware
        .total_ram_bytes
        .saturating_sub(3 * GIB)
        .saturating_sub(ram_weights);
    let gpu_room = if gpu_weights > 0 {
        hardware
            .vram_bytes()
            .saturating_sub(gpu_weights)
            .saturating_sub(GIB)
            .min(8 * GIB)
    } else {
        0
    };
    let memory_room = ram_room.saturating_add(gpu_room);
    let mut limit = if memory_room >= 20 * GIB {
        65_536
    } else if memory_room >= 8 * GIB {
        32_768
    } else if memory_room >= 3 * GIB {
        16_384
    } else {
        8_192
    };
    if hardware.available_ram_bytes > 0
        && hardware.available_ram_bytes < 2 * GIB
        && gpu_room < 2 * GIB
    {
        limit = limit.min(8_192);
    }
    let base = limit.min(16_384);
    // Reserve response, system prompt and tool schemas; in-turn compaction
    // still protects the remaining window.
    let demand = estimated_input_tokens
        .saturating_add(estimated_input_tokens / 4)
        .saturating_add(6_144);
    let tier = [8_192, 16_384, 32_768, 65_536, 131_072]
        .into_iter()
        .find(|&size| size as usize >= demand)
        .unwrap_or(131_072);
    base.max(tier)
        .min(limit)
        .min(model.context_tokens.max(1_024))
}

fn offload_layers(log: &str) -> Option<Offload> {
    log.lines().rev().find_map(|line| {
        // Ignore "offloading N layers" intentions, only parse placement.
        let (_, tail) = line.split_once("offloaded ")?;
        let (count, rest) = tail.split_once('/')?;
        if !rest.contains("layers to GPU") {
            return None;
        }
        let total = rest.split_whitespace().next()?.parse::<u32>().ok()?;
        let layers = count.trim().parse::<u32>().ok()?;
        (total != 0 && layers <= total).then_some(Offload { layers, total })
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
    fn selected_context_is_bounded_before_engine_allocation() {
        assert_eq!(effective_context_tokens(0, 32_768), 32_768);
        assert_eq!(effective_context_tokens(4_096, 32_768), 4_096);
        assert_eq!(effective_context_tokens(65_536, 32_768), 32_768);
        assert_eq!(effective_context_tokens(100, 32_768), 1_024);
        assert_eq!(effective_context_tokens(0, 512), 1_024);
    }

    fn hardware(ram_gib: u64, available_gib: u64, vram_gib: u64) -> Hardware {
        const GIB: u64 = 1024 * 1024 * 1024;
        Hardware {
            total_ram_bytes: ram_gib * GIB,
            available_ram_bytes: available_gib * GIB,
            gpus: if vram_gib == 0 {
                vec![]
            } else {
                vec![openmind_llm::Gpu {
                    name: "test GPU".into(),
                    vendor: "amd".into(),
                    vram_bytes: vram_gib * GIB,
                }]
            },
            cpu_threads: 8,
            avx2: true,
        }
    }

    #[test]
    fn auto_reuses_sufficient_window_but_manual_requires_exact_match() {
        assert!(context_allocation_matches(32_768, 16_384, true));
        assert!(context_allocation_matches(32_768, 32_768, true));
        assert!(!context_allocation_matches(8_192, 16_384, true));
        assert!(context_allocation_matches(16_384, 16_384, false));
        assert!(!context_allocation_matches(32_768, 16_384, false));
    }

    #[test]
    fn automatic_window_starts_small_and_grows_for_long_inputs() {
        let catalog = openmind_llm::Catalog::builtin().expect("catalog");
        let model = catalog.get("nemotron-3-nano-4b-q4").expect("model");
        let hw = hardware(16, 8, 8);
        assert_eq!(automatic_context_tokens(model, &hw, true, 0), 16_384);
        assert_eq!(automatic_context_tokens(model, &hw, true, 12_000), 32_768);
        assert_eq!(automatic_context_tokens(model, &hw, true, 100_000), 32_768);
    }

    #[test]
    fn automatic_window_respects_low_memory_and_manual_override() {
        let catalog = openmind_llm::Catalog::builtin().expect("catalog");
        let model = catalog.get("nemotron-3-nano-4b-q4").expect("model");
        let hw = hardware(8, 1, 0);
        assert_eq!(automatic_context_tokens(model, &hw, false, 0), 8_192);
        assert_eq!(automatic_context_tokens(model, &hw, false, 30_000), 8_192);
        assert_eq!(effective_context_tokens(4_096, model.context_tokens), 4_096);
    }

    #[test]
    fn gpu_offload_comes_from_the_engine_report_not_detected_capacity() {
        let full = offload_layers("load_tensors: offloaded 33/33 layers to GPU");
        assert_eq!(full, Some(Offload { layers: 33, total: 33 }));
        assert_eq!(gpu_mode(true, full), "gpu");

        let mixed = offload_layers("llm_load_tensors: offloaded 16/33 layers to GPU");
        assert_eq!(mixed, Some(Offload { layers: 16, total: 33 }));
        assert_eq!(gpu_mode(true, mixed), "partial");

        let cpu = offload_layers("load_tensors: offloaded 0/33 layers to GPU");
        assert_eq!(gpu_mode(true, cpu), "cpuFallback");
        assert_eq!(gpu_mode(false, full), "cpu");
    }

    #[test]
    fn gpu_status_is_unknown_without_a_reliable_engine_report() {
        let log = "ggml_vulkan: found a device\\nload_tensors: offloading 33 repeating layers to GPU";
        assert_eq!(offload_layers(log), None);
        assert_eq!(gpu_mode(true, None), "unknown");
        assert_eq!(gpu_mode(false, None), "cpu");
        assert_eq!(offload_layers("Vulkan device: 8 GB VRAM"), None);
        assert_eq!(offload_layers("load_tensors: offloaded 34/33 layers to GPU"), None);
        assert_eq!(offload_layers("load_tensors: offloaded 0/0 layers to GPU"), None);
    }

    #[test]
    fn latest_offload_report_wins_when_multiple_are_present() {
        let log = "load_tensors: offloaded 4/33 layers to GPU\\nload_tensors: offloaded 19/33 layers to GPU";
        assert_eq!(offload_layers(log), Some(Offload { layers: 19, total: 33 }));
    }

    #[test]
    fn stopped_or_missing_engine_has_no_gpu_report() {
        let slot = EngineSlot::default();
        assert!(slot.gpu_report().is_none());
        slot.stop();
        assert!(slot.gpu_report().is_none());
        assert_eq!(slot.acceleration(), (false, None));
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
