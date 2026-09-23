# Openmind Studio

A native desktop code editor (Rust + Tauri 2 + React/TypeScript + Monaco), portable-first,
targeting Windows primarily with future Linux/macOS support. Not a web app.

## Development strategy

Work **milestone by milestone**. Never generate the whole project at once. Every milestone ends
with: build → test → fix → refactor → commit. Never move to the next milestone if the previous
one doesn't build/test cleanly. Keep the tree production-ready at all times: no placeholder code,
no TODO-as-implementation, no mock logic standing in for a real feature.

## Tech stack

- Rust (stable channel, pinned via `rust-toolchain.toml`), Tokio async runtime
- Tauri 2 (native shell, IPC, windowing, bundling)
- SQLite via `sqlx` (async, `runtime-tokio`, statically linked/bundled — no system SQLite
  dependency), **WAL journal mode**
- React 19 + TypeScript (strict, no `any`) + Vite + pnpm
- Monaco Editor (from Milestone 2 onward), Tree-sitter (from language-support milestones onward)

## Architecture

Clean architecture, one Cargo crate per bounded module under `crates/`, wired together in the
`src-tauri` binary crate via Tauri's managed state (dependency injection at the composition
root — `src-tauri/src/main.rs` — not scattered globals). Modules must not import each other
except through well-defined public APIs; no circular crate dependencies (enforced structurally —
`crates/core` has no dependency on any other workspace crate).

- `openmind-core` — shared error types, `AppPaths` (portable, exe-relative path resolution),
  logging init. No I/O beyond what's needed for path/logging setup. Everything else depends on
  this; this depends on nothing else in the workspace.
- `openmind-db` — SQLite connection pool, WAL setup, embedded migrations (`crates/db/migrations`),
  and thin repository types for each persisted concern.
- `openmind-settings` — business logic over `openmind-db` (defaults, validation, persistence)
  for user/workspace/window settings.
- `src-tauri` (binary/package name `openmind-studio`) — the Tauri application: composition root,
  Tauri commands, window/event wiring. Frontend-facing IPC surface lives here, not in the domain
  crates.

Only depend on a workspace crate you actually call into — an unused `[dependencies]` entry is a
lint away from a compile warning and dead weight either way; two path deps were caught and removed
during the Milestone 1 → rebrand pass for exactly this reason.

### Planned future crates (create only when the milestone that implements them lands — do not
pre-scaffold empty crates)

`openmind-fs` (async file system service + watcher), `openmind-workspace` (project/workspace
model, multi-root), `openmind-runtime-manager` (portable Python/Node/Go/Rust/... runtime
install/switch/repair), `openmind-lsp` (language server client + auto-download), `openmind-dap`
(Debug Adapter Protocol client), `openmind-terminal` (PTY sessions), `openmind-git` (Git client),
`openmind-search` (indexed workspace/symbol search), `openmind-extensions` (extension host +
sandboxing), `openmind-ai` (AI provider plugin architecture, including the future OpenMindAI
provider), `openmind-plugin-host`.

Frontend gains matching feature folders under `src/features/*` as each lands (no empty folders
pre-created either).

## Persistence

Everything persistent lives in SQLite (WAL mode) **except project/workspace files themselves**.
The full schema (see `crates/db/migrations/0001_init.sql`) covers: editor settings, workspace
settings, opened projects, recent files, pinned folders, terminal history, search history,
extensions, installed runtimes, AI settings, theme, window state, keybindings, bookmarks,
breakpoints, git settings, session restore, plugin registry, download cache. Tables are created
up front from the full spec even before the owning module exists, so later milestones don't need
migrations churn for the base shape — but a table only gets read/written once its owning module
is actually implemented (no module should touch another module's table).

The database file lives at `<directory containing the running exe>/data/openmind-studio.db` —
never `%APPDATA%` or another per-user OS directory — so the whole app runs portably from its own
folder with no admin rights. See `openmind_core::paths::AppPaths`.

## Branding

- Product name: **Openmind Studio** (`tauri.conf.json` `productName`/window title, `index.html`
  `<title>`, `package.json` name, and the `openmind-studio` binary/package name in `src-tauri`).
- Tauri app identifier: `com.openmindstudio.app`.
- App icon: `src-tauri/icons/` — generated via `pnpm tauri icon <source>` from the brand mark
  (blue-to-magenta ribbon with a `</>` glyph); desktop targets only (32/128/128@2x/ico/icns plus
  the Windows Store square tiles) — iOS/Android output from the generator is deleted, this project
  doesn't target mobile.

## Coding rules

- Max 700 lines per file, max 80 lines per function — split before either limit.
- Rust: idiomatic, no `unwrap()`/`expect()` outside tests, all fallible paths return `Result` with
  a `thiserror` error type, structured logging via `tracing`.
- TypeScript: strict mode, no `any`.
- Every module gets tests (unit at minimum; integration where the module has meaningful I/O
  boundaries). Don't invent tests for code that doesn't exist yet.
- Don't reach for admin privileges or globally-installed tools when a portable runtime/local
  dependency will do.

## Milestone tracker

- [x] **Milestone 1** — Project foundation: Cargo workspace, Tauri 2 shell, React/Vite frontend
  shell, SQLite WAL + full schema migration, window-state save/restore proving the Rust ↔ SQLite
  ↔ Tauri ↔ React pipeline end-to-end. Rebranded from the placeholder "CodeForge" working name to
  **Openmind Studio** immediately after, including crate names, product identifiers, and the icon.
- [ ] Milestone 2 — Monaco editor core (mount, open/save a file, tabs, basic theme).
- [ ] Milestone 3 — Explorer (file tree, CRUD, drag/drop, context menu, git decorations).
- [ ] Milestone 4 — Integrated terminal (PTY: cmd/PowerShell/Git Bash/WSL, multiplexed).
- [ ] Milestone 5 — Portable Runtime Manager (download/verify/extract/switch for Node/Python/...).
- [ ] Milestone 6 — Git client (clone/commit/push/pull/branch/merge/rebase/stash/diff/blame).
- [ ] Milestone 7 — LSP integration + auto-downloaded language servers.
- [ ] Milestone 8 — Debug Adapter Protocol integration.
- [ ] Milestone 9 — Indexed workspace/symbol/reference search.
- [ ] Milestone 10 — Extension system (sandboxed, contributes commands/views/themes/...).
- [ ] Milestone 11 — AI provider plugin architecture (local + hosted providers, chat, embeddings,
  including the future OpenMindAI integration).
- [ ] Milestone 12 — Settings UI, theming, icon themes, profiles, sync-readiness.
- [ ] Milestone 13 — Packaging, installers, startup/memory performance hardening.

This list is a living roadmap — refine milestone boundaries as work progresses, but keep the
"one milestone, fully working, then commit" discipline.
