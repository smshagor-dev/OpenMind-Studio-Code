# Context window selection

Context allocation is **Automatic** by default (persisted `contextTokens: 0`).
A manual token limit remains available under Settings > Context window.

## Automatic allocation

- Starts with a conservative 8K/16K window, depending on the model and detected memory.
- Estimates input from the matching live conversation, current message and text attachments. History loaded from disk is bounded to the same 80 messages/200 KB as the session.
- Leaves space for model responses and tool schemas. On the **next turn**, it may grow through 16K, 32K or 64K tiers if the estimated input needs more room and the detected memory/model limit permits it.
- Reuses an already sufficient engine allocation rather than shrinking or restarting every turn. Switching between Manual and Automatic reconfigures the engine.
- The session's input/output budget always reflects the actual server `--ctx-size`; changing the allocation does not discard conversation messages.
- Existing in-turn context compaction still protects long tool loops. Memory-based tiers are conservative heuristics, **not** a guarantee that the allocated model/KV cache fits physical free memory.

For a manual context, the configured window is clamped to the model's advertised maximum and is passed directly to the local engine; the user remains in control. Changing it while a request runs takes effect on the next turn, rather than interrupting the request.

The panel reports the context actually allocated by the running engine, so it may be larger than the minimum needed for a given request.

## Limitations

A llama.cpp server cannot increase its `--ctx-size` without restarting. Automatic growth therefore happens **between turns**, not in the middle of one streaming response. Available system RAM and dedicated GPU capacity are used only to select conservative tiers; dedicated VRAM capacity does not indicate currently free VRAM. If a large context fails to load, the normal engine error is shown and a smaller manual context can be selected.

## Regression coverage

Rust tests cover automatic sizing by memory/input demand, manual clamping and context growth while retaining session history. Frontend tests cover Auto/Manual selection and existing engine preload/reconfiguration paths.

## Automated validation

The dedicated GitHub Actions workflow `.github/workflows/context-validation.yml` runs on **every pull request to main**, every push to main, and with **Run workflow** (without path filters or secrets).

| Check name | What it validates |
| --- | --- |
| `context / model contract` | Rust formatting, `--ctx-size` server arguments, manual context bounds, automatic session budgets, preserving conversation history |
| `context / desktop allocation` | Windows desktop context selection, memory tiers, allocation reuse, engine lease tests |
| `context / settings and IPC` | Frontend TypeScript/IPC signatures, lint, Auto/Manual Settings, persisted preload, idle reconfiguration and frontend build |

The existing complete `CI` workflow remains unchanged and continues to check the full workspace. The dedicated checks run independently to identify context regressions quickly. A successful green status is meaningful only after all three jobs actually execute their steps.

**Important: runner failures before checkout.** If a run ends in a few seconds with all jobs failing and no steps/logs, the tests did **not** execute. Inspect GitHub Actions run annotations and account billing/usage, Actions permissions, runner availability, and repository Actions settings. A GitHub-hosted runner/account restriction cannot be fixed by changing tests. Do not report such a run as code validation, green or red. This repo is private; branch-protection required-status-check configuration may depend on the GitHub plan and is not enabled by this workflow alone.

### Developer validation commands

```sh
cargo fmt --all -- --check
cargo test --locked -p openmind-llm --lib
cargo test --locked -p openmind-agent --lib
cargo test --locked -p openmind-studio --bin openmind-studio commands::agent::engine::tests
pnpm install --frozen-lockfile
pnpm exec tsc --noEmit -p .
pnpm exec vitest run src/components/agent/AgentSettings.test.tsx src/components/agent/AgentView.test.tsx src/services/agent/agentService.test.ts
```

The desktop Rust tests require the runtime dependencies and Tauri legal resources as prepared by the Windows CI job; they are not portable to an unprepared checkout without that setup.
