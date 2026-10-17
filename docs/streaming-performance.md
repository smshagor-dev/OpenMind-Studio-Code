# Streaming response and history performance

## Why this was slow

Previously each llama.cpp token delta was emitted as a separate Tauri
`agent:event`, folded into a new React transcript, sent to every UI
subscriber and scheduled for persistence. The history scheduler wrote full
transcript snapshots every 350 ms during continuous output. Also, every
unrelated state update (e.g. model overview polling) rescheduled the same
history, and finished Markdown messages were rendered again.

## New behavior

1. **Rust output batches.** The model transport accumulates adjacent text
   or reasoning deltas. It emits at most once per 50 ms during a busy stream
   (or immediately at 4 KiB, reasoning/text transitions, usage, stream end or
   transport errors). The parser still captures all tool calls and all
   content. No completed or partial output is discarded on error/cancel.
2. **Frontend batches.** The UI coalesces incoming text, reasoning and
   repeated thinking signals for up to 50 ms or 8 KiB/128 events.
   This reduces React state notifications without delaying permission or
   tool cards, usage, completion, error or engine events. Queued output
   is synchronously committed before a non-stream event, history navigation,
   reset, Stop and disposal.
3. **Incremental rendering.** Stable assistant and tool-card components
   are memoized. When one live assistant message grows, existing completed
   Markdown messages and tool cards are not unnecessarily rendered again.
4. **Durable checkpoints.** History serialization/writes are scheduled
   after 1 s of inactivity or at most 5 s while a response is continuously
   streaming. Saves stay strictly serialized to prevent older snapshots
   from overwriting newer ones. Turn completion and history navigation
   explicitly flush the last content before proceeding.
5. **Relevant persistence only.** Pure UI changes, periodic hardware/model
   refresh and settings updates no longer schedule redundant full-history
   writes. Transcript/task changes continue to save.

## Correctness and tradeoffs

- Text and reasoning **remain ordered** around tool calls, usage reports
  and end-of-turn events. Permission prompts are immediate.
- Chat navigation and cancellation paths flush pending chunks; remaining
  streamed content must not appear after another task becomes active.
- Long streams are periodically saved, but process termination can still
  lose up to the last 5 seconds of in-flight data, compared with up to
  350 ms previously. This is a deliberate disk-I/O vs recovery-frequency
  tradeoff; it does not change the final turn-end save.
- Backend timings are activity-triggered: the 50 ms limit is checked when
  the next token arrives, and any final small batch flushes at request end.
- Reducing event count and renders should reduce load; it is not yet a
  benchmarked FPS/tokens-per-second improvement on user hardware.

## Verification

Rust: `cargo test --locked -p openmind-agent --lib` covers full text
reconstruction, reasoning/text/usage ordering and incomplete network
responses. Vitest covers UI event coalescing, tool/permission boundaries,
stale tasks, history max-interval checkpoints and final save guarantees.
Existing CI runs these tests; when GitHub billing prevents a runner from
being allocated, no test steps execute and passing/failing code cannot be
inferred.

```sh
cargo fmt --all -- --check
cargo test --locked -p openmind-agent --lib
pnpm install --frozen-lockfile
pnpm exec tsc --noEmit -p .
pnpm exec vitest run src/services/agent/agentService.test.ts src/services/agent/agentHistory.test.ts src/services/agent/agentModel.test.ts
```
