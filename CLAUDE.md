# OpenMind Studio

A native desktop code editor (Rust + Tauri 2 + React/TypeScript + Monaco), portable-first,
targeting Windows primarily with future Linux/macOS support. Not a web app.

## Ecosystem

OpenMind Studio is the desktop IDE in the broader OpenMind ecosystem:

- **OpenMind Studio** — Desktop IDE (this project)
- **OpenMind AI** — AI Assistant (future; see the planned `openmind-ai` crate below)
- **OpenMind Runtime** — Portable Runtime Manager (future; see the planned
  `openmind-runtime-manager` crate below)
- **OpenMind Extensions** — extension ecosystem (future; see the planned `openmind-extensions`
  crate below)
- **OpenMind Sync** — settings/session sync (future, not yet scoped into a milestone)
- **OpenMind Cloud** — cloud services (future, not yet scoped into a milestone)

Nothing outside OpenMind Studio itself is implemented yet; this section exists so future
milestones name things consistently with the ecosystem instead of improvising.

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
  crates. No `#[tauri::command]`s exist yet (Milestone 1 has no frontend-initiated calls into
  Rust); once they land, namespace command names by domain (`document_open`, `document_save`,
  `workspace_open_folder`, ...) rather than a flat/generic verb set, so the IPC surface stays
  readable as it grows.

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
sandboxing, backing the OpenMind Extensions ecosystem), `openmind-ai` (AI provider plugin
architecture, including the future OpenMind AI provider), `openmind-plugin-host`.

Frontend gains matching feature folders under `src/features/*` as each lands (no empty folders
pre-created either).

## Persistence

Everything portable is rooted at `AppPaths::root_dir` (the directory containing the running exe —
never `%APPDATA%` or another per-user OS directory, so the whole app runs from its own folder
with no admin rights). See `openmind_core::paths::AppPaths`, which resolves and (via
`ensure_dirs()`) creates the full layout:

```text
OpenMind Studio/
    data/openmind-studio.db   SQLite, WAL mode — see openmind_db
    logs/                     structured log output (populated in a future milestone)
    cache/                    download_cache contents on disk (future milestone)
    runtimes/                 installed portable runtimes (future milestone)
    extensions/               installed extension packages (future milestone)
    themes/                   on-disk theme/icon-theme assets (future milestone)
    settings/                 user-editable JSON config export (future milestone)
```

Only `data/` (and, within it, the `window_state` table) is read/written today; the rest of the
layout is created up front — matching the directories the product spec requires — but stays empty
until the milestone that owns it lands. Don't write into `logs/`, `cache/`, etc. speculatively.

SQLite (WAL mode) holds every persistent concern **except project/workspace files themselves and
the on-disk assets listed above**. The full schema (see `crates/db/migrations/0001_init.sql`)
covers: editor settings, workspace settings, opened projects, recent files, pinned folders,
terminal history, search history, extensions, installed runtimes, AI settings, theme, window
state, keybindings, bookmarks, breakpoints, git settings, session restore, plugin registry,
download cache. Tables are created up front from the full spec even before the owning module
exists, so later milestones don't need migrations churn for the base shape — but a table only
gets read/written once its owning module is actually implemented (no module should touch another
module's table). The on-disk directories above generally pair with a metadata table of the same
concern (e.g. `runtimes/` holds the actual runtime installs, `installed_runtimes` tracks them).

sqlx tracks each applied migration file's checksum in `_sqlx_migrations`. Never edit the contents
of an already-applied migration file (e.g. `0001_init.sql`) once real user data could exist under
it — that changes the checksum and every existing install fails to start with
`Migrate(VersionMismatch(_))`. Add a new numbered migration instead. (Safe to ignore for local dev
databases before the first real release — just delete the dev `data/` directory and let it
recreate.)

## Branding

- Product name: **OpenMind Studio** — this exact capitalization everywhere in UI text, docs, and
  comments (`tauri.conf.json` `productName`/window title, `index.html` `<title>`, the app shell).
  Technical identifiers stay lowercase-kebab per normal convention: npm package name
  (`package.json`), Cargo crate/package names (`openmind-core`, `openmind-db`,
  `openmind-settings`, and the `openmind-studio` binary/package name in `src-tauri`), and the
  `openmind-studio.db` filename.
- Tauri app identifier: `com.openmindstudio.app`. Bundle metadata (`tauri.conf.json` `bundle`):
  publisher `OpenMind`, copyright, short/long description — update these if the legal entity name
  changes.
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
  ↔ Tauri ↔ React pipeline end-to-end.
- [x] **Rebrand** — CodeForge (placeholder working name) → **OpenMind Studio** (permanent product
  name, part of the OpenMind ecosystem — see "Ecosystem" above), done in two passes: an initial
  product-name/icon pass, then a complete pass fixing capitalization everywhere and adding the
  full portable directory layout (`logs/`, `cache/`, `runtimes/`, `extensions/`, `themes/`,
  `settings/` alongside `data/`) documented under "Persistence" above.
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
  including the future OpenMind AI integration).
- [ ] Milestone 12 — Settings UI, theming, icon themes, profiles, sync-readiness.
- [ ] Milestone 13 — Packaging, installers, startup/memory performance hardening.

This list is a living roadmap — refine milestone boundaries as work progresses, but keep the
"one milestone, fully working, then commit" discipline.
