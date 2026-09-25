# OpenMind Studio

A portable, native desktop code editor built with Rust, Tauri 2, React, and Monaco Editor.
Not a web app — everything runs from the application's own directory, with no admin rights and
no dependency on globally installed software.

OpenMind Studio is the desktop IDE in the OpenMind ecosystem:

- **OpenMind Studio** — Desktop IDE (this project)
- **OpenMind AI** — AI Assistant (future)
- **OpenMind Runtime** — Portable Runtime Manager (built in: Node.js, Python, Git, PHP, Composer, MariaDB, phpMyAdmin)
- **OpenMind Extensions** — extension ecosystem (future)
- **OpenMind Sync** / **OpenMind Cloud** — future

## What it does

Explorer, Monaco editor with tabs and split editors, integrated terminal, Run Code, a Git client,
language servers (LSP) with a Problems panel, a debugger for Python and Node.js (DAP), a portable PHP
stack with a control panel, and Settings, Keyboard Shortcuts and themes (Dark, Light, High Contrast,
System) you can edit from a page or as JSON.

## Portable edition

Download `OpenMindStudio-<version>-portable-win-x64.zip`, unzip it anywhere (a USB drive, a path with
spaces) and run `OpenMindStudio.exe`. Nothing is installed; no administrator rights are needed; your
Registry, `AppData` and `PATH` are never touched. Everything the app keeps is next to the executable:

```text
OpenMind Studio/
    OpenMindStudio.exe
    data/openmind-studio.db   SQLite (WAL)
    settings/                 settings.json, keybindings.json
    runtimes/                 portable Node.js, Python, Git, PHP ... (installed from the Runtime Manager)
    cache/  logs/  language-servers/
```

A folder's own settings live inside the project, in `.openmind/settings.json`.

## Settings and shortcuts

`Ctrl+,` opens Settings (User and Workspace, searchable, with Reset per setting); "Open Settings (JSON)"
edits the same file by hand and saving it applies it. Keyboard Shortcuts lists every command, lets you
change, remove and reset a key, warns about conflicts, and stores your changes in `keybindings.json`.

## Tech stack

Rust · Tokio · Tauri 2 · SQLite (WAL, via `sqlx`) · React 19 · TypeScript (strict) · Vite · pnpm ·
Monaco Editor.

## Getting started (development)

Prerequisites: a stable Rust toolchain (pinned in `rust-toolchain.toml`), Node.js, and pnpm.

```sh
pnpm install     # frontend dependencies
pnpm tauri dev   # run the app in development mode
```

Other useful commands:

```sh
cargo build --workspace   # build all Rust crates
cargo test --workspace    # run Rust tests
cargo clippy --workspace --all-targets -- -D warnings
cargo fmt --check

pnpm build   # type-check and build the frontend
pnpm lint    # ESLint
pnpm test    # Vitest
```

## Packaging

```sh
pnpm package:portable      # release build + dist-portable/OpenMindStudio-<version>-portable-win-x64.zip (+ .sha256)
pnpm package:installer     # per-user NSIS installer (tauri build --bundles nsis)
```

Neither is code-signed. The installer installs for the current user (no administrator rights); the
app is exe-relative either way, so an installed copy keeps its data next to the installed executable.

## Project layout

See [`CLAUDE.md`](CLAUDE.md) for the full architecture (clean-architecture crate boundaries,
persistence model, coding rules) and the milestone roadmap. In short:

- `crates/*` — domain crates (`openmind-core`, `-db`, `-settings`, `-fs`, `-workspace`, `-terminal`,
  `-runtime-manager`, `-runner`, `-git`, `-lsp`, `-dap`, `-search`, `-file-watch`, `-process`).
- `src-tauri` — the Tauri application (composition root, Cargo package `openmind-studio`; the built
  executable is `OpenMindStudio.exe`).
- `src/` — the React/TypeScript frontend.

## License

Proprietary — UNLICENSED. Not for redistribution.
