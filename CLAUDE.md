# OpenMind Studio

A native desktop code editor (Rust + Tauri 2 + React/TypeScript + Monaco), portable-first,
targeting Windows primarily with future Linux/macOS support. Not a web app.

## Ecosystem

OpenMind Studio is the desktop IDE in the broader OpenMind ecosystem:

- **OpenMind Studio** — Desktop IDE (this project)
- **OpenMind AI** — AI Assistant (future; see the planned `openmind-ai` crate below)
- **OpenMind Runtime** — Portable Runtime Manager (foundation landed in Milestone 5 as the
  `openmind-runtime-manager` crate)
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

**Retracted (Milestone 3.5)**: Milestone 3's retrospective reported WebView2 child processes
(GPU/renderer/network helpers) as orphaned after close, and blamed `app_handle.exit(0)` for
mapping to `std::process::exit` and skipping Drop-based teardown. Both claims were wrong. Reading
Tauri 2.11.6's source directly showed `AppHandle::exit()` calls `request_exit()`, which runs the
graceful `RunEvent::ExitRequested` → `RunEvent::Exit` → `cleanup_before_exit()` sequence, not
`std::process::exit`. And the original "~10+ orphans" observation came from `tasklist /IM
msedgewebview2.exe`, which matches every process sharing that image name system-wide — Windows
Search's `SearchHost.exe` WebView2 host, Microsoft 365 Copilot's own WebView2 instance, etc., not
just this app's children. Process-ancestry tracing (PowerShell `Get-CimInstance Win32_Process
-Filter "ParentProcessId=$parentId"`, walking from the app's own PID) in a controlled A/B
comparison showed the app's real WebView2 descendants exit cleanly on close, with or without
extra teardown code. `window_events.rs` still calls `window.destroy()` before `app_handle.exit(0)`
and wraps the close-time state save in a `tokio::time::timeout` — kept as defensive hardening
(avoids `.close()`'s event-recursion risk; bounds a stuck save) rather than as a fix for a bug
that turned out not to exist. Lesson: verify a "known issue" with process-ancestry tracing, not
`tasklist` name-filtering, before trusting it in a future retrospective.

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
  Windows-1252 fallback) and line-ending detection (LF/CRLF/CR/Mixed), plus (Milestone 3) explorer
  file-system primitives: `read_dir` (one level only — the explorer tree loads lazily, so nothing
  in this crate ever recursively walks `node_modules`/`.git`/etc.), `path_metadata`, `is_binary`
  (NUL-byte sniff, used to refuse opening binaries as text), `path_safety::ensure_within_root`
  (canonicalizes and checks containment — the path-traversal guard every explorer CRUD command
  runs before touching disk), and `ops` (create/rename/move/copy/`copy_path_as`/`delete` — delete
  goes to the OS recycle bin via the `trash` crate, not a permanent unlink). No persistence, no
  knowledge of "documents" or tabs — that's the frontend's `DocumentService`.
- `openmind-workspace` — business logic over `openmind-db`: `RecentFilesService` (MRU list,
  ordered by row id not wall-clock time — see `crates/db/src/recent_files.rs` for why),
  `SessionService` (owns the `SessionSnapshot` JSON shape stored in `session_restore`),
  `WorkspaceFolderService` (Milestone 3 — open/close/recent-folders/active-workspace, layered over
  `opened_projects` + `session_restore.active_project_id`), `ExplorerStateService` (Milestone 3 —
  per-workspace expanded/selected tree state, keyed by path; resolves the internal numeric
  `opened_projects.id` internally so callers never see it, and deliberately never touches
  `opened_projects`' recency — saving tree state isn't "opening" the workspace again).
- `openmind-terminal` (Milestone 4) — real PTY sessions via `portable-pty` (ConPTY on Windows).
  Tauri-agnostic: `TerminalRegistry::create(id, request, fallback_cwd, on_output, on_exit)` takes
  plain closures, so the command layer decides how output is forwarded. Owns shell detection
  (`detect_shells`: PowerShell/cmd always, Git Bash/WSL only if found on disk/PATH — no registry,
  no admin, no process spawning), cwd validation (a missing/non-directory cwd silently falls back to
  the portable app root rather than failing), the injected environment (`default_environment`:
  `TERM`/`COLORTERM` only — inherited env passes through untouched, PATH is never modified), and
  process-tree cleanup. `portable-pty`'s own `kill()` only `TerminateProcess`es the direct child
  (verified in its `win/mod.rs`), which would orphan e.g. a `node` started inside the shell, so on
  Windows every session's shell is put in a Job Object (`job.rs`, `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`)
  and closing a session terminates the job; a registry test spawns a real `ping` grandchild and
  asserts it dies. Non-Windows falls back to killing the direct child only (compiles, unverified).
  ConPTY asks its host for the cursor position (`ESC[6n`) and holds the shell back until answered —
  xterm.js replies automatically in the app; tests driving a real shell must answer it themselves.
- `openmind-runtime-manager` (Milestone 5) — portable toolchains under `runtimes/<kind>/versions/
  <version>/`, downloads cached in `cache/downloads/`. Runtime definitions are **data**: JSON
  manifests embedded from `crates/runtime-manager/manifests/` (node/python/git) and overridable or
  extendable by `settings/runtime-manifests/*.json` (invalid overrides are skipped with a warning),
  so adding Go/Java/etc. or bumping a version needs no core logic change. Downloads go through an
  `HttpClient` trait (real client `UreqClient`, `https_only`; tests use an in-memory server) with
  Range-based resume into `.part` files; the SHA256 is verified (mismatch deletes the file) before
  anything is extracted, and nothing downloaded is executed before that. Extraction (`extract.rs`)
  validates every zip entry (`safe_entry_path`: no `..`, absolute, drive/stream `:`, NUL; refuses
  symlinks; size cap) into an `.installing` staging folder that is renamed into place. The active
  version and install records live in the existing `installed_runtimes` table (no symlinks);
  `reconcile` adopts healthy copied-in installs and removes stale staging; delete recomputes the
  folder from validated names, never from the stored path. A manifest can also declare an artifact
  `extractRoot` (install only that folder of the archive, e.g. a NuGet package's `tools/`; safety
  is still checked on every entry), `postInstall` setup steps (run once, by the checksum-verified
  runtime itself, inside its final folder with the manifest's `env`; a failure removes the install)
  and `features` (e.g. pip/venv — reported per installed version by checking a file exists, so the
  UI never claims support an install lacks). Only healthy installs are injected. `shims` declare
  command launchers (see "Relocation" below). `RuntimeManager::environment()` yields
  `path_prepend` + env vars, which `commands::terminal` passes to the terminal crate; that prepends
  to the *spawned shell's* PATH only — the system PATH, Registry and Program Files are never
  touched. No admin needed.

  **Python strategy (Milestones 5.5/5.6)**: python.org's *embeddable ZIP has no pip and no venv*,
  and making it usable means hand-editing its `._pth` file — not done. The manifest uses python.org's
  official **NuGet package** (`api.nuget.org/v3-flatcontainer/python/<v>/python.<v>.nupkg`, a zip;
  `extractRoot: "tools"`): the full standard library with `venv` and `pip` already inside
  `Lib/site-packages`. It ships pip *without* a `Scripts/pip.exe`; pip's own launchers record the
  interpreter's absolute path and so break when the app folder moves, so none are generated —
  `pip`/`pip3` are runtime **shims** instead (below). `PYTHONNOUSERSITE=1` is part of the manifest
  `env` (injected into terminals): without it the portable interpreter silently imported the
  *system* Python's `%APPDATA%\Python\Python314` user packages (found by manual testing — `pip list`
  showed torch/scipy). Verified in the built app: `python`, `pip`, `git` resolve to the portable
  copies first in `where.exe`; `pip install six` lands in the runtime's own `site-packages`;
  `python -m venv` works; `pip list` shows only pip and six. Not bundled: tkinter/IDLE. Git is
  MinGit (no bash, no GUI). `postInstall` still exists as a generic mechanism (tested), but no
  built-in manifest uses it now.

  **Relocation (Milestone 5.6)**: the whole app folder can be moved (or copied to a USB drive) and
  everything keeps working, with no migration. Nothing persistent depends on an absolute path: the
  DB's `installed_runtimes.path` column is informational (written at install, never read for
  behavior — every path is recomputed from the current `AppPaths` root + validated kind/version, as
  delete always did), active/installed state is keyed by kind+version, and `PATH`/env are computed at
  terminal launch. The one thing that *does* embed a path is a generated launcher, hence shims: a
  manifest `shims` entry (`name`, `target`, fixed `args`; validated to letters/digits/`-_.=` so
  nothing can inject script text) makes `runtimes/<kind>/shims/<version>/<name>.cmd` (Windows;
  `sh` script elsewhere) that calls `"%~dp0..\..\versions\<version>\<target>" <args> %*` —
  relative to the shim's own location, which is why `shims/<v>` and `versions/<v>` must stay
  siblings (`RuntimePaths::shim_dir`). Shims are written after the archive is verified and extracted;
  if writing fails the install fails and is cleaned up. An install counts as healthy only with its
  files *and* its shims. Missing shims of an otherwise intact install are recreated silently-but-
  logged whenever the list is loaded, a terminal is launched or on reconcile (this is also how an
  install from before shims existed gains them), and `repair` recreates them without reinstalling;
  if recreation fails the install is reported unhealthy, never half-working. Delete removes the
  shim folder; stray shim folders of removed versions are cleaned by reconcile. Injection order is
  shims, then the manifest's `binDirs` (`versions/<v>`, `versions/<v>/Scripts`), then the existing
  PATH. Known limitation: launchers that *other tools* generate later (e.g. `pip install black`
  creates `Scripts/black.exe`) still bake in absolute paths and break after a move — run them as
  `python -m black`; venvs created in a project are likewise not relocatable (Python's own design).
- `openmind-process` (Milestone 5.6.2, Windows only) — `ProcessTree`, the Job Object
  (`JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`) that kills a process *and its descendants*. Extracted from
  `openmind-terminal` so the terminal and the runner share one implementation.
- `openmind-runner` (Milestone 5.6.2) — runs the active file. `kind::detect` maps an extension to
  Python/Node/PHP/TypeScript or a "not runnable" reason (Markdown is flagged previewable). `plan`
  validates the file (absolute, exists, not binary), picks the cwd (workspace → file's folder → app
  root), tokenizes the command template (quotes only — no shell syntax) and expands `${file}`/
  `${fileDir}`/`${fileBasename}`/`${workspaceFolder}` *per token*, then resolves the program, which
  must be a bare name or an absolute path, in order: OpenMind portable runtime (`path_prepend` from the
  Runtime Manager) → project `node_modules/.bin` → system PATH. Processes are spawned as an argument
  list, never through a shell. Python gets `PYTHONUNBUFFERED=1` and the runtime's `PYTHONNOUSERSITE=1`.
  `RunRegistry` streams stdout/stderr lines as `RunEvent`s (`started`/`output`/`exited`), allows one
  run per file, stops by killing the Job Object, and `stop_all()` runs on window close.
  `shell_command_line` quotes an argv for PowerShell/cmd/bash for the "Run Code in Terminal" target and
  refuses line breaks. Missing runtimes read "<Runtime> runtime is not installed yet." **PHP is
  portable-only** (5.6.3): a machine's XAMPP/system PHP is never used or presented as the runtime, so
  PHP Run Code stays disabled until an OpenMind portable PHP is installed (no PHP manifest exists yet —
  that is the PHP Stack Manager's job). Python/Node/TypeScript tools may fall back to the system PATH,
  labelled "System Python" etc. `RunPlan.display` is the friendly command (`python hello.py`: plain
  program name, paths inside the cwd made relative); `RunPlan.resolved` is the absolute interpreter,
  reported separately (`resolved:` line in Output).
- `openmind-search` (Milestone 5.6.1) — workspace text search, on disk with no index. `search(query,
  cancel)` walks the root iteratively (sorted, so results are stable), never follows symlinks,
  always skips `node_modules`/`.git`/`target`/`dist`/`build`/`vendor`, skips binary files (shares
  `openmind_fs::looks_binary` with the explorer's binary check; UTF-16 files with a BOM are text)
  and files over 2 MB (both counted in the outcome), decodes with `openmind_fs::encoding::decode`,
  and reports matches Monaco-style (1-based line, UTF-16 columns) with a highlighted preview. Query:
  literal (escaped) or regex (`regex` crate, size-limited, no backtracking blow-ups), case/whole-word
  options, VS Code-style include/exclude globs matched against *root-relative* forward-slash paths
  (so a pattern can't address anything outside the root). `SearchRegistry` gives each run a cancel
  flag; a newer run with the same id cancels the older. `commands::search::search_run` refuses any root
  outside the open workspace and runs on `spawn_blocking`; window close cancels all searches.
  `commands::system::open_external_url` opens only `http(s)` URLs, passed to `rundll32
  url.dll,FileProtocolHandler` as data (no shell). No indexing, symbols or replace yet (Milestone 9).
- `src-tauri` (binary/package name `openmind-studio`) — the Tauri application: composition root
  (`AppState` in `app_state.rs`), Tauri commands under `commands/` namespaced by domain
  (`commands::document::*`, `commands::workspace::*`, `commands::filesystem::*`,
  `commands::settings::*`, `commands::theme::*`, `commands::terminal::*` — output/exit are pushed
  as `terminal:output` (base64 bytes: a chunk can split a UTF-8/escape sequence) and
  `terminal:exit` events), window/event wiring. Frontend-facing IPC surface
  lives here, not in the domain crates. `commands::settings` also holds two thin repository
  passthroughs (`EditorSettingsRepository` generic key-value, `PinnedFoldersRepository`) with no
  service-layer logic to justify a dedicated service — `AppState.db` exists for exactly this case.

Only depend on a workspace crate you actually call into — an unused `[dependencies]` entry is a
lint away from a compile warning and dead weight either way; two path deps were caught and removed
during the Milestone 1 → rebrand pass for exactly this reason.

### Planned future crates (create only when the milestone that implements them lands — do not
pre-scaffold empty crates)

`openmind-lsp` (language server client + auto-download), `openmind-dap` (Debug Adapter Protocol
client), `openmind-git` (Git client), `openmind-search`
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
- `CommandRegistry` (`commandRegistry.ts`) — named, executable commands (`file.new`/`file.open`/
  `file.openFolder`/`file.closeFolder`/`file.save`/`file.saveAs`/`file.closeActiveTab`/
  `view.toggleTheme`/`explorer.newFile`/`explorer.newFolder`/`explorer.refresh`/
  `explorer.collapseAll`/`explorer.revealActiveFile`), registered once in `container.ts`, plus the
  workbench commands in `workbenchCommands.ts` (Milestone 3.5 — every Edit/Selection/Go menu entry
  mapped to its Monaco action via `EDITOR_ACTIONS`, editor view toggles via `EDITOR_TOGGLES`,
  layout/zoom/full-screen/theme toggles, save-all/revert/reopen-closed/close-all). Commands carry
  optional `enabled`/`checked` predicates; a command id that was never registered reports disabled.
  Keyboard shortcuts, the menu bar, and toolbar buttons for actions with no per-invocation target
  (Refresh Explorer, Collapse All, Save All, view toggles, ...) go through the registry
  (`container.run(id)` = execute + surface failures as `appError`). The explorer's context menu and
  its header's New File/New Folder/Pin buttons call `ExplorerService`/`WorkspaceService` directly
  instead: those actions need a specific node (or the click-time selection) and, for New File/New
  Folder/Rename, local UI state (`pendingEdit`) that a global command handler has no way to reach —
  see `useExplorerInteractions.ts`. F2/Delete are bound inside `FileTree`'s own keydown handler for
  the same reason (VS Code's list keyboard model, active only while the tree has focus), not as
  global commands.
- `KeybindingService` (`keybindings.ts`) — VS Code's Windows default keybindings, each owned by
  either `app` (dispatched by the window-level listener in `appHooks.ts`) or `editor` (Monaco
  already binds it natively; listed only so menus show the shortcut — dispatching it too would run
  it twice). Matches on `event.code`, so layouts/Shift don't change which binding fires.
- `menus.ts` — the title-bar menu structure as pure data (File/Edit/Selection/View/Go/Run/Terminal/
  Help, every VS Code section and submenu), plus the gear and explorer "..." menus. Entries for
  features from later milestones reference their future command ids and render **disabled** (no
  stub handlers) — they light up automatically when that milestone registers the command.
- `EditorService` (`editorService.ts`) — bridges commands to whichever Monaco editor is mounted
  (`MonacoHost` hands its editor to `attach()` via a callback prop, staying service-free), publishes
  cursor/selection/language status for the status bar, and owns persisted editor view options
  (word wrap, minimap, sticky scroll, whitespace, column selection, multi-cursor modifier).
- `LayoutService` (`layoutService.ts`) — side bar visibility/width/side, status bar, breadcrumbs,
  explorer section state; one JSON value (`workbench.layout`) in `editor_settings`, still honoring
  Milestone 3's `sidebar.visible` key on first load.
- `WindowService` (`windowService.ts`) — the custom title bar's minimize/maximize/close, full
  screen and whole-window zoom (persisted), over an injectable `WindowApi` (Tauri window/webview).
- `MarkerService` (`markerService.ts`) — error/warning totals from Monaco markers (status bar).
- `BufferManager` (`bufferManager.ts`) — owns Monaco `ITextModel` lifecycle. Knows nothing about
  files or paths.
- `DocumentService` (`documentService.ts`) — the "Document Manager": document identity
  (path/encoding/line-ending), dirty tracking (buffer content vs. last-saved content), open/save/
  save-as orchestration between `BufferManager` and `IpcClient`.
- `WorkspaceService` (`workspaceService.ts`) — tab order + active tab, the active workspace
  *folder* (Milestone 3: `openFolder`/`closeFolder`/`loadRecentFolders`/`restoreActiveWorkspace`;
  Milestone 3.5: `pinFolder`/`unpinFolder`/`loadPinnedFolders`, emitting `pinnedFoldersChanged` so
  the explorer's pin toggle and the Start Page's Pinned section stay in sync), and
  session/recent-files/recent-folders persistence. Persists the session after *every* mutation
  (open/close/save-as), not only on app close, so it survives a crash or force-quit.
- `FileSystemService` (`fileSystemService.ts`) — the dedicated file/folder CRUD service (read dir,
  metadata, binary check, create/rename/delete/move/copy/duplicate). Pure IPC wrapper plus one
  piece of real logic: `duplicate()` computes a free "name copy"/"name copy 2" name client-side
  (`fs_duplicate` takes an explicit target name — reusing a source's own name for an in-place copy
  always collides). No tree state, no confirmation dialogs — those are `ExplorerService`'s and the
  UI's jobs respectively.
- `ExplorerService` (`explorerService.ts`) — the file tree, entirely outside React: which
  directories are expanded, which entry is selected, lazily-loaded node data (one `readDir` per
  expand/refresh — never a recursive walk), CRUD orchestration (call `FileSystemService`, then
  refresh only the affected directory/directories), and `revealPath` (walks the loaded/loadable
  tree matching path *segments* by name — never reconstructs a path string itself, which would be
  separator-fragile on Windows). Persists expanded/selected state via `explorerStateSave`
  (debounce-free; each mutation just fires its own save). Also owns the explorer's Copy/Cut
  clipboard (`setClipboard`/`paste` — cut moves, copy into the same folder duplicates).
  `explorerTree.ts` holds the pure helpers: `visibleTreeRows` (keyboard-navigation order),
  `isSameOrDescendant` (no dropping a folder into itself), `pathSegments` (breadcrumbs).
- `TerminalService` (`terminalService.ts`, Milestone 4) — the integrated terminal's UI-facing
  state (panel visibility/height, session list, active session, available shells) mirroring the Rust
  registry over IPC. Never spawns anything on launch (only `terminal.new`/`terminal.toggle` do, i.e.
  explicit user actions); persists only panel visibility/height and the last shell as one JSON value
  (`terminal.state` in `editor_settings` — no migration needed), never output or commands. Output goes
  to a per-session `TerminalSink` the xterm view registers via `attachSink` (buffered only until it
  attaches; late output from an already-closed session is dropped). New terminals start in the open
  workspace folder via an injected `getCwd`. `terminalCommands.ts` registers `terminal.toggle`
  (Ctrl+`, checkable), `terminal.new` (Ctrl+Shift+`, optional shell-kind argument from the selector),
  `terminal.clear`, `terminal.kill`; `terminal.split` is intentionally unregistered so its menu entry
  stays disabled (no split panes yet). `TerminalPanel`/`XtermHost` are UI-only, like `MonacoHost`.
- `RuntimeService` (`runtimeService.ts`) + `RuntimeManagerDialog` — UI-facing state (list,
  per-runtime working/progress/error) over the `runtime*` IPC commands and `runtime:progress`
  events, plus pure `*Availability` predicates that give every disabled button a reason (tooltip)
  and `injectionStatus` (mirrors the backend rule: only the active, healthy version is on new
  terminals' PATH). Each installed version lists its features (pip/venv: available, or not
  available with the reason).
  `runtime.manage` (`runtimeCommands.ts`) opens the dialog from the Terminal/Manage menus.
- **Workbench shell (Milestone 5.6.1).** `LayoutService.activeView` picks the side bar view
  (`explorer`/`search`/`scm`/`debug`/`extensions`); Source Control, Run and Debug and Extensions are
  honest empty states ("Git client is not enabled yet", ...), Remote Explorer and PHP Server are
  disabled activity-bar items with a tooltip reason, Runtime Manager opens its dialog. `PanelService`
  owns the bottom panel frame (visible/height/active tab, `panel.state`, migrating the old
  `terminal.state` visibility/height once); `TerminalService` now only owns sessions and shows/hides
  the panel through it. `OutputService` = named in-memory channels (OpenMind Studio / Runtime Manager /
  Terminal / Search, capped at 5000 lines; services take an optional `log` callback, wired in
  `container.ts`, so they never import the output service). `PortsService` = a *registry* services
  register into (no OS port scanning — that would be guessing); "open in browser" only for entries
  with a URL. `MarkerService` also lists Monaco markers per open document (the Problems tab), so with
  no language service it honestly says "No problems".
- **Editor groups.** `EditorGroupService` is the pure model: an ordered row of groups, each with tabs
  (`{id, docId, kind: text|markdownPreview, preview}`), an active tab and a locked flag; a text tab's
  id is its document id, a preview tab's is `<docId>#preview`. Provisional ("preview") tabs are
  replaced by the next provisional open in the same group and kept once edited/double-clicked; a locked
  group is skipped when a file opens (another group, or a new one, gets it); closing a group's last tab
  removes the group. `WorkspaceService` keeps its API (`getState().tabs/activeId` = the *active
  group's*; `.groups` has everything) and owns document lifecycle: a document is released only when
  no tab in any group shows it (`tracking()`). `EditorAssociationService` (default editor per
  extension, `editor.associations`; only Markdown can default to the preview),
  `PreviewEditorService` (Enable Preview Editors, default on; Explorer single-click opens a
  provisional tab, double-click keeps it), `OpenEditorsService` (list, Close All, Close Saved — "saved"
  = not dirty), `EditorLayoutService` (saves groups/tabs/active/locked/widths to `editor.layout`,
  coalesced, only file-backed tabs; restore falls back to the old flat session and skips files that
  can't be reopened), `MarkdownPreviewService` (open preview / to the side without stealing focus,
  follow links: http(s) -> browser, relative -> open file, everything else refused). The ⋯ menu of each
  group is built by `editorHeaderMenu.ts` (pure, tested); every row works or is disabled with a
  `reason` tooltip. `EditorService` handles one Monaco editor *per group* (commands act on the
  last-focused one) and `reveal()` selects a range in whichever editor shows a model URI, waiting up to
  5 s for the file to be shown.
- **Markdown preview** (`markdown.ts` + `MarkdownPreview.tsx`): a hand-written parser producing a data
  tree that React renders as elements — no HTML string, no `dangerouslySetInnerHTML`; raw HTML in the
  source is shown as text, images as alt text (nothing is loaded), and `safeHref` allows only
  `http(s)`, `#anchors` and relative paths (`javascript:`, `data:`, `file:`, `//host` become plain
  text). Link clicks are intercepted so the webview never navigates.
- `SearchService` (`searchService.ts`) — debounced search-as-you-type + Enter, keeps only the newest
  answer (a stale one is dropped, the in-flight one cancelled over IPC), logs a summary to the Search
  output channel; `SearchView` groups results by file with highlighted previews, click opens the
  file at the match via `WorkspaceService.openPathAt`.
- `RunCodeService` (`runCodeService.ts`, Milestone 5.6.2) + `RunConfigurationService`
  (`runConfigurationService.ts`) — the editor header's Run Code. `describeRunButton` turns the active
  file + backend `runResolve` answer into a button state and tooltip (a disabled button always carries
  its reason: unsaved, not runnable, runtime missing, already running); a dirty file is saved first.
  Output goes to the language's Output channel (Python/Node.js/PHP) and the "Run Code" channel; the
  terminal target writes the quoted command into the active terminal. Run configurations (per
  extension command templates, validated) persist as one JSON value `run.configurations` in
  `editor_settings`. Commands: `run.code` (Ctrl+F5, alias `debug.runWithoutDebugging`),
  `run.codeInTerminal`, `run.codeShowOutput`, `run.stop` (Ctrl+Shift+F5, enabled only while running),
  `run.configure`, `run.selectRuntime`; plain F5 stays unbound for the future debugger. Output header:
  `[Run Code] <friendly command>`, `cwd:`, `runtime:`, `resolved:`. The dropdown's "Run Code" row prints
  the disabled reason as visible text (`showReason`), not just a tooltip.
  `RunCodeControls` (button/dropdown/status) and `RunConfigurationDialog` are UI-only.
- `ThemeService` (`themeService.ts`) — foundation-level theme selection (`dark`/`light`, Monaco's
  built-in `vs-dark`/`vs`), persisted via the `theme_get`/`theme_set` commands.
- `safely()` (`safely.ts`) — shared helper: runs an operation, and on failure emits `appError`
  (rendered as a toast by `App.tsx`) and returns a fallback instead of throwing. Used by
  `WorkspaceService` and `ExplorerService` everywhere a failure is plausible in normal use (a file
  deleted outside the app, a permission error) — this is what satisfies "a file deleted outside the
  app must show a safe error, not crash": `restoreSession`/`openPath` skip the failing file and
  keep going rather than aborting.
- `ipc.ts` — `IpcClient` interface (property/arrow-function-typed, not method-shorthand — avoids
  eslint's `unbound-method` false-positive on bare method references in tests) + the real
  `tauriIpcClient` implementation. Services take an `IpcClient` via constructor injection, so
  tests substitute a fake implementation instead of needing a real Tauri runtime.
  `src/testUtils/fakeIpcClient.ts` holds the one shared fully-stubbed fake every test file
  overrides from, instead of each redeclaring all ~30 methods.

UI (Milestone 3.5 — VS Code workbench layout, Dark+/Light+ colors as CSS tokens in
`styles/theme.css`, switched by `data-theme` on `<html>`): the window is **undecorated**
(`decorations: false`); `TitleBar` draws VS Code's Windows title bar (app icon, `MenuBar`, command
center, side bar toggle, window controls; non-control areas are `data-tauri-drag-region`).
`MenuPopup` is the one dropdown used everywhere (menu bar, gear menu, explorer context menu),
with submenus, check marks, shortcut labels and full keyboard navigation; Alt+<letter> opens a menu.
`ActivityBar` (Explorer + Manage gear — still no placeholder icons for views that don't exist),
`SideBar` (EXPLORER title, `OpenEditorsSection`, then `ExplorerPanel` or "No Folder Opened", with
a resizable `Sash`), `FileTree` (flat rows from `visibleTreeRows`, 8px indent + hover indent
guides, Seti-style `FileTypeIcon`s and no folder icons, VS Code list keyboard model, HTML5
drag-and-drop move — requires `dragDropEnabled: false` in `tauri.conf.json`, otherwise WebView2's
native file-drop handling swallows HTML5 drag events), `EditorGroup` (`TabBar`, `Breadcrumbs`,
Monaco or `StartPage`), `StatusBar` (problems, Ln/Col, indentation, encoding, EOL, language;
purple with no folder open), `AboutDialog`, `ConfirmDialog` (before delete and drag-and-drop
move), `ErrorToast`. Transient interaction state (open menu, inline rename, pending confirm) stays
component state (`useExplorerInteractions`), never service state.

Every service is unit-tested independent of React (`*.test.ts` next to each file); `App.test.tsx`
is a thin smoke test on top (with `@tauri-apps/api/core`, `/window`, `/webview` and
`@tauri-apps/plugin-dialog` mocked at the module level), and `FileTree.test.tsx` covers the tree's
keyboard model.

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
don't write into them speculatively). Within `data/openmind-studio.db`, tables now live in:
`window_state`, `recent_files` (global MRU list — no project scoping yet, every row has
`project_id = NULL`; see `crates/db/src/recent_files.rs`), `session_restore` (one row, opaque
JSON owned by `openmind_workspace::SessionSnapshot`, plus `active_project_id` — Milestone 3, the
currently-open workspace folder), `theme` (one row), `opened_projects` (Milestone 3 — recent
folders; `touch_seq` monotonic counter, not `last_opened_at`/`id`, drives "most recent" ordering,
see the migration comment in `0002_workspace_explorer.sql` for why), `explorer_state` (Milestone
3 — one row per workspace folder, expanded/selected tree state), `editor_settings` (Milestone 3 —
generic key-value; currently just `sidebar.visible`), `pinned_folders` (Milestone 3 backend,
Milestone 3.5 UI — `WorkspaceService.pinFolder`/`unpinFolder`/`loadPinnedFolders`, a pin/unpin
toggle in the explorer's folder-header actions, and a Pinned section on the Start Page).

SQLite (WAL mode) holds every persistent concern **except project/workspace files themselves and
the on-disk assets listed above**. The full base schema (see
`crates/db/migrations/0001_init.sql`, extended by `0002_workspace_explorer.sql`) covers: editor
settings, workspace settings, opened projects, recent files, pinned folders,
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
recreate.) Hit this again during Milestone 3 (a `tauri dev` instance from an earlier session kept
running unnoticed in the background — see the WebView2-orphan known issue above — and auto-rebuilt
against an in-progress edit of `0002_workspace_explorer.sql`): before editing an unshipped
migration file, check for stray running instances first, not just after something breaks.

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
- [x] **Milestone 3** — Workspace Explorer and Start Page: `openmind-fs` gained real filesystem
  primitives (`read_dir`, `path_metadata`, `is_binary`, path-traversal-safe CRUD, recycle-bin
  delete via `trash`), `openmind-workspace` gained `WorkspaceFolderService` and
  `ExplorerStateService`, new migration `0002_workspace_explorer.sql` (`explorer_state` table +
  `opened_projects.touch_seq`). Frontend gained `FileSystemService` and `ExplorerService` (tree
  state outside React), a VS Code-style sidebar (`ActivityBar`/`ExplorerPanel`/`FileTree` with
  lazy-loaded directories, context menu, inline rename, confirm-before-delete), and a `StartPage`
  (Open Folder/Open File/New File, recent folders + files). `safely()` + an `appError`/`ErrorToast`
  path means a file deleted outside the app (or any other explorer/workspace failure) surfaces as
  a toast instead of crashing or failing silently. Git decorations were explicitly out of scope
  (belongs to the Milestone 6 Git client). Move is implemented and tested end to end
  (`FileSystemService.move`/`ExplorerService.moveEntry`, workspace-boundary-checked on both source
  and destination) but has **no UI trigger yet** — drag-and-drop needs real drop-target handling
  in `FileTree`, and a native-dialog-driven "Move to..." would either need to loosen the
  workspace-root check for an externally-picked destination or build a custom in-tree folder
  picker; neither was a small enough addition to call "safely achievable" within this milestone,
  so it's left as ready backend for whichever UI approach a future pass picks.
  99 Rust tests + 66 TypeScript tests.
- [x] **Milestone 3.5** — VS Code workbench UI + shutdown stability: custom title bar with VS
  Code's full menu bar (every section/submenu; entries for later milestones disabled until their
  command registers), command center, window controls; VS Code explorer (Open Editors, 8px-indent
  tree with indent guides, Seti-style icons, keyboard navigation, copy/cut/paste, drag-and-drop
  move with confirm — the Milestone 3 "Move has no UI" gap), resizable/movable side bar, VS Code
  tabs, breadcrumbs, status bar, About dialog, Dark+/Light+ chrome. Edit/Selection/Go menus drive
  Monaco's own actions. A pin/unpin toggle in the explorer's folder-header actions and a Pinned
  section on the Start Page close the Milestone 3 "backend ready, UI deferred" gap for
  `pinned_folders`. `window_events.rs` was also audited for clean shutdown: the Milestone 3
  WebView2-orphan report turned out to be a false positive (see the retraction under "Tech stack"
  above) — `window.destroy()` and a `tokio::time::timeout` on the close-time state save were kept
  as defensive hardening regardless. Known limitation: moving/renaming a file that's open in a tab
  doesn't retarget the tab. 136 TypeScript tests, 99 Rust tests.
- [x] **Milestone 3.6** — Editor Test Stability Gate: eliminated an intermittent "unhandled
  rejection"/"EnvironmentTeardownError" that Vitest occasionally reported against an unrelated test
  file. Root cause, found by instrumenting `process.on("unhandledRejection", ...)` around a
  model-creation test: monaco-editor's TypeScript/JavaScript language service is registered lazily
  (`languages.onLanguage`) and activates via a dynamic `import()` the first time any model uses
  that language — real production code, working as designed in a browser, but jsdom has no
  `Worker` and no real async module-loading environment, so that import can still be in flight when
  Vitest tears down whichever test file happens to be running once the race loses. `editorService.test.ts`
  triggered it by defaulting its model fixtures to `"typescript"`; `workbenchCommands.test.ts`
  triggered it by opening a document at `"a.ts"` through a real `DocumentService`/`BufferManager`
  (which maps `.ts` to Monaco's `"typescript"` language same as production code does). Fixed by
  using languages with no worker-backed service (`"markdown"`, `.rs`) in both, since neither test
  needed TypeScript's language service specifically — not by stubbing `Worker` (tried first; only
  delays the same race rather than removing it, since the leak is in the dynamic `import()`, not
  the `new Worker()` call after it) or suppressing the warning. The same hazard applies to
  `"javascript"`/`"css"`/`"html"`/`"json"` (each has its own lazily-activated, worker-backed
  service) — avoid them in test fixtures that exercise a real `BufferManager`/`DocumentService`
  the same way. Verified with 20 consecutive clean `pnpm test` runs. 136 TypeScript tests
  (unchanged — no test added or removed, only two fixtures' languages changed), 99 Rust tests.
- [x] **Milestone 4** — Integrated terminal: new `openmind-terminal` crate (real ConPTY sessions,
  shell detection, cwd validation, Job-Object process-tree kill — 13 Rust tests including real
  `cmd.exe` sessions and a grandchild-kill check), five Tauri commands + push events, kill-all on
  window close (`window_events.rs`, before the existing `destroy()`/`exit()`), and on the frontend
  `TerminalService`, xterm.js (`@xterm/xterm` + fit addon) bottom panel with tabs, active indicator,
  shell selector (only available shells listed), resize sash, clear/kill, copy/paste, exited-state
  indicator, Ctrl+`/Ctrl+Shift+`, and the Terminal menu entries. Verified against the real app
  (screenshots + process-ancestry tracing): PowerShell opened in the workspace folder, `node`/`python`
  ran, two terminals switched, closing one killed only its shell/conhost/`ping` grandchild, closing the
  app left no shell or child behind, and relaunch restored the panel without auto-starting a shell.
  Not done: split terminal (menu entry stays disabled), non-Windows kill is direct-child only. 161 TypeScript tests, 112 Rust tests.
- [x] **Milestone 4.5** — Terminal UX verification and shell polish. Every terminal UI behavior
  Milestone 4 hadn't checked was exercised in the real app (maximized window, synthesized input,
  screenshots, process-ancestry checks): shell selector (lists all four shells here, creates the
  chosen one), resize handle (panel height persists across relaunch), copy, paste, exited-tab
  indicator, closing an exited tab, PowerShell, cmd, Git Bash (bash 5.3.15, starts in the workspace
  folder), WSL, `Ctrl+``/`Ctrl+Shift+``, and the Terminal menu (Split disabled). Three real bugs
  found and fixed: (1) **shell exit was never reported on Windows** — ConPTY's output pipe doesn't hit
  EOF while the master is open, and exit detection waited for that EOF, so an exited shell's tab
  stayed "running" forever; exit is now detected by a dedicated thread waiting on the child process
  (regression test: a real `cmd.exe` running `exit 7` must be reported as `Some(7)`). (2) **Copy did
  nothing** — `navigator.clipboard.writeText` doesn't work inside the webview (also silently broke the
  explorer's "Copy Path"); both now go through `tauri-plugin-clipboard-manager`
  (`IpcClient.clipboardWriteText/ReadText`, permissions in `capabilities/default.json`), and terminal
  paste reads the same way and calls `terminal.paste` for that view's terminal only, with the browser's
  own paste suppressed so it can't paste twice. (3) Typing into an exited terminal sent input to a dead
  session and raised an error toast; it's now a quiet no-op, and requesting a shell that isn't in the
  available list is refused before touching the backend. Findings worth keeping: WSL here has a broken
  distro (`ext4.vhdx` missing) — the app handled it correctly (WSL prints its error, the tab shows
  "exited"); closing the last terminal hides the panel (VS Code behavior); and **UI test harness
  caveat** — `SendKeys` synthesizes key events with no scan code, so the browser's `event.code` is
  empty and any handler matching on `code` (Ctrl+C/V/`) silently doesn't fire; drive chords with
  `keybd_event` + `MapVirtualKey` scan codes instead. After a synthetic window activation the first
  mouse press is swallowed as an activation click. 174 TypeScript tests, 117 Rust tests.
- [x] **Milestone 5** — Portable Runtime Manager foundation: new `openmind-runtime-manager` crate
  (manifests, HTTPS resume-capable downloads, SHA256 verify, safe zip extraction, DB-backed
  install/active-version records, repair/delete, PATH injection), `installed_runtimes` repository in
  `openmind-db`, `path_prepend` support in `openmind-terminal`, and a frontend `RuntimeService` +
  `RuntimeManagerDialog` (Terminal > Manage Runtimes). Node.js, Python (embeddable) and Git (MinGit)
  ship as manifests. **Verified by hand in the built app for Node only**: install with live
  progress, new terminal `node`/`npm --version` via injection, registry User/Machine PATH
  byte-identical, persistence across restart, delete falls back to the global node, clean exit
  with no orphan descendants. Python and Git use the same code path and are covered by manifest
  validation and fake-HTTP-client tests, but their real downloads were not exercised. Known
  limitations: python.org's embeddable ZIP has no pip (noted in its manifest); python.org publishes
  no SHA256, so those hashes were computed from the official download when pinned; only Windows
  x64 artifacts are listed; WSL detection exists but WSL itself is broken on the dev machine.
  (Update, Milestone 5.5: Python and Git were later verified end to end and Python moved to the
  NuGet distribution with pip — the Python limitations in this entry are superseded.)
  Manual UI testing tip: port 1420 may be held by another dev server, so build the embedded-frontend
  debug exe (`pnpm tauri build --debug --no-bundle`) instead of `tauri dev`. 202 TypeScript tests,
  176 Rust tests.
- [x] **Milestone 5.5** — Runtime verification and Python/Git hardening. Python and Git were
  installed, used and deleted through the real Runtime Manager UI in the built app: live progress,
  terminal PATH injection first in `where.exe` for python/pip/git, `git init`/`git status` in a temp
  folder (no global Git needed), `pip install`, `python -m venv`, persistence across restart,
  delete removes the version folders and stops injection, registry User/Machine PATH byte-identical
  before/after, no orphan processes on close. Python switched from the embeddable ZIP (no pip) to
  the python.org NuGet package — see "Python strategy" under `openmind-runtime-manager`; that needed
  three general manifest features (`extractRoot`, `postInstall`, `features`) and found a real
  isolation bug (system user-site leaking in; fixed with `PYTHONNOUSERSITE`). An ignored
  integration test (`crates/runtime-manager/tests/real_install.rs`, run with `cargo test -p
  openmind-runtime-manager --test real_install -- --ignored`) downloads and exercises the real
  Python and Git. Known limitations: only Windows x64 artifacts; Node was verified in Milestone 5
  (not re-run by hand here); moving the app folder invalidated pip.exe (fixed in 5.6). 208
  TypeScript tests, 195 Rust tests (+1 ignored network test).
- [x] **Milestone 5.6** — Runtime relocation hardening: installed runtimes survive moving the whole
  app folder. Added the generic manifest `shims` concept (relative-path command launchers, see
  "Relocation" under `openmind-runtime-manager`), moved Python's `pip`/`pip3` onto it and dropped the
  absolute-path `pip.exe` generation (and with it Python's `postInstall` step and its `pip.exe`
  verify file; pip's presence is now checked as `Lib/site-packages/pip`). Verified for real: the app
  was copied to a fresh folder, Python + Node + Git installed through the UI, a terminal ran
  `python`/`pip`/`pip install six`/`python -m pip`/`node`/`npm`/`git` from there, the *whole folder
  was moved* to a different path (with a space in it), and from the new location the same script gave
  the same results with the new portable paths first in `where.exe`, no system/user site-packages
  in `pip list`, and no registry PATH change; deleting Python from the UI removed its version and
  shim folders. The ignored real-network test also moves the runtimes folder and re-runs pip via the
  shim. UI: the pip feature now reads "pip (relocatable launcher): available". 209 TypeScript tests,
  206 Rust tests (+1 ignored network test). Testing note: the UI-driving script picked the wrong
  window once when another window took focus — check the foreground window before scripted clicks.
- [x] **Milestone 5.6.1** — Workbench shell, panels and editor actions (the "5.6" workbench spec;
  relocation had already taken the name 5.6). New `openmind-search` crate (31 tests) + `search_run`/
  `search_cancel`/`open_external_url` commands; activity bar with Explorer/Search/Source Control/Run
  and Debug/Extensions/Runtime Manager (Remote Explorer and PHP Server disabled with reasons); bottom
  panel with Problems/Output/Debug Console/Terminal/Ports; multiple editor groups (Split Editor Right,
  resizable, per-group ⋯ menu: Show Open Editors, Close All, Close Saved, Split, Open Preview to the
  Side, Open as Preview, Enable Preview Editors, Lock Group, Configure Editor, Reopen Editor With,
  Set Default for ".md"); safe Markdown preview; persisted layout. Verified in the built app (fresh
  portable copy + a test workspace): Explorer, real search (node_modules and a binary file excluded,
  click opens the file with the match selected), Output channels (incl. the Search summary), Problems /
  Ports empty states, terminal still works inside the Terminal tab, split + live Markdown preview to
  the side, Reopen With Text Editor (status bar goes to "Plain Text"), Close All, relaunch restored
  both groups, the panel and its tab without auto-starting a terminal, clean exit with no orphan
  shells. Found and fixed a pre-existing `MenuPopup` bug on the way: submenu rows were located by
  position among rows, ignoring separators, so a submenu after a separator opened the wrong items or
  none. Known limitations: Debug Console, Source Control, Run and Debug and Extensions are empty
  states by design; groups are side by side only (no vertical splits, no drag-and-drop of tabs);
  "Close All" doesn't prompt about unsaved changes (pre-existing behavior of closing tabs); a file
  with mixed line endings shows as modified as soon as it opens (Monaco normalizes the line endings
  — pre-existing, and it also keeps "Close Saved" from closing that file). 343 TypeScript tests, 239
  Rust tests (+1 ignored network test).
- [x] **Milestone 5.6.2** — Run Code header action. New `openmind-process` and `openmind-runner`
  crates (41 runner tests, several against a real `cmd.exe`/`ping` tree), `run_*` commands and the
  `run:event` push event, header ▶ with dropdown (Run Code, in Terminal, and Show Output, Configure Run
  Command, Select Runtime, Stop), Run menu entries and shortcuts. Verified in the built app (fresh
  portable copy, workspace path containing spaces): system Python fallback is labelled as such; after
  installing portable Python/Node from Select Runtime, hello.py/hello.js run with the portable
  interpreters first; PHP falls back to the machine's XAMPP PHP; README.md and package.json leave Play
  disabled; a dirty file is saved before running; a 10-minute loop shows "Running…", Stop ends it with
  "Process stopped"; closing the app during a run left no python/conhost orphan; relaunch clean.
  Known limitations: the terminal target types into the terminal's current directory (it doesn't
  `cd`); WSL shells are unsupported for it; stdout and stderr are read on separate threads so their
  interleaving isn't exact; Play tooltips show the resolved executable path; a file with mixed line
  endings shows modified on open (pre-existing). 397 TypeScript tests, 280 Rust tests (+1 ignored).
- [x] **Milestone 5.6.3** — Run Code polish and PHP runtime guard. PHP no longer runs through a
  machine's XAMPP (portable-only; reason "PHP runtime is not installed yet."); Output shows the friendly
  command with `runtime:` and `resolved:` on separate lines ("System Python" is labelled as such);
  disabled reasons are visible in the Run dropdown. Verified in the built app (fresh copy, workspace
  path with spaces): README.md/package.json/index.php disabled with visible reasons even with XAMPP on
  PATH; hello.py/hello.js ran with portable Python/Node via Output and via Run Code in Terminal (the
  typed `& '<portable python>' '<file>'` line is visible and quotes the space); Configure Run Command
  rejected `C:\evil.exe x`, saved `node --no-warnings ${file}` (ran as such), persisted, and reset;
  long-running Python and Node scripts were stopped from the dropdown with no process left; closing the
  app mid-run left no python/node/conhost; registry User/Machine PATH byte-identical. Known limitation:
  the terminal target types the absolute interpreter path, so it doesn't depend on the terminal's PATH,
  but a terminal opened before the runtime install won't have `PYTHONNOUSERSITE=1` in its environment.
  400 TypeScript tests, 282 Rust tests (+1 ignored).
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
