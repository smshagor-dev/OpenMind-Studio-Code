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
- Monaco Editor (landed Milestone 2), Tree-sitter (from language-support milestones onward)

**Known issue**: this project's Vite 8 (Rolldown bundler) fails to bundle a web worker that
imports from a node_modules package (`?worker`/`?url` suffixes and bare `new URL(...)` specifiers
all fail the same way — confirmed a Rolldown-specific resolver bug, not an app bug). Monaco
therefore runs without a custom `MonacoEnvironment.getWorker` — a real, Monaco-supported
main-thread fallback (console warning, no crash), not a mock. Revisit when LSP-adjacent work
(Milestone 7) needs the language-service workers, or when Rolldown's worker resolution improves.

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
  for user/workspace/window/theme settings.
- `openmind-fs` — file I/O with encoding detection (BOM-sniffed UTF-8/UTF-16LE/UTF-16BE, else
  Windows-1252 fallback) and line-ending detection (LF/CRLF/CR/Mixed). Pure I/O + detection, no
  persistence, no knowledge of "documents" or tabs — that's the frontend's `DocumentService`.
- `openmind-workspace` — business logic over `openmind-db` for session/recent-files concerns:
  `RecentFilesService` (MRU list, ordered by row id not wall-clock time — see
  `crates/db/src/recent_files.rs` for why), `SessionService` (owns the `SessionSnapshot` JSON
  shape stored in `session_restore`).
- `src-tauri` (binary/package name `openmind-studio`) — the Tauri application: composition root
  (`AppState` in `app_state.rs`), Tauri commands under `commands/` namespaced by domain
  (`commands::document::*`, `commands::workspace::*`, `commands::theme::*`), window/event wiring.
  Frontend-facing IPC surface lives here, not in the domain crates.

Only depend on a workspace crate you actually call into — an unused `[dependencies]` entry is a
lint away from a compile warning and dead weight either way; two path deps were caught and removed
during the Milestone 1 → rebrand pass for exactly this reason.

### Planned future crates (create only when the milestone that implements them lands — do not
pre-scaffold empty crates)

`openmind-runtime-manager` (portable Python/Node/Go/Rust/... runtime install/switch/repair),
`openmind-lsp` (language server client + auto-download), `openmind-dap` (Debug Adapter Protocol
client), `openmind-terminal` (PTY sessions), `openmind-git` (Git client), `openmind-search`
(indexed workspace/symbol search), `openmind-extensions` (extension host + sandboxing, backing the
OpenMind Extensions ecosystem), `openmind-ai` (AI provider plugin architecture, including the
future OpenMind AI provider), `openmind-plugin-host`.

## Frontend architecture

React components render; they never own business logic (Monaco itself is UI-only too — see
`src/editor/MonacoHost.tsx`, which just mounts/tears down an editor instance and knows nothing
about documents, files, or IPC). All logic lives in `src/services/`, composed once in
`src/services/container.ts` (the frontend's composition root) and consumed by components via
`useSyncExternalStore` or plain subscriptions — never by a component reaching into service
internals.

- `EventBus<TEvents>` (`eventBus.ts`) — generic typed pub/sub; the app's shared instance is typed
  by `AppEvents` (`events.ts`) so services can react to each other without depending on each other
  directly (e.g. `WorkspaceService` re-deriving tabs when `DocumentService` reports a dirty-state
  change).
- `CommandRegistry` (`commandRegistry.ts`) — named, executable commands
  (`file.new`/`file.open`/`file.save`/`file.saveAs`/`file.closeActiveTab`/`view.toggleTheme`),
  registered once in `container.ts`. Keyboard shortcuts and UI buttons both call
  `commands.execute(id)`, never a service method directly — this is the seam a future command
  palette/menu system hangs off.
- `BufferManager` (`bufferManager.ts`) — owns Monaco `ITextModel` lifecycle. Knows nothing about
  files or paths.
- `DocumentService` (`documentService.ts`) — the "Document Manager": document identity
  (path/encoding/line-ending), dirty tracking (buffer content vs. last-saved content), open/save/
  save-as orchestration between `BufferManager` and `IpcClient`.
- `WorkspaceService` (`workspaceService.ts`) — tab order + active tab, recent-files loading,
  session restore/persist. Persists the session after *every* mutation (open/close/save-as), not
  only on app close, so it survives a crash or force-quit.
- `ThemeService` (`themeService.ts`) — foundation-level theme selection (`dark`/`light`, Monaco's
  built-in `vs-dark`/`vs`), persisted via the `theme_get`/`theme_set` commands.
- `ipc.ts` — `IpcClient` interface (property/arrow-function-typed, not method-shorthand — avoids
  eslint's `unbound-method` false-positive on bare method references in tests) + the real
  `tauriIpcClient` implementation. Services take an `IpcClient` via constructor injection, so
  tests substitute a fake implementation instead of needing a real Tauri runtime.

Every service is unit-tested independent of React (`*.test.ts` next to each file); `App.test.tsx`
is a thin smoke test on top, with `@tauri-apps/api/core` and `@tauri-apps/plugin-dialog` mocked at
the module level.

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

Only `data/` is read/written so far (`logs/`, `cache/`, `runtimes/`, `extensions/`, `themes/`,
`settings/` are created up front but stay empty until the milestone that owns each one lands —
don't write into them speculatively). Within `data/openmind-studio.db`, tables now live in
(as of Milestone 2): `window_state`, `recent_files` (global MRU list — no project scoping yet,
every row has `project_id = NULL`; see `crates/db/src/recent_files.rs`), `session_restore` (one
row, opaque JSON owned by `openmind_workspace::SessionSnapshot`), `theme` (one row).

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
- [x] **Milestone 2** — Editor foundation: Monaco mounted (UI-only, no business logic — see
  "Frontend architecture" above), `openmind-fs` (encoding + line-ending detection),
  `openmind-workspace` (recent files, session), `theme` table wired up, document
  open/save/save-as via native dialogs, dirty-state tracking, multiple tabs, recent files, session
  restore (persisted continuously, not just on close), Command Registry + EventBus foundations.
  44 Rust tests + 43 TypeScript tests (every service unit-tested independent of React).
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
