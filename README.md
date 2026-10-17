# OpenMind Studio

A portable, native desktop code editor built with Rust, Tauri 2, React and Monaco Editor. It runs from its own folder:
no administrator rights, no dependency on globally installed software, and nothing written to the Registry, `PATH` or
`AppData` unless you choose an installer option that says so.

- **Downloads:** [github.com/smshagor-dev/OpenMind-Studio/releases](https://github.com/smshagor-dev/OpenMind-Studio/releases)
- **Source:** this repository · **Licence:** [Apache-2.0](LICENSE) · **Third-party licences:** [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)
- **Security reports:** [SECURITY.md](SECURITY.md) · **Contributing:** [CONTRIBUTING.md](CONTRIBUTING.md) · **Privacy:** [docs/legal/privacy-policy.md](docs/legal/privacy-policy.md)

## Release status

- **Current published release: v1.0.3.** Download from the [official releases page](https://github.com/smshagor-dev/OpenMind-Studio/releases). Read [v1.0.3 release notes](docs/release-notes-1.0.3.md).
- **Upcoming: v1.0.4.** Source code and release packages have been prepared, but publication is pending. See [v1.0.4 release notes](docs/release-notes-1.0.4.md). The source package version may therefore show `1.0.4` while the latest publicly available version remains `1.0.3`.

### What's coming in v1.0.4

- Network Deployment for discovering, trusting and installing from LAN deployments, with signed-package verification and a diagnostic test.
- Per-user Desktop shortcuts for shared Windows installations, with IT deployment controls.
- Fixes for shared runtimes, concurrent language-tool installation, mapped-drive profiles, and per-computer caches.
- Security hardening for network discovery and package serving.

The v1.0.4 packages are not Authenticode-signed. Physical multi-computer university-network validation is still pending; deployment across separate subnets requires manual addressing. Do not treat prepared builds as publicly released.

## What it does

- Explorer, Monaco editor with tabs and split editors, Markdown and file previews (images, PDF, DOCX, XLSX, CSV).
- Integrated terminal (PowerShell, cmd, Git Bash, WSL), Run Code for Python, JavaScript/TypeScript, PHP, C, C++, Java,
  Rust and assembly, and a built-in browser for HTML.
- Git client: changes, staging, commits, diffs, branches, clone, history, blame, stash.
- Language servers (LSP) and a Problems panel; an offline bundle of language servers and formatters ships with the
  Windows packages.
- Debugger for Python and Node.js (DAP), tasks (`tasks.json`) and notebooks.
- Runtime Manager: portable Node.js, Python, Git, PHP, Composer, MariaDB/phpMyAdmin, JDK, Go, .NET and more, installed
  into the app's folder on request; a PHP/MySQL control panel.
- A VS Code-compatible extension subset (local `.vsix` and Open VSX), AI chat with providers you configure, and
  local-first collaboration (preview).
- Settings, keyboard shortcuts, themes and profiles; English and Russian.

## AI assistance and coding agent status

**Available foundation:** The project includes a configurable AI chat/provider integration. AI requests depend on the provider and model configured by the user; this is not a bundled, guaranteed-offline coding agent.

**Planned / not release-verified:** A full workspace-aware coding agent with multi-file edits, tool execution, approval controls, persistent task state, and end-to-end autonomous coding workflows is an upcoming direction. These capabilities are **not advertised as completed in v1.0.3 or v1.0.4** without source-level tests and release validation.

For v1.0.4, see the [release notes](docs/release-notes-1.0.4.md) for verified changes. AI coding-agent work is not included in the confirmed v1.0.4 change list.

## Platforms

| Platform | Packages |
| --- | --- |
| Windows 10/11, x64 and x86 | NSIS setup (per user, or a shared network folder), MSI (per machine), portable ZIP |
| Linux x64 and x86 | `.deb`, AppImage, portable `.tar.gz` (needs WebKitGTK 4.1, GTK 3) |

The offline language-server and Python bundles and the Runtime Manager's downloads are Windows-only. Linux copies are
told about new versions but update through their package (see [docs/release.md](docs/release.md)).

## Building from source

Prerequisites: Rust (the version CI uses is in [`.github/workflows/ci.yml`](.github/workflows/ci.yml)), Node.js 24 and
pnpm 11. On Linux also the WebKitGTK 4.1 development packages (listed in the same workflow).

```sh
pnpm install --frozen-lockfile
pnpm tauri dev                 # run the app in development mode

cargo fmt --all -- --check     # the checks CI runs on every pull request
cargo clippy --workspace --all-targets -- -D warnings
cargo test --workspace
pnpm lint && pnpm exec tsc --noEmit -p . && pnpm test && pnpm build
```

Release packages are built by the [Release workflow](.github/workflows/release-windows.yml) on GitHub-hosted runners
from this repository; [docs/release.md](docs/release.md) describes the same steps locally (offline bundles, x86 builds,
the Linux script, verification). Release files are written to `release/v<version>/` and are never committed.

## Code signing policy

**Status: not signed.** Windows releases are **not** Authenticode-signed and Windows SmartScreen (and Smart App
Control, where it is on) will warn about or block them; macOS releases are not Developer ID-signed or notarized.
Update packages are always signed with OpenMind Studio's own updater key and checked by the app before installing.

Free signing through [SignPath Foundation](https://signpath.org/terms) requires OSI-licensed source and builds that
can be traced to a known source repository ("binaries based on source code that nobody knows" can't be signed). This
project's source repository is private, so it is **not eligible** as long as that stays so; no other free, trusted
provider was found (Certum's open-source certificate and Azure Artifact Signing are paid). The workflow integration
(`.github/workflows/release-windows.yml`, `docs/signpath/`) is kept ready in case that changes.

| Role | Members |
| --- | --- |
| Committers and reviewers | [Md Shahanur Islam Shagor (@smshagor-dev)](https://github.com/smshagor-dev) |
| Approvers | [Md Shahanur Islam Shagor (@smshagor-dev)](https://github.com/smshagor-dev) |

Privacy policy: see [docs/legal/privacy-policy.md](docs/legal/privacy-policy.md). This program will not transfer any information to other
networked systems unless specifically requested by the user or the person installing or operating it, except the two
automatic requests described there: the update check (GitHub) and, while the Extensions view is shown, the Open VSX
marketplace list (can be turned off).

## Project layout

- `crates/*` — domain crates (core, database, settings, file system, workspace, terminal, runtime manager, runner, Git,
  LSP, DAP, search, extensions, AI, network, collaboration …).
- `src-tauri/` — the Tauri application (the executable is `OpenMindStudio.exe`).
- `src/` — the React/TypeScript user interface.
- `docs/` — design notes and operating guides; [`CLAUDE.md`](CLAUDE.md) is the detailed architecture and milestone log.

## Licence

OpenMind Studio is licensed under the Apache License 2.0 ([LICENSE](LICENSE)). Third-party components keep their own
licences; the packages ship them in `THIRD-PARTY-LICENSES.txt` (generated by `pnpm licenses:generate`).
