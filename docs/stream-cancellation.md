# Cancelling a local inference turn

The editor uses llama.cpp with `--parallel 1` so one task can use the full
allocated context window. This is a resource choice, not a guarantee that the
HTTP generation slot becomes free when a user clicks **Stop**.

## Original failure

`crates/ai/src/transport.rs` sends the synchronous HTTP request on a
background worker, and the caller polls the result channel every 40 ms.
Cancellation lets the **caller** return promptly, but dropping that receiver
cannot interrupt a blocking `ureq` socket read immediately. The former
worker, and sometimes llama.cpp's sole inference slot, could outlive the turn.
The next request might then hang or hit the 10-second idle wait, even though
the previous transcript said the turn was finished.

There was a second ordering race: the terminal `turnEnd` event was emitted
**before** the Rust worker released the global engine lease and per-window
busy guard. Frontend task queues resume on `turnEnd`, so they could submit
their next task while the previous engine lease was still held.

## Updated contract

- Transport checks an already-cancelled flag *before* spawning a network
  worker. A stalled HTTP stream still returns cancellation promptly at the
  normal 40 ms polling cadence.
- The local model wrapper records whether an HTTP stream was attempted and
  whether its request was interrupted or failed. Errors, cancellation or
  incomplete/error terminal streams mark that engine for recovery.
- **Only the local llama.cpp instance used by the turn** is stopped to reclaim
  the abandoned generation slot. The stop runs while that turn still holds
  the shared engine lease; process termination closes the detached reader's
  connection. The next normal request lazily launches a new engine and
  re-applies GPU/context settings.
- `Session::run_turn_deferred` retains the existing streamed output and
  state/history mutations but returns the terminal event without emitting it
  immediately. The original `Session::run_turn` retains its existing
  behavior for its other callers.
- After recovery and all locks are released, the desktop publishes precisely
  one `turnEnd` event and frontend scheduling resumes. Failed or cancelled
  requests cannot race the previous engine lease by observing completion too
  early.
- Cancelling a permission prompt, an external tool or work before an HTTP
  request doesn't automatically restart a healthy engine. Normal successful
  requests retain their warm engine.

The app **does not** increase `--parallel` (which would allocate more
context and memory), attempt undocumented llama.cpp slot APIs or interrupt
other windows' healthy work. The shared engine lease remains exclusive.

## Trade-offs and limits

Stopping a cancelled inference stream unloads the local model. The next
request pays model cold-start time but should not inherit an occupied
one-slot engine. Cancellation may still wait for cleanup and for any earlier
non-HTTP blocking operation; this is not an instantaneous, universal kill
switch for all tools or plugins. Remote provider operations are separate
from this local recovery policy.

## Verification

Tests cover:

- Cancelling a deliberately stalled local HTTP response without waiting for
  the blocked HTTP worker to finish;
- No HTTP worker spawned for requests cancelled before dispatch;
- Abort/error classification and terminal event serialization;
- Desktop `turnEnd` sent only after the per-window busy guard and engine
  lease are released;
- Existing session output preserved by deferred completion; cancellation
  before a model request remains terminal.

```sh
cargo fmt --all -- --check
cargo test --locked -p openmind-ai --lib transport::tests
cargo test --locked -p openmind-agent --lib
cargo test --locked -p openmind-studio --bin openmind-studio commands::agent::turn::cancellation_tests
cargo test --locked -p openmind-studio --bin openmind-studio commands::agent::completion_tests
```

Desktop tests require the legal resources and Windows toolchain prepared
by the repository's CI workflow. GitHub billing restrictions may prevent
runner allocation before a single test step executes; a failed workflow
without steps is **not** evidence of a code test failure or passing result.
