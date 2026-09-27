# OpenMind Studio

A native desktop code editor (Rust + Tauri 2 + React/TypeScript + Monaco), portable-first,
targeting Windows primarily with future Linux/macOS support. Not a web app.

## Ecosystem

OpenMind Studio is the desktop IDE in the broader OpenMind ecosystem:

- **OpenMind Studio** — Desktop IDE (this project)
- **OpenMind AI** — AI Assistant (provider architecture and chat landed in Milestone 13 as the `openmind-ai` crate; the
  OpenMind AI provider itself is future)
- **OpenMind Runtime** — Portable Runtime Manager (foundation landed in Milestone 5 as the
  `openmind-runtime-manager` crate)
- **OpenMind Extensions** — extension ecosystem (VS Code-compatible foundation landed in Milestone 10 as the
  `openmind-extensions` crate; local `.vsix` only, no marketplace)
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
therefore runs without a custom `MonacoEnvironment.getWorker` for the language services — a real,
Monaco-supported main-thread fallback (console warning, no crash), not a mock. **One exception (Milestone 6)**:
the diff editor computed no highlights on the fallback, so Monaco's own pre-bundled, self-contained editor
worker (`node_modules/monaco-editor/min/vs/assets/editor.worker-<hash>.js`) is copied to
`public/monaco-workers/editor.worker.js` by `scripts/copy-monaco-workers.mjs` (`predev`/`prebuild`; the folder is
git-ignored) and `src/editor/monacoEnvironment.ts` returns it for the `editorWorkerService` label only —
every other label returns `undefined`, which keeps Monaco's default for it. Revisit when LSP-adjacent work
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
- `openmind-settings` — business logic over `openmind-db` (window state, the legacy `theme` row) and, since Milestone 9,
  the user-facing settings and keyboard shortcuts. `schema` is the one list of settings as **data** (id, category, title,
  description, kind bool/int-range/text/enum, default, scope `user` or `both`) plus `validate`, so the Settings page, the JSON
  files and the backend all agree on what a value may be. `store` reads and writes the two JSON files with VS Code's model:
  `settings/settings.json` (user) and `<workspace>/.openmind/settings.json` (workspace, only `both`-scope settings);
  `effective` = workspace value > user value > default, an invalid value in a file is *ignored and reported* (never breaks the
  app), a file with a syntax error is never rewritten, saves keep unknown keys and their order (serde_json `preserve_order`)
  and are atomic (temp file + rename), `validate_text` gives per-key problems with line numbers for the JSON editor.
  `keybindings` owns `settings/keybindings.json` — a list of `{key, command}`, a leading `-` on the command removes that
  command's default for that key (VS Code's format); `normalize_chord` canonicalizes (`ctrl+shift+s` -> `Ctrl+Shift+S`) and
  refuses chords that would break typing (a plain letter, `Shift+S`). `AppPaths` gained `settings_file`/`keybindings_file`.
  **Extras (Milestone 10)**: `SettingDef`/`EnumOption` own their strings so `schema::Extras` (`settings`, `themes`) can add what enabled
  extensions contribute — every schema/store function takes `&Extras` (`definitions`, `find`, `effective`, `issues`, `set_value`,
  `reset_value`, `validate_text`); an extension can't replace a built-in id, its themes become extra options of
  `workbench.colorTheme` (`extension:<id>/<label>`), its category is added after the built-in ones. New built-in setting
  `extensions.allowSystemNode` (user, default off). **AI (Milestone 13)**: category `AI` with `ai.enabled` (user, default on: the master
  switch for the AI panel and commands), `ai.defaultProvider`, `ai.defaultModel`, `ai.confirmBeforeOnlineRequest` (default on) and
  `ai.saveConversationHistory` (default on) — all user scope, each with a real consumer in `src/services/ai/`.
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
  **PHP stack (Milestone 5.7)**: `php` (official windows.php.net NTS x64 zip from downloads.php.net,
  SHA256 from its `releases.json`) and `composer` (`composer.phar` from getcomposer.org, SHA256 from
  its `.sha256sum`) are ordinary manifests, using three general manifest features added for them:
  artifact `archive: "file"` + `installAs` (a single downloaded file is the install), `seedFiles`
  (static text written into a fresh install — PHP's `php.ini`, which enables curl/fileinfo/mbstring/
  mysqli/openssl/pdo_mysql/zip and uses only the relative `extension_dir = "ext"`, so the folder stays
  movable), and shim `viaEnv` (the `composer.cmd` launcher runs `%OPENMIND_PHP% <phar>`; PHP's manifest
  env sets `OPENMIND_PHP={dir}\php.exe` per launch from the *active* install, so Composer never reaches
  for a global PHP — with none active it says so and exits 1). Apache is **not implemented** (listed in the
  PHP Server view as "Not available yet" with a reason).
  **Database stack (Milestone 5.8)**: `mariadb` and `phpmyadmin` are ordinary manifests. `openmind_runner::stack`
  plans (no I/O): the MariaDB config (`settings/mariadb/my.ini`, bind 127.0.0.1, default port 3307, data in
  `data/mariadb/`, logs in `logs/mariadb/`), `mysql_install_db`-style init, start (`mysqld`, normal child, never a
  Windows service), admin (`mariadb-admin ping/shutdown`, password via `MYSQL_PWD` env) and Composer
  (`install`/`update`/`dump-autoload`, only with a `composer.json`, on portable Composer + active portable PHP).
  `oneshot::run_to_completion` runs short helper commands. Everything resolves portable-only. The generated root
  password (alphanumeric, `getrandom`) and phpMyAdmin's cookie secret live in `editor_settings` **encrypted with
  Windows DPAPI** (`src-tauri/src/secret.rs`: current-user scope, fixed entropy, stored as `dpapi1:<base64>`; no
  admin, no Registry, no cloud). An older plain-text value is still readable and is re-saved encrypted the first
  time it is read (verified on a real pre-existing install). A value encrypted by another Windows user/machine
  can't be opened: the UI reports the Windows error instead of claiming there is no password. Non-Windows stores
  values as they are (nothing else is wired up). The UI shows/copies the password only on request. phpMyAdmin is served by the active
  portable PHP's built-in server (default port 8081) with a generated config using cookie login (the password is
  typed, never written to a file). `commands::database` exposes `mariadb_*`/`pma_*`/`composer_*` with
  `*:changed` and `*:event` broadcasts; window close stops all services. Services keep the PHP/DB version they
  started with when the active PHP changes and show a restart notice. Frontend: `MariaDbService`,
  `PhpMyAdminService`, `ComposerService` (its own project folder, `composer.project` in `editor_settings`, chosen
  with "Select Project…" — the server serves the whole web root, Composer works on one project; pure availability
  functions, every disabled button has a reason) and
  `PhpStackSections` (Database/phpMyAdmin/Composer/Logs with ellipsized, copyable paths). The PHP window is
  single-instance and its geometry is persisted in `window_state` (`WindowStateService::load_or`; the *inner*
  size is saved, because saving the outer size made a decorated window grow by its frame on every reopen).
  **Control panel (5.8.1)**: the PHP Server window is an XAMPP-style control panel. `ControlPanelService` +
  `ControlPanel.tsx`: a table with one row per module (PHP Server / MariaDB / phpMyAdmin) — PID, port, status and
  Start|Stop, Admin, Config, Logs — side buttons Config, Netstat, Shell, Explorer, Help, Quit, and one merged log
  (`OutputService.onAppend` hook, panel-clock timestamps, `[Module]` tags, capped at 500 lines; only lines that
  arrive while the window is open are kept). Installing versions, the project folder, ports, Composer and the
  MariaDB password are behind the Config *button* (the old `PhpServerView` as a sub page). Row Config opens the
  module's config file in Notepad (`panel_config_path`/`panel_open_file`, restricted to files inside the app
  folder), Logs filters the log, Admin opens the browser (MariaDB's Admin is phpMyAdmin), Explorer opens the
  project folder, Shell opens a console (`panel_open_shell`, cwd = project, portable runtimes first on that
  console's PATH only), Netstat lists listening TCP ports with owning process (`openmind_runner::netstat`
  parses `netstat -ano` + `tasklist`; our own servers are marked). There is no "Services" button: nothing
  here is a Windows service. The main page copies XAMPP's layout (logo + title, a "Modules" group box, a
  side column of icon buttons from `controlPanelIcons.tsx`, the log below; a running module's name cell is
  green, MariaDB starting yellow / error red — the status text is the cell's tooltip).
  **Tray mode**: closing the *main* window while the PHP server, MariaDB or phpMyAdmin runs hides the app
  to the system tray instead of quitting (`src-tauri/src/tray.rs`, `tray::servers_running`; needs Tauri's
  `tray-icon` feature). The servers keep running; the tray menu has Show OpenMind Studio (also a left
  click; removes the icon), PHP Control Panel, Stop All Servers and Quit OpenMind Studio, which runs the
  normal full shutdown (`window_events::shutdown`). With no server running, close quits as before. If the
  tray icon can't be created, close quits (never an unreachable hidden app). Launching the exe again while
  hidden starts a second instance (no single-instance lock — it would also block two portable copies in
  different folders); its server starts fail with "port in use".
- `openmind-git` (Milestone 6) — the Git client. `exe::resolve` picks the executable: OpenMind's portable Git first
  (searched in the Runtime Manager's injected `path_prepend` dirs), the system Git **only** when the user allowed it
  (`editor_settings` `git.allowSystem`, set by the "Use System Git" button) and then labelled "System Git at <path>";
  otherwise `NotInstalled` ("Git runtime is not installed yet."). `args` builds every command as an argument list
  (never a shell; paths after `--` with `--literal-pathspecs` in front — a flag, not the env variable, which
  silently breaks `git stash --include-untracked`; `GIT_TERMINAL_PROMPT=0`, no editor/pager) and the log
  label (paths counted, commit message elided). `exec::run` runs it with a time limit inside a Job Object
  (`openmind-process`), tracked in `GitRegistry` so `stop_all()` kills stragglers on app close. `status` parses
  `status --porcelain=v2 -z --branch` (modified/added/deleted/renamed/conflicted/untracked, branch, upstream,
  ahead/behind). `path::repo_relative` refuses empty/absolute/drive/`..`/NUL/`.git` paths and
  `crosses_symlink` blocks destructive file operations through links. `GitClient` (blocking) offers find_root,
  init, status, stage/unstage (+ all; before the first commit unstage is `rm --cached`), discard/discard_all/
  delete_untracked (each refuses unless told `confirmed`; discard only touches tracked working-tree edits, delete
  only files Git lists as untracked), commit (message required, staged changes required), identity get/set
  (repo-local config), `diff_sides` (both texts; added/deleted = one side `None`; binary and >2 MB refused),
  branches list/switch/create/delete (`switch` without force, `branch -d`, names checked with
  `check-ref-format`), and fetch/pull (`--ff-only`)/push (no credential storage: a remote that wants a password
  fails with an explicit message). Tests: unit tests plus `tests/real_git.rs` against a real Git in temp folders with
  spaces (skipped if the machine has no Git).
  **Milestone 6.1** added `clone.rs` (`validate_url`: not empty, not option-like, no control characters, never a
  `transport::address` like `ext::`; `validate_destination`: existing parent, missing or *empty* target — a folder
  with anything in it is refused, nothing is ever overwritten or emptied), `history.rs` (`log -z` and
  `show --name-status -z -M --diff-merges=first-parent` parsers, hashes must be 7-40 hex digits), `blame.rs`
  (`blame --porcelain` parser; refuses untracked, binary, >2 MB, missing and commit-less files with a reason),
  `stash.rs` (`stash list` parser, references built from a number only, single-line messages), `extras.rs` (the
  second `impl GitClient`: clone, history, commit files/diff sides, blame, stash list/push/apply/pop/drop — drop
  needs `confirmed`; push refuses when there is nothing to stash and says untracked files need the option) and
  `path::relative_to_root`. Authentication failures (HTTP, credential prompts, ssh publickey) all become
  "Authentication is required. Credential storage is not implemented yet."; stash conflicts keep Git's CONFLICT lines.
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
  reported separately (`resolved:` line in Output). `server.rs` (5.7) plans the PHP built-in server:
  `php -S 127.0.0.1:<port> -t <root>` by the *portable* PHP only (never a system one), root must be an
  existing absolute folder ("Select a valid folder first."), ports 1024-65535, `port_is_free`
  binds 127.0.0.1 to check. The root is a **web root, not a project** (XAMPP's `htdocs`): `webroot.rs`
  `ensure_web_root` creates `<app>/htdocs` and writes a start page (`DASHBOARD_INDEX`: lists the sub-folders,
  each a site at `/<folder>/`, every name escaped) only when the folder has no `index.php`/`index.html` —
  a user's page is never overwritten; `php_web_root` returns it, recomputed from the app folder each time. It produces an ordinary `RunPlan`, so a second `RunRegistry`
  (`AppState.php_server`, events on `php:event`, one server at a time) starts/streams/kills it exactly
  like Run Code; `window_events.rs` calls `php_server.stop_all()` on close.
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
- `openmind-file-watch` (Milestone 6.2) — `FileWatcher::start(root, callback)`: a `notify` 8 recursive watcher on the
  open workspace, feeding a worker thread and a pure `Debouncer` (250 ms of quiet, merge rules such as
  created+removed = nothing, remove+create = modified, rename pairs; more than 500 paths becomes `overflow`, meaning
  "re-check everything"). `ignore::is_ignored` skips `node_modules`/`.git`/`target`/`dist`/`build`/`vendor`;
  `normalize` makes event paths forward-slash and root-contained. Dropping the watcher stops the thread.
  `commands::watch` (`watch_start`/`watch_stop`; `watch_start` accepts only the active workspace folder, so a
  compromised webview can't watch elsewhere) pushes `fs:changed` batches; window close stops it. `document_read`
  (`commands::document`) answers missing/file/unreadable without touching recent files.
- `openmind-lsp` (Milestone 7) — the Language Server Protocol client, Tauri-agnostic (`LspEvents` sink supplied by the app).
  `registry` lists the servers as data (TypeScript/JavaScript = typescript-language-server + typescript, Python = Pyright,
  PHP = Intelephense, JSON/CSS/HTML = vscode-langservers-extracted) with the **pinned `package.json` + `package-lock.json`**
  embedded from `crates/lsp/servers/<package>/`; `install` runs Node's own `npm ci --ignore-scripts` on that lockfile (every
  download is checked against a pinned integrity hash; npm cache in `cache/npm`) into `language-servers/<package>/<revision>/`,
  staged then renamed, only when the user presses Install. `node::resolve_node` = OpenMind portable Node first, a Node on the
  system PATH only as a labelled fallback ("System Node.js at ..."). `process` spawns `node <entry> --stdio` directly (argument
  list, no shell, no console window, the Runtime Manager's `path_prepend`/`env` on the *server's* PATH only) inside a Job Object,
  so the whole tree dies with it (verified: a hard-killed app leaves no server behind). `jsonrpc` (Content-Length framing),
  `session` (ids, waiting callers, timeouts + `$/cancelRequest`, answers the server's own requests such as
  `workspace/configuration` (an empty object for the `css`/`scss`/`less`/`html`/`json`/`http` sections — `null` crashed the CSS
  validator — `null` for the rest), notifications to a listener; tested over in-memory pipes), `protocol` (client capabilities,
  capability parsing, diagnostics, the fixed list of requests the UI may send — anything else is refused), `docs`
  (`DocumentSync`: didOpen once, then full-text didChange with rising versions, save, close), `uri`, `language`, and
  `LspManager` (one server per id, started lazily for a file inside the open workspace, gate per server, crash -> Error state
  + log, `stop_all` = `shutdown`/`exit` then tree kill). `commands::lsp` (`lsp_status/install/sync_document/save_document/
  close_document/request/stop/stop_all/set_verbose`) picks the server by extension, refuses files outside the workspace,
  pushes `lsp:diagnostics`/`lsp:log`/`lsp:changed` and writes `logs/lsp/<server>.log` (rotated at 2 MB). Ignored real-network
  tests (`crates/lsp/tests/real_server.rs`) install and drive the real TypeScript, Pyright and Intelephense servers.
  **Offline LSP bundle (Milestone 17)** — see `docs/lsp-bundle.md`. `registry::Package` gained `source` (`Npm` with the embedded
  lockfile, or `Native`: a program only the bundle carries) and `redistributable`; `ServerDef` gained `runtime` (`Node` | `Native`),
  `init_options` (JSON), `after_initialized` (notifications) and `env`. Servers now: the six above plus YAML (yaml-language-server),
  Bash (bash-language-server), Dockerfile (dockerfile-language-server-nodejs), **rust-analyzer** and **clangd** (native). `language_id`
  also matches whole names (`Dockerfile`, `Dockerfile.*`, `Containerfile`). `bundle` reads `<app>/lsp/bundle.json` (format
  `openmind-lsp-bundle` v1, platform `windows-x64`, a Node.js entry and one pack per package with SHA256/size/licence; paths must stay
  inside `lsp/`; a damaged/foreign file is reported and ignored; a pack is used only for the app's revision and never for a package
  that isn't `redistributable`; the bundled `node.exe` only with its recorded size; only on 64-bit Windows). `unpack` checks the
  pack's SHA256 before writing, extracts with safe names (no `..`/absolute/drive, links refused, 1 GiB / 60 000-entry caps) into
  `language-servers/<id>/.unpacking`, requires every server's entry, writes a `.openmind-bundle` marker (the pack SHA256) and renames it
  into `language-servers/<id>/<revision>/` — the same folder an npm install uses; `is_current` re-unpacks a folder from another pack
  (an npm-installed folder has no marker and counts as current). `pack::create_pack` + `examples/bundle_tool.rs` (`pack`/`extract`/
  `packages`) are the build side. `LspManager::prepare_bundled` (per-package gate, members show `installing`, never replaces a
  running server's files); `resolve_lsp_node` = bundled Node (`NodeSource::Bundled`, "OpenMind bundled Node.js", no npm) > portable >
  system. `StartContext.node` is optional (native servers need none). **Offline switches**: TypeScript `disableAutomaticTypingAcquisition`,
  JSON `handledSchemaProtocols: ["file"]`, YAML section `schemaStore.enable: false` + `yaml/registerContentRequest`, `vscode/content`
  refused with "remote schemas are not downloaded (OpenMind Studio's language servers work offline)", rust-analyzer
  `CARGO_NET_OFFLINE=true`, clangd `--background-index=false`. `commands::lsp`: `lsp_sync_document` unpacks from the bundle when
  needed (offline), `lsp_install` unpacks when the bundle carries the server and otherwise uses npm with a Node that has npm,
  `lsp_status` adds `runtime`, `bundled`, `installSource` and `bundle` (present/problem/nodeVersion/packs). **Intelephense is not in
  the bundle** — its licence forbids redistribution; it stays an npm install on request. `tests/bundled_servers.rs` (ignored,
  `OPENMIND_LSP_BUNDLE=<repo>/lsp-bundle`) unpacks and runs all ten bundled servers with a PATH of only System32.
- **Editor windows (File > New Window, Ctrl+Shift+N)** — `src-tauri/src/windows.rs`. One process, several editor
  windows: `main` plus `window-2`, `window-3`, ... (`window_new`; the capability lists `window-*`; `main.tsx` shows
  `App` for them). Each window has its own open folder: `windows::window_workspace(state, label)` gives `main` the
  saved one (`session_restore`) and an extra window the one kept in memory (`EditorWindows`); `workspace_*`,
  `session_*`, `search_run`, `watch_*` and every Git command take Tauri's `window` argument and use that window's
  folder, so two windows can hold two projects. An extra window's folder still joins the recent folders
  (`WorkspaceFolderService::remember_folder`) but is not restored; its session and the workbench keys
  `editor.layout`/`panel.state` (`commands::settings` `MAIN_WINDOW_ONLY_KEYS`) are neither read nor written, so it
  never overwrites the main window's. Watchers are per window and `fs:changed` goes only to that window; a terminal
  belongs to the window that opened it (output/exit via `emit_to`) and dies with it. **Closing a window closes only
  that window** (VS Code): its terminals and watcher end (`windows::release_window`); `main` is *hidden* rather than
  destroyed while another editor window is on screen, because it owns the saved session (the tray's Show brings it
  back). The last editor window on screen (`is_last_editor_window`) quits the app — or hides to the tray while a
  server runs (`window_events::close_last_editor_window`). **Tab drag-out**: a saved text tab dragged out of the tab
  bar and let go outside the window (`dragend` with `dropEffect` "none" beyond the viewport) opens in a new window at
  the drop point (`EditorWindowService.moveToNewWindow` -> `window_new(path, x, y)`, kept inside the monitor's work
  area by `keep_inside`; the new window takes its file with `window_take_pending_open`) and leaves this window; an
  untitled or unsaved tab stays with a notice. Command `workbench.moveEditorToNewWindow` does the same for the
  active tab.
  Not per window yet: Run Code / Output channels (`run:event`, `git:log` still reach every window), LSP
  (`commands/lsp.rs` still asks `active_workspace()`, i.e. the main window's folder), and extra windows are not
  restored on relaunch.
- `openmind-dap` (Milestone 8) — the Debug Adapter Protocol client, Tauri-agnostic (`DapEvents` sink supplied by the app).
  `wire` (Content-Length framing), `protocol`/`session` (seq/request_seq, waiting callers with timeouts, events, answers the
  adapter's reverse requests — `startDebugging` opens js-debug's child session, `runInTerminal` is refused), `target`
  (`LaunchConfig`, `default_configs`, `readiness`: the exact user messages — runtime missing / debugger not installed /
  PHP "requires Xdebug and is not available yet." — and `resolve_interpreter`: OpenMind portable runtime first, system
  Python/Node only as a labelled fallback), `adapter` (spawn plans), `manager` (`DapManager`: one session at a time,
  start/control/request/set_breakpoints/stop/snapshot, `RunState` Starting/Running/Stopped/Terminated). **Adapters are
  Runtime Manager manifests** (`debugpy`: the PyPI wheel, a zip; `js-debug`: the GitHub release tar.gz — new
  `ArchiveKind::TarGz`, every entry validated, links refused), pinned with SHA256, installed only when the user presses
  Install Debugger; `RuntimeManager::installed_dir(kind)` locates them. debugpy runs over stdio
  (`python -m debugpy.adapter`, `console: internalConsole`); js-debug is `node dapDebugServer.js 0 127.0.0.1` over TCP
  (127.0.0.1 only; the port is read from its first line), a launcher session plus a child session per debuggee. Adapter and
  debuggee live in a Job Object (`openmind_lsp::process::spawn`), so stop / app close leave no python/node/conhost. Nothing
  starts unless the user starts debugging. Breakpoints persist in the existing `breakpoints` table
  (`openmind_db::BreakpointsRepository::{list, replace_all}`). Ignored real-adapter tests: `crates/dap/tests/real_debug.rs`
  (`OPENMIND_DEBUGPY_DIR` / `OPENMIND_JSDEBUG_DIR`). `commands::debug` (`debug_status/start/control/request/
  set_breakpoints/stop`, `breakpoints_load/save`) pushes `debug:event`/`debug:state`/`debug:log`; `window_events` stops it on close.
- `src-tauri` (binary/package name `openmind-studio`) — the Tauri application: composition root
  (`AppState` in `app_state.rs`), Tauri commands under `commands/` namespaced by domain
  (`commands::document::*`, `commands::workspace::*`, `commands::filesystem::*`,
  `commands::settings::*`, `commands::theme::*`, `commands::git::*` (the repository is always the open workspace's,
  found server-side; the UI sends only repo-relative names; each Git command is pushed as a `git:log` event),
  `commands::terminal::*` — output/exit are pushed
  as `terminal:output` (base64 bytes: a chunk can split a UTF-8/escape sequence) and
  `terminal:exit` events), window/event wiring. Frontend-facing IPC surface
  lives here, not in the domain crates. `commands::settings` also holds two thin repository
  passthroughs (`EditorSettingsRepository` generic key-value, `PinnedFoldersRepository`) with no
  service-layer logic to justify a dedicated service — `AppState.db` exists for exactly this case.

Only depend on a workspace crate you actually call into — an unused `[dependencies]` entry is a
lint away from a compile warning and dead weight either way; two path deps were caught and removed
during the Milestone 1 → rebrand pass for exactly this reason.

- `openmind-ai` (Milestone 13) — the AI provider layer, Tauri-agnostic. **Providers are data** (`provider::ProviderConfig`: id, name, kind, endpoint,
  model, known models, enabled, `source` = the contributing extension, capabilities); one client speaks three wire formats chosen by
  `ProviderKind`: `claude` (Anthropic Messages API, `x-api-key`), `openai-compatible` (Chat Completions — OpenAI and any server that copies it,
  i.e. a *custom endpoint*) and `gemini` (`generateContent`/`streamGenerateContent`, key in `x-goog-api-key`, never in the URL), plus `local`
  = the OpenAI-compatible protocol restricted to a loopback address (Ollama, LM Studio, llama.cpp ...): **OpenMind runs no model itself**, it talks to
  one the user started. A provider can't claim more than `ProviderKind::implemented` (chat, streaming, code assistance; embeddings for OpenAI-
  compatible/Gemini/local; vision and tool calling are parsed but never claimed). `normalized()` checks a provider: id/name/model, endpoint
  `https` only (`http` only for `localhost`/`127.*`/`::1`), no user info in the address. `wire` = pure request builders and answer/stream parsers
  (unit-tested for the exact request shape of each kind, SSE lines, model lists, embeddings, error messages by status), `transport` = the only
  network code (ureq, worker thread + channel so cancelling returns at once, **redirects never followed** so an `Authorization` header can't leave
  for another host, 15 s connect / 120 s first byte / 600 s body limits), `client` = `chat` (streamed or whole), `list_models` (the connection
  test), `embed_text`/`list_embedding_models` (the embeddings *foundation*: callable, tested, used by nothing — no semantic index, no vector
  store, no automatic workspace embeddings), `registry::ProviderStore` (`data/ai/providers.json`, no secrets, atomic write, a damaged file is
  never overwritten), `store::ConversationStore` (`data/ai/conversations.sqlite`, created only when first used) and `error::redact` (removes a
  key and `key=` query values from any message). **Keys**: passed into one call, never stored, logged or put in an error (`tests/
  no_key_in_logs.rs` captures every log line of a real run; error messages are redacted). Cancelling stops the wait immediately; the worker
  thread ends when the server closes or at its time limit (a stalled server can keep one thread until then).
  `src-tauri/src/commands/ai.rs` (`ai_providers_list|provider_save|delete|set_enabled|set_key|clear_key|test`, `ai_chat_send` + `ai:chunk` events to
  the asking window, `ai_request_cancel`, `ai_conversation*`) owns storage of keys: **encrypted with Windows DPAPI** (`secret.rs`) in `editor_settings`
  as `ai.key.<provider id>`; the UI hands a key over once (`ai_provider_set_key`) and only ever learns `hasKey`. A provider from an extension is
  **refused by the backend too** while its extension is disabled or gone (`provider_offered`). Nothing runs at launch: the provider list is a local
  file read, the history file appears on first use, and the only requests are `ai_chat_send` (Send / an action) and `ai_provider_test`
  (Test connection). Window close cancels every request in flight.
- `openmind-language` (Milestone 14) — language and project support, Tauri-agnostic and **side-effect free**: it only *looks* (file names, small manifests,
  whether an executable exists) — it never runs a tool, installs anything, downloads, changes PATH or reads outside the folder it is given (links are never followed).
  **Not literal support for every language**: the registry lists ~55 languages and stacks with practical IDE support, and each says honestly what OpenMind can do
  with it (`levels`). `registry` (`LanguageDef`: id, name, group, extensions, whole file names with `*` patterns such as `Dockerfile.*`/`docker-compose.*.yml`/`.env.*`,
  comment marker, the Monaco grammar to use and whether it is `exact`, `approximate` (Vue/Svelte/Astro coloured as HTML, TOML/.env as INI, Gradle as Java) or `none` (Dart,
  Prisma, LaTeX, CMake, Makefile: shown plain), formatter/linter/language-server candidates, toolchain tools, and `levels`: syntax, lsp, format, lint, run, build, debug, test).
  Levels are conservative: `lsp` only where OpenMind starts a server (TypeScript/JavaScript/JSX/TSX, Python, PHP, HTML, CSS/SCSS/Less, JSON), `debug` only Python and
  JavaScript, `run` (Run Code on one file) only JavaScript, TypeScript, Python and PHP; a test asserts these sets. `tools` (~75 named tools: runtimes, package managers, SDKs,
  formatters, linters, language servers, `ANDROID_HOME`) and how they are found — **the project's own copy first (`node_modules/.bin`, `.venv`, `vendor/bin`), then OpenMind's
  portable runtimes, then the machine's PATH**, reporting which one (a bare file without `.exe/.cmd/.bat` isn't runnable on Windows); nothing is executed to ask a version.
  `project` + `detect/{web,backend,native}` detect what a folder is from marker files/manifests (bounded: the folder plus two levels, 400 folders, never `node_modules`, `.git`,
  `target`, `dist`, `build`, `vendor`, virtual environments or hidden folders): Node.js with package manager (`packageManager` field, lock file), React, Next.js, Vite, Vue,
  Svelte, Astro, Tailwind, Express, NestJS, Electron, Neutralino, Tauri, React Native, Expo, Ionic, Capacitor, Flutter (+ Flutter desktop), Dart, Android (Gradle), iOS (Podfile/Xcode),
  Swift package, Python (Django/FastAPI/Flask), PHP/Laravel, Ruby/Rails, Maven/Gradle/Spring/JavaFX, .NET (WPF, WinForms, ASP.NET Core), Go, Rust, CMake/Make, Docker/Compose,
  Prisma, Jupyter (detected only). Every detection has a confidence (`high` = a definitive file, `medium` = a dependency or hint, `low`) and its evidence; a project's platform
  folders (`android/`, `ios/`, `src-tauri/`) belong to the parent instead of becoming second projects; two Python web frameworks with no `manage.py` are all listed and the project is
  `ambiguous` (nothing is guessed). `commands` generates run/dev/build/test/lint/format/install commands **from what is in the folder** (a `package.json` script — only
  known names with safe characters —, `cargo`, `go`, `mvn`/`gradle` with the wrapper when there is one, `dotnet`, `flutter`/`dart`, `artisan`, `manage.py`, uvicorn only when
  `app = FastAPI(` is really in the file, `cmake`, `docker compose`, ...); a command is an argument list, flagged `network` when it downloads, and has `tools` it needs. A command with
  no support is not offered; one whose tool or platform is missing is offered disabled with the reason (`iOS builds require macOS and Xcode.`, `A Windows build needs Windows.`,
  `Cargo not found. Install Rust (rustup) — OpenMind doesn't install it.`). `format` finds formatters/linters (Prettier, Biome, ESLint, Stylelint, Black, Ruff, isort, PHP CS Fixer,
  Pint, rustfmt, clippy, gofmt, golangci-lint, clang-format, dotnet format, ktlint, dart) and builds their exact argument list (project's own first); `lsp` lists language server
  candidates per language and says which are OpenMind's own (with their live state supplied by the app) and which are only *found* — **OpenMind cannot start
  gopls, JDT LS, OmniSharp, Vue/Svelte/Astro/Tailwind/SQL/GraphQL servers yet, and says so** (detection only, no fake diagnostics; since Milestone 17 YAML, Bash,
  Dockerfile, rust-analyzer and clangd are OpenMind's own and those languages have the `lsp` level). `service` assembles
  `WorkspaceStatus` (projects with tool status, per-command availability and a one-sentence summary such as "Detected Tauri + React. Found: Node.js, pnpm, Cargo. Dev: pnpm tauri dev.")
  and `FileStatus`; `shell::typed_line` renders an argument list for PowerShell/cmd/Git Bash (plain words stay plain, anything else is quoted, a line that can't be quoted safely
  is refused). `src-tauri/src/commands/language.rs`: `language_registry`, `language_workspace_status` (the asking window's folder, portable runtimes from the Runtime Manager first),
  `language_file_status` (path guarded with `ensure_within_root`), `language_terminal_line`.
  **Built-in policy (no extra download)**: *OpenMind Studio ships language/project support metadata in the app bundle. It does not download language support at runtime.* The
  registry, detection rules, command templates, formatter/linter recipes and language-server candidate list are Rust data compiled into the app; the crate has no network or process
  dependency (`tests/policy.rs` scans its source and manifest, and checks that large SDKs — Flutter, JDK, .NET, Go, Rust, Docker, Ruby, C/C++, Xcode, the Android SDK — are reported
  missing with a setup hint, never bundled or faked, and that Node/Python/PHP are the Runtime Manager's portable tools). Nothing is bundled beyond this metadata (no third-party asset, no size
  to license). The status dialog says so: "Language support metadata is built in. Missing tools must be installed/configured separately."

- `openmind-toolchains` (Milestone 15) — **bundled toolchain packs**: app-local tools in `<app>/tools`, listed in `tools/toolchains.json` (docs: `docs/toolchains.md`). The crate only
  *reads*: no network, no installs, no PATH/Registry writes (`tests/policy.rs` scans its source and manifest), and the only process it can start is the program the user asked to **Verify**
  (`verify.rs`, only with the manifest's `verifyArgs`, 8 s limit; without them the file is only checked to exist). `catalog` = the ~40 tools OpenMind knows as static data (id, name, category, one-sentence
  summary, long details, used-by, the command name, hint; the big SDKs — Flutter, Android SDK, Xcode, JDK, .NET, C/C++ toolchain, Rust toolchain, Go, Docker — are `external`: never bundled). `manifest` parses
  it (a damaged file is reported and ignored; a path must be relative with no `..`/drive/UNC). `packs::load(app_root, platform, chosen)` builds per tool the versions (platform-filtered, newest first, **at most
  5 kept** — `maxBundledVersions` can only lower it, extra oldest ones are ignored with a warning), each `Active | Bundled | Broken` (Broken = listed but the program is missing) and the tool `Active | Missing |
  Broken | External`. **Active version** = the user's choice (`editor_settings` `toolchains.active`, only if that version is present) > the manifest's `activeVersion` > the newest *stable* present version; a
  missing program is never Active. `injection()` = the folders of active programs (debuggers excluded: their files are not commands) for the PATH of processes OpenMind starts. `commands::toolchains`
  (`toolchains_list|set_active|verify`) plus `run::environment` (put the bundled folders **in front of** the Runtime Manager's — used by terminals, Git, runs, LSP, extensions), `language::tool_env`
  (`ToolEnv.bundled_dirs`, so lookup order is **project-local > bundled > portable runtime > system**, `Source::Bundled`), `debug` (the active bundled debugpy — path
  `<v>/debugpy/adapter/__main__.py` — is the adapter folder before the Runtime Manager's) and `composer_run` (an active bundled `composer.phar` before the Runtime Manager's Composer). Git needs no change:
  its resolver takes the first folder that has `git.exe`. **What is physically bundled in this build: nothing** — the system, manifest, detection, selection, Verify, UI and packaging check are built and tested
  against fixture folders; every tool shows Missing (or External) until real files are added. Do not claim "last five versions" shipped until they are.
  Since Milestone 17 the servers of the offline LSP bundle (Pyright, typescript-language-server, vscode-langservers-extracted, rust-analyzer, clangd, YAML, Dockerfile)
  are no longer tool-pack entries in `catalog` (they live in `lsp/` and Language Tools; listing them here showed them "Missing"; a test keeps them out).

- `openmind-format` (Milestone 15.2) — the formatting backend, Tauri-agnostic. It formats **text** (the editor's in-memory buffer, never a file on disk). `json` = the **built-in JSON / JSONC
  formatter** (own lexer + checker + printer: comments and trailing commas are accepted and kept, structure is validated with a line/column, strings and numbers are copied verbatim, key order is kept, every member
  and element on its own line, `{}`/`[]` stay, a final newline only if there was one, tab/space indent and LF/CRLF from the document, depth limit 256, stable when run twice; an invalid document is refused and
  changes nothing). `run::run_stdin` pipes the text through an external formatter's stdin/stdout (argument list, no shell, `CREATE_NO_WINDOW`, a time limit, on Windows a Job Object so a timeout kills the
  whole tree — `prettier.cmd` starts a `node` —, output capped, invalid UTF-8 / empty output for non-empty input / a non-zero exit are errors and the caller keeps its text; the runtime folders go in front of PATH
  **for that child only**). `project::nearest_project_root` gives the working folder (nearest ancestor with `package.json`, `pyproject.toml`, `Cargo.toml`, `go.mod`, `composer.json`, `.prettierrc`, `.editorconfig`,
  `.git` ..., never above the open folder). `resolve` builds the candidates from `openmind_language::format::options` (which gained `stdin_argv`: prettier `--stdin-filepath`, biome `format --stdin-file-path`, black
  `-q --stdin-filename - `, ruff `format --stdin-filename -`, rustfmt `--edition 2021 --emit stdout`, gofmt, clang-format `--assume-filename`) plus the built-in JSON formatter, with a `Policy` (project / bundled /
  system tools allowed; a source that is off is not searched, so the next one can supply the tool, and the reason says so) and **the order: the user's default, project-local, bundled, built-in, OpenMind's portable
  runtime, the system PATH (only when allowed), otherwise a reason** (`No formatter available for TypeScript. Prettier not found. ...` / `No formatter configured for Plain Text.`). A default that is not one of the
  file's candidates is ignored; one that is but can't be used is an error, never silently replaced. Tools that only rewrite files on disk (**Pint, PHP CS Fixer, dotnet format, ktlint, `dart format`**) are listed
  as unavailable for Format Document with the reason and stay reachable through "Format Saved File With Tool (Terminal)"; isort is not a document formatter and is not offered. `tests/policy.rs` scans the source: no
  environment writes, no registry, no files written, no network, no shell. `src-tauri/src/commands/format.rs`: `format_options` (candidates + the selected one + why none) and `format_run` (limit 2 MB, absolute
  path without NUL, timeout 1-120 s, on `spawn_blocking`). **Settings** (all in the Editor category): `editor.formatOnSave` (user, default **on** since the menu-restore pass), `editor.defaultFormatter` (user + workspace), `formatter.timeoutMs`
  (default 10 000), `formatter.useProjectLocalTools` (default on), `formatter.useBundledTools` (default on), `formatter.useSystemTools` (default **off**) — every setting that can start a program is **user-only**, so a
  folder's own `.openmind/settings.json` can't switch on running its tools.

- `openmind-extensions` (Milestone 10) — the VS Code-compatible extension system foundation. **OpenMind Studio supports a VS Code
  API subset**; nothing here is VS Code's source. Layout (portable, never AppData): `extensions/installed/<publisher>.<name>-<version>/`,
  `extensions/disabled/…` (enabling/disabling *moves the folder*, so the state persists by location and there is no registry file that
  could disagree with the disk), `extensions/cache/{staging,host}`, `extensions/storage/<id>/{global,workspace/<key>}`,
  `extensions/logs/extension-host.log` (rotated at 2 MB). `vsix` inspects and extracts a `.vsix` (zip): every entry name goes through
  `safe_relative` (no `..`, absolute, drive/stream `:`, NUL, backslash tricks), symlinks/oversize/too many entries are refused *before* anything is
  written, extraction goes to `cache/staging` and is renamed into `installed/`; `pack` (used by tests and `examples/pack.rs`) builds a `.vsix`.
  `manifest` parses/validates `package.json` (name, publisher — `local` when absent —, version, `engines.vscode`, main/browser, activationEvents,
  extensionDependencies/Pack, contributes) with the field named in every error; `contributions` types the initial subset (commands, menus,
  keybindings, configuration, configurationDefaults, languages, grammars, snippets, themes, iconThemes, debuggers/problemMatchers as metadata)
  and `report()` classifies every point as `supported`, `metadata` or `unsupported` ("This contribution point is not supported yet."), unknown
  points are counted, never dropped. Supported menu locations: `commandPalette`, `editor/context`, `explorer/context` (others are listed
  as unsupported); keybindings are normalized to the app's chords (key *sequences* are not supported). `store::ExtensionStore` installs (refuses an
  existing id unless `replace`, a replaced disabled extension stays disabled), lists (broken folders are reported, not hidden), enables/disables,
  uninstalls (canonical-path check; storage is kept, like VS Code) and reads files inside an extension only. `activation` maps a `Trigger`
  (startup, command, language, view, workspace) to the enabled extensions with code whose events match (`onCommand` and `onLanguage` are also
  implied by `contributes.commands/languages`; `*` is allowed but warned about; `onView` is recorded but never triggers — no extension views;
  `workspaceContains` uses a bounded glob walk that skips node_modules/.git/build folders). `settings::extras_for` turns enabled extensions'
  configuration and themes into `openmind_settings::Extras`.
  **The host** (`host.rs`, `host/host.js`, `host/vscode.js`, embedded with `include_str!` and written to `cache/host/`): a separate Node.js process,
  never in the WebView and never in this process, on OpenMind's portable Node first (`resolve_host_node`; a system Node only when the user set
  `extensions.allowSystemNode`, labelled "System Node.js at …"; none: "Node.js runtime is required for extension host."), spawned through
  `openmind_lsp::process` so the Windows Job Object kills the whole tree when the app closes or crashes. JSON-RPC 2.0 with the LSP framing
  (`openmind_lsp::jsonrpc`); requests app→host (`host/init|register|activate|deactivate|executeCommand|provide|shutdown`) have timeouts, host→app
  requests (`ui/showMessage|showQuickPick|showInputBox|openExternal`, `workspace/openTextDocument|getLanguages|updateConfiguration`,
  `commands/execute|getCommands`) are forwarded to the window and answered with `respond`. The host's `console.*`/stdout are captured (a
  stray `console.log` can't corrupt the protocol), an uncaught error is logged and attributed, an extension that throws in `activate` is
  cleaned up, reported and can be retried — the host and the other extensions keep running. `activate(context)` runs once per host session
  (`context`: subscriptions, extensionPath/Uri, globalStorageUri, storageUri, logUri, globalState/workspaceState as JSON mementos),
  `deactivate` on disable/uninstall/shutdown. The `vscode` shim (a Proxy: anything not implemented throws "VS Code API '<name>' is not supported
  by OpenMind Studio yet.") offers commands (registerCommand, executeCommand, getCommands), window (show*Message with buttons, createOutputChannel,
  showQuickPick, showInputBox, activeTextEditor, visibleTextEditors, onDidChangeActiveTextEditor), workspace (workspaceFolders, getConfiguration
  with get/has/inspect/update, onDidChangeConfiguration, openTextDocument, textDocuments, onDidOpen/Close/Change/SaveTextDocument, asRelativePath,
  getWorkspaceFolder), languages (registerCompletionItemProvider, registerHoverProvider, registerDefinitionProvider, createDiagnosticCollection),
  extensions, env, plus Disposable, EventEmitter, Uri, Position, Range, Selection, Location, Diagnostic, MarkdownString, Hover, CompletionItem(Kind/List),
  SnippetString, CancellationTokenSource, ConfigurationTarget, ViewColumn. Not supported (see Milestone 10.3 for what was added later: TextEditor.edit, WorkspaceEdit, status bar items): decorations, webviews, status bar
  items, debug/tasks/terminal/SCM APIs, authentication, notebooks, proposed APIs. **Permissions/sandbox — honest limits**: the host is an ordinary
  Node process with the user's rights; extension code *can* use `fs`, `child_process` and the network. What is enforced is isolation (a separate
  process, a fixed request list through the bridge, no privileged app API exposed, a crash or hang can't take the app down, the host is killed with
  the app, nothing is auto-installed or auto-run: a `.vsix` is installed only after the user accepts "Extensions can run code on your computer. Install only
  from trusted sources." and code runs lazily on an activation event). A permission model for filesystem/terminal/network is *not* built. A
  synchronous infinite loop in one extension blocks the host (calls time out and "Reload Extension Host" restarts it); Node has no per-extension
  isolation. Tests: unit tests plus integration tests against a real Node with the five sample extensions in `tests/fixtures` (command,
  configuration, language, theme, bad-activate — skipped when the machine has no Node).
  **Hardening (Milestone 10.1).** `permissions` — 11 categories (`workspaceRead`, `workspaceWrite`, `commands`, `settings`, `languages`,
  `themes`, `snippets`, `network`, `processExecution`, `terminal`, `filesystemOutsideWorkspace`). A manifest may *request* them with the OpenMind
  field `"openmindPermissions": [...]` (an unknown name is refused, listing the valid ones); the contributions *imply* the harmless ones (commands,
  settings, languages, themes, snippets). The install dialog shows both (dangerous ones marked "High risk"), installing accepts them, and the accepted
  list is stored in `.openmind-permissions.json` inside the extension folder (so it moves with enable/disable and dies with uninstall; a file can't grant
  more than the manifest asks for, except the one the user can add by hand, filesystemOutsideWorkspace; an extension installed before this milestone only gets the implied ones). The host descriptor carries the accepted
  list and `host/guard.js` enforces it — **a guard, not a sandbox** (the host is an ordinary Node process; native addons, `process.binding` or a
  hand-made loader can get around it, and a symlink inside the workspace can point outside it). Exactly: `require('child_process'|'cluster')` needs
  `processExecution`; `require('net'|'http'|'https'|'http2'|'tls'|'dgram'|'dns')`, the globals `fetch`/`WebSocket` (attributed with `AsyncLocalStorage`, so it
  works across `await`) and `vscode.env.openExternal` need `network`; `require('fs')`/`fs/promises` are wrapped: paths in the extension's own storage/log
  folders are free, a path in an open workspace folder needs `workspaceRead` (reading) or `workspaceWrite` (changing), its own install folder is read-only,
  anything else needs `filesystemOutsideWorkspace`; `vscode.window.createTerminal` needs `terminal` (and is then still "not supported yet");
  `commands.*` need `commands`, `getConfiguration`/`onDidChangeConfiguration` need `settings`, language providers/diagnostics need `languages`,
  `workspace.openTextDocument`/`textDocuments`/document events need `workspaceRead` (`filesystemOutsideWorkspace` for a path outside the folder). Not gated:
  what the app itself hands a language provider (the document being edited), `Uri` helpers, messages/quick picks/output channels. A denied call throws
  "Permission '<permission>' is required for this extension API." `process.exit()` throws for extensions. Install limits (`vsix::Limits`, checked before
  anything is written): package file 256 MB, extracted size 512 MB, 20 000 files, `package.json` 1 MB; entry names go through `safe_relative`;
  the manifest must have name/version, ids/publishers can't contain path characters, every command needs an id and a title (unique in the manifest),
  every setting's default must validate, and every theme/snippets file and the entry point must exist in the package. Two extensions contributing one
  command id: the first keeps it and the second gets a warning in its details; an extension can never re-register another extension's command (the shim
  says who owns it). Host resilience: the API shim tracks every listener, provider, command, diagnostic collection and output channel an extension
  creates and disposes them all on deactivate or a failed activation (a disposed output channel goes silent); a throwing command is logged against its
  extension and the error returned; unsupported-API calls are logged against the extension too. Host states: `stopped`, `starting`, `running`,
  `crashed`, `restarting`, `unavailable`; a crash is announced (toast + Extensions log) and the host is restarted at most twice in a row
  (`MAX_AUTO_RESTARTS`, attempts start again after 5 stable minutes, "Reload Extension Host" always works and resets them). Per extension the backend
  keeps activation count, last activation time and last error. Output channels: **Extensions** (install/enable/disable/uninstall, activation results,
  host start/crash/restart, failed commands), **Extension Host** (what extensions print, unsupported-API and permission errors, `[extension.id]`
  prefixed) and one channel per `createOutputChannel` name. Disabling/uninstalling the extension of the active colour theme resets the setting to the
  default theme. Extensions with `"*"`/`onStartupFinished` run only after startup finished (`finishStartup` at the end of the startup sequence, after the
  window is up and the session restored); the host is never started before an extension needs it.

- `openmind-preview` (Milestone 11) — the backend of the **read-only file previews**, Tauri-agnostic and in-process only: no external program, no network,
  nothing written, no macro or script ever run. `kind::detect` maps an extension to `PreviewKind` (image: png/jpg/jpeg/webp/gif/bmp/svg, pdf, docx, xlsx, csv, markdown,
  html, latex, else `unsupported`) and holds the size limits (image 15 MB, PDF 30 MB, DOCX/XLSX 25 MB, Markdown/HTML/LaTeX 5 MB, a CSV is read only up to its first 8 MB, "Open as
  Text" and other files 10 MB). `path::validate` runs on every command: absolute, no `..`, no NUL, no network (UNC `\\server`, `//server`) path, an existing regular file, canonicalized.
  `inspect` gives kind, size, `binary` (a NUL in the first 8000 bytes; images/PDF/Office are binary by nature), `too_large` and `text_safe` (safe for "Open as Text");
  `read_bytes` (image/PDF, limit enforced), `read_text` (text formats, decoded by `openmind_fs`, refused when binary or over the limit, a big CSV cut at whole lines with
  `truncated`). `zipsafe` reads Office packages (ZIP) **in memory only** — only the few known parts are read, each capped at 40 MB *while reading* (a zip bomb can't inflate past it),
  at most 20 000 entries, never extracted to disk (so nothing app-relative to clean up), XML parsed with `roxmltree` with DTDs refused (no entity tricks) and a node cap.
  `docx` returns paragraphs, headings (`Heading1-6`, Title/Subtitle), list items, tables (flattened text), core metadata, the number of embedded pictures (not shown) and
  `has_macros` (a `vbaProject.bin` part exists: reported, never run); tracked deletions (`w:delText`) aren't shown; capped at 20 000 blocks / 2 M characters. `xlsx` returns the
  sheet list and one sheet's values (first 1 000 rows × 100 columns, the real totals reported): shared strings, inline strings, booleans, cached values, and a formula
  *without* a cached value shown as its `=text` — **no formula engine**, dates stay serial numbers, charts/pivots/macros ignored. Commands in `src-tauri/src/commands/preview.rs`
  (`preview_inspect/read_bytes/read_text/docx/xlsx`, all on `spawn_blocking`).

### Planned future crates (create only when the milestone that implements them lands — do not
pre-scaffold empty crates)

`openmind-plugin-host` (the OpenMind AI provider itself, embeddings/RAG and an agent mode are also future work; the AI provider
layer is `openmind-ai`, landed in Milestone 13).

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
- `PhpServerService` (`phpServerService.ts`, Milestone 5.7) + `PhpServerView` — web root and port
  (persisted as `php.server` = `{webRoot, port}` in `editor_settings`; `webRoot` is `null` for the default
  `htdocs`, which is never saved so it follows a moved app folder; the pre-web-root `root` project folder
  key is deliberately ignored; "Change Folder…" / "Use Default (htdocs)", no "Use Open Folder") and the built-in server's lifecycle (`start`/`stop`/
  `restart`/`openBrowser`/`openLogs`). Every button's enabled state and reason comes from `startState()`/
  `stopState()`/... (pure `startAvailability`), and `php.*` commands use the same predicates. Output goes
  to the "PHP Server" channel; a running server registers 127.0.0.1:<port> in `PortsService` (source
  `php-server`) and unregisters on exit. Nothing starts on launch or on opening a project.
  **Separate window (5.7.1)**: the PHP Server is *not* a side bar view. The activity bar's PHP Server icon
  (`php.openWindow`, also `view.showPhpServer`) calls `php_window_open`, which opens (or focuses) a second
  native window labelled `php-server` (`capabilities/default.json` lists it) loading the same page;
  `main.tsx` picks `PhpServerWindow` instead of `App` by the window label. Each window has its **own**
  frontend container, so the backend is the single truth: `AppState.php_server_info` (URL, port, PHP version)
  is read via `php_server_status`, `php:changed` (server started/ended) makes every window's
  `PhpServerService.syncServer()` re-read it (the main window then registers the port in its Ports panel),
  `php:event` output reaches both windows' Output, and `runtime:changed` (after any runtime
  install/repair/switch/delete) makes every `RuntimeService` reload — so installing PHP in the PHP window
  enables Run Code for `.php` in the main window. "Use Open Folder" asks the backend
  (`workspaceActiveFolder`) for the main window's folder.
- `PhpRuntimeService` (`phpRuntimeService.ts`) + `PhpRuntimeCards` (5.7.1) — the PHP and Composer version
  manager inside the PHP Server window: the PHP card lists installed versions (active first) and the
  available 8.0-8.4 lines (8.4 "recommended"), each row with Install / Set Active / Repair / Delete and its
  reason; Composer shows its dependency on the active PHP (a notice when none is active) and can't be
  installed before PHP; an update is only offered inside the same line (PHP 8.3.x -> 8.3.y, never 8.4).
  A running server pins the PHP version it started with (`PhpServerService.versionInUse`, and the Rust
  commands `runtime_delete`/`runtime_repair` refuse it too via `php_in_use_reason`), and after switching the
  active PHP `restartNotice()` says "Restart the PHP server to use the new PHP version." (shown in both the
  server section and the PHP card). Python, Node.js and Git are managed only in the Runtime Manager dialog;
  the Extensions side bar view is still the empty state (a Runtime Extensions sidebar was built and then
  removed at the user's request).
- **Source Control (Milestone 6).** `GitService` (`gitService.ts`) = the IPC facade + the "Git" output channel (label,
  cwd, output, exit code per command). `SourceControlService` = the view's brain: the backend snapshot (`noWorkspace` /
  `gitMissing` / `notRepository` / `repository`), Staged / Changes / Untracked groups (a file can be in Staged and
  Changes), pure `commitAvailability` (message, staged, identity, conflicts — each with its reason), every action
  wrapped in `act()` (busy, notice, error, then a fresh status and a reloaded-or-closed diff), destructive actions
  behind `pending` + `confirm()`, refresh on workspace change, document save, window focus and (while Git is missing)
  runtime changes. `SourceControlView` + `GitFileList` / `GitCommitBox` / `GitBranchIndicator` (also in the status
  bar: branch, `*` when dirty, `↑↓`) are UI only. The diff (`GitDiffViewer` + `editor/MonacoDiffHost`) is an overlay
  over the editor area, not a tab. "Install Git Runtime" opens the Runtime Manager.
- **Git follow-ups (Milestone 6.1).** `GitCloneService` (address, destination folder from the folder dialog, folder
  name derived from the address; pure `cloneAvailability`; the snapshot carries which Git is usable, so Clone is
  disabled with "Git runtime is not installed yet." without a repository; never opens the clone by itself — "Open
  Cloned Folder" is a click), `GitHistoryService` (latest 100 commits, select one for its files, a file opens that
  commit's diff through `SourceControlService.openCommitDiff`), `GitStashService` (stash with message and
  "Include untracked files", apply/pop/drop; drop only after the dialog; conflicts shown verbatim), `GitBlameService`
  (blame of the active file over the editor area, pure `blameAvailability`: no repo / no file / outside / untracked).
  UI: `GitCloneForm`, `GitHistoryPanel`, `GitStashPanel`, `GitBlameViewer`; `git.clone` and `git.blame` are
  registered commands (`gitCommands.ts`) for the future palette. The Runtime Manager installing Git refreshes the view.
- **External file sync (Milestone 6.2).** `DocumentService` tracks `external: none | changed | deleted` per document and
  `checkDisk` (`same|reloaded|conflict|deleted|unavailable`): a clean buffer is reloaded through
  `BufferManager.replaceContent` (minimal prefix/suffix edit, so cursor/scroll stay and it is undoable, pure helpers in
  `textSync.ts`); a dirty one is **never** overwritten — it becomes `changed` and `ExternalChangeBanner` offers Compare
  (`ExternalCompareViewer`, disk left / edits right), Reload from Disk (confirm first), Keep My Changes (the disk text
  becomes the saved baseline, the buffer stays dirty) and Save As; a vanished file becomes `deleted` (text kept, Save/
  Save As/Close). Nothing here ever saves. `FileSyncService` consumes `fs:changed` batches (retargets a tab on a rename
  when the target isn't already open, refreshes only the affected loaded Explorer folders, tells Source Control), and
  re-checks all open files on window focus and via `afterGitOperation()`, which `SourceControlService` calls after switch
  branch / discard / discard all / delete untracked / pull and `GitStashService` after apply/pop (one notice, not one per
  file). `SourceControlService.refreshOpenDiff` closes a working-tree/staged diff that went stale with a notice. `appNotice`
  events render as info toasts (`ErrorToast` kind `info`).
- **Language servers (Milestone 7).** `LspService` keeps every open file-backed document told to its server (didOpen on open,
  edits debounced 250 ms and flushed before a request, save, close, a file deleted on disk is closed there and reopened when it
  is back, Save As/rename re-targets), remembers each file's last sync outcome (why it has no features), installs/restarts/
  stops servers on request, logs to the **LSP** Output channel and answers `available(action, doc)`; pure `lspAvailability`
  gives every disabled action its reason ("Language server is not installed yet.", "Node.js runtime is not installed yet.",
  "This file is outside the open folder.", "<Server> doesn't support Format Document.", ...). `DiagnosticsService` turns
  `lsp:diagnostics` into Monaco markers (owner `lsp:<server>`; the Problems panel already reads markers, so problems appear,
  update, clear when a file closes — markers outlive models in Monaco, so they are removed explicitly — or its server stops).
  `lspProviders.ts` registers hover, completion (+resolve), signature help, definition/declaration/type definition/
  implementation, references, rename (prepare + edits over open documents; a file that isn't open is opened as a tab and
  edited unsaved), formatting, range formatting and document symbols for every language a server handles, plus an editor
  opener so cross-file navigation goes through the tabs; files that aren't open appear in Peek as read-only copies
  (`PeekModels`, max 40). `lspConvert.ts` holds the pure LSP<->Monaco conversions. `lspCommands.ts` gates `go.toDefinition`,
  `go.toDeclaration`, `go.toTypeDefinition`, `go.toImplementations`, `go.toReferences`/`lsp.findReferences`, `edit.renameSymbol`
  (F2), `edit.formatDocument` (Shift+Alt+F) on the server's capabilities (`CommandOptions.disabledReason` shows in menus),
  plus `lsp.restart`, `lsp.manage` (Language Tools dialog: install/restart/stop/logs/verbose), `lsp.openOutput`; the status
  bar shows the active file's server or the reason. `monacoBuiltins.ts`: Monaco's own TypeScript/JavaScript, JSON, CSS and HTML services are switched off for good at
  start-up, before any model exists (their worker isn't available here — hovers hung on "Loading…"; switching them off
  only while a server runs was tried and did not work: TypeScript reads its settings once, CSS kept a stuck hover).
  `documentOpened`/`documentClosed` events feed the sync.
- **Debugger (Milestone 8).** `BreakpointService` (per-file breakpoints matched across slash/drive-letter styles, saved
  debounced to SQLite, stale ones — file gone — kept, marked and never sent to the adapter, changes reach a running session
  per file), `DebugService` (status snapshot, pure `startAvailability`/`controlAvailability` so every disabled control has its
  reason, start/continue/pause/step/restart/stop, "Debug" output channel), `CallStackService`, `VariablesService` (lazy
  scopes/children), `WatchService`, `DebugConsoleService` (adapter + program output, evaluate only while paused, clear),
  `DebugConfigurationService` (`defaultConfigs`; no launch.json yet), `debugCommands.ts` (F5 Start/Continue, Shift+F5, F9,
  F10/F11/Shift+F11, Ctrl+Shift+F5 restart; **Ctrl+F5 stays Run Code**), `debugEditorBinding.ts` (glyph-margin toggling,
  breakpoint/paused-line decorations, breakpoints follow their line). UI: `RunDebugView` (start controls with the exact
  reason messages and Install Debugger, Variables/Watch/Call Stack/Breakpoints via `DebugPanes`), `DebugToolbar`,
  `DebugConsoleView` (Debug Console tab), `DebugStatusItem`. Testing note: a synthesised F10 (`keybd_event`) during a manual
  run highlighted the File menu and the session had ended in the resulting screenshot; Step Over was verified with its toolbar
  button instead, and F10 itself was not confirmed by hand.
- **Settings, shortcuts and themes (Milestone 9).** `commands::preferences` (`preferences_load/set/reset/file/validate/scope_of`,
  `keybindings_load/save/file`; the folder is always the asking window's, found server-side) returns one `PreferencesSnapshot`
  (definitions, effective values with their source, which ids each file sets, file errors and issues). `SettingsService`
  (`settingsService.ts`) is the only reader: `bool/number/string(id, fallback)`, `set/reset/setEffective`, `search`, `onChange(ids)` and
  `handleSaved` (saving `settings.json`, the workspace file or `keybindings.json` in an ordinary editor tab re-reads it, validates it
  and toasts what is wrong — `preferenceFiles.ts`). Consumers follow settings, they never read files: `EditorService` (font, tab size,
  line numbers, cursor, word wrap/minimap/sticky/whitespace — the View-menu toggles now write the setting; old toggles migrate once),
  `XtermHost` (terminal font/cursor/scrollback), `SearchService.applyDefaults`, `RunCodePrefs`, `LspService.applyEnabled`/`verbose`,
  `DebugService` (`stopOnEntry`, console on start), `PhpServerService.applyDefaultPort`, `WelcomeService`, git auto refresh/status-bar
  branch, and Rust reads `php.tray.hideOnClose` for the tray. All of it is wired in `preferencesWiring.ts`, keeping `container.ts` small.
  `KeybindingsManager` applies `effectiveBindings(defaults, userEntries)` (pure model in `keybindingsModel.ts`: user bindings first,
  `-command` removals, `conflictsFor`, contextual pairs such as F11 Full Screen/Step Into that share a key on purpose) to
  `KeybindingService.setBindings`, so the listener, the menus' labels and the tooltips (`shortcutLabel.ts`) follow at once. A
  built-in Monaco shortcut can be freed only for the language features (Go to Definition/References, Rename, Format): the old
  key is switched off with `addKeybindingRules([{ command: '-<action>' }])` (`editor/monacoKeys.ts`); every other editor-owned
  shortcut is listed but its Change button is disabled with the reason, and a key that one of them uses is refused. The page is
  `PreferencesPage` (an overlay over the editor area, `PreferencesPageService`): Settings tab (search, User/Workspace scope,
  categories, boolean/number/text/dropdown controls, Modified + Reset, validation message under the control, the file's problems)
  and Keyboard Shortcuts tab (search, Change with key recording, Replace on conflict, Remove, Reset). Commands: `preferences.openSettings`
  (Ctrl+,), `openWorkspaceSettings`, `openSettingsJson`, `openWorkspaceSettingsJson`, `openKeybindings`, `openKeybindingsJson`,
  `colorTheme`, `theme.setSystem/Dark/Light/HighContrast`. `ThemeService` resolves `workbench.colorTheme` (system/dark/light/
  high-contrast; `system` follows `prefers-color-scheme` live) to `data-theme` on `<html>` and the Monaco theme (`openmind-dark`/
  `-light`/`-hc`); every window builds its own, so the PHP window follows too, and terminals read `--terminal-*` tokens. **All colors
  are tokens** in `styles/theme.css` (dark, light and a high-contrast palette, plus semantic tokens: success/warning/info/error,
  overlays, debugger, terminal, disabled/invalid); `styles/themeTokens.test.ts` fails on a hard-coded color in any other stylesheet
  and on a token nobody defines. The old `theme` table is only read once, as the default of the new setting.
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

- **Extensions (Milestone 10).** `commands::extensions`/`extension_manage`/`extension_host` (`ext_list`, `ext_inspect_vsix`, `ext_install`,
  `ext_set_enabled`, `ext_uninstall`, `ext_read_file`, `ext_host_log`, `ext_host_start|stop`, the allow-listed `ext_host_request|notify`, `ext_host_respond`,
  `ext_activate_for`; events `ext:changed`, `ext:host-state`, `ext:host-request`, `ext:host-notification` go to the main window only) with
  `ExtensionsRuntime` in `AppState` (store, host handle, per-extension activity/last error, a generation counter so a late exit report of an old
  host is ignored); the host stops in `window_events::shutdown`; the backend refuses to activate a disabled extension. Frontend services (all
  UI-free, wired in `extensionsWiring.ts`): `ExtensionRegistryService` (the installed list + search-installed, follows `ext:changed`),
  `ExtensionService` (choose a `.vsix` → read it → **trust dialog** → install; enable/disable; uninstall behind a confirm; details, logs, reload host,
  "Use System Node.js"; every button has an `*Availability` reason), `ExtensionHostService` (starts the host lazily — never at launch —, `activateFor`,
  `executeCommand`, answers the host through `HostBridge`, keeps it told about settings/folders/open files via `HostDocumentSync`),
  `HostBridge` (the API bridge: a fixed list of what the host may ask; output channels named by the extension, host lines in "Extension Host";
  language providers registered in Monaco via `editor/extensionMonaco.ts`; diagnostics become markers owned `ext:<collection>`),
  `ExtensionPromptService` (messages with buttons, quick pick, input box as data; `ExtensionPrompts.tsx` draws them),
  `ExtensionContributionService` (commands into `CommandRegistry` — disabled with the reason when the extension is disabled or Node is missing, running one wakes
  its extension first —, editor actions for the F1 palette and right-click menu via `EditorService.setExtensionActions`, Explorer context items, keybindings merged
  into `KeybindingsManager` after the built-ins with source "extension" — a user's entry wins, conflicts are flagged —, languages registered in Monaco (Monaco can't
  unregister one: disabling an extension's language takes effect after a restart), snippets as a completion provider, colour themes) and
  `ExtensionMarketplaceService` (a disabled placeholder: "Online extension marketplace is not available yet."). Contributed settings reach the Settings page
  because the backend adds them to the definitions; `SettingsService.values()` is what `getConfiguration` reads and `update` writes back through
  `SettingsService.set`. Extension colour themes: `extensionTheme.ts` translates a theme file (JSON with comments, `jsonc.ts`) — editor/workbench colours to Monaco
  colours and the `--*` tokens (`WORKBENCH_TOKENS`), TextMate token colours to Monaco token names (approximate — Monaco is not TextMate; `include` is not
  followed); `ThemeService` applies it on top of the built-in palette matching `uiTheme` and falls back to Dark (with a notice) when it is gone. TextMate
  grammars and icon themes are stored and shown as unsupported. `ExtensionsView` (side bar) replaces the old "not available yet" placeholder.
  Not done: custom views (`onView`), webviews, source control/view-title menus, a permission model, updates (a replace-install of the same id is the only
  update path), the online marketplace, extension dependencies are only reported.

- **Read-only file previews (Milestone 11).** `FilePreviewService` (`filePreviewService.ts`) owns the preview documents (`pv:<n>`, one per path, never a text
  document): load through the backend, the model per kind (image data address, PDF bytes, DOCX/XLSX models, CSV table, Markdown/HTML text, LaTeX outline, or a message), status
  loading/ready/error, zoom (fit / actual / steps 10%-800%), PDF page, XLSX sheet, image dimensions, reload with a sequence number so a stale load never overwrites a newer one.
  A preview is an editor tab of kind `filePreview` (`EditorKind`, id = its `pv:` id): no dirty state, no Save/Save As/Revert (all no-ops), never seen by Save All, released when
  its last tab closes (Reopen Closed Editor brings it back), restored with the layout and the flat session (a preview whose file is gone is skipped). `WorkspaceService.openPath`
  routes: images, PDF, DOCX and XLSX always open as a preview; **text and code open in the editor** (Markdown, HTML, LaTeX and CSV too — Open Preview is one click away); any file that
  is binary or too big for the editor becomes a preview tab with a message (a 40 MB `.log` no longer freezes Monaco). `openFilePreviewOf`/`preview.open` (Markdown keeps its live
  preview; HTML/LaTeX/CSV show the *saved* file), `openAsText` (preview -> editor in place, only when `textSafe`), explorer context menu "Open Preview"/"Open as Text", the
  editor ⋯ menu ("Open File Preview", and "Open as Text"/"Reload Preview" on a preview), and `previewCommands.ts` (`preview.open|openAsText|reload|zoomIn|zoomOut|fit|actualSize`,
  each disabled with a reason; no keyboard shortcuts, Ctrl+Plus/Minus already zoom the window). `FilePreviewView` = toolbar (name, tooltip with the path, kind, size, pixel size,
  "Read-only preview", zoom, page controls, Open as Text, Reload) over `components/filePreview/*`: `ImagePreview` (`<img>` from a `data:` address — an SVG shown that way runs no script and loads
  nothing external; `describeSvg` tells the reader what it contained), `PdfPreview` (pdf.js, one page at a time, Fit Width, encrypted/damaged PDFs named as such), `DocxPreview`,
  `SheetPreview` (XLSX and CSV grids, row/column counts, truncation notices), `HtmlPreview` (the extension-webview sanitizer with scripts off + `<iframe sandbox="">`, a notice for every
  blocked script, handler, link and remote address), `LatexPreview` (`outlineLatex`: title, author, sections, equations, bibliography commands, paragraphs — never compiled) and
  Markdown through the existing safe renderer. Preview tabs are not documents: `activeTextEditor` is undefined while one is active, an extension edit for a file that is only previewed is
  refused ("isn't open"), the status bar shows no line/encoding info for them. pdf.js lives in `public/pdf` (worker, character maps, fonts, wasm; copied by `scripts/copy-pdf-assets.mjs` in
  `predev`/`prebuild`, git-ignored) and is loaded lazily (a separate chunk) — the same Rolldown-worker workaround as Monaco's.
- **AI providers and chat (Milestone 13).** All in `src/services/ai/`, wired by `wireAi` (`aiWiring.ts`, called from `container.ts`; `container.ai` = `{providers, chat, actions, ui}`,
  started by `startAi` after the extensions). **The rule that shapes everything: the AI panel exists only while a provider is available.** `AiProviderService` keeps the
  configured providers (the backend owns the list; an API key is stored encrypted and never comes back — the UI only learns `hasKey`) and computes for each one `available`:
  turned on, and — when it came from an extension — that extension installed, enabled and still offering it (`ext:<extension id>/<contribution id>`; `sourceMissing` when the
  extension is gone, which makes the provider deletable). `panelVisible()` = `ai.enabled` and at least one provider available. That single value drives: the **AI activity bar
  item** (absent otherwise — no disabled placeholder), the **side bar view** (`SideBar` falls back to the Explorer when the persisted `ai` view has no provider), the **AI
  commands** (`syncCommands` *registers* `ai.openChat`, `ai.newChat`, `ai.explainSelection`, `ai.suggestFix`, `ai.generateDocs`, `ai.explainTerminalError`,
  `ai.summarizePreview` when a provider becomes available and *unregisters* them when the last one goes; `EditorService.setAiActions` does the same for the F1 palette and the
  right-click menu) and the running request (`AiChatService.onProvidersChanged` stops it and drops a waiting confirmation). Only `ai.manageProviders` ("AI Providers..." in the
  Manage menu) is always registered: it is how the first provider gets added. Extensions' providers are created (once, then editable) when their extension is enabled
  (`syncContributions`), disabling the extension makes them unavailable at once and enabling brings them back; the backend refuses them too. `AiChatService`: one open conversation,
  `sendDraft()` (the message box's text lives in the service: `draft`, emptied on send and **restored when the user declines the confirmation**), `submit()`, `confirm()`/
  `cancelConfirmation()`, streaming (`ai:chunk` events matched by request id), `stop()`, `retry()` after a failed or stopped answer (an error stays in the conversation),
  `contextWarning()` (about 30 000 tokens), local history (`ai.saveConversationHistory`; list/open/delete/clear all) and pure `sendBlocker()` reasons (no provider, key, model, request
  running). **Before text goes to an online provider the user sees a dialog** (`AiConfirmDialog`): "This will send <selected code | terminal output | preview text | your message>
  (about N characters) to <provider> (<host>). It leaves this computer." — unless `ai.confirmBeforeOnlineRequest` is off *and* the message is small (more than 20 000 characters
  always asks); a provider on this computer (loopback) is never asked about. `AiActionsService` builds the five actions from what the user selected or is looking at *at the moment
  they run one* (`AiContextSource`): the active text editor's selection (only while a **text tab** is in front — a preview tab is not an `activeTextEditor`, with the reason in the
  tooltip), the active terminal's selection (`TerminalSink.selection`, so nothing without a selection), and the active file preview's already-loaded text (Markdown, HTML source, CSV
  rows, DOCX paragraphs, LaTeX structure; images, PDFs and spreadsheets are refused with a reason and never sent); more than 100 000 characters is refused, not cut; each action
  has `reason()` (why it can't run) and the same reason is its disabled tooltip and the notice a palette run shows. "Insert" on an answer's code block uses
  `EditorService.insertAtCursor` (one undoable edit that replaces the selection, only on a click, only into a text tab). UI: `AiView` (provider and model pickers, an Online/Local
  label with the host, the five action buttons, the conversation as text nodes and code blocks with Copy/Insert — never HTML —, message box with Send/Stop/New chat/Clear chat,
  history; a provider without key or model shows a configuration prompt instead of a chat), `AiProviderManager` (list with kind, Online/Local, key state, status; Enabled, Edit,
  Test connection, Set as default, Delete with confirmation; the form masks the key, empty means keep, "Clear saved API key"; Clear AI history with confirmation) and
  `AiConfirmDialog`, mounted in `App.tsx`.

- **Languages and projects (Milestone 14).** In `src/services/language/`, wired by `wireLanguage` (`container.language` = `{support, projects, ui, ...}`, `startLanguage` loads the
  registry before the session is restored and scans the open folder). `LanguageSupportService`: the registry from the backend, `languageOf(path)` (the same matching rules as the
  backend, in `languageRegistry.ts`), `editorLanguageFor(path)` — the editor grammar for files the built-in table and **extensions** don't know (it is chained *after*
  `ExtensionContributionService.languageForPath`, so extension languages win, and disabling the extension removes them again): Go, Rust, Java, C#, C/C++, Ruby, Swift, Kotlin, shell,
  PowerShell, batch, SQL, GraphQL, YAML, Dockerfile, INI ... now get real highlighting instead of plain text, Vue/Svelte/Astro as HTML — the workspace scan (`refresh`: when a folder
  opens, when a manifest — `package.json`, `Cargo.toml`, `go.mod`, `pubspec.yaml`, a Gradle/`.csproj`/`Dockerfile` ... — is saved (debounced), or on request; a stale answer is dropped),
  `summary()` for the status bar ("Vite + React", "Tauri + React (+2)", "No project detected") and `lookUpFile`. `ProjectCommandService`: `availability`/`describe` of a command and
  `runCommand`/`runTool`, which — only on a click — open a **new integrated terminal in the project's folder** (so the portable runtimes are first on that terminal's PATH like every
  terminal; nothing else touches PATH), ask the backend for the line quoted for that terminal's shell, type it and show the panel; a command that can't run says why and opens nothing; WSL
  terminals are refused with a reason. Commands: `language.showStatus` (always there), `language.refresh`, `language.formatWithTool` ("Format Saved File With Tool (Terminal)", Edit menu; since Milestone 15.2) and
  `language.runLinter` — they act on the **saved** file of the active *text* tab inside the folder (an edited file is saved first; a preview, an untitled or outside file is refused with a
  reason), run the first *found* tool (the project's own first) in the terminal and otherwise say "No formatter found for <language> (looked in the project, OpenMind's runtimes and PATH)"
  with each candidate's setup hint. Format Document itself (Shift+Alt+F) is the formatting service's since Milestone 15.2. UI: `LanguageStatusItem` (status bar) and `LanguageStatusDialog` ("Project & Language
  Status..." in the Manage menu and the status bar item): the current file's language, group, support levels, syntax note, language servers (`languageView.lspLine`: OpenMind's own server's
  live state or "LSP not configured: install it from Language Tools", any other candidate found/not found and always "OpenMind can't start this language server yet"), formatters and
  linters; every detected project with its confidence chips (evidence in the tooltip), ambiguity warning, notes, tools and command buttons grouped Dev/Run/Build/Test/Lint/Format/Install
  (a disabled button's reason is its tooltip *and* visible text below); and the toolchains on the computer.

- **Formatting (Milestone 15.2).** `src/services/formatting/`: `FormattingService` (the brain, free of Monaco/React over a small `FormattingHost`), `formattingWiring.ts` (commands, host, save hook), `formatSelection.ts`,
  `formattingIpc.ts`. Format Document is **the app's own command** (`edit.formatDocument`, Shift+Alt+F is now an app-owned binding and Monaco's own key is switched off): it asks the backend which formatter applies,
  runs it on the buffer's text and applies the answer with `BufferManager.replaceContent` (a minimal prefix/suffix edit: one undo step, the cursor stays where it can, the tab is dirty unless the text is the same, nothing
  is saved). The **language server is one formatter among the others** (`lsp`, after the tool formatters; the LSP document/range formatting providers are no longer registered with Monaco, so the context menu shows one
  Format Document, not two). Guards: only a **text tab** formats (a preview says "A preview is read-only and can't be formatted. Open the file as text first."), a file over 2 MB is refused, if the text changed while the
  formatter ran nothing is applied, a failure (invalid JSON with its line/column, Prettier's own error, a timeout) is shown and the text is untouched, "No formatter available for <Language>. ..." with the reason when there
  is none. Commands: `edit.formatDocument`, `edit.formatDocumentWith` (**Format Document With...**: every formatter with its source or the reason it can't be used, "Remember as the default formatter for <Language>"
  stored as `formatting.defaults` in `editor_settings`), `edit.configureDefaultFormatter`, `format.showStatus`, `edit.formatSelection` (**only with a running language server that supports range formatting**; the built-in and
  tool formatters format the whole document), `format.toggleOnSave` (checkable, writes the user setting); in the Edit menu and, for Format Document / With..., the F1 palette and the right-click menu
  (`EditorService.setFormatActions`). `language.formatWithTool` is now "Format Saved File With Tool (Terminal)". **Format on Save** = `DocumentService.setBeforeSave` (only a save to the document's own path, not Save As):
  off by default; no formatter is silent (a line in the **Formatting** Output channel), a failing one shows "Format on Save: ... The file was saved as it was." and the save goes on; never for an unsaved, huge or
  preview document. **Status bar**: `FormatterStatusItem` ("JSON — Built-in JSON formatter", "TypeScript — Prettier (from the project)", "⚠ Python — Black missing, Ruff missing"; a formatter that exists but is turned off
  reads "unavailable"), click = `FormatterDialog` in status mode (lookup only; nothing runs). Nothing formats at launch. **Key limits**: no Ctrl+K Ctrl+F (chords are not supported), no Format Modified Lines, no bundled
  Prettier/Biome (nothing is bundled; they come from the project, a bundled toolchain pack or — when allowed — the PATH), no HTML/CSS/JS/TS/Markdown/YAML/SQL/Dockerfile/Java formatter of OpenMind's own, Rust formatting
  passes `--edition 2021` on stdin (a different edition needs `cargo fmt`), a project's own formatter is a program from the folder you opened (turn `formatter.useProjectLocalTools` off for untrusted folders).

- **Toolchains and the Runtime Manager (Milestone 15).** `Terminal > Manage Runtimes` is now the **Runtime Manager** with two tabs. *Runtimes*: the existing portable runtimes as a two-column grid of compact cards
  (name, chips, a description clamped to two lines with the full text as its tooltip, version selector, Install; the long `notes` — e.g. Python's — moved into a **Details** dialog). *Language Tools*: `ToolchainService`
  (`src/services/toolchains/`, `container.toolchains`; list, `setActive` — only a present, inactive version —, `verify`, details, refresh of the language status after a change) and `toolchainView.ts` (pure:
  sections Package Managers / Language Servers / Formatters / Linters / Debuggers / Version Control / Helper Tools / Mobile/Desktop SDKs / External Required, status chips, honest version counts, middle-ellipsis
  paths). `ToolsPanel` draws cards (name, chip, two-line summary, active version, "N versions available (up to 5 kept)", shortened path, version selector, Verify, Details, the setup hint when missing),
  `ToolDetailsDialog` the full text, every version with its licence and a Use button, the source and the verification result. Project & Language Status gained a **Bundled with OpenMind** section (Git,
  Composer, Python debugger: the active bundled version or that nothing is bundled). Tokens only in `styles/toolchains.css`.
- **PHP stack Configuration page (Milestone 15).** Only the *Config* sub-page of the PHP window was redesigned; the main control panel (module table, side buttons, log) is unchanged. `phpConfigModel.ts`
  (pure: status chips, `connectionString` — no password —, `envBlock`, `adminAvailability`, `laravelCommands`), `components/phpConfig/` (`Card`/`StatusChip`/`Facts`, `ConfigHeader` = title chips + Stack Summary,
  `CredentialsBlock`, `LaravelCard`) and restyled sections in `PhpStackSections`/`PhpServerView`: header (Back, title, subtitle, chips PHP / Composer / MariaDB / phpMyAdmin), Stack Summary, Web Root, PHP and Composer
  version cards, PHP Server, Ports, MariaDB (status, version, bind address, port, data/config/log paths, Init/Start/Stop/Restart/Logs, and a **Connection** block: host, port, user, password masked `••••••••`
  until **Reveal Password**, Copy Password, Copy Connection String), phpMyAdmin (status, address, Start/Stop, **Open phpMyAdmin** = Admin — disabled with "Start MariaDB first." / "Start phpMyAdmin first…" /
  "isn't installed…" —, Copy URL, Logs), Composer, **Laravel helper** (only when the Composer project has `laravel/framework` + `artisan`: PHP/Composer/MariaDB/.env status, *Copy DB Credentials for .env*, copyable
  `composer install` (while `vendor/` is missing) / `php artisan serve` / `npm run dev|build`; OpenMind **never writes or edits `.env`**) and Logs. `php_project_info` gained `isLaravel/hasVendor/hasEnv/npmScripts`.
  The password is decrypted only on Reveal or a Copy, is never logged (checked in the app's logs and `settings/`), and the connection string has none.

- **Menu system and About (pre-Milestone 16 menu completion).** The title-bar menus are still pure data (`menus.ts`) over the `CommandRegistry`, with one new rule: **an entry whose command is not registered is not
  shown** (`pruneMenuEntries`, applied in `resolveMenuEntries` each time a menu opens; also removes submenus left empty and leading/trailing/double separators). A registered command that can't run now stays visible with its
  reason. Nothing in a menu is therefore a dead or placeholder item: the never-built entries (tasks, workspaces, Auto Save, Emmet, release notes, videos, feature requests, updates, developer tools ...) simply don't appear
  (Help lost them from the data too), and an entry appears the moment its command exists — the **AI Panel** item (`ai.openChat`, View) exists only while an AI provider is enabled, a shell item only for a shell that was found.
  Top level: **File, Edit, Selection, View, Go, Run, Terminal, Help** — About lives under **Help > About OpenMind Studio** (a separate top-level About entry was tried and removed at the user's request). Entries with
  arguments (a shell profile, a project command) show no shortcut. Dynamic content comes from `MenuContext`: `Terminal > New Terminal With Profile` lists `TerminalService`'s detected shells (PowerShell, Command Prompt,
  Git Bash, WSL only when found); `Run > Project Run / Build / Test Commands` lists the language support's commands (`projectMenuCommands`, executed by `language.runProjectCommand`, which is the status window's click-to-run
  path: a new terminal in the project folder, a disabled command says why). New commands: `terminal.killAll` (Kill All Terminals), `help.showLogs` (the app's log file opened as an editor tab), `help.openLogsFolder`
  (`helpCommands.ts`). Help = Welcome, Show All Commands, Keyboard Shortcuts, Show Logs, Open Logs Folder, About OpenMind Studio. **Documentation, Report Issue and Check for Updates are deliberately absent**: no project
  page URL and no update system exist, so they would be dead links. **Edit > Paste** now reads the clipboard through the app (`ipc.clipboardReadText`) and pastes with Monaco's `paste` command
  (`EditorService.pasteText`, one undo step): Monaco's own paste action made WebView2 show a "wants to see text and images copied to the clipboard" permission prompt on every click. Save and Save As are unavailable
  on a preview tab ("A preview is read-only: there is nothing to save."). Fixed on the way: **opening the File menu while a preview tab was active threw `document "pv:1" does not exist` and blanked the whole window**
  (`file.revert`'s predicate asked a preview for its dirty state), and `CommandRegistry.isEnabled` now treats a throwing predicate as disabled instead of throwing into the menu; the Explorer "open folder" command
  turned `C:/a/b` into a switch and opened Documents (`panel_open_folder` now passes backslashes). **About window** (`AboutDialog`, `about_info` in `commands/about.rs`): the app (logo, version — no commit or build hash —,
  description, technologies), the **author** card (Md Shahanur Islam Shagor — Founder & Developer, OpenMind Studio; Independent Researcher and Software Engineer; contacts: support email smshagor.dev@gmail.com (`mailto:`), Telegram @smshagor1 (t.me link), GitHub smshagor-dev, WhatsApp smshagor1 as plain text; a Portfolio entry only when `PORTFOLIO_URL` in `about.rs` is set — it is empty, no address was invented; every link opens only on click via `open_external_url`, which accepts http(s) and a plain `mailto:` address), a
  System list (version, platform, WebView2, Tauri, compiler, licence **Apache-2.0** — workspace/`package.json` metadata say so too; the full Apache licence text file is not in the repository yet) and the buttons Copy System Info (built by
  the backend: versions, platform, licence, support email, app and logs folders — no commit hash — no keys, passwords, provider settings or project content; a Rust test checks it), Open Logs and Close. **Author picture**: put it at
  `src/assets/about/author.png` (`.jpg`, `.jpeg` or `.webp` also work); it is bundled with the app, never fetched, and when there is none, or it can't be decoded, the card shows the initials `MS`
  (`aboutAuthor.ts`, `import.meta.glob`). The current `author.png` is the photo the author supplied. **Shortcuts** are unchanged: Ctrl+N, Ctrl+O, Ctrl+Shift+O (Open Folder — the `Ctrl+K Ctrl+O` chord is not supported),
  Ctrl+S, Ctrl+Shift+S, Ctrl+Z, Ctrl+Y, Ctrl+X/C/V, Ctrl+A, Ctrl+F, Ctrl+H, Ctrl+Shift+F, Ctrl+P, Ctrl+T, Ctrl+G, Shift+F12, F5 / Shift+F5 / F10 / F11 / Shift+F11, Ctrl+` , Ctrl+Shift+P; **Ctrl+F5 stays Run Code**
  (it is not "Run Without Debugging"), and chord sequences such as `Ctrl+K S` (Save All) don't exist.

**Look (post-6.3)**: the dark theme follows VS Code's *current* default dark, measured from a real VS Code window
(frame, title bar, status bar and the 4px gaps between cards `#191a1b` while the window has focus, `#121314` when it
doesn't — `workbench--inactive`, from window focus/blur; editor `#121314`; side bar, panel and secondary side bar
`#191a1b`; every card has a 1px `#2a2b2c` border and 8px corners; tabs `#202122`; text `#bfbfbf`/`#ededed`/`#8c8c8c`,
links `#48a0c7`, buttons `#297aa0`): activity bar + side bar are one card, the editor, the panel (under the editor
column only) and the secondary side bar (full height) are separate cards (`styles/frame.css`, loaded last), title-case
side bar headers, 24px activity icons with a rounded active highlight, a 35px title bar with Back/Forward (disabled
until `go.back` exists), a "Search"/folder-name command center and side bar + panel + secondary toggles, and a 32px
status bar in the frame color. The terminal's xterm background is `--panel-bg`.
Monaco uses `openmind-dark`/`openmind-light` (`editor/monacoThemes.ts`, defined lazily by `defineMonacoThemes()` —
defining a theme starts Monaco's global services, which made unrelated jsdom tests fail on clicks). The Welcome page
is a closable tab (`WelcomeService`, `WelcomeEditor.tsx`): Start (New File, Open File, Open Folder, Clone Git
Repository, New Window), Recent (5, then More...), Get Started cards for real features, "Show welcome page on
startup" (`workbench.welcomeOnStartup`); closed, the empty editor shows a watermark with real shortcuts; Help >
Welcome (`help.welcome`) reopens it. Light keeps Light+ colors on the same card structure.
**Secondary Side Bar** (VS Code's): `SecondarySideBarService` + `SecondarySideBar.tsx`, a card on the far side of the
editor (left when the primary side bar is on the right) showing an Output channel (picker, Clear, Hide). Title-bar
toggle and `view.toggleSecondarySidebar` (Ctrl+Alt+B). Run Code (`RunCodeService`'s optional `showBeside` callback,
wired in `container.ts`) opens it at **half** of the editor + side bar row on the run's channel; the bottom
panel's Output channel gets the same lines but is only *selected*, not opened. **The bottom panel (terminal area)
never opens by itself**: `PanelService.initialize` restores height/tab but always starts hidden, and no automatic
path calls `panel.show` (Run Code, Composer runs, debug start — `debug.openConsoleOnStart` defaults to false); only
user actions open it (Ctrl+J/Ctrl+`, New Terminal, View menu, Open Logs, Show Git Output, Run Code in Terminal); dragging its sash switches to a fixed, clamped width. Saved as
`workbench.secondarySideBar` (a main-window-only key, like `panel.state`). The Run-in-Terminal target doesn't open it.
UI (Milestone 3.5 — VS Code workbench layout, Dark+/Light+ colors as CSS tokens in
`styles/theme.css`, switched by `data-theme` on `<html>`): the window is **undecorated**
(`decorations: false`); `TitleBar` draws VS Code's Windows title bar (app icon, `MenuBar`, command
center, side bar toggle, window controls; non-control areas are `data-tauri-drag-region`).
`MenuPopup` is the one dropdown used everywhere (menu bar, gear menu, explorer context menu),
with submenus, check marks, shortcut labels and full keyboard navigation; Alt+<letter> opens a menu.
`ActivityBar` (Explorer + Manage gear — still no placeholder icons for views that don't exist),
`SideBar` (EXPLORER title, `OpenEditorsSection`, then `ExplorerPanel` or "No Folder Opened", with
a resizable `Sash`), `FileTree` (flat rows from `visibleTreeRows`, 8px indent + hover indent
guides, `FileTypeIcon`s (real per-language SVGs from the MIT Material Icon Theme — `fileIconSpec.ts` maps names/extensions, `fileIconUrls.ts` bundles only the ~100 used icons, license in `THIRD_PARTY_NOTICES.md`) and no folder icons, VS Code list keyboard model, HTML5
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

## VS Code API compatibility matrix (extensions)

**OpenMind Studio supports a VS Code API subset.** It does not claim full VS Code compatibility, and no VS Code source is used. `S` = supported,
`P` = partially supported, `U` = unsupported (any use throws "VS Code API '<name>' is not supported by OpenMind Studio yet." and is logged
against the extension). The permission column is what the extension must have been granted (see `openmind-extensions`, Milestone 10.1).

| API group | Level | What works | Differences from VS Code | Permission |
| --- | --- | --- | --- | --- |
| `vscode.commands` | P | `registerCommand`, `executeCommand` (extension commands and the app's own), `getCommands` | No `registerTextEditorCommand`; a command id another extension owns is refused (VS Code: last wins); arguments from the Explorer menu arrive as a `Uri` | `commands` |
| `vscode.window` | P | `showInformation/Warning/ErrorMessage` (with buttons), `createOutputChannel` (+ log channels), `showQuickPick` (single/many), `showInputBox`, `activeTextEditor`, `visibleTextEditors` (the active one only), `onDidChangeActiveTextEditor`, `onDidChangeTextEditorSelection`, `createStatusBarItem` (text, tooltip, command, `ThemeColor` colours, Left/Right, priority, show/hide/dispose), `registerTreeDataProvider`/`createTreeView` | `TextEditor`: `document`, `selection(s)` (also settable), `options`, `viewColumn` (always 1), `edit`, `revealRange`; no decorations, `insertSnippet`, `selections` of non-active editors; message options/modal ignored; `createWebviewPanel` (a subset, see Milestone 10.4), no webview views, progress, terminals (`createTerminal` is permission-gated, then unsupported); status bar items are plain text (`$(icon)` markers dropped), colours only from a fixed list of theme colours, no `accessibilityInformation` | none (`terminal` for `createTerminal`) |
| `vscode.workspace` | P | `workspaceFolders`, `name`, `rootPath`, `getWorkspaceFolder`, `asRelativePath`, `getConfiguration` (`get/has/inspect/update`), `onDidChangeConfiguration`, `openTextDocument`, `textDocuments`, `onDidOpen/Close/Change/SaveTextDocument`, `onDidChangeWorkspaceFolders` | One folder only; `update` writes the user or workspace settings file; `applyEdit` (open documents only); no `fs`, `findFiles`, file watchers, `registerTextDocumentContentProvider`; change events carry no `contentChanges` (the whole text is current) | `settings`, `workspaceRead` (`workspaceWrite` for `applyEdit`) |
| `vscode.languages` | P | `registerCompletionItemProvider`, `registerHoverProvider`, `registerDefinitionProvider`, `createDiagnosticCollection`, `getLanguages` | Selectors: `language` only (patterns/schemes ignored); completion items map label/kind/detail/documentation/insertText (`SnippetString` too); no code actions, formatting, rename, semantic tokens, inlay hints | `languages` |
| `vscode.debug` | U | nothing — `vscode.debug.*` and `vscode.tasks.*` throw the unsupported message | Debug adapters run only through OpenMind's own debugger (Milestone 8); `debuggers`/`problemMatchers` contributions are stored as metadata | — |
| `vscode.extensions` | P | `getExtension(id)`, `all` (id, path, `packageJSON`, `isActive`) | `exports` is always `undefined`; no `onDidChange` | none |
| `vscode.env` | P | `appName`, `appHost`, `language`, `uriScheme`, `machineId`, `sessionId`, `shell`, `openExternal` | Fixed values (`appName` is "OpenMind Studio", `vscode.version` is `1.85.0` as a compatibility level); no clipboard, telemetry, `isTelemetryEnabled` | `network` for `openExternal` |
| `vscode.Uri` | P | `file`, `parse`, `joinPath`, `with`, `fsPath`, `path`, `scheme`, `toString` | No `Uri.from`, query encoding subtleties | none |
| `vscode.Range` / `Position` / `Selection` | P | constructors, `isEmpty`, `isSingleLine`, `contains`, `isEqual`, `isBefore/isAfter`, `translate`, `with`, `anchor/active` | `compareTo`, `isBeforeOrEqual/isAfterOrEqual`, `intersection`, `union`, `Selection.isReversed` exist; the classes do not validate their values (documents do, via `validateRange`) | none |
| `vscode.Diagnostic` | S | `range`, `message`, `severity`, `source`, `code` | No `relatedInformation`, `tags` | `languages` |
| `vscode.CompletionItem` | P | `label`, `kind` (all `CompletionItemKind` values), `detail`, `documentation`, `insertText` (string or `SnippetString`), `sortText`, `filterText`, `CompletionList` | No `range`, `additionalTextEdits`, `commitCharacters`, resolve | `languages` |
| `vscode.Hover` | S | `contents` (strings/`MarkdownString`), `range` | Only markdown text | `languages` |
| `vscode.Disposable` | S | `dispose` (once), `Disposable.from`, `EventEmitter` | Everything an extension registers is also disposed by the host on deactivate | none |
| `ExtensionContext` | P | `subscriptions`, `extensionPath`, `extensionUri`, `globalStorageUri/Path`, `storageUri`, `logUri/Path`, `globalState`, `workspaceState` (JSON mementos), `asAbsolutePath`, `extension` | No `secrets`, `environmentVariableCollection`, `extensionMode`, `globalState.setKeysForSync` (no-op) | none |

Activation events: `*`, `onStartupFinished`, `onCommand:`, `onLanguage:`, `workspaceContains:` work; `onView:` is recorded and never triggers; every other event is
listed as unsupported. `aiProviders` (Milestone 13) is supported as data: the app's own client talks to the provider, extension code is not involved and never sees a key; an entry
needs an id, a name and a type of claude, openai-compatible, gemini or local. Contribution points: commands, menus (`commandPalette`, `editor/context`, `explorer/context`), keybindings, configuration (boolean,
integer, whole-number `number`, string, string enums), configurationDefaults (metadata), languages, snippets and themes are used; grammars and icon themes,
debuggers and problemMatchers are stored and shown ("This contribution point is not supported yet." / metadata only); every other point is counted and shown as
unsupported.

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
    extensions/               installed/, disabled/, cache/, storage/, logs/extension-host.log (Milestone 10)
    themes/                   on-disk theme/icon-theme assets (future milestone)
    language-servers/         language servers, one folder per package revision: unpacked from lsp/ or npm-installed (Milestone 7/17)
    lsp/                      the offline language server bundle shipped with release builds, read-only (Milestone 17)
    settings/                 settings.json and keybindings.json (Milestone 9; edited by hand or from the Settings page)
    data/ai/                  providers.json (no secrets) and conversations.sqlite, created only when AI is used (Milestone 13)
    data/search-index/        the workspace search index, one SQLite file per folder (Milestone 12)
```

`data/`, `runtimes/`, `logs/`, `cache/`, `language-servers/`, `extensions/` (Milestone 10) and `settings/` (Milestone 9) are in use; `themes/`
is created up front but stays empty until the milestone that owns it lands — don't write into them
speculatively. A workspace's own settings live inside the project, in `.openmind/settings.json`, created only when the user
sets a workspace setting or opens that file. Within `data/openmind-studio.db`, tables now live in:
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
  comments (`tauri.conf.json` `productName`/window title, `index.html` `<title>`, the app shell). The built executable is
  **`OpenMindStudio.exe`** (`tauri.conf.json` `mainBinaryName`; Cargo's own binary stays `openmind-studio`).
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

## Packaging and startup baseline (Milestone 9)

Windows x64 editions (portable ZIP, per-user NSIS setup, and — since Milestone 16 — an MSI; none is code-signed unless a certificate is configured, see `docs/release.md`):

- **Portable ZIP** — `pnpm package:portable` (`scripts/package-portable.mjs`; `--no-build`, `--profile debug`, `--out` and `--exe`
  exist for testing) runs `pnpm tauri build --no-bundle` and zips a folder `OpenMind Studio/` holding `OpenMindStudio.exe` and a
  README.txt, named `OpenMindStudio-<version>-portable-win-x64.zip` with a `.sha256`. The pure helpers (names, README text, exe
  path) are in `scripts/portablePackage.mjs` and are unit-tested (`src/services/packaging.test.ts` also checks that
  `tauri.conf.json`, `package.json`, `Cargo.toml`, `index.html` and the icon list agree on name, identifier and version).
  Unzipped anywhere (a path with spaces is fine) the app creates `data/`, `settings/`, `runtimes/`, `cache/`, `logs/`,
  `extensions/`, `themes/` next to itself — nothing in `%APPDATA%`, the Registry, Program Files or PATH.
- **Installer** — `pnpm package:installer` = `tauri build --bundles nsis`: a per-user NSIS installer (`installMode: currentUser`, no
  administrator rights, `OpenMind Studio_<version>_x64-setup.exe`). The app is exe-relative either way, so an installed copy keeps
  its data next to the installed executable (under `%LOCALAPPDATA%/Programs` by default). WiX/MSI is not built (`targets` is
  `["nsis"]`). Both editions were built for real in Milestone 9 (release exe 16.6 MB, portable zip 8.8 MB, installer 7.5 MB) and the
  portable one was run from a copied folder with a space in its path; the installer was built but **not installed** during
  verification.
- **Offline language servers (Milestone 17).** Every edition carries `lsp/` (built by `pnpm lsp:bundle`, checked by `--check`; see
  `docs/lsp-bundle.md`), which makes the installers larger: NSIS setup 104 MB, MSI 121 MB, portable ZIP 120 MB (was 7.5 / — / 8.8 MB).
  A `tauri build`/`tauri dev` copies `lsp-bundle/` next to the exe too (`bundle.resources`); a fresh clone has only its README there, so
  development builds simply have no bundle and fall back to npm installs.
- **WebView2 profile.** The webview's own profile (cache, local storage, cookies) used to live in
  `%LOCALAPPDATA%\com.openmindstudio.app\EBWebView` (247 MB after a few weeks) — found in Milestone 9 by watching that folder while
  running the portable copy. Every window is now built with `data_directory(<app>/data/webview)` (the main window is described in
  `tauri.conf.json` with `create: false` and built in `setup`; the PHP and extra editor windows pass the same directory, which
  WebView2 requires for windows of one process); verified: the AppData profile's newest file no longer changes and `data/webview`
  fills instead. The old AppData folder is left alone (delete it by hand if you want the space back).

Startup baseline (this machine, Windows 11, a fresh unzipped portable copy, nothing installed, a folder open, launched cold):
release build — window visible after ~0.16 s; debug build ~0.9 s (it used to add a console window; since the fix every build is a GUI-subsystem exe). Idle after 12 s: the app process 43 MB and
6 WebView2 processes 414 MB, ~457 MB in total. The **only** child processes are those six WebView2 helpers (the debug build adds one
console host): no language server, debug adapter, Git, PHP/MariaDB/phpMyAdmin server, Composer, shell or terminal starts by itself;
each starts only on an explicit action (open a file with a supported language *and* an installed server, Start Debugging, Start in the
PHP control panel, a Git action, Ctrl+` / New Terminal). Closing the app with a terminal open left 0 processes of the copy behind.
Memory is dominated by WebView2; no reduction was attempted in this milestone.

Extension startup baseline (Milestone 10.1; this machine, Windows 11, a fresh portable copy `E:\omext`, a *debug* build without debug info, folder open, launched from a
cold-ish start, window visible = `MainWindowTitle` set; each row twice): **no extensions** 0.64 s / 0.63 s to a visible window, no node process, ~178 MB
(app + WebView2 helpers, 9 s after launch); **5 extensions installed and enabled, 1 disabled, none activated** 0.67 s / 0.62 s, no node process (nothing
starts a host until an extension is needed), ~179 MB; **the same plus one `"*"` extension** 0.66 s / 0.62 s to a visible window (one cold launch took
1.2 s), then the host starts after startup finished: one `node` process, the extension activates ("sample-star activated at startup" in the log), ~224 MB
(+45 MB for the Node host). So installed-but-idle extensions cost nothing measurable at launch, and a `"*"` extension costs one Node process and ~45 MB
right after start-up (the extension list marks it "Activates at every start-up (\"*\"), which can slow the app down.").

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
- [x] **Milestone 5.7** — Portable PHP stack manager (PHP + Composer + built-in server; Apache/MariaDB/
  phpMyAdmin deliberately not built). New PHP/Composer manifests and the runtime-manager features above,
  `openmind_runner::server` + `php_server_*` commands, PHP Server view, Ports/Output integration. Verified
  in the built app (fresh copy, workspace path with spaces): PHP 8.4.26 and Composer 2.10.3 installed from
  the panel with real downloads; a new terminal resolved `php`/`composer` to the portable copies first
  (`where.exe`), `php --version` and `composer --version` worked (Composer ran on the portable PHP, XAMPP's
  php was second in `where.exe`); the Play button became enabled for `index.php` and ran it as "OpenMind
  portable PHP 8.4.26" with the portable `resolved:` path; Start Server served the folder (`curl` got
  "Hello from PHP 8.4.26 via cli-server", listening on 127.0.0.1 only), the request log and port 8000
  appeared in Output/Ports, Open Browser opened it; Stop left no php process and freed the port; closing the
  app with the server running left no php/conhost; relaunch kept PHP/Composer, folder and port and did not
  auto-start; Delete removed both installs; Registry User/Machine PATH unchanged. (Originally a side bar
  view — moved into its own window in 5.7.1.) Known limitations: only
  NTS x64 Windows builds; PHP versions 8.4.26/8.3.35 only; the log excerpt in the panel shows the last 8
  lines (Open Logs shows all); no `composer install` button; no per-project PHP version; the panel doesn't
  detect that the server was started by something else on the same port until it re-checks.
  433 TypeScript tests, 298 Rust tests (+1 ignored).
- [x] **Milestone 5.7.1** — PHP version matrix and the PHP Server window. PHP 8.0.30, 8.1.34, 8.2.34,
  8.3.35 and 8.4.26 (default/recommended) are pinned (windows.php.net NTS x64, SHA256 from the official
  `releases.json` and re-checked by downloading all five; each was started with its `php.ini` and all
  seven extensions load cleanly). New: per-version `seedFiles` (8.0/8.1 have zip built in, so their
  `php.ini` doesn't load `php_zip.dll`), manifest `features` for node/git/php/composer, the PHP Server
  window (above), `PhpRuntimeService`, backend `php_server_status`/`php_window_open`/`php:changed`/
  `runtime:changed`, the in-use guard on delete/repair, and a fix for the "System detected" version text
  (`php --version` and Composer printed whole banners with ANSI codes: only the first word after the
  prefix is kept now). A Runtime Extensions sidebar with Python/Node/Git/PHP/Composer cards was built and
  verified, then removed on the user's instruction ("remove everything that was added there; PHP Server
  opens in its own window"). Verified in the built app (fresh copy): the PHP Server icon opens a separate
  native window; PHP 8.4.26 installed from it and Run Code for `index.php` in the *main* window became
  enabled without a reload; "Use Open Folder" picked the main window's folder; the server started from the
  PHP window served `index.php` on 127.0.0.1:8000 and appeared in the main window's Ports panel; earlier in
  the same milestone (sidebar version, same backend) 8.4 -> 8.3 -> 8.4 switches were seen in `where.exe
  php`/`php --version`, the restart notice appeared while the server ran, Restart moved it to the new PHP
  (process path checked), deleting the PHP the server used was refused with a reason, `composer --version`
  ran on the active PHP, and python/pip/git worked; closing the app with the server running left no
  php/conhost; Registry PATH unchanged. Known limitations: only 8.4.26 was exercised through the UI
  end-to-end after the move into the window (8.3 through the sidebar version); the PHP window isn't
  restored on relaunch (open it again from the activity bar); Python/Node/Git are not in the PHP window.
  462 TypeScript tests, 308 Rust tests (+1 ignored).
- [x] **Milestone 5.8** — PHP Server window polish and portable database stack (`feat: add php server window
  polish and database stack`). Single-instance PHP window with persisted size/position/maximized, responsive
  layout, MariaDB (init/start/stop/restart, port 3307, generated root password, logs), phpMyAdmin, Composer
  install/update/dump-autoload, per-service logs and Ports registration, cross-window sync via backend status +
  change events, services stopped on app close. Validated: fmt, clippy -D warnings, cargo test --workspace,
  pnpm lint, pnpm test x3 (466), pnpm build. Real MariaDB init/start/ping/shutdown was exercised by hand while
  designing the backend; the full end-to-end pass of the built app through the PHP window UI (fresh portable copy)
  was **not** repeated after the final UI landed — do that before relying on it. Known limitations: Windows x64
  only; the password is stored unencrypted in local SQLite; Apache not built; PHP window not restored on relaunch.
- [x] **Milestone 5.8.1** — XAMPP-style control panel for the PHP Server window (see "Control panel (5.8.1)"
  above). Verified in the built app (fresh portable copy, workspace path with spaces): PHP 8.4.26, MariaDB 11.8.9,
  phpMyAdmin 5.2.3 and Composer installed from Config, database initialized, all three modules started from
  the table (PIDs/ports shown: PHP 8000, MariaDB 3307, phpMyAdmin 8081), Admin opened the browser, phpMyAdmin
  logged into MariaDB with the generated password (HTTP login, database list returned), row Config opened
  php.ini and my.ini in Notepad, Logs filtered, Netstat listed ports with our servers named, Shell opened a
  console in the project with the portable php first, Explorer opened the project folder, Stop ended each
  process, Quit closed the window (servers keep running, reopening shows their PIDs and there is still one
  window), closing the main app killed every server and the PHP window. Real bugs found this way and fixed:
  MariaDB 11.8 rejected `shared-memory=OFF` in my.ini (aborted at start); the PHP window grew by its frame on
  every reopen. Known limitations: the log only holds lines from while the window was open (MariaDB's and
  phpMyAdmin's full logs are in `logs/`); MariaDB's Config is disabled until its first start creates
  `settings/mariadb/my.ini`; no Windows-service or Apache modules; the test folder `E:\omcp` could not be deleted
  by the tool (protected path) and was left for manual removal.
- [x] **Milestone 5.8.2** — PHP stack verification and credential hardening (`fix: verify and harden php
  database stack`). Root password and phpMyAdmin secret now DPAPI-encrypted (above); a decrypt failure is
  surfaced. Control-panel table wraps its buttons instead of scrolling sideways at the 560x400 minimum size.
  Verified by hand in the built app from a fresh portable copy (`E:\omcp2`, workspace `My Site` with a space,
  Composer project requiring psr/log): launch; PHP icon clicked three times gives one window; window at 560x400
  and 1300x900 without overflow; PHP 8.4.26, Composer 2.10.3, MariaDB 11.8.9 and phpMyAdmin 5.2.3 installed from
  Config; project folder chosen through the native dialog; PHP server served index.php (curl) and showed in the
  main window's Ports panel, Stop freed 8000 and removed it; MariaDB initialized, started on 127.0.0.1:3307
  (`Get-NetTCPConnection`), showed in Ports; Show/Copy Password (24 chars) — `mariadb-admin ping` succeeded
  with it, a wrong or empty password was refused ("Access denied ... using password: NO"); Restart changed the
  PID, Stop left no mysqld; phpMyAdmin logged into MariaDB over HTTP and listed the databases; Composer
  install/update/dump-autoload each ran (vendor + lock created) and their output appeared in the Composer log
  tab and the merged log; closing the main app with PHP, MariaDB and phpMyAdmin running left no php/mysqld/
  conhost descendant, no listening port and closed the PHP window; relaunch did not auto-start anything and
  kept window size/position, project folder and PHP; Registry User and Machine PATH identical before/after.
  On a pre-existing (plain-text) install the first MariaDB start migrated the password to `dpapi1:` in SQLite and
  the copied password still had the same length. Not done here: phpMyAdmin's own HTTP login was scripted rather
  than typed into a browser; Copy Password was verified through the UI, its exact value only through its length
  and a successful ping; the test folders `E:\omcp` and `E:\omcp2` couldn't be deleted by the tool (protected
  path) and are left for manual removal. 491 TypeScript tests, 337 Rust tests (+1 ignored).
- [x] **Milestone 6** — Integrated Git client (`feat: add integrated git client`). New `openmind-git` crate (39 tests,
  13 of them against a real Git), `commands::git`, `SourceControlService`/`GitService` and the Source Control view:
  detect repository, init, changed/staged/untracked groups, stage/unstage (single and all), discard and delete with
  confirmation, commit, working-tree and staged diff (Monaco side-by-side; binary/too-large handled), branch
  list/switch/create/delete, fetch/pull/push, status-bar branch, Git output channel, identity form when Git has
  none. Verified by hand in the built app (fresh portable copy, workspace `my repo` with a space): with no Git
  runtime the view said so, offered Install Git Runtime (opened the Runtime Manager, MinGit installed) and offered
  the machine's Git only as an explicit, path-labelled "Use System Git" (never used silently); non-repo state; Initialize
  Repository (branch `master` in the view and status bar); an untracked file appeared, was staged, committed
  (`[master (root-commit) f5d910e]`), edited, shown in the working-tree diff (real red/green highlights), staged,
  shown in the staged diff, unstaged and discarded after the confirmation dialog (file content restored);
  a second file with Stage All / Unstage All (disabled ones carry their reason); Git output channel content;
  branch create/switch/delete (confirmation); relaunch re-detected the repository; closing the app left no Git
  process; Registry User/Machine PATH identical. Real problems found and fixed on the way: the diff had no
  highlights without a worker (see the Monaco worker note above), the view didn't notice Git being installed, a
  stale staged diff stayed open after unstaging, action errors were wiped by the following refresh. Known
  limitations: no clone, history/log or blame, merge/rebase/stash; untracked files can only be deleted one at a time;
  the diff is an overlay, not a tab; the commit identity form writes the repository's own config; fetch/pull/push
  were verified only against a local bare repository (no network remote, no credentials by design); rename
  detection shows what Git reports and was covered by parser tests, not by hand. The test folder `E:\\omgit` could
  not be deleted by the tool (protected path). 533+ TypeScript tests, 376 Rust tests (+1 ignored).
- [x] **Milestone 6.1** — Git clone, history, blame and stash (`feat: add git clone history blame and stash`).
  `openmind-git` gained clone, log/commit files/commit diff, blame and stash (see above); Source Control gained the
  Clone form, History, Stashes and Blame. Verified by hand in the built app (fresh portable copy, every path with
  spaces, a local bare repository as the remote): Clone was disabled with its reason while Git wasn't adopted yet and
  enabled after; clone into `clones here/cloned repo`; cloning into the same folder again was refused ("not empty.
  Nothing is overwritten") and left it untouched; a second clone offered "Open Cloned Folder", which opened it
  (`master 0↑ 0↓`); two commits through the UI (`2↑`); History listed all 5 commits, a commit listed its file and
  its diff opened (`notes.txt (b8150be)`); Blame of `notes.txt` attributed every line to its commit/author/date;
  stash with a message left a clean tree and listed it, Apply kept the stash and restored the change, a second stash
  was Popped (list and file checked with the Git CLI), a third was Dropped after the confirmation dialog; a renamed
  file showed as Deleted + Untracked until staged and then as `docs file.md ← readme file.md  R`, and its staged
  diff opened safely; closing the app left no Git process; Registry User/Machine PATH identical. Real problems
  found by tests/by hand and fixed: `GIT_LITERAL_PATHSPECS` broke `stash --include-untracked` (now a per-command
  flag), the view didn't notice Git becoming available while no folder was open, a staged-but-uncommitted file
  blames as "Not Committed Yet" (not an error). Known limitations: no merge/rebase, no graph, no stash diff/show, no
  "clone with submodules"/branch options; clone output is written when the clone ends (not streamed); (an editor
  tab not reloading a file changed on disk by a stash apply/pop was fixed in Milestone 6.2); an unstaged rename appears as Deleted + Untracked (that is
  what Git reports until both are staged); the authentication message was verified by unit tests, not against a
  real password-protected remote; `E:\\omgit` and `E:\\omgit2` are left on disk (protected path).
- [x] **Milestone 6.2** — External file change sync and Git refresh (`fix: sync editor with external file changes`).
  New `openmind-file-watch` crate (16 tests), `watch_*`/`document_read` commands, `FileSyncService`, the document
  external-state model and conflict UI (see above), Git-operation refresh of buffers/Explorer/Source Control, stale diff
  handling, info toasts. Verified by hand in the built app (fresh portable copy, workspace path with spaces): clean files
  reload on external edits, dirty files show the banner and are never overwritten (Compare, Reload from Disk after
  confirm, Keep My Changes, Save As), deleted files keep their text, renames retarget the tab, stash apply/pop (open tabs now refresh — the gap Milestone 6.1 listed), branch
  switch, discard and a terminal-created file refreshed editors, Explorer and Source Control; relaunch restored the
  session; closing left no orphan process; Registry PATH unchanged. 608 TypeScript tests, Rust workspace green.
  Known limitations: only the open workspace is watched (files outside it are caught on window focus/Git operations);
  `.git` is not watched, so a Git command run in a terminal refreshes Source Control from the resulting file events or
  on focus; (the mixed-line-ending false-dirty problem seen here was fixed in Milestone 6.3); notices reuse the toast component in an info style; `E:\omsync` test folders are
  left on disk.
- [x] **Milestone 6.3** — Editor line ending stability and documentation cleanup (`fix: stabilize line endings and update milestone docs`).
  Cause of the mixed-line-ending false dirty: Monaco keeps one line ending per model, so `model.getValue()` of a file
  with mixed (or lone-CR) endings differs from the text read from disk, and dirty state compared the two. `DocumentService`
  now takes the baseline (`savedContent`) from the model right after loading it; `lineEnding` is still the backend's honest
  `lf|crlf|cr|mixed` (status bar shows Mixed), nothing is normalized on disk at open, and Save on an unedited, in-place
  document does not write the file at all. Saving after an edit writes the model's text (one line ending per model — a
  mixed file gets its lines unified then, as before). Tests: Rust round-trip of a mixed file's bytes (44 `openmind-fs`
  tests), TypeScript cases for LF/CRLF/mixed open-clean, edit/undo, save, and external reload/conflict (616 tests).
  Verified by hand in the built app (workspace `my repo` with a space, `E:omsync`): LF, CRLF and mixed files opened
  clean (status bar LF/CRLF/Mixed); typing in the mixed file showed the dirty dot and backspacing back to the original
  cleared it; Ctrl+S on the unedited file left its SHA256 unchanged; `git status` (with `core.autocrlf=false`; this
  machine's global `autocrlf=true` otherwise muddies line-ending tests) showed no false modification; an external append
  reloaded the clean tab with an info toast; relaunch restored the tabs clean; no orphan process. Known limitations: the
  model still holds one line ending, so saving an *edited* mixed file unifies its endings; a mixed file is
  not offered a "convert line endings" action yet.
- [x] **Milestone 7** — LSP and Problems panel integration (`feat: add lsp and problems integration`). New `openmind-lsp` crate
  (52 tests + 3 ignored real-server tests), `commands::lsp`, the frontend services above, Language Tools dialog, status bar
  item, LSP output channel, Go/Edit/Terminal menu entries, F2/Shift+Alt+F. Also fixed on the way: `documentService` mapped only a
  handful of extensions to Monaco languages (PHP, SCSS, Less, .mjs ... opened as plain text, so no provider would have run).
  Verified by hand in the built app (fresh portable copy `E:\omlsp\OpenMind Studio`, workspace `My Site` with a space): the
  status bar said "Language server is not installed yet." and opened Language Tools; Install (real `npm ci` from the lockfile)
  for TypeScript, Pyright and Intelephense started each server; TypeScript: hover, completion (`console.lo` -> `log`),
  inline squiggles + Problems entries for an intentional error (click moved the cursor; fixing it cleared them), Go to
  Definition (F12), Find References (Shift+F12 peek, 2 results), Rename (F2, both places), Format Document (Shift+Alt+F);
  Python: hover and an error from Pyright; PHP: an error from Intelephense; Problems grouped per file with Error/Warning/Info/
  Hint; an external overwrite of a dirty file showed the conflict banner and kept sending the editor's text, Reload from Disk
  sent the new text and Pyright's problems followed; closing the app left no node/server process (6 before, 0 after), Registry
  User/Machine PATH identical; relaunch restored the tabs and restarted the servers. Known limitations (see 7.1 for what was
  verified afterwards): Intelephense's free tier lacks rename
  and some features; sync is full-text (no incremental); only files inside the open folder get a server; diagnostics exist only
  for open files; rename opens the other files as tabs (edits left unsaved) and refuses file create/rename/delete edits; no
  code actions, inlay hints, semantic tokens or workspace symbols; Python settings/interpreter selection are not passed to
  Pyright (it finds Python on the server's PATH, portable first); without the matching server .ts/.js/.json/.css/.html files have no language
  features at all (Monaco's own services are off); the test folders `E:\omlsp` are left on disk.
- [x] **Milestone 7.1** — LSP commit verification and workspace reconcile (`fix: verify lsp commit and reconcile workspace state`).
  The exact committed Milestone 7 tree (`241fd5f`, in a clean worktree with its own target dir) was validated: fmt, clippy
  `-D warnings`, `cargo test --workspace` (477 passed, 4 ignored) and `pnpm lint` were clean, but **`pnpm test` failed 7 tests and
  `pnpm build` failed** — the hunk-by-hunk staging of Milestone 7 had left `fakeIpcClient.ts` without part of the LSP mocks
  (the working tree, which had them, hid it). Fixed (688 tests, three runs, build clean). The other session's uncommitted
  PHP control panel / tray / Composer work was left untouched and uncommitted; only my hunks were staged. Manual verification
  (fresh copy `E:\omlsp2\OpenMind Studio`, workspace `My Site` with a space): **portable Node precedence** — with portable
  Node 24.21.0 installed from the Runtime Manager, Language Tools said "Node.js: OpenMind portable Node.js" and the server
  processes' executable was `...\runtimes\node\versions\24.21.0\node.exe` although a system Node 24.16 exists (before it was
  installed the dialog said "System Node.js at ..."); **JSON** — invalid JSON showed "Trailing comma" inline and in the status
  bar, fixing it cleared it, closing a file with an error cleared its problem; **CSS** — found and fixed a real bug: the CSS
  server crashed while validating because `workspace/configuration` answered `null` (now `{}` for the web sections); afterwards
  `colr` showed as an unknown-property warning, hover showed the MDN text and completion offered `display`; **HTML** —
  completion (`<sec` -> `section`) and hover (`div`) worked; the HTML server reports no diagnostics for ordinary markup;
  **PHP** — hover on a user function, completion (`str_rep` -> `str_repeat`, `str_replace`) and diagnostics worked, and the
  Edit menu showed "Rename Symbol — Intelephense doesn't support Rename Symbol."; closing the app left no node/server process
  (4 before, 0 after), Registry User/Machine PATH identical. Also fixed: the stuck "Loading…" hover for CSS (see
  `monacoBuiltins.ts`). Not verified by hand: that a file outside the open folder starts no server (covered by the
  `outsideWorkspace` backend check and unit tests); JSON/CSS/HTML rename/format. The test folders `E:\omlsp` and `E:\omlsp2`
  (and the build cache `E:\wt7-target`) are left on disk for manual deletion; the temporary worktree `E:\wt7` was removed.
- [x] **Milestone 8** — Debugger and DAP integration (`feat: add debugger and dap integration`). New `openmind-dap` crate
  (unit tests + 3 ignored real-adapter tests that pass), tar.gz support and debugpy/js-debug manifests in the Runtime
  Manager, `breakpoints` repository, `commands::debug`, the debug frontend above. Validated: fmt, clippy `-D warnings`,
  `cargo test --workspace`, `pnpm lint`, `pnpm test` x3 (749), `pnpm build`. Verified by hand in the built app (fresh
  portable copy `E:\omdbg8\OpenMind Debug`, workspace `My Debug Site` with spaces): the view said "Python debugger is not
  installed yet." with Install Debugger; the install (real download, checksum-verified) enabled Start Debugging; a gutter/F9
  breakpoint on line 3 stopped there (F5) with Locals `msg`/`name`, the call stack `greet`/`<module>`, the yellow paused line
  and toolbar; Step Over moved to line 4 and printed "Hello world" in the Debug Console; a bad expression showed debugpy's real
  error; Continue ended with "The program exited with code 0. / The debug session ended." and no python left. Node: "Node.js
  debugger is not installed yet." + Install (js-debug 1.140.0), breakpoint, paused with locals/`this`/Global and a call stack
  with runtime frames dimmed; Stop left no node process; closing the app during a session left none (2 before, 0 after);
  relaunch restored the breakpoints and started nothing. Interpreters were the system Python/Node (labelled fallback; no
  portable ones installed in that copy). Known limitations: PHP/Xdebug not implemented (message only); no launch.json,
  conditional/log breakpoints, hover evaluate, watch drag/edit, restart-with-changes, multi-session, attach, or TypeScript
  debugging; Ctrl+F5 stays Run Code; portable-interpreter precedence for debugging is unit-tested, not re-run by hand here;
  Step Into/Out, Pause, Restart and Watch were covered by tests and real-adapter backend runs but not clicked by hand; the
  test folders `E:\omdbg8` (and `E:\omdbg` from an earlier attempt), `E:\wt7-target`, `E:\wt8` are left for manual deletion.
- [x] **Milestone 8.1** — Debugger rebase and portable-runtime verification (`fix: merge and verify debugger integration`).
  Milestone 8 (`9102963`) was rebased onto master `d9c09f2` (the workbench frame / windows / PHP web root commit) with four
  conflicts, all additive and resolved by keeping both sides: `CLAUDE.md` (the "Editor windows" and `openmind-dap` entries),
  `src-tauri/src/main.rs` (master had moved the git command list and `file_watch`/`editor_windows` state; only the
  `commands::debug::*` handlers and the `dap` field were kept), `src-tauri/src/window_events.rs` (master moved close handling
  into `shutdown(app)`; `stop_debug` was added to its blocking stop list) and `src/services/ipc.ts` (debug methods
  kept, git declarations already lived elsewhere in master). Validation of the rebased tree in its own worktree: fmt, clippy
  `-D warnings`, `cargo test --workspace`, `pnpm lint`, `pnpm test` x3 (764 tests) and `pnpm build` all clean.
  Verified by hand in the built app (fresh portable copy `E:\omdbg81\OpenMind Debug`, workspace `My Debug Site`, with
  OpenMind portable Python 3.14.7 and Node.js 24.21.0 installed from the Runtime Manager while system Python/Node exist too):
  **Python** — the adapter, the launcher and the debuggee were all `...\runtimes\python\versions\3.14.7\python.exe` (not
  `C:\Python314`); debugpy installed with the view's Install Debugger; a breakpoint on `s = add(x, y)` stopped there (yellow
  line, Locals x/y, call stack `main`/`<module>`); Step Into -> `add` (a, b), Step Out -> back in `main`, Step Over -> next line
  with `s = 3`; a Watch `s` showed the real `NameError` before the assignment and `3` after; Restart replaced all three
  processes and stopped at the breakpoint again; Pause on `while True` stopped in `<module>` (`count` = 14); Continue printed
  `sum 3`/`end` in the Debug Console and ended the session; Stop (Shift+F5) left no python. **Node** — adapter and debuggee were
  `...\runtimes\node\versions\24.21.0\node.exe`; the same steps worked (Step Into `add`, Step Out `main`, Step Over with `sum 3`
  printed, Watch `s` = 3 — `evaluate failed` while `s` is still in its temporal dead zone — Restart, Pause on a `setInterval`
  script (paused inside `processTimers`, a frame with no file), Continue, Stop). **Keys** — F5 started a session and F10 stepped
  over (`Ln 9` -> `Ln 10`, `s` = 3) in both languages when the editor had focus; the earlier F10 failure was a focus problem of
  the test harness; Shift+F5 stops. **Cleanup** — closing the app during a running Python session and during a running Node
  session each left 0 python/node/conhost processes (3 before, 0 after); Registry User and Machine PATH were identical before
  and after; relaunch restored the breakpoints (and the watch expression), started nothing and showed no session. Found and
  fixed: the Runtime Manager said the debug adapters were "In new terminals' PATH" although they inject nothing; it now says
  "Used only by the debugger — not added to any PATH" (with a test). Known limitations: no launch.json, conditional/log
  breakpoints or hover evaluate; PHP/Xdebug not implemented; Step Out lands on the calling line (debugpy) or the next line
  (js-debug), as each adapter reports it; a Node session that ends normally prints "The debug session ended." without an
  exit-code line; Pause shows runtime frames without a file for Node. Left on disk for manual deletion: `E:\omdbg81`,
  `E:\omdbg8`, `E:\omdbg`, `E:\omlsp`, `E:\omlsp2`, `E:\wt7-target`, and the worktree `E:\wt8` after the merge.
- [x] **Milestone 9** — Settings, keybindings, themes and packaging hardening (`feat: add settings keybindings themes and packaging hardening`).
  What landed is described under "Settings, shortcuts and themes (Milestone 9)" (frontend) and `openmind-settings` (backend), and
  "Packaging and startup baseline". Summary: 31 settings in 9 categories with a real consumer each (editor, search, terminal, Run
  Code, Git, language servers, debugger, PHP server/tray, workbench), a Settings page (User/Workspace, search, reset, validation),
  a JSON editor that is just the file in a normal tab (saving applies it and reports problems with line numbers), a Keyboard
  Shortcuts page (list, search, change, remove, reset, conflicts) over `keybindings.json`, Dark/Light/High Contrast/System themes on
  central tokens, a Welcome page with Install Runtimes, Keyboard Shortcuts and Settings cards, and the portable ZIP + per-user
  installer. Validated: fmt, clippy `-D warnings`, `cargo test --workspace` (546 passed, 8 ignored), `pnpm lint`, `pnpm test` x3
  (887), `pnpm build`. Verified by hand in the built app (fresh portable copies under `E:\omset9`, workspace `My Workspace`, every
  path with spaces): Settings from the Welcome card and from Ctrl+,; Font Size saved to `settings/settings.json` and shown as
  Modified/Reset; 500 refused with "Font Size must be between 8 and 40." and the file untouched; the workspace tab wrote
  `.openmind/settings.json` (12) while the user file kept 20, the editor drew at 12 and the User tab said the folder overrides it;
  resetting the workspace value fell back; relaunch kept the theme, tabs and folder; Keyboard Shortcuts: search, Change recorded
  real key events, Ctrl+S was refused for Run Code with the conflict message (Replace/Save/Cancel), Ctrl+Alt+R was saved
  (`-run.code` on Ctrl+F5 + the new key), the old Ctrl+F5 then did nothing, Ctrl+Alt+R ran the Python file, Reset wrote `[]` and brought
  Ctrl+F5 back; themes: Light and High Contrast applied to the workbench, editor and terminal (the terminal reads its own tokens) and
  survived a relaunch, the PHP window followed a change of the setting when it got focus; JSON: Open Settings (JSON) opened the file as
  a tab, a broken edit gave "Settings saved with 1 problem: Not valid JSON (line 2, column 26)…" and undoing it gave "Settings applied.";
  release build + NSIS installer + portable zip built; the copy left no process behind, and Registry User/Machine PATH were identical
  before and after. Real problems found and fixed on the way: the WebView2 profile lived in AppData (above); a half-typed JSON file
  flipped the theme back to the defaults (a file with a syntax error now keeps the last good values in force); the PHP control
  panel's buttons were unreadable in Light (`color: inherit` on a dark button — now a token); several tooltips and hints hard-coded
  shortcuts that stop being true after a remap (they read the live binding); undefined CSS tokens (`--accent-fg`, `--danger-fg`,
  `--button-secondary-fg`...) silently fell back to dark-theme literals — now defined, and a test fails on any new one.
  Known limitations: chord sequences (Ctrl+K Ctrl+S) are not supported, so Keyboard Shortcuts has no default key; only the language
  features (Go to Definition/References, Rename, Format) can be re-bound among Monaco's built-in shortcuts — the Monaco key removal
  for them is unit-tested but was not checked by hand (no language server was installed in the test copies); settings files are plain
  JSON (no comments); a setting edited while the same value is overridden by the workspace shows the value in force, not the user's
  own; a settings file changed on disk is re-read when a window gets focus or when it is saved in the editor, not by a watcher;
  Runtime settings are the Run Code ones (no system-fallback switch yet); the installer was not run; icons/profile/sync are not
  done. Left on disk for manual deletion: `E:\omset9`, `E:\omdbg81`, `E:\omdbg8`, `E:\omdbg`, `E:\omlsp`, `E:\omlsp2`,
  `E:\wt7-target`, `C:\omrel` (release build cache), the empty `E:\wt8`, the worktree `E:\wt9` after the merge, and the old
  `%LOCALAPPDATA%\com.openmindstudio.app`.
- [x] **Milestone 10** — VS Code-compatible extension system foundation (`feat: add vscode-compatible extension system foundation`). New
  `openmind-extensions` crate, `commands::extensions*`, the extension services and the Extensions view (see `openmind-extensions` and "Extensions
  (Milestone 10)" above). Local `.vsix` install (trust warning first, archive traversal refused), enable/disable/uninstall, lazy activation, a Node
  extension host with a `vscode` API subset, contributed commands/menus/keybindings/settings/languages/snippets/colour themes, unsupported points shown
  as unsupported. Known limitations: no marketplace, webviews, custom views, grammars/icon themes (stored as unsupported), no permission model (the host
  has the user's rights), key sequences are not bindable, a disabled extension's language stays registered until restart, `include` in theme files is
  ignored, an extension's `uninstall` keeps its storage folder.
  Verified by hand in the built app (fresh portable copy `E:\omext\OpenMind Studio`, workspace `My Site` with a space, the five sample
  extensions packed with `cargo run -p openmind-extensions --example pack`): the Extensions view had no marketplace (only "Online extension
  marketplace is not available yet."); Install from VSIX (native file dialog) showed the trust warning and the contribution points before
  installing; with no portable Node the view said "Node.js runtime is required for extension host." and offered the machine's Node only as an
  explicit "Use System Node.js" (the log then said "System Node.js at …"); no node process existed until then, and the extension stayed "Enabled"
  (not "Active") until its command ran — Ctrl+Alt+H (contributed keybinding) activated it lazily, showed the message and wrote to its Output
  channel and the host log; Disable moved the folder to `extensions/disabled`, called `deactivate` and the shortcut did nothing; Enable brought
  it back; the configuration extension's setting appeared under its own Settings category, the new value ("Howdy") was written to
  `settings/settings.json` and read by the extension through the F1 palette command; a `.omsample` file got the contributed language (status bar
  "OpenMind Sample" — found and fixed on the way: `DocumentService` only knew a built-in extension table, and files the session restores were
  opened before extensions loaded, so `startExtensions` now runs before `restoreSession`); the theme extension's theme was chosen in the Color
  Theme setting and recoloured the editor, uninstalling it deleted its folder and fell back to Dark; the bad extension showed its activation
  error (toast + "Error" badge) and the app kept running; closing the app left no OpenMindStudio/node/WebView2 process of the copy; relaunch
  showed the enabled extensions still enabled (none active, no node started) and the disabled one still in `disabled/`; Registry User/Machine
  PATH were identical before and after. Left on disk: `E:\omext`, `E:\omset9`, `E:\wt7-target`, `C:\omrel`.
- [x] **Milestone 10.1 (combined)** — Extension marketplace, activity bar views, and API hardening (`e276ef0` `feat: extension marketplace, activity bar views and api hardening`,
  then `fix: finalize extension marketplace and api hardening`). Two sessions worked on the same tree and the work was committed together on purpose (not split). Three parts:
  (1) the security/API hardening described next; (2) the **Open VSX marketplace foundation** — `commands/marketplace.rs`, `extensionMarketplaceService.ts`: search, Popular/Installed
  lists with counts, filter/sort, an extension page, install (the download is checked against Open VSX's published SHA256, then the same trust dialog as a local VSIX) and
  uninstall. **It is a foundation, not a complete marketplace**: Open VSX (open-vsx.org) is the only source, there is no account/API key, no ratings/reviews/publishing,
  no update checks or auto-update, no recommendations, and many VS Code-only extensions will not run (unsupported API). The only network calls are to open-vsx.org:
  **nothing is fetched at launch or when the view is shown** (the view says "Online marketplace results are loaded only when you request them." and offers Load Popular);
  requests happen on Load Popular, a search, opening an extension page or an install; the setting `extensions.marketplace.autoFetch` (**default on since the 14.1 follow-up, at the user's request**: Popular loads when the Extensions view is shown — never at launch; turn it off to go back to "Load Popular" on click) controls loading Popular when the view shows; nothing
  is installed without the trust dialog; (3) the activity bar/tree views described in the next entry; (4) **a user-controlled outside-workspace grant**: `filesystemOutsideWorkspace` is off for every extension by default; the Extension page's Features tab has "Grant access to files outside the workspace" (warning: "This allows the extension to access files outside your open workspace. Grant only for extensions you trust."), `ext_grant_permission` stores it in `.openmind-permissions.json` (`permissions::USER_GRANTABLE` — only that permission can be added by hand, nothing else the manifest doesn't ask for), the host reloads so the extension can retry, and the permission is listed afterwards. Also in this milestone: `package.nls.json` `%key%` titles and `vscode.l10n.t`. Not claimed: full VS Code compatibility, webview support (webview views show an "unsupported" message), ratings/reviews/recommendations/updates in the marketplace, a sandbox (the permission guard is not one).
  What landed is described under "Hardening (Milestone 10.1)" in `openmind-extensions` and in "VS Code API compatibility matrix (extensions)":
  the permission model (request/infer/accept/store/enforce in the host, honestly *not* a sandbox), stricter install validation and limits, host states with
  a bounded automatic restart, activation count/last activation/last error, the Extensions and Extension Host Output channels, shim cleanup and duplicate-command
  protection, theme fallback on disable/uninstall, startup deferral for `"*"` extensions, and the regression pack of ten sample extensions
  (`crates/extensions/tests/fixtures`: command-basic, command-throws, configuration-basic, language-basic, snippets-basic, theme-basic, bad-activation,
  unsupported-api, duplicate-command, permission-denied, plus startup-star for the startup measurement). Verified by hand in the built app (fresh portable copy
  `E:\omext\OpenMind Studio`, workspace `My Site` with a space): the trust dialog listed name/publisher/version, the permissions and the contribution points; the
  contributed command ran (lazy activation, message, host log), Disable removed it (no message, folder in `disabled/`) and Enable restored it; the
  unsupported-api extension's error was shown and logged and the app stayed up; the bad-activation extension showed its error with an "Error" badge, Reload
  Extension Host restarted the host and the good extension still worked; the duplicate-command extension's attempt to take `sampleCommand.hello` was refused with
  "already registered by openmind-samples.sample-command; an extension can't replace another extension's command" and the owner still worked; the permission-denied
  extension got "Permission 'processExecution'/'network'/'filesystemOutsideWorkspace'/'terminal'/'settings' is required for this extension API." for
  child_process, http, fetch, fs, createTerminal, openExternal and getConfiguration; a theme was applied and disabling its extension fell back to Dark; closing the
  app left no node/WebView2 process of the copy; relaunch kept enabled extensions enabled and the disabled one in `disabled/` and started no node; Registry
  User/Machine PATH identical. Known limitations: the permission guard is bypassable by code that goes around Node's module loader (native addons,
  `process.binding`), symlinks inside the workspace can point outside it, `workspaceRead` does not stop a language provider from seeing the document it is
  asked about, `onView` never triggers, permissions can't be changed after install (reinstall to re-accept), and the F1 palette was re-checked in the marketplace/views pass below (an earlier script bug had swallowed F1).
  Left on disk: `E:\omext`, `E:\omset9`, `E:\wt7-target`, `C:\omrel`.
  Marketplace/views pass before merge (built app from e276ef0): Popular loaded from Open VSX, local VSIX install/enable/disable/uninstall, tree-view sample (welcome button,
  items, command click, refresh), a webview view shown as unsupported, a broken view contribution reported without crashing, F1 palette listing and running a contributed
  command. Found and fixed: with two extensions contributing one command id the palette showed the second one's title; the owner (first) now wins (test added).
- [x] **Extension views and editor integration (after 10.1)** — extensions' `viewsContainers.activitybar` become activity bar icons
  (after Extensions; the icon rail scrolls when full, the Manage gear stays) and open a side bar view (`ext:<extension>/<container>` in
  `LayoutService`, falls back to the Explorer when the extension is gone): `crates/extensions/src/views.rs` parses containers, views and
  `viewsWelcome` (with `when`) and reads icons (`ext_read_icon`, .svg/.png inside the extension); opening a view implies `onView:<id>`;
  `host/treeviews.js` gives extensions `window.registerTreeDataProvider`/`createTreeView`, `TreeItem`, `TreeItemCollapsibleState`,
  `ThemeIcon` (the app asks `host/tree` for children/click/expand; elements stay in the host behind handles; `views/*` notifications);
  `ExtensionViewsService` + `ExtensionContainerView` draw trees, welcome text/buttons (`whenClause.ts`: `==`, `!=`, `!`, `&&`, `||` on
  `workbenchState`/`workspaceFolderCount`), a failed activation's reason, and webview views as unsupported. Manifests now read
  `package.nls.json` (`nls.rs`: `%key%` strings) and the host offers `vscode.l10n.t`. Fixed: extension completion kinds were off by one
  since Monaco added `Tool` (27) — Snippet is 28; `extensionProviderKinds.test.ts` checks the table against Monaco by name. Verified in the
  built app: the tree-view sample (icon, welcome + Add Task, tree, expand, click runs its command), a snippet extension (completion and
  expansion in the editor), the command extension from the editor's context menu, and Open VSX's Project Manager (icon, localized titles,
  `when`-picked welcome; its activation stops at the permission guard because it reads VS Code's own `projects.json` under `%APPDATA%`,
  outside the workspace, without `filesystemOutsideWorkspace`). Not done: webview views, views in built-in containers (Explorer, SCM,
  panel), `TreeView.reveal`, checkboxes, drag and drop, item context menus, complex `when` clauses.
- [x] **Milestone 10.2** — Extension UI polish and marketplace reliability (`fix: polish extension marketplace ui reliability`). Fixed the three known rough edges and
  tested the marketplace states. (1) Layout: the Extensions view scrolls as a whole when the window is too short, the notice banner is capped (30%, scrolls) and the growing
  Popular/Marketplace section keeps a minimum height and scrolls, so the Load Popular block can no longer overlap the "Extension host" line. (2) README: a linked image
  (`[![Build](img)](link)`, every badge) now parses as a link with its alt text; images are still never loaded, unsafe link targets stay plain text, no HTML/scripts. (3) Tooltips:
  `useQuietTitle` drops a menu button's native tooltip while it is pressed (gear, Filter, More Actions) so it can't cover the menu it opens. (4) States: not loaded yet ("Online
  marketplace results are loaded only when you request them." + Load Popular), failure with Retry, and "No extensions found for \"query\".". Extension auto-discovery/auto-load and
  lazy activation are unchanged. Verified by hand in a fresh copy (`E:\omext`): launch with the Extensions view active made no network request and started no node; installed
  extensions and the tree-view icon appeared with no manual step after a relaunch; F1 listed the contributed command with the host "Not running" and running it started the
  host; Load Popular, search, an empty search and the YAML page (badges as "[Visual Studio Marketplace] [Build Status] ..." links) worked; the gear menu had no tooltip over it;
  a 700x420 window scrolled instead of overlapping; a normal close left no node/conhost/WebView2/app process; User/Machine PATH unchanged. Known limitations: images in READMEs
  are text only; offline was covered by a unit test (a rejected request shows the retry state), not by cutting the network; the outside-workspace grant was not re-run by hand.
- [x] **Milestone 10.3** — VS Code API compatibility: TextEditor.edit and Status Bar (`feat: add text editor edit and status bar extension APIs`). New host modules `host/editors.js`
  (documents, editors, edits) and `host/statusbar.js`; app side `ExtensionEditorService` (edits/selection/reveal), `StatusBarItemsService` + `ExtensionStatusItems`, `hostEdits.ts`, `BufferManager.applyHostEdits`.
  **Documents/editors**: a `TextDocument` is a live view of the app's copy (`uri`, `fileName`, `languageId`, `version`, `isDirty`, `lineCount`, `eol`, `getText(range?)`, `lineAt` (TextLine),
  `offsetAt`/`positionAt` (real line-break lengths, CRLF = 2), `validateRange/Position`, `getWordRangeAtPosition`); `activeTextEditor`/`visibleTextEditors` exist only for a text tab of a
  saved file (undefined for a Markdown preview or an untitled buffer — untitled buffers are not shared with the host); `selection(s)` come from Monaco (debounced `host/selectionChanged`,
  `onDidChangeTextEditorSelection`), can be set, `revealRange` scrolls, `options` = tab size/insert spaces. **`TextEditor.edit`**: the callback collects `insert/replace/delete` (ranges are
  validated/clamped to the document), overlapping ranges throw "Overlapping ranges are not allowed!" (as VS Code) before anything is sent, the batch goes as one `editor/applyEdits` request
  with the document version the extension saw; the app refuses (`edit` returns `false`, the reason is logged as an Extension Host line) when the file isn't open, is shown only as a preview,
  the version is stale or typing hasn't reached the host yet; otherwise it applies all edits as ONE undoable step to the open buffer (never the disk — Save is unchanged), the buffer is
  dirty, the host is told the new text and version *before* the answer, so `document.version`/`isDirty`/`onDidChangeTextDocument` are current when `edit` resolves. `setEndOfLine` is
  unsupported. **`WorkspaceEdit`** (`insert/replace/delete/has/get/set/entries/size`) and `workspace.applyEdit` work on documents that are already open (needs `workspaceWrite`; an unopened file
  returns false with a logged reason); `createFile/deleteFile/renameFile` throw the unsupported message. **Permissions decision**: `TextEditor.edit` needs no permission (it edits a buffer the
  user opened); with a folder open, editing an open file *outside* it needs `filesystemOutsideWorkspace` (the existing grant), with no folder open open files are editable. **Status bar**:
  `createStatusBarItem(alignment?, priority?)` (and the `id, alignment, priority` form); text, tooltip, command (string or `{command, arguments}`), `ThemeColor` colour/backgroundColor from a fixed
  list (`statusBarItem.errorBackground/warningBackground`, `errorForeground`, `editorError/Warning/Info.foreground`; any other colour is ignored with a warning), `show/hide/dispose`. Items are
  plain React text (never HTML), `$(icon)` markers are dropped, long text is cut with an ellipsis and the tooltip has it all; higher priority = further left; a click runs the command (an
  unregistered one shows an error); ids are `<extension>#status-<n>`, never reused in a host process, an update for a disposed/unknown/other extension's id is ignored; items disappear when the
  host stops, crashes or restarts, and when their extension is disabled or uninstalled. Also fixed on the way: **Restart Extension Host now repeats the start-up wake-up** (`*`,
  `onStartupFinished`), as does an automatic restart, so those extensions' items come back; and **enabling** a disabled start-up extension wakes it at once (it used to wait for the next start).
  Samples: `editor-edit-basic` (Ctrl+Alt+F2: uppercase the selection or insert `[inserted]`; also an `applyEdit` command), `editor-edit-overlap` (F3), `statusbar-basic`, `statusbar-dispose`,
  `unsupported-api-still-clear`. Tests: `tests/editor_status.rs` (real Node, the test plays the app), `hostEditorApi.test.ts` (the shim run in-process), `extensionEditing.test.ts`. Verified by hand
  in a fresh copy (`E:\omext`, folder `My Site`): selecting `hello` and running the command gave `HELLO` (dirty, version 1 -> 2), with no selection `[inserted]` went to the cursor, Ctrl+S wrote both
  to disk, the overlap sample said `overlap rejected: Overlapping ranges are not allowed!; buffer unchanged=true`, the status bar items appeared at start-up (one left, one right cut with an
  ellipsis and a warning colour), clicking the left one ran its command and changed its text, disabling the extension removed both, enabling brought them back at once and Restart
  Extension Host left exactly one pair; a normal close left no node/conhost/WebView2/app process and User/Machine PATH were unchanged. **Not done / limitations**: text decorations,
  `insertSnippet`, `setEndOfLine`, edits of documents that are not open, file create/rename/delete edits, `contentChanges` in change events, editors other than the active one, `TextEditor.viewColumn`
  other than 1, untitled documents, status bar `accessibilityInformation`/arbitrary colours/icons; the read-only Markdown preview refusal is covered by unit tests, not by hand; webviews,
  terminal, debug and notebook APIs remain unsupported; this is a subset, not full VS Code compatibility.
  Follow-up fix (after 10.4): the host is told the active tab when it starts or restarts (`HostDocumentSync.currentActiveId`, hydrated in `initial()`/`start()`), not only on a tab change, and an extension webview panel covering the editors hides the active editor from extensions (`editorsCovered`/`refreshActive`), so Restart Extension Host no longer loses `activeTextEditor`.
- [x] **Milestone 10.4** — VS Code API compatibility: Webview API foundation (`feat: add secure webview extension api foundation`). New host module `host/webviews.js`, Rust `openmind_extensions::webview`
  (local resources) + `ext_webview_read_resource`, app side `WebviewService`, `webviewHtml.ts` (the sanitizer) and `WebviewPanels.tsx` (sandboxed frames). **Supported**: `window.createWebviewPanel(viewType, title,
  showOptions, options)` -> `WebviewPanel` (`title` get/set, `viewType`, `webview`, `visible`, `active`, `viewColumn`, `reveal()`, `dispose()`, `onDidDispose`, `onDidChangeViewState`), `Webview` (`html` get/set,
  `postMessage`, `onDidReceiveMessage`, `asWebviewUri`, `cspSource`, `options`), options `enableScripts` (default false), `retainContextWhenHidden`, `localResourceRoots`; the page gets a tiny
  `acquireVsCodeApi()` (`postMessage`, `getState`, `setState`; one call per page). **Unsupported (they throw the "not supported" message)**: `enableCommandUris`, `portMapping`,
  `registerWebviewPanelSerializer` (panels are not restored), `registerWebviewViewProvider` (**webview views stay unsupported**; the tree-view sample's webview view still says so), `WebviewPanel.iconPath` (accepted, ignored), forms (no submission). **Architecture and security**: a panel is an `<iframe sandbox srcdoc>` inside the editor area (an overlay with its own tab strip; the
  "Editors" button hides it without closing, a "Webviews (n)" button brings it back). The sandbox never has `allow-same-origin` (opaque origin: no access to the app, its storage, cookies, Tauri or the disk), no popups,
  no top navigation, no forms, `allow-scripts` only when `enableScripts` is true, `referrerpolicy=no-referrer`. The HTML is rewritten by `prepareWebviewHtml` before it is shown: a CSP goes first (`default-src 'none'`,
  images/fonts/media/styles only inline or `data:`, `script-src 'none'` unless scripts are enabled then only inline, `connect-src`/`frame-src`/`object-src`/`base-uri`/`form-action 'none'`; the page's own CSP can only
  narrow it); `<base>`, frames, objects, embeds and meta-refresh are removed; scripts and `on*` handlers only stay when scripts are enabled; every URL is either an `asWebviewUri` resource inlined as data, an inline
  png/jpeg/gif/webp/svg `data:` image (img only), a `#fragment`, or an ordinary link that can't open anything; remote (`http(s):`, `//`), `file:`, `javascript:`, `vbscript:`, `blob:`, other `data:`, relative paths, `srcset`
  and CSS `@import`/`url()` to any of those are dropped and listed in a notice above the page and in the Extension Host output. **No remote content is ever loaded, even with the network permission** (a decision, not an
  oversight); nothing is fetched at launch. **Local resources**: `asWebviewUri` only accepts `file:` Uris inside the panel's roots (default: the extension's own folder; `..` is normalised away, so traversal throws
  "The file is outside this webview's localResourceRoots"); a `localResourceRoots` entry outside the extension needs `workspaceRead` (inside the open folder) or `filesystemOutsideWorkspace`, otherwise
  "Permission '<permission>' is required for this webview resource." — checked in the host and again in Rust (`RootPolicy`: canonical roots, the file must lie inside them, a short list of file types
  (png/jpg/gif/webp/svg/ico/css/js/json/txt/woff/woff2/ttf/otf, never HTML), regular files only, 5 MB cap; the addresses are `openmind-webview-resource://panel/<base64url path>`). **Messages**: JSON text only
  (functions/`undefined` rejected), at most 1 MB each way, extension -> page through `contentWindow.postMessage`, page -> app only from that very frame (`event.source`) carrying its random per-frame token; a panel
  belongs to one extension (ids `<extension>#wv-<n>`, checked on every event), at most 20 panels. **Life cycle**: closing a tab disposes the panel and the extension gets `onDidDispose`; disabling/uninstalling the
  extension, and a stopped/crashed/restarted host, remove its panels; a deactivating extension disposes its own. Panels are not restored after a restart. Basic panel creation needs no permission. Samples:
  `webview-panel-basic`, `-message`, `-local-resource`, `-blocked-remote`, `-dispose`, `-unsupported-api-still-clear`. Tests: Rust `webview.rs` (roots, traversal, types, size, permission messages) and
  `tests/webviews.rs` (real Node), `webviewHtml.test.ts` (the sanitizer), `webviewService.test.ts`, `webviewPanels.test.tsx`. Verified by hand in a fresh copy (`E:\omext`, folder `My Site`): the basic panel showed
  its HTML with the script not running; the message sample's button got "Reply: pong 1" from the extension; the local-resource sample drew its CSS and image and blocked the `..` path; the remote sample showed
  nothing remote, listed what was blocked and showed the permission message for an outside root; closing a tab disposed the panel; Restart Extension Host and disabling the extension removed the panels;
  TextEditor.edit and the status bar still worked; Load Popular loaded only after the click; a normal close left no node/conhost/WebView2/app process and User/Machine PATH were unchanged. **Limitations**: not
  VS Code parity — no webview views, serializers/restore, command URIs, port mapping, `vscode-resource`/`vscode-webview` schemes, remote content, `<iframe>`/`<object>` inside a page, forms, service workers or
  `localStorage` for the page, CSP differences (ours is always applied first), the VS Code theme CSS variables/classes, `retainContextWhenHidden` keeps the page alive but scroll/focus state is the browser's, and
  any extension that relies on those will fail or look plain; the frame's isolation is the browser sandbox, not more.
- [x] **Milestone 10.4.1** — Webview security and UX hardening (`fix: harden webview security and ux`). Not a feature milestone: the Milestone 10.4 Webview API is still a **subset** (no webview views, no command URIs,
  no VS Code parity), remote content stays blocked, there is no Node integration in a page and the frame's isolation is the browser sandbox.
  **Security audit** (sandbox, script switch, HTML rewriting, CSP, protocols, resources, messages, cleanup) found no way out, and added defence in depth: `normalizeUrl` strips tabs/newlines/control characters before every scheme
  or resource decision (`java\nscript:`, `da\tta:`), at most 200 local resources and 20 MB inlined per page, the saved page state is embedded as a JSON *string* parsed inside the page (never script text; `<` escaped),
  the host refuses UNC (`\\server`, `//server`) and NUL paths in `asWebviewUri` before resolving them, and the app-side caps: HTML 5 MB (`webview/html` above that is ignored + error), title 200 and view type 100
  characters (clipped), page state 1 MB and valid JSON only (else refused), messages 1 MB, messages queued for a page that hasn't loaded are capped, 20 panels. The frame has `allow=""` (no camera/clipboard/etc.),
  `referrerpolicy="no-referrer"`, `sandbox` without `allow-same-origin`/`allow-forms`/`allow-popups`/`allow-top-navigation`; in WebView2 the sandboxed frame is its own out-of-process target (seen in the DevTools target list).
  **Tauri CSP decision — Option B: `csp` stays `null`.** Tried for real: a partial app CSP (`object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`) is answered by Tauri as
  `script-src 'self' 'sha256-…'` plus those directives, and a `srcdoc` frame **inherits the embedding document's CSP**, so every extension page script was blocked (the Count button did nothing; `acquireVsCodeApi` was undefined) —
  reverted. What protects the app instead: the UI is rendered by React (no HTML strings, no `dangerouslySetInnerHTML`), the Markdown preview builds elements, and a webview page can't reach the app (opaque origin,
  no same-origin, token + `event.source` checked messages) and carries its own strict CSP first. **Follow-up:** to get a strict app CSP, serve the webview from its own origin (a custom protocol URL in `src`, not `srcdoc`) so the app CSP
  is no longer inherited, then add `default-src`/`script-src 'self'` to `tauri.conf.json` and re-test Monaco, xterm, the extension icons and the Open VSX pages.
  **Local resources** (Rust `webview.rs` tests added; host and app both check): roots are canonicalized, the extension folder is the default root, a sibling folder sharing a name prefix is outside, `..`/encoded `%2e%2e`/backslash and
  mixed slash names never lead out (a percent-encoded name is just an odd file name and is not decoded), a link pointing out of the root is refused (the test skips where links can't be made), case differences on Windows stay inside,
  `file:stream` and UNC names are refused, spaces/Unicode paths work, only the short file-type list loads (no HTML/executables, no directory listing), 5 MB cap, and a missing file names the file and the reason.
  **Remote content** stays blocked even with the `network` permission accepted (verified by hand with an extension that asked for it: the install dialog showed Network "High risk", the page showed the blocked-content notice
  and the app's process tree, WebView2 helpers included, made no connection to example.com; the only remote connection seen was one WebView2 browser-process connection to a Microsoft address that exists at launch too).
  **`retainContextWhenHidden`** — fixed a real defect: the frames were remounted when the Editors button was toggled (the panel tree changed shape); the frames now live in one stable tree. Behaviour, verified by hand with the
  counter sample: a retained panel keeps running while hidden or unselected (runtime counter 3 survived a tab switch and Editors → Webviews (3)); a plain panel is taken out of the page when it isn't shown and drawn again when
  it comes back (runtime counter back to 0), keeping only what the page saved with `setState`. **`setState`/`getState`**: per panel (nothing is readable by another panel or extension), JSON only, 1 MB, held in the
  application's memory for the panel's life, cleared when the panel is disposed, the extension is disabled/uninstalled, the host restarts or the app closes — **it does not survive an app restart** (no webview serializer).
  **UX**: the tab strip ellipsizes long titles (full title in the tooltip), tabs shrink instead of overflowing, the close target is 22 px, the active tab is underlined, tabs are keyboard reachable (Arrow keys move, Enter/Space
  select, Delete closes; selecting a panel focuses its page, so arrow keys then belong to the page), focus rings, the "Editors" and "Webviews (n)" buttons, the blocked notice lists five entries and "…and N more", and panels
  hide with the `hidden` attribute. **Verified by hand in the built app** (fresh copy `E:\omext\OpenMind Studio`, workspace `My Site` with a space; a debug build with WebView2 remote debugging was used only to take
  measurements and to open the folder): no marketplace fetch at launch (the Load Popular button, no request); **local VSIX install through the UI** — Install from VSIX… → native file dialog → trust dialog (permissions,
  contribution points) → Install → the extension appeared in Installed at once, F1 listed its commands before any host existed, the first command started the host lazily and opened the webview, the extension was still
  there after a relaunch, Restart Extension Host closed every panel (no stale frames), Disable closed the panel and moved the folder to `disabled/`, Uninstall (confirm dialog) removed the folder, the panel and its
  frame; the tree-view sample added its activity bar icon immediately after install; a normal close left no OpenMindStudio/node/conhost/WebView2 process of the copy and User/Machine PATH were identical before and
  after. **Not re-clicked by hand**: TextEditor.edit after a host restart, status bar items, the `filesystemOutsideWorkspace` grant and the unsupported-API message are covered by the existing automated tests (all
  green) and were verified by hand in Milestones 10.3/10.4; F1 doesn't reach the app while a webview page has the keyboard — click Editors first. Tests: TS webviewHtml/webviewService/WebviewPanels (obfuscated
  schemes, budget, safe state embedding, caps, per-panel state, focus, retain frame identity, keyboard/long titles), Rust `webview.rs` (path cases above), integration against real Node
  (`as_webview_uri_refuses_every_way_out…`, `retain_context_is_reported_per_panel…`) and the new sample extensions `webview-state-counter` and `webview-path-tricks`. **Limitations**: the Webview API remains a subset
  (webview views, serializers, command URIs, port mapping and remote content are not implemented), the app has no Tauri CSP (see above), page state is lost on app restart, and a hostile extension still runs with the user's
  rights in its Node host (the permission guard is not a sandbox). Left on disk for manual deletion: `E:\omext`, `E:\wt10-target`.
- [x] **Milestone 11** — Universal read-only preview system (`feat: add universal read-only file previews`). New `openmind-preview` crate (see above; 14 tests, malformed/encrypted/oversized
  inputs included), `commands::preview`, `FilePreviewService` + the preview tab kind + `FilePreviewView` (see "Read-only file previews"), pdf.js (`pdfjs-dist`) for PDF. **Preview only — nothing here edits,
  converts, uploads or runs anything**: no OCR, no online converter or upload, no Office macro execution, no PDF editing/annotation/forms/signing, no LaTeX compilation (no pdflatex, no TeX Live),
  no browser execution of HTML, no full Word/Excel rendering. **Formats**: PNG/JPG/JPEG/WebP/GIF/BMP/SVG (zoom, fit, actual size, pan by dragging, pixel size); PDF (page navigation, zoom, fit width,
  reload, encrypted and damaged files reported); DOCX (text, headings, list items, tables, metadata — "This DOCX preview is read-only and may not exactly match Microsoft Word layout."; pictures are only counted;
  a macro project is reported, never run); XLSX (sheet list, one sheet at a time, first 1 000 rows × 100 columns with the real totals, cached values or unevaluated formula text — "This spreadsheet preview
  is read-only and does not evaluate formulas or macros."); CSV (delimiter detection for , ; tab |, quotes, first 1 000 rows, partial read of files over 8 MB); Markdown (the existing safe renderer: raw HTML and
  scripts stay text, images show their alt text only — **local images are not loaded**); HTML (sanitized, sandboxed, scripts/handlers/frames/remote content blocked with a notice); LaTeX (structured source
  view: "LaTeX compilation preview is not available yet. This is a read-only source preview."); unsupported types ("Preview not available for this file type."), binary files ("This file appears to be
  binary and cannot be previewed safely.") and files over their limit (a message with both sizes, bytes never read). **Security model**: every path is validated in Rust; limits are enforced while reading;
  Office files are read in memory with capped parts and DTDs refused; SVG/HTML/Markdown are never injected as markup into the app (SVG as `<img>`, HTML through `prepareWebviewHtml` with scripts off inside an
  empty-`sandbox` frame, Markdown/DOCX/LaTeX/sheets as React elements); no network request is made by any preview (pdf.js loads its worker, fonts and cmaps from the app itself); no temp or cache file is written
  at all (verified: `cache/` stayed empty), so there is nothing to clean up. **Setting**: `preview.allowRemoteContent` was **not** added — remote content is always blocked and a switch nothing
  implements would be a fake control (the safe default the spec asks for is the only behaviour). **Limitations**: DOCX/XLSX are partial (no layout, images, comments, styles beyond headings, charts, date formats,
  hidden rows/columns); a PDF is shown one page at a time (no continuous scroll, text selection, search or thumbnails); pdf.js needs a WebView2 that supports its features; previews of HTML/LaTeX/CSV show the
  *saved* file, not the unsaved buffer; text formats open in the editor by default (Open Preview to render); "Open Externally" is **not** offered (the app has no such command; adding one would launch
  Word/Excel, which can run macros); previews are not added to Recent Files; session restore reopens preview tabs (verified) but not their zoom/page/sheet; a file that changes on disk is only re-read by Reload
  Preview (the file watcher doesn't refresh previews yet). **Extensions**: preview tabs are never `activeTextEditor`, `TextEditor.edit` finds no editor while one is active and works again on switching back
  (verified by hand and by tests); auto-load, F1 before the host starts, status bar items, webview samples and "Load Popular only after a click" were re-checked by hand. **Verified by hand in the built app**
  (fresh portable copy `E:\omprev\OpenMind Studio`, workspace `My Files` with a space, generated samples incl. a 40 MB log): PNG zoom in/out/fit/actual and dimensions, evil SVG (script and external image
  did nothing; the notice named them), a 3-page PDF (next page to 3/3, zoom 125%, canvas label), encrypted / truncated / fake PDFs (clear messages), DOCX (headings, list, table, metadata, limitation, `<script>`
  text kept as text), a DOCX with a macro part (reported), a broken DOCX, XLSX with formulas and a second sheet (tab click loaded it), an XLSX with a macro part, a 3 001-row CSV (counts, delimiter `;`, 1 000 of 3 001
  rows message, 1 000 table rows drawn), Markdown with raw `<script>`/`onerror`/`javascript:` (0 script/img/javascript links in the DOM, page title unchanged), HTML (sandbox="", 0 script/handler/iframe/remote in
  the frame, notice list), TEX, a binary file, the 40 MB log (message, no freeze), Open as Text (tex preview replaced by the editor), context-menu Open Preview, preview tabs restored after a relaunch, the three
  extension samples installed through Install from VSIX (trust dialog each), `activeTextEditor` absent on a preview tab ("no active text editor") and `edit applied (version 1 -> 2, dirty=true)` on a text tab, the
  Sample Status status bar items, the webview sample, Load Popular not fetched until clicked; a normal close left no OpenMindStudio/node/conhost/WebView2 process of the copy and User/Machine PATH were identical.
  Real bugs found and fixed on the way: CSV opened every row one column too wide after a delimiter (quote handling), an SVG `<foreignObject/>` self-closing tag slipped past the notice, the preview toolbar/pane
  grew wider than the editor group (flex sizing), and a stalled test harness (not the app). Tests: 14 Rust (`kind`, `path`, `inspect`, `docx`, `xlsx` incl. macros, DTD, limits, malformed), TypeScript for the
  parsers (CSV, LaTeX, SVG and HTML notices), the service (routing, models, limits, errors, stale loads, zoom, pages), the workspace (tabs, no dirty/save, Open as Text, restore, extensions' active editor and edit
  refusal), the commands and the view (every format, controls, messages, sanitizing). Roadmap renumbered: indexed search is now Milestone 12, AI providers 13, icon themes/profiles/signing 14.
- [x] **Milestone 12** — Indexed workspace / symbol / reference search (`feat: add indexed workspace symbol and reference search`). `openmind-search` gained `index/`
  (`ignore` + bundled `rusqlite`, SQLite WAL + an FTS5 trigram table, one database per workspace at `data/search-index/<hash>.sqlite`, local only, no network): `crawl` (the
  `ignore` walker, `.gitignore`, `.openmindignore`, `search.indexing.exclude`, built-in skips `.git node_modules target dist build .next vendor .venv __pycache__` ..., never follows
  symlinks, every path checked to lie inside the root), `text` (binary/text sniff, language), `symbols` (line-based **heuristic** extractors for TypeScript/JavaScript, Python, PHP, Rust,
  Markdown headings and JSON keys; containers tracked), `store`, `sync` (incremental pass by size+mtime in batches; `apply_changes` for watcher batches and saves), `query`
  (`search_files` fuzzy/glob/path ranking with highlights, `search_text` = FTS prefilter + regex/whole word/case, `search_symbols`, `file_symbols`) and `IndexManager` (start/refresh/
  rebuild/clear/cancel/status, `index:status` events, stopped on window close). Defaults: 1 MiB per file, 256 MiB total, `.gitignore` on, hidden files off. Settings: `search.indexing.enabled|
  exclude|maxFileSizeKb|useGitignore|indexHiddenFiles` (user + workspace); there is no follow-symlinks setting because links are never followed. Tauri: `commands::index`
  (`index_*`, `search_*_indexed`, `search_file_symbols`), the watcher feeds the index (`apply_watch_batch`), a saved file is `index_touch`ed. Frontend: `WorkspaceIndexService`,
  `FileSearchService`, `SymbolSearchService`, `ReferenceSearchService`, `QuickOpenService`, `SearchPanelService`, `searchWiring.ts` (commands `go.toFile` Ctrl+P, `go.toSymbolInWorkspace`
  Ctrl+T, `search.show*`, `search.refresh/rebuild/clearIndex`, `search.cancelIndexing`); the Search view has Files / Text / Symbols / References tabs and an index bar, the status bar shows
  the index state, `SearchService` uses the index and falls back to the disk walk (results say "from the index"). **Find References (Shift+F12, now app-owned)**: language server first,
  otherwise a **labelled "Text-based references"** whole-word text search — not semantic. Monaco's outline gets an index-based symbol provider only when no language server handles the file.
  **Privacy**: the index holds project text on the local disk, inside the app folder; *Clear Search Index* deletes it, nothing leaves the machine. **Limitations**: symbols are heuristics (not
  a parser; no LSP workspace/symbol use), references are text matches, PDF/DOCX/XLSX and other previews are not indexed, nested `.gitignore` files are honoured in the full pass only,
  files outside the open folder are not indexed, no semantic/AI search (Milestone 13). Verified by hand in a fresh copy with a path containing spaces: background indexing (ignored
  folders excluded), Ctrl+P (fuzzy, glob, path), text search options and click-to-line, incremental updates (create/edit/rename/delete/save), symbol search and open, text-based references,
  index persisted across relaunch, clean close with no leftover process. The three sample extensions were **not** re-installed by hand this time (the native file dialog could not be driven);
  Extension System and previews are covered by their automated tests, which stay green. Left on disk: `E:\omidx`, `E:\wt12-target`.
- [x] **Milestone 13** — AI provider plugin architecture (`feat: add ai provider plugin architecture`). New `openmind-ai` crate (see above), `commands::ai`, the frontend AI services and UI
  (see "AI providers and chat (Milestone 13)"), the extension contribution point `contributes.aiProviders`, five `ai.*` settings. **Providers**: Claude (Anthropic Messages API), OpenAI /
  any OpenAI-compatible endpoint (the custom endpoint), Gemini, and *local* (an OpenAI-compatible server on this computer, e.g. Ollama/LM Studio — OpenMind runs no model itself, and
  a local provider is refused unless its address is loopback). Chat with streaming, Stop, error display and Retry for all four; connection test = list models; embeddings are an interface
  only (`embed_text`, `list_embedding_models`; OpenAI-compatible/Gemini/local), used by nothing — no RAG, no vector store, no workspace embeddings. **The AI panel appears only when a
  provider is enabled**: no provider (or `ai.enabled` off) means no activity bar item, no side bar panel, no disabled placeholder, no AI command in the palette/menus/context menu
  (only "AI Providers..." in the Manage menu, which opens the manager dialog, exists); a provider from an extension follows the extension (disable/uninstall -> gone at once, enable ->
  back; a crash or an unavailable host doesn't matter because the extension contributes *data* and OpenMind's own client talks to the provider). **Extension model**: `contributes.aiProviders`
  entries (`id`, `name`, `type` = claude | openai-compatible (`openai`, `custom`) | gemini | local, `capabilities`, `defaultModel`, `models`, `baseUrl`, `description`) are read by
  `openmind-extensions` (listed as *supported*, unusable entries reported); the API key is never given to extension code (there is none involved) and the extension has no way to read it.
  Not supported for a provider contribution: a per-provider configuration schema (the fields are fixed: endpoint, model, key), an icon, a custom activity view (the panel is OpenMind's own).
  **Privacy/security**: no request at launch or in the background (nothing but a local file read; verified with a mock server that saw no request and the app folder had no `data/ai` until
  used); every request starts from Send, an action button or Test connection; online providers ask first (provider, host, content kind, size); no automatic project scan, file upload or terminal
  upload; no telemetry; keys are DPAPI-encrypted (`dpapi1:` in `editor_settings`, verified in the database) — on a non-Windows build they would be stored as they are (the same limit as the
  MariaDB password) —, never returned to the UI, logged, put in an error, in a URL (Gemini uses a header) or in `providers.json`; endpoints are https (http only for this computer), no
  redirects; conversations stay in `data/ai/conversations.sqlite` (created on first use, off with `ai.saveConversationHistory`, cleared from the panel or the manager). **Tests**:
  Rust — 23 unit tests (request shapes for all three wire formats, SSE parsing, kinds' names, endpoint rules, registry add/update/delete/enable, conversation store incl. reopen,
  redaction) and 10 mock-server tests (`127.0.0.1`, no real API: streaming OpenAI/Claude, Gemini whole answer with the key out of the URL, provider error mapped and redacted, dead
  server, cancellation returns quickly, key required unless local, disabled provider refused, model listing, embeddings), `no_key_in_logs.rs` (every log line of a real run), extension
  contribution parsing and a sample extension (`ai-provider-basic`, `ai-provider-mock`), `provider_offered` (an extension's provider is refused by the backend while the extension is off);
  TypeScript — provider service (panel visibility rules, extension enable/disable/uninstall, configuration, key never kept, test), chat service (confirmation, local vs online, large
  messages, streaming, Stop, error + Retry, persistence on/off, history, long-conversation warning, declined draft restored), actions (selected-code needs a text editor, preview is not
  one, terminal selection, preview text extraction, insert), wiring (commands registered/unregistered with the provider), message parsing, `EditorService`/`TerminalService` additions,
  component tests (`aiViews.test.tsx`) and an app-level test (`App.ai.test.tsx`: no provider -> no AI item, enabled -> panel, disabled -> Explorer, confirmation names the provider, key
  prompt, first provider from the manager). **Verified by hand in the built app** (fresh portable copy `E:\omai`, workspace `My Project` with a space, a mock OpenAI-compatible server on
  127.0.0.1:18080 driven through the WebView2 debugging port): launch showed no AI item and created no `data/ai` and the mock saw no request; a provider added from the manager
  (Manage > AI Providers...) made the AI item appear; Test connection listed the mock's models; a message streamed in and was rendered with a code block; the connection dropping showed the
  error with Retry, which worked; Stop cancelled a slow stream and kept the text; Explain Selected Code sent the selection with file, language and lines; Insert put the code into the
  buffer (unsaved); an online provider (`https://api.example.com`) asked "Send to Online Example? This will send your message (about 32 characters) to Online Example (api.example.com). It
  leaves this computer." and Cancel sent nothing; the key field was a password field and the key was in the database only as `dpapi1:...` (not in `providers.json`, not in the log);
  history and providers survived a relaunch with no request at start; turning both providers off removed the AI item and the panel fell back to the Explorer, turning one on brought it
  back; an extension's provider (copied into `extensions/installed`) appeared with the extension, Disable (Extensions view) removed the AI item at once, Enable brought it back,
  Uninstall removed it again and left the provider deletable; the Extensions view still said nothing had been fetched from Open VSX until Load Popular. Real problem found by hand and fixed:
  `serde`'s `kebab-case` spelled the kind `open-ai-compatible`, so saving an OpenAI-compatible provider failed (a regression test now pins every kind's spelling). Also fixed after the manual pass:
  text typed before a declined confirmation is put back in the message box, an extension's provider whose extension was uninstalled can be deleted, the provider/model row wraps in a narrow side bar.
  **Known limitations**: an API-key-less remote provider isn't offered (a key is required unless the address is on this computer); no vision, tool calling, agent mode, RAG, embeddings UI or
  OpenMind AI provider; streaming stops only when the answer or the time limit ends the worker thread (the wait itself stops at once); conversation search/rename don't exist; the
  provider list is one file with no locking across two windows; Claude/Gemini/OpenAI model names come from the user or the connection test (no built-in list); the
  TextEditor.edit/status bar/webview samples and the preview tabs were re-checked by the automated tests (all green) but **not** re-installed by hand this time (the native file dialog
  can't be driven). A preview tab in front disabled every selected-code action with "A preview is not a text editor. Switch to a text file." and Summarize Current Preview said images are never sent; the search index and the image preview still worked; a normal close left no app/node/conhost/WebView2 process of the copy and User/Machine PATH were identical before and after. Left on disk: `E:\omai`, `E:\omidx`, `E:\wt12-target`.
- [x] **Milestone 14** — Language, framework and app stack support (`feat: expand language framework and app stack support`). New `openmind-language` crate (21 unit + 31
  integration tests over real temp folders), `commands::language`, the frontend under `src/services/language/` and the Project & Language Status dialog (see above). **Practical, honest support —
  not "every language"**: ~55 registry entries with per-language levels, project detection with confidence/evidence/ambiguity, project-local > portable > system tool lookup, formatter/linter
  routing, run/build/test/lint/install commands generated from the folder and typed into a *new* terminal only on a click, editor grammars for languages the editor didn't colour, and a disabled
  button with a visible reason wherever a runtime, SDK or platform is missing (iOS off macOS, Windows-only builds). Nothing is installed, downloaded or executed to detect; PATH/Registry untouched.
  **Known limitations**: language servers other than OpenMind's six (rust-analyzer, gopls, clangd, JDT LS, OmniSharp, Vue/Svelte/Astro/Tailwind/YAML/Docker/SQL/GraphQL) are detected only; no
  emulator/device manager, signing or store publishing; no notebook editor; no automatic runtime install; tool versions aren't checked; each command opens a new terminal; format/lint run through
  the terminal on the saved file (the LSP Format Document is unchanged); symbols/frameworks are detected from marker files, not parsed. Left on disk: `E:\omlang`, `E:\wt14-target`.
  **Verification pass (rebuilt debug app from the final tree, fresh-ish copy `E:\omlang`, workspace `My Projects` with a space)**: clicking a command opened a new terminal in the project's folder and
  typed `cargo run` (output `hi`); Format Document With Tool typed `& 'C:\Program Files\Go\bin\gofmt.exe' -w '<file>'` for a Go file, and for `app.ts` said "No formatter found for TypeScript ... Prettier: Add it to
  the project (`npm i -D prettier`) — OpenMind doesn't install it. Biome: ..."; Run Linter did the same for ESLint, `query.sql` had the item disabled ("No formatter is known for SQL."), a preview tab
  disabled it ("Open a text file first (a preview can't be formatted)."); command lists were checked for Android, Django, Docker Compose, .NET (disabled: ".NET SDK not found ..."), Electron, React Native/Expo
  (iOS disabled: "iOS builds require macOS and Xcode."), FastAPI (uvicorn disabled with its reason), Flutter, Go, Laravel, Next.js, Rust, Tauri; the current-file section showed gopls "Found on this computer, but
  OpenMind can't start this language server yet" and "LSP not configured: install it from Language Tools" for TypeScript/JSON/HTML; an image opened as a preview tab; the search index answered a text search ("from
  the index"); the AI item was absent with no provider, appeared when one was added, vanished when it was disabled and came back when re-enabled; the Extensions view fetched nothing until Load Popular (no connection
  from the app's process tree before the click, Open VSX's after it); a normal close left no app/WebView2/node process and User/Machine PATH were byte-identical. Not re-done by hand: symbol/reference search, the
  native VSIX dialog (can't be driven — covered by automated tests). Found and fixed: the npm label "npm tauri dev" now reads "npm run tauri dev".
- [x] **Milestone 14.1** — Cross-language and multi-stack integration QA (`fix: stabilize mixed language workspace support`). Verification-only phase with two small bug fixes, run on a
  nine-project workspace under a path with spaces (plain web, Vite + React, Python + JSON, Python + C++/CMake, Tauri, Laravel, Rust + JSON + SQL, Go + Docker Compose, Flutter + Android + iOS).
  **Bugs found and fixed**: (1) `language_file_status` compared a `std::fs::canonicalize` root (Windows `\?\` prefix) with a `dunce`-normalised file, so **no file in a sub-folder was ever matched to its
  project** — project-local tool lookup (`node_modules/.bin`, `.venv`) and the folder a whole-project linter/formatter runs in were wrong (`cargo clippy` ran in the workspace root); both paths now use
  `path_safety::normalize_path` (regression test in `commands::language`, fails without the fix). (2) A folder with only `main.py`/`app.py` (no manifest) beside a CMake or web project was not Python at all,
  so its run command was missing; it is now a low-confidence Python detection. New `crates/language/tests/mixed.rs` (4 tests: nine projects found once each with no Android/`src-tauri` duplicates and nothing written,
  commands and detections stay in their own project incl. `npm run tauri dev`, a missing tool disables only the projects that need it, each file keeps its own language and nearest project). **Verified by hand**
  (rebuilt debug app): every project's command list; a click opened a new terminal in the right project folder for Python, Rust, Vite/React, Tauri and the Python+CMake project; languages of ~24 file types;
  formatter/linter messages for TS/TSX/CSS/HTML/JS/Python (missing, with hints) and real `rustfmt`/`cargo clippy` for Rust in `rust-json-sql`; SQL/none disabled with a reason; language-server lines for TSX/CSS/JSON
  (built-in, not configured), C++ (clangd not found), Rust (rust-analyzer found, can't start), SQL (not found, can't start); text and symbol search across the workspace; image preview; AI item absent, present, gone;
  Load Popular only after a click; no connection from the app tree at launch; clean close, PATH unchanged. **Known gaps**: a Tauri project shows no Cargo commands and Run Linter on a file in `src-tauri/` runs
  `cargo clippy` in the project folder, where cargo says it finds no `Cargo.toml`; Dart, CMake and Podfile are shown as Plain Text (no grammar); the reference-search fallback was not re-checked. Left on disk: `E:\omstack qa`.
- [x] **Milestone 15** — Bundled toolchain packs, professional Runtime/Tools UI and PHP Configuration page (`feat: add bundled toolchain packs and polish tools ui`). New `openmind-toolchains` crate
  (7 unit + 15 integration + 1 policy test), `commands::toolchains`, the Language Tools tab and Details dialogs, the redesigned Runtime cards (two-line clamp, Python notes in Details), the Bundled section of
  Project & Language Status, `scripts/portablePackage.mjs` `validateToolchainManifest` (a `tools-bundle/` is refused unless: at most 5 versions per tool, every file present, paths inside the folder, a `license`
  note on every version) and the PHP Configuration page redesign incl. DB credentials and the Laravel helper (see above). **Actually bundled: nothing yet.** Manifest-supported (shown Missing until files exist): Git,
  Composer, debugpy, Pyright, Ruff, Black, isort, pytest, TypeScript / HTML-CSS-JSON servers, ESLint, Prettier, Biome, Tailwind/Vue/Svelte/Astro servers, Intelephense, Phpactor, PHP CS Fixer, Pint, rust-analyzer,
  gopls, clangd, YAML/Dockerfile/GraphQL/SQL servers. External required (never bundled): Flutter, Android SDK, Xcode, JDK, .NET SDK, C/C++ toolchain, Rust toolchain, Go SDK, Docker. **Behaviour**: last 5
  versions per tool is a cap enforced on the manifest, not a promise; the active version is the user's choice, else the manifest's, else the newest stable present one; a broken listed version is shown Broken
  and cannot be chosen; project-local tool > bundled > portable > system (tests for each step); bundled folders go only on the PATH of terminals/processes OpenMind starts. **Verified by hand** (debug build,
  fresh portable copy `C:\omtmp15`, workspace `My Workspace` with a space, *fixtures*: Git versions are junctions to the machine's real Git for Windows, Composer/debugpy/Prettier are placeholder files/stub `.cmd`):
  the tab lists the sections with chips; the Git selector offered 2.47.0/2.46.2/2.45.1 and a Broken 2.44.0 (disabled), switching to 2.46.2 stuck and Verify ran the real `git --version`; Composer's Verify said
  "file present, not run"; with no Runtime-Manager Git and the system Git not allowed, Source Control initialised a repository using the bundled Git ("OpenMind portable Git"); Format Document With Tool
  used the project's own `prettier.cmd` in one project and the bundled one in another; Project & Language Status showed the three bundled lines; the Python runtime card's description is two lines (measured) with
  its notes under Details; the PHP Configuration page (PHP 8.4.26, Composer, MariaDB 11.8.9, phpMyAdmin 5.2.3 installed from it) showed the header chips, cards, masked password, Reveal/Hide, Copy Password
  (24 characters, absent from every log and settings file), Copy Connection String (`mysql://root@127.0.0.1:3307`), phpMyAdmin Running with its address and Open phpMyAdmin (opened the browser), Admin disabled
  with "Start MariaDB first." after stopping MariaDB, and the Laravel card for a Laravel folder (no `.env` created); the main control panel looked as before; a normal close (after stopping phpMyAdmin — closing
  with a server running hides to the tray, as designed) left no process of the copy; User/Machine PATH identical; no outside connection from the app tree at launch. **Not done / limitations**: no tool
  binaries are bundled; a bundled Composer is a `composer.phar` used by the PHP panel's Composer buttons (a `composer.cmd` next to it is needed to also find `composer` for project commands); the debugpy
  bundle must be laid out as `debugpy/adapter/__main__.py` and was verified only as a fixture (no real bundled debugpy was started); "Use External Path" is not implemented; the Runtimes section of the Tools
  tab is empty (the Runtimes tab already covers them); the Laravel helper copies commands, it does not run them. Note: the Extensions view now loads Popular by itself when it opens (a user request after Milestone
  14.1; never at launch). Left on disk: `C:\omtmp15`, `C:\omtmp`, `C:\Users\smsha\.cargo-target`.
- [x] **Menu system completion and About** (branch `menu-system-completion`, `feat: complete application menu system and about section`). See "Menu system and About" above. Tests: `menus.test.ts` (prune rules,
  shells, project commands), `menuBar.test.tsx`, `about.test.tsx`, `helpCommands.test.ts`, `App.test.tsx` (eight top-level menus, every visible item backed by a registered command, no empty groups or
  double separators, Help > About opens the window, the Help menu), `App.ai.test.tsx` (AI Panel item follows the provider rule), terminal/language/editor/workbench/command-registry tests and the Rust `about` and `panel`
  tests. **Verified by hand** in the built app (debug build, `C:\omtmp15`, workspace with a space, trusted mouse clicks through every menu): New File, Settings, Find/Replace widgets, Select All, Duplicate Selection,
  Undo/Redo, Toggle Line Comment, Copy/Cut/real Paste (clipboard checked; no permission prompt after the fix), Find in Files, Format Document With Tool, Expand/Shrink Selection, Add Cursor Below, Command Palette,
  Explorer/Search/Source Control/Extensions, Problems/Output/Ports/Debug Console panels, Terminal and Panel toggles, Zoom, Word Wrap, Go to File/Symbol/Line/References, Next Problem, Next Editor, Run Code,
  Project Run Commands (typed `python main.py` in a new terminal in `python-app`), Start/Stop Debugging and Toggle Breakpoint (reachable), New Terminal With Profile (Command Prompt), Clear/Kill/Kill All Terminals,
  Keyboard Shortcuts, Show Logs (the log opened as a tab), Open Logs Folder (a real Explorer window on the logs folder), About from Help, Copy System Info (contents checked); with a preview tab in front
  the Selection and Edit editor actions are disabled and the File menu opens. **Not driven by hand**: the native Open File / Open Folder / Save As dialogs (covered by their existing service tests), Save All with a
  dirty file, and debugging a real session from the menu (Step/Continue only show a reason while no session exists). **Known limitations**: Step Over/Into/Out, Continue, Stop and Restart Debugging are always listed
  and say "There is no debug session." until one runs; Edit > Cut/Copy need a real click or key (WebView2 refuses `execCommand` for scripted events, so an automated synthetic click can't test them); Documentation,
  Report Issue and updates are absent (see above).
- [x] **Milestone 15.2** — VS Code-like formatting system (`feat: add vscode-like formatting system`). See `openmind-format` and "Formatting (Milestone 15.2)" above. **Regression fixed**: a one-line `package.json` now
  formats to readable JSON with no tool and no language server (`{"name":"r","scripts":{"dev":"vite","build":"vite build"},"dependencies":{"react":"19.0.0"}}` -> the two-space, one-member-per-line form asked for;
  Rust test `the_package_json_regression_formats_without_any_tool_or_server`). **Supported**: built-in JSON/JSONC; Prettier or Biome (project / bundled / runtime / allowed system) for HTML, CSS/SCSS/Less, JS/JSX,
  TS/TSX, JSON, Markdown, YAML, Vue/Svelte/Astro, GraphQL; Black or Ruff for Python; rustfmt; gofmt; clang-format (C/C++/Objective-C); the language server for the languages OpenMind starts one for. Not document
  formatters (listed with their reason): Pint, PHP CS Fixer, dotnet format, ktlint, dart format. No tool is installed, downloaded or bundled by this milestone; PATH and the Registry are never written.
  **Tests**: Rust — `openmind-format` 22 unit (JSON: package.json, stability, verbatim strings/numbers, tabs/CRLF, comments + trailing commas, errors with a position, deep nesting; resolver: project > bundled > built-in >
  portable > system, system refused unless allowed with the setting named, missing-formatter reasons, the default never silently replaced, file-only tools; project root; a real `cmd.exe` for stdin/stdout, failure message,
  timeout kill, empty output never empties a file, missing program, working folder and child-only PATH) + 3 policy tests, `openmind-language` stdin recipes, `commands::format` (the package.json case, invalid JSON, no formatter,
  unknown/unavailable id, path rules, language lookup); TypeScript — `formattingService` (format, invalid JSON, unchanged, preview refused, no formatter, text changed mid-run, huge file, default/timeouts/policy, language server
  first/preferred, With... list, remember, Configure, saved defaults, Format on Save on/off/failing/no formatter/huge, status texts), `formattingWiring` (real command handlers, preview reasons, Format Selection gating, the
  on-save toggle, the save hook, Shift+Alt+F resolution, Edit menu), components (status item, dialog modes) and `BufferManager` (one undo step, EOL, indent, edits applied to a copy). **Verified by hand** in the built
  app (fresh copy `C:\omfmt\OpenMind Studio`, workspace `C:\omfmt\My Workspace` — a space —, Prettier installed *into the workspace* with npm and Black/Ruff into its `.venv` as test fixtures): a one-line package.json
  through Edit > Format Document (real Prettier from the project; status bar "JSON — Prettier (from the project)"), Edit > Undo restored the one-liner and Redo re-formatted (one step), File > Save wrote the formatted file;
  invalid JSON showed Prettier's error and, through Format Document With... > Built-in, "The document is not valid JSON: Unexpected ',', expected a property name in double quotes (line 1, column 9)" with the text
  untouched; HTML, CSS, TS, TSX, Markdown (Prettier) and Python (Black from `.venv`) formatted; Rust and Go said "No formatter available ... A tool found on the system PATH is not used unless you allow it (setting
  formatter.useSystemTools)" and formatted with the real rustfmt/gofmt after that user setting was turned on; a plain-text file said "No formatter configured for Plain Text."; with an image preview in front every
  formatting item in the Edit menu was disabled with its reason; Format on Save (toggled from the Edit menu) formatted a minified package.json on Save, and with invalid JSON showed "Format on Save: prettier failed: ...
  The file was saved as it was." and saved; Shift+Alt+F (real key event) and the right-click menu (one Format Document) formatted; Format Document With... > Built-in with "Remember" formatted with the built-in formatter
  and the choice survived a reload; the status dialog listed Prettier / Built-in / Biome (missing, with the install hint); no connection from the app's own processes at launch or while formatting (only WebView2's usual
  Microsoft connections); a normal close left no OpenMindStudio/node process and User/Machine PATH were identical. **Not verified by hand**: formatting through a running language server and Format Selection (no server was
  installed; covered by unit tests), C/C++, PHP, Windows-only quirks of `.cmd` argument quoting for paths with `&`, Ruff (installed, Black won). **Known limitations**: see "Formatting (Milestone 15.2)". Left on disk:
  `C:\omfmt`.

- **Menu restore, Auto Save and always-on formatting (after Milestone 15.2, same branch).** *Why entries had vanished*: the menu-completion pass hid every entry whose command was not registered. **That rule is reversed**:
  every VS Code entry is listed again (`menus.ts`, incl. Help's Documentation / Release Notes / Playground / Videos / Tips / Feature Requests / Report Issue / License / Privacy / Developer Tools / Process Explorer /
  Check for Updates, Terminal's Run Task / Build Task / Running Tasks / Configure Tasks, File's New File... and workspace entries); an entry whose feature is not built is **disabled with its reason** (`unbuiltReason`,
  tooltip only), and lights up the moment its command is registered. Only the AI item is still hidden while no provider is on (`HIDDEN_WHEN_UNREGISTERED`). **Built for real**: `file.newFilePicker` (**New File...**: the native
  Save dialog picks any drive/folder, an empty file is created — an existing file is opened, never emptied — and opened), **Auto Save** (`AutoSaveService`, `files.autoSave` off / afterDelay / onFocusChange / onWindowChange +
  `files.autoSaveDelay`, File > Auto Save toggles afterDelay; only files that already have a path, never one changed on disk underneath, an after-delay save skips Format on Save), `editorLayout.single|twoColumns|threeColumns`
  (`EditorGroupService.setColumns`: extra groups' tabs move into the last kept group, none is closed), Go > Switch Group (`go.group1|2`, `go.next|previousGroup`), **Zen Mode** (hides side/status/panel, full screen, restored on exit)
  and **Centered Layout**, Terminal > **Run Active File** (= Run Code in Terminal) and **Run Selected Text**, Help > Keyboard Shortcuts Reference and View License (open the shortcuts page / About). **Still disabled with a reason**:
  tasks, multi-folder workspaces and workspace files, Replace in Files (profiles and the file icon theme were built in Milestone 16), Emmet, conditional/log/function breakpoints and launch.json, split up/down/rows/grid, last edit location, next/previous change,
  used-editor switching, Open View, and everything that needs an online service or update system. Save of an unsaved (untitled) file opens the Save dialog (any location) as before. **Formatting is now on by default**:
  `editor.formatOnSave` defaults to **on** (still user-only), the right-click menu has Format Document and Format Document With..., and Auto Save formats when it saves on a focus/window change. Verified by hand in the built app:
  all eight menus listed with the right entries disabled, Auto Save saved an edit ~1 s later without touching the text, Two Columns / Single, Zen Mode, and File > Save formatted a minified package.json with the default settings.
  **Not driven by hand**: the native New File... dialog (covered by unit tests).
- [x] **Milestone 16** — Icon themes, profiles, sync-readiness, startup diagnostics and release-installer preparation (`feat: add release polish profiles icons and installer prep`). Docs: `docs/release.md`, `docs/sync-readiness.md`,
  `docs/release-notes-0.1.0.md` (draft).
  **Icon themes** (`components/iconThemes.ts`, `fileIconSpec.ts`, `fileIcons.tsx`): setting `workbench.iconTheme` = `material` (files + folders, default), `material-files` (files only, the old look) or `minimal` (one generic file icon,
  no folder icons). All icons are bundled Material Icon Theme SVGs (MIT): nothing is fetched and an unknown name falls back to the generic file/folder icon (a test checks every name the tables can return is bundled). Files: JS/TS/TSX/JSX,
  HTML/CSS/SCSS, JSON/YAML/TOML/XML, Python, PHP, Laravel (`artisan`, `*.blade.php`), Rust, Go, Java, C/C++, C#, Markdown, Dockerfile (+ `Dockerfile.*`, `docker-compose.*`), SQL, Prisma, GraphQL, Dart/Flutter (`pubspec.yaml`), Gradle,
  `AndroidManifest.xml`, Tauri, Git files, `.env*`; there is **no Electron icon in the theme**, so Electron files use their language's icon. Folders (closed/open): src, src-tauri, test/tests/__tests__/spec, node_modules, .git, .github,
  dist/build/out, target, public, assets/resources, routes, controllers, components, pages/views, config, docs, lib, app, database, images, scripts, utils, api, android, ios, else the generic folder. The Settings page shows the theme as a dropdown;
  File > Preferences > Themes > File Icon Theme opens it. **Extension icon themes are not supported** (stored and shown as unsupported, as before): no fake support.
  **Profiles** (`openmind_settings::profiles`, `commands::profiles`, `src/services/profiles/`, `ProfilesDialog`, status bar item): files in `settings/profiles/` (`<id>.json` + `active.json`; `format: "openmind-profile"`, `version: 1`, `createdAt`/
  `updatedAt`). A profile is a **fixed list of 21 settings** (`PROFILE_SETTINGS`: color/icon theme, editor font/tab/wrap/minimap/line numbers/sticky/whitespace, format on save, Auto Save + delay, terminal font size/scrollback, search indexing,
  `ai.enabled`, marketplace auto-fetch, `lsp.enabled`, `git.autoRefresh`) — keybindings, extensions, runtimes, keys and passwords are **not** profile-aware and the dialog says so. Ready-made: Default (your settings at first run),
  Web Development, Python, PHP / Laravel, Systems (Rust / Go / C++), Minimal / Low memory (seeded once; a deleted one stays deleted). Switching first saves the current values into the profile being left, then writes the target's values into the
  user `settings.json` (a setting the profile lacks is removed so its default applies; every other key is kept) and re-reads the settings, so theme/icons/editor follow at once; a `settings.json` with a syntax error blocks the switch. Create
  (empty or from the current settings), rename, duplicate, delete (**Default and the active profile can't be deleted**), export, import; names 1-40 characters, unique ignoring case; ids are slugs, never paths; a damaged profile file is skipped, listed
  and never overwritten; a damaged/missing `active.json` falls back to Default.
  **Sync readiness (no sync exists)**: `crates/settings/src/sync.rs` lists the app-local layout as data (syncable / user's choice / never) with tests; export/import keep only valid, path-free profile settings (a drive or UNC path or an unknown
  setting is dropped, keys/passwords cannot be in a profile), refuse another `format`, a newer `version` or a file over 256 KB, and an import gets a fresh id. Profiles and export files carry format, version and timestamps. See `docs/sync-readiness.md`
  (what may sync later; never: API keys, DB passwords, provider keys, absolute paths unless chosen, search index, conversations unless chosen, runtime binaries). No "Sync now", no account, no network.
  **Start-up**: the window is **usable before background work ends** — `useAppStartup` sets ready after the session is restored and runs the mirror/initialise services (Run Code, PHP, MariaDB, phpMyAdmin, Composer, file sync, language tools, debug tools, Git)
  in parallel afterwards; the About, Run Configuration, Language Tools and Runtime Manager dialogs are `React.lazy` chunks. **Diagnostics**: `StartupTimings` measures each phase, the main window reports them once (`startup_report`) and the app log gets
  one line (`main window shown elapsed_ms=…` and `startup: window usable after N ms (process M ms) | phases (ms): settings=… | working set X MB` — names and numbers only; `startup.rs` drops any other name). `startup.test.ts` scans the start-up sequence
  and start functions for anything that belongs to a click (marketplace, AI requests, tool verification, server starts, installs, extension host start, external URLs) and pins the phase order. Measured (release build, installed by the NSIS setup):
  main window shown after 642 ms, editor usable 74 ms of front-end work later (process clock 1.06 s), app process 42 MB, ~546 MB with all WebView2 helpers, the only outside connections were WebView2's usual Microsoft ones (none from the app itself).
  **Installers** (`pnpm release:build` = `tauri build --bundles nsis,msi`; `pnpm release:collect`): `bundle.license = "Apache-2.0"`, `bundle.licenseFile = "../LICENSE"`; `scripts/releaseTools.mjs` + `release.mjs` check the configuration and LICENSE
  (and the generated WiX for a PATH change, licence page and launch option), copy the installers that exist to `release/` under the release names (`OpenMind-Studio-Setup-<v>-x64.exe`, `OpenMind-Studio-<v>-x64.msi`, `OpenMind-Studio-Portable-<v>-x64.zip`),
  sign them when configured, and write `SHA256SUMS.txt` and `RELEASE-REPORT.md` (version, arch, **build type unsigned / test-signed / signed**, date, size, SHA256; only existing files). **Signing** is optional and env-only (`SIGNING_CERT_PATH`,
  `SIGNING_CERT_PASSWORD`, `TIMESTAMP_URL`, `SIGNING_CERT_KIND=test`): nothing configured = unsigned with a clear message, a half-configured pair = skipped with a message, the password is never printed or written (tests, incl. one that fails on a tracked
  certificate/key file or a committed password); `signtool` signs the installer files only (the exe inside is not signed yet). **Verified by hand**: the NSIS setup (UI driven through UI Automation) — Welcome, **licence page with the full Apache text and
  "You must accept the agreement to install"** (only *I Agree* continues), install location, install, Finish with *Run OpenMind Studio* (launched the installed app) and *Create desktop shortcut*; per-user (no UAC, HKCU uninstall entry `OpenMind Studio 0.1.0`,
  publisher OpenMind, Start Menu shortcut), data folders next to the installed exe, About-level checks below, uninstall (`/S`) removed the app and the uninstall entry (the `data/settings/...` folders are kept, by design); PATH (User and Machine) identical.
  The **MSI** (WiX, **per-machine: Program Files, needs administrator rights / UAC**): its wizard was driven up to *Ready to install* — the licence page shows the Apache text and **Next stays disabled until "I accept" is ticked** — and cancelled there
  because installing needs elevation: **MSI install, launch and uninstall were NOT run**. The MSI has no `<Environment>` element (no PATH change), writes only HKCU keys for the install folder and shortcuts, and offers *Launch* on its last page; when
  WebView2 is missing its installer would download Microsoft's bootstrapper (installer-time, not the app). **Known limitations**: unsigned; MSI needs admin and was not installed here; no auto-update; the NSIS uninstaller keeps user data; the portable
  zip was built from the same release exe and not re-run; extension icon themes, Electron icon, cloud sync, profile-aware keybindings/extensions/runtimes are not built; a profile switch does not reload extensions. Left on disk: `C:\omfmt`, `E:\Code Editor\release`
  (git-ignored), `C:\Users\smsha\.cargo-target`.
- [x] **Milestone 17** — Offline bundled Language Server Protocol pack (`feat: bundle offline language servers`). See the "Offline LSP bundle" paragraph under
  `openmind-lsp` and `docs/lsp-bundle.md`. **Shipped in the installers** (`lsp/`, 167 MB; packs are zips unpacked on first use): TypeScript/JavaScript, Pyright,
  JSON/CSS/HTML, YAML, Bash, Dockerfile, rust-analyzer, clangd, and Node.js 24.21.0 (`node.exe` only) to run the Node-based ones. **Not shipped**: Intelephense (its licence
  forbids redistribution — found while building the bundle; still an npm install on request), gopls/JDT LS/OmniSharp (need toolchains). Build side: `pnpm lsp:bundle`
  (`scripts/prepare-lsp-bundle.mjs` + pure `scripts/lspBundle.mjs`: npm ci from the pinned lockfiles, Node/native from `crates/lsp/servers/bundle-sources.json` with
  SHA256, packs via `bundle_tool`, `THIRD-PARTY-NOTICES.txt`, `--check`), `tauri.conf.json` `bundle.resources` `../lsp-bundle/` -> `lsp/`, `release:build` and
  `package:installer` refuse to run until `--check` passes, `package:portable` copies it after `--check`, `checkInstallerConfig` requires the resource mapping.
  Frontend: Language Tools shows the bundle line, "Bundled" badges, "Unpack Now" (no download), "Contains … · runs on Node.js / its own program"; availability
  treats a bundled-not-yet-unpacked server as usable; `lspLanguages` mirrors the new languages (Monaco `yaml`, `shell`, `dockerfile`, `rust`, `c`, `cpp`);
  `openmind-language` marks YAML/Docker Compose/Dockerfile/Shell/Rust/C/C++ with the `lsp` level. **Fixed on the way**: since Milestone 15 the Language Tools
  dialog showed none of its notes (the compact Runtime Manager CSS hides `.runtime-card__notes` in every `.modal--runtimes`; the dialog now has
  `modal--lsp-tools`); the release test's secret scan failed on its own fixture password. **Verified**: `bundled_servers` runs all ten servers from the real bundle
  with PATH = System32 only (each gave a real diagnostic/hover/symbol answer); by hand in a debug build (fresh copy `E:\omlsp17\OpenMind Studio`, workspace
  `My Workspace` with a space): nothing unpacked or started at launch; opening each file unpacked only its pack and started the server — every Node-based one on
  `lsp
ode
ode.exe`, clangd/rust-analyzer from `language-servers\` — with problems from TypeScript, Pyright, JSON, CSS, YAML, Dockerfile, clangd and rust-analyzer
  (`mismatched types`), HTML hover and Bash document symbols through `lsp_request`, PHP "Language server is not installed yet."; a remote `$schema` in JSON and YAML
  was refused and no process of the app's tree connected anywhere; a normal close left 0 processes; User/Machine PATH identical. Release: NSIS setup **104 MB**
  (installed silently per user into a folder with spaces: `lsp\` beside the exe, TypeScript and clangd ran from it with diagnostics, Language Tools showed the
  bundle, silent uninstall removed the program and `lsp\` but kept the data folders), MSI **121 MB** (built, WiX lists every bundle file, no `<Environment>`; not
  installed — needs admin), portable ZIP **120 MB**. **Limits**: Windows x64 only (32-bit/ARM64 accepted but untested); the NSIS uninstaller keeps
  `language-servers\` (~317 MB when all servers were used); the per-machine MSI can't unpack into Program Files without admin; rust-analyzer runs the machine's
  cargo (creates `target/`/`Cargo.lock`, offline); no server auto-update. Left on disk: `E:\omlsp17` (test copies, installer test folder, portable output).
- [x] **Milestone 18** — Bundled offline formatters (`feat: bundle offline formatters for every supported language`). A user asked for a formatter that
  works in every language with nothing to install ("No formatter available for HTML. Prettier not found." was the trigger). The offline bundle (`lsp/`)
  now also carries **Prettier 3.9.9 with plugins** (PHP, shell + Dockerfile + `.properties` + `.env`, XML, SQL, TOML, Java, Svelte, Astro — plus
  its own HTML/CSS/JS/TS/JSON/Markdown/YAML/GraphQL/Vue), **Ruff 0.16.9** (Python), **gofmt** (only `gofmt.exe` from Go 1.27.1), **clang-format
  23.1.1** (from the official PyPI wheel; C/C++/Objective-C/C#, Java after Prettier) and **StyLua 2.5.2** (Lua), each SHA256-pinned in
  `bundle-sources.json` (new native option `only`: keep just those files) or by the Prettier lockfile. `openmind-lsp`: formatter `PACKAGES`,
  `registry::BUNDLED_TOOLS` (tool id, package, entry, runtime, Prettier's plugin files), `tools.rs` (`ensure_unpacked` — all formatter packs at once,
  process-wide gate — and `ready_tools`: a native tool's folder, or Prettier's launcher `node <prettier.cjs> --plugin=<absolute path>...`; no Node,
  no Prettier), unpack/`bundle_tool` also check tool entries. `openmind-language`: `ToolEnv.launchers` (tool id -> program + leading args, looked at
  right after the project's own copy), `Found.args` + `Found::command()`, StyLua tool + recipe, formatters added for PHP, shell, Dockerfile, XML, SQL,
  TOML, Java, C#, Lua, `.properties`, `.env` (with the Format level). `openmind-format`: a launcher is named after its script in messages, the shown path
  is the script. App: `commands::language::tool_env` adds the unpacked bundle tools (after the user's `tools/` packs); `commands::format::prepare` first
  calls `unpack_offline_formatters` (so the first format/format status after install unpacks, offline, ~a few seconds; nothing at launch). Prettier and
  Ruff left the `tools/` catalog (they would show "Missing"). Order stays: user default > project's own tool > **bundled** > built-in JSON > portable >
  system. **Not bundled** (need a toolchain): rustfmt, `dotnet format`, ktlint, `dart format`, Ruby, PowerShell. Sizes: formatter packs +42 MB (bundle
  209 MB), unpacked 177 MB. Tests: `crates/format/tests/bundled_formatters.rs` (ignored; 21 files — HTML, CSS, TS, TSX, JSON, Markdown, YAML, PHP,
  shell, Dockerfile, XML, SQL, TOML, Java, Svelte, Python, Go, C, C++, C#, Lua — each formatted by a *bundled* tool with an empty system PATH), unit tests
  for the launcher order, ready tools, labels, registry. Verified by hand (debug build, fresh copy `E:\omfmt18`, workspace with a space): nothing
  unpacked at launch; Edit > Format Document formatted HTML ("HTML — Prettier (bundled with OpenMind)"), PHP, Python (Ruff), Go (gofmt), Lua (StyLua),
  SQL, shell and C++ (clang-format); no formatter process stayed, no connection from the app's processes; close left 0 processes. Rust 927 passed,
  frontend 1590. Built on branch `milestone-18` in the clean worktree `E:\wt-release`.
- [ ] Milestone 19 — to be scoped (icon/product themes from extensions, profile-aware keybindings, signing with a real certificate, auto-update).

This list is a living roadmap — refine milestone boundaries as work progresses, but keep the
"one milestone, fully working, then commit" discipline.
