# OpenMind Studio

A portable, native desktop code editor built with Rust, Tauri 2, React, and Monaco Editor.
Not a web app — everything runs from the application's own directory, with no admin rights and
no dependency on globally installed software.

OpenMind Studio is the desktop IDE in the OpenMind ecosystem:

- **OpenMind Studio** — Desktop IDE (this project)
- **OpenMind AI** — AI Assistant (future)
- **OpenMind Runtime** — Portable Runtime Manager (future)
- **OpenMind Extensions** — extension ecosystem (future)
- **OpenMind Sync** / **OpenMind Cloud** — future

## Tech stack

Rust · Tokio · Tauri 2 · SQLite (WAL, via `sqlx`) · React 19 · TypeScript (strict) · Vite · pnpm ·
Monaco Editor.

## Getting started

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

## Project layout

See [`CLAUDE.md`](CLAUDE.md) for the full architecture (clean-architecture crate boundaries,
persistence model, coding rules) and the milestone roadmap. In short:

- `crates/core`, `crates/db`, `crates/settings` — domain crates (`openmind-core`, `openmind-db`,
  `openmind-settings`).
- `src-tauri` — the Tauri application (composition root, binary name `openmind-studio`).
- `src/` — the React/TypeScript frontend.

At runtime, OpenMind Studio creates its data directory next to its own executable
(`data/`, `logs/`, `cache/`, `runtimes/`, `extensions/`, `themes/`, `settings/`) — never
`%APPDATA%` — so the whole install stays portable.

## License

Proprietary — UNLICENSED. Not for redistribution.
