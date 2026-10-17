# GPU acceleration diagnostics

GPU acceleration is a **request** to the local llama.cpp engine, not a
guarantee of actual GPU execution. The desktop starts llama-server using
`--gpu-layers auto` when `Use GPU acceleration` is enabled, and
`--gpu-layers 0` when disabled. Actual placement depends on the llama.cpp
binary's Vulkan/CUDA backend, GPU drivers, available memory, and model size.

## Runtime status (observed, not estimated)

When the engine becomes ready, OpenMind Studio Code reads the startup log of
**that process**. A line like `load_tensors: offloaded 18/33 layers to GPU`
means 18 of the 33 reported model layers were placed on GPU.

| Display | Meaning |
| --- | --- |
| GPU offload — X/Y layers | The engine explicitly reported X = Y GPU layers (model-layer placement only, not a GPU utilization percentage or proof that all computation is GPU-only) |
| Partial GPU offload — X/Y layers | Some model layers are GPU-resident; remaining layers execute on CPU and may affect generation speed |
| CPU fallback — GPU requested, offloaded 0/Y layers | A GPU was requested but llama.cpp reported zero GPU layers. This is not advertised as GPU acceleration |
| GPU offload unverified | No trustworthy layer-placement line was found. Do not infer GPU execution from the configured switch or detected GPU memory |
| CPU selected | GPU execution was intentionally disabled |
| Engine not running | No active inference server; old GPU status is cleared |

The Agents overview also exposes `gpuReport` with `requested`,
`mode`, `offloadedLayers`, and `totalLayers`. It preserves the old
`acceleration` tuple for compatibility, while the UI and diagnostics panel
use the richer report. The status reflects **model-layer offload**, not
real-time GPU utilization, VRAM occupancy, or actual tokens per second.
Detected VRAM **capacity** is not free VRAM.

## Troubleshooting CPU fallback / partial offload

1. In Agent Settings verify **Use GPU acceleration** is enabled, then
   restart the idle engine or start the next turn.
2. Read the GPU label in the panel and the actual startup log at the
   app's log folder (`llama-server.log`). Look for
   `offloaded X/Y layers to GPU` and backend errors.
3. Confirm the installed llama.cpp build contains a suitable Vulkan/CUDA
   backend and the GPU drivers are installed/working. A working CPU build
   can respond normally with **zero** GPU layers.
4. Partial offload is expected for large models, insufficient free VRAM or
   larger context windows. Select a smaller quantized model or reduce
   context allocation if memory is constrained.
5. If the report is **unverified**, don't assume GPU acceleration.
   Compare against the detailed engine startup log. If no offload line
   exists, consider updating the installed llama.cpp build.

Never automatically force `--gpu-layers all`: doing so can fail on
memory-constrained hardware. The engine's native automatic selection remains,
and any CPU fallback is displayed truthfully, not hidden or promoted to
full GPU. This change is about **observability and safe diagnostics**, not
a promise to make incompatible hardware accelerate models.

## Validation and limitations

- Rust unit tests validate full, partial, zero, malformed and missing
  offload reports, latest-report selection, explicit CPU mode and state
  clearing on stop.
- Frontend unit tests cover all display statuses independently of the
  legacy acceleration tuple.
- Existing Windows CI runs desktop tests covering offload parsing; frontend
  CI runs TypeScript and Vitest. Billing restrictions can block GitHub-hosted
  runners **before any test step executes**. No runtime throughput or
  driver/backend compatibility benchmark has been performed here.

Official llama.cpp server options:
https://github.com/ggml-org/llama.cpp/blob/master/tools/server/README.md
