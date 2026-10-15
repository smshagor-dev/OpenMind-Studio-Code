//! Whether a model fits this PC, as pure rules over [`Hardware`]: the model's memory need against the graphics card's
//! own memory and what the system memory can spare, and a rough speed from how many bytes each token reads.

use serde::Serialize;

use crate::catalog::ModelEntry;
use crate::hardware::Hardware;

const GIB: f64 = 1024.0 * 1024.0 * 1024.0;
/// What Windows and the editor itself keep for themselves.
const OS_HEADROOM: f64 = 3.0 * GIB;
/// A graphics card with less than this is treated as none (an integrated GPU's reserved slice).
const MIN_GPU: f64 = 1.5 * GIB;
/// Rough processor memory bandwidth (dual-channel DDR4/DDR5) used to estimate the processor path's speed.
const CPU_BANDWIDTH: f64 = 20.0 * 1e9;
/// Below this many tokens a second the agent feels stuck; such a model is marked "slow".
const SLOW_TOKENS_PER_SECOND: f64 = 4.0;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum FitLevel {
    /// Fully on the graphics card.
    Gpu,
    /// Split between the graphics card and the processor.
    Mixed,
    /// On the processor, at a usable speed.
    Cpu,
    /// It loads, but answers slowly.
    Slow,
    /// Not enough memory.
    TooBig,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Fit {
    pub level: FitLevel,
    /// Memory the model needs while running (weights plus working space).
    pub needed_bytes: u64,
    /// A rough speed, in tokens per second (0 when it doesn't fit).
    pub tokens_per_second: f64,
}

impl FitLevel {
    pub fn runs(self) -> bool {
        !matches!(self, FitLevel::TooBig)
    }
}

/// The memory a model needs while it runs: its weights plus the context cache and buffers.
pub fn needed_bytes(model: &ModelEntry) -> f64 {
    let size = model.size_bytes() as f64;
    size * 1.08 + 0.8 * GIB
}

pub fn fit(model: &ModelEntry, hw: &Hardware) -> Fit {
    let need = needed_bytes(model);
    let vram = hw.vram_bytes() as f64;
    let gpu = if vram >= MIN_GPU { vram * 0.9 } else { 0.0 };
    let ram = (hw.total_ram_bytes as f64 * 0.85 - OS_HEADROOM).max(0.0);
    let needed_bytes = need as u64;
    if need > gpu + ram {
        return Fit {
            level: FitLevel::TooBig,
            needed_bytes,
            tokens_per_second: 0.0,
        };
    }
    // Every token reads the active part of the weights once; on a processor that is bandwidth-bound.
    let active_share = model.active_params_b / model.total_params_b;
    let bytes_per_token = model.size_bytes() as f64 * active_share;
    let cpu_part = ((need - gpu) / need).clamp(0.0, 1.0);
    let cpu_speed = CPU_BANDWIDTH / bytes_per_token * if hw.avx2 { 1.0 } else { 0.35 };
    // The graphics card is roughly ten times the processor's bandwidth; the slower part decides.
    let gpu_speed = cpu_speed * 10.0;
    let tokens_per_second = if cpu_part <= 0.0 {
        gpu_speed
    } else {
        1.0 / (cpu_part / cpu_speed + (1.0 - cpu_part) / gpu_speed)
    };
    let level = if cpu_part <= 0.0 {
        FitLevel::Gpu
    } else if tokens_per_second < SLOW_TOKENS_PER_SECOND {
        FitLevel::Slow
    } else if gpu > 0.0 {
        FitLevel::Mixed
    } else {
        FitLevel::Cpu
    };
    Fit {
        level,
        needed_bytes,
        tokens_per_second: (tokens_per_second * 10.0).round() / 10.0,
    }
}

/// The model to suggest: the largest one that runs at a usable speed (the catalog lists them small to large).
pub fn recommended<'a>(models: &'a [ModelEntry], hw: &Hardware) -> Option<&'a ModelEntry> {
    models.iter().rev().find(|m| {
        matches!(
            fit(m, hw).level,
            FitLevel::Gpu | FitLevel::Mixed | FitLevel::Cpu
        )
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::catalog::Catalog;
    use crate::hardware::Gpu;

    fn pc(ram_gb: u64, vram_gb: u64) -> Hardware {
        let gib = 1024 * 1024 * 1024;
        Hardware {
            total_ram_bytes: ram_gb * gib,
            available_ram_bytes: ram_gb * gib / 2,
            gpus: if vram_gb > 0 {
                vec![Gpu {
                    name: "GPU".into(),
                    vendor: "nvidia".into(),
                    vram_bytes: vram_gb * gib,
                }]
            } else {
                Vec::new()
            },
            cpu_threads: 8,
            avx2: true,
        }
    }

    fn level(id: &str, hw: &Hardware) -> FitLevel {
        let catalog = Catalog::builtin().expect("catalog");
        fit(catalog.get(id).expect("model"), hw).level
    }

    #[test]
    fn a_small_office_pc_gets_the_4b_model_on_the_processor() {
        let hw = pc(8, 0);
        assert_eq!(level("nemotron-3-nano-4b-q4", &hw), FitLevel::Cpu);
        assert_eq!(
            level("nemotron-3.5-lightning-30b-a3b-iq3", &hw),
            FitLevel::TooBig
        );
        let catalog = Catalog::builtin().expect("catalog");
        let pick = recommended(catalog.models(), &hw).expect("pick");
        assert_eq!(pick.family, "Nemotron 3 Nano 4B");
    }

    #[test]
    fn an_8_gb_graphics_card_runs_the_4b_model_fully_on_it() {
        assert_eq!(level("nemotron-3-nano-4b-q8", &pc(16, 8)), FitLevel::Gpu);
        assert_eq!(
            level("nemotron-3.5-lightning-30b-a3b-iq3", &pc(16, 8)),
            FitLevel::TooBig
        );
        assert_eq!(
            level("nemotron-3.5-lightning-30b-a3b-iq3", &pc(32, 8)),
            FitLevel::Mixed
        );
    }

    #[test]
    fn a_32_gb_pc_is_offered_the_newest_mixture_of_experts_model() {
        let hw = pc(32, 0);
        assert_eq!(
            level("nemotron-3.5-lightning-30b-a3b-iq3", &hw),
            FitLevel::Cpu
        );
        let catalog = Catalog::builtin().expect("catalog");
        let pick = recommended(catalog.models(), &hw).expect("pick");
        assert_eq!(pick.id, "nemotron-3.5-lightning-30b-a3b-iq3");
    }

    #[test]
    fn the_120b_model_needs_a_workstation() {
        assert_eq!(
            level("nemotron-3-super-120b-a12b-q4", &pc(32, 8)),
            FitLevel::TooBig
        );
        assert!(level("nemotron-3-super-120b-a12b-iq3", &pc(96, 24)).runs());
    }

    #[test]
    fn without_avx2_the_processor_path_is_marked_slow_sooner() {
        let mut hw = pc(80, 0);
        hw.avx2 = false;
        assert_eq!(level("nemotron-3-super-120b-a12b-iq3", &hw), FitLevel::Slow);
    }

    #[test]
    fn a_pc_with_too_little_memory_gets_no_recommendation() {
        let catalog = Catalog::builtin().expect("catalog");
        assert!(recommended(catalog.models(), &pc(2, 0)).is_none());
    }
}
