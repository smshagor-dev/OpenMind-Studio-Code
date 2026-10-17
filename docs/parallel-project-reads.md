# Parallel project reads

## What changed

A model reply may contain several tool calls. Previously OpenMind Studio Code
prepared **every call sequentially**, even independent file reads and searches.
For the built-in inspection tools most I/O happens in `tools::prepare()`,
so simply parallelizing `tools::execute()` would provide no benefit.

`Session::run_calls` now identifies **contiguous groups** of independent
built-in read operations and runs up to **four concurrent workers** per group:

| Parallel-safe built-in tool | What it does |
| --- | --- |
| `read_file` | Reads and pages text within the validated workspace |
| `list_dir` | Lists project directory entries |
| `find_files` | Searches filenames under the workspace |
| `search` | Searches project file contents |

Only *explicitly named* built-in read operations can enter this path.
Unknown tools cannot be treated as safe merely because `ToolKind::Read`
is their default; built-in names shadowed by external/MCP registered tools
also remain on the old dispatch path.

All read preparation and execution happens in `std::thread::scope` with
borrowed workspace and cancellation state. No worker may update session
history, permission grants, UI events, task lists or files. The caller joins
all workers and then emits `ToolStart`, `ToolEnd` and corresponding
`tool_call_id` model messages in **exact model call order**, regardless
of which read finishes first.

## Dependency and permission safety

Never parallelize across any non-read operation. This includes:

- `edit_file`, `write_file`, `delete_file` and `run_command`
- `todo_write` or unknown tools
- External/MCP tool invocations, including ones claiming to be read-only
- Any read that follows or precedes a write separated by that write

For example, `read_file(A), search(B), edit_file(A), read_file(A)` executes
the first two reads together, performs the edit only after its normal
permission and unsaved-editor checks, then reads the updated file.
Default Ask, Accept Edits, Auto and Plan permissions are unchanged.
All changes are still recorded for Undo in sequential order.

Cancellation checks run before dispatch, within read workers, and before
results are published. When Stop is requested, subsequent mutations are
skipped; the existing terminal-event and HTTP stream recovery behavior
remains as implemented in `docs/stream-cancellation.md`.

## Resource and compatibility limits

The concurrency ceiling is **4 workers per batch**, preventing unbounded
thread creation from model-generated tool-call lists. Calls after a batch
are not dispatched until all workers in that batch have joined. This design
prioritizes file-safety and stable transcript/tool ordering; it does not
parallelize dependent edits, shell commands, web requests or MCP tools.

Concurrent disk searches may not outperform sequential execution on slow
or heavily loaded storage. No time savings, tokens-per-second changes or
cross-platform hardware benchmark are claimed without measurement.

## Regression coverage

- Real scoped workers start concurrently but results return in input order.
- Multiple tool calls within one model response produce ordered start/end
  events, original IDs and exact ordered tool messages.
- Parallel reads **before and after** an edit cannot cross the edit or
  bypass permission/Undo.
- External tool name collisions and unknown names are never parallelized.
- A Stop event after a read group prevents subsequent mutating tools.
- Existing context, reasoning-budget, GPU diagnostics, streaming and
  cancellation tests remain part of CI. One obsolete context test expectation
  has been updated to the current 4,096-token default.

```sh
cargo fmt --all -- --check
cargo test --locked -p openmind-agent --lib
cargo test --locked -p openmind-agent --lib independent_reads
cargo test --locked -p openmind-agent --lib edits_and_permission
cargo test --locked -p openmind-agent --lib cancellation_between_read_batches
cargo test --locked -p openmind-ai --lib transport::tests
```

GitHub Actions runner billing restrictions can prevent these tests from
**starting**. A zero-step failure cannot establish code health; perform
local Rust/Tauri tests and real multi-file performance measurements before
calling a release production-validated.
