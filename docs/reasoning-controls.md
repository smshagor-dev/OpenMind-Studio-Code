# Reasoning and response limits

OpenMind Studio Code's local model may stream private thinking into a separate
`reasoning_content` field before the visible answer. **Hiding the field never
stopped generation**. This update gives generation an independent request-level
budget while preserving the existing Show reasoning display preference.

## Defaults and controls

| Setting | New default | Range | Meaning |
| --- | ---: | ---: | --- |
| Output tokens per response | 4,096 | 1,024–32,768 | Maximum combined answer + thinking + tool-call output for each model request |
| Reasoning budget | 1,024 | 0–8,192 | Maximum requested thinking budget, separate from the output limit |
| Show reasoning | On | On/Off | Affects the transcript display **only** |
| Execution effort | Medium | Low/Medium/High | Existing system-prompt hint; does not override the numeric thinking budget |

The UI stores `reasoningBudgetTokens`, and the Rust `SessionOptions` layer
accepts the field with serde defaults for saved conversations/settings that do
not have it. New installations use a 4K response limit. Existing users' stored
`maxOutputTokens` values are **not overwritten** by the new default.

Rust bounds the thinking budget to 8,192 tokens and, on each model call,
caps the requested thinking budget to leave at least 512 tokens available
for a visible answer or complete tool-call JSON when the model honors it. Both controls are also capped by the running model
context. For example, an output limit of 1,024 allows a thinking budget of at
most 512.

## How local inference applies the budget

Each streamed `/v1/chat/completions` request includes
`"thinking_budget_tokens": <effective budget>`, alongside
`"max_tokens": <effective output limit>`.

Recent llama.cpp versions accept `thinking_budget_tokens` at request scope
when a model's Jinja template supports the relevant thinking delimiters. This
avoids restarting the server for budget changes. A budget of `0` requests
an immediate end to thinking **when supported**.

**Compatibility limitation:** older llama.cpp builds and models without
recognized thinking delimiters may ignore the field. Do not promise universal
strict separation of tokens, or claim that disabling `Show reasoning` affects
generation. The `max_tokens` output cap remains in effect. If a server
responds with only reasoning and stops due to output length, automatic
continuations stop with an explanatory message instead of spending further
tokens on invisible thinking.

Reference: https://github.com/ggml-org/llama.cpp/discussions/21445

## Validation

The existing Rust tests exercise the request body, zero budget, serialized
legacy settings, model-context/output clamping and prevention of
reasoning-only continuation loops. Frontend tests exercise saved settings,
validation, UI editing and forwarding options to the desktop send command.

Commands for local validation (no GitHub Actions billing required):

```sh
cargo fmt --all -- --check
cargo test --locked -p openmind-agent --lib
pnpm install --frozen-lockfile
pnpm exec tsc --noEmit -p .
pnpm exec vitest run src/services/agent/agentOptions.test.ts src/services/agent/agentService.test.ts src/components/agent/AgentSettings.test.tsx
```

GitHub Actions workflows remain available for future runs, but GitHub-hosted
jobs may be blocked before checkout by an account billing restriction. That is
not evidence that tests ran, whether successfully or unsuccessfully.
