# OpenMind Studio 0.1.0 — release notes (draft)

The first Windows build of OpenMind Studio: a portable, native code editor (Rust + Tauri + Monaco). Apache License 2.0.

## Highlights

- Editor with tabs, groups, Markdown/HTML/PDF/DOCX/XLSX/CSV previews, Explorer with file and folder icons and icon themes.
- Format Document (built-in JSON formatter, Prettier/Biome/Black/Ruff/rustfmt/gofmt/clang-format when present), Format on
  Save, Auto Save, New File... anywhere on the computer.
- Integrated terminal, Git client, language servers, debugger (Python, Node.js), Run Code, indexed search.
- Portable Runtime Manager (Node.js, Python, Git, PHP, Composer, MariaDB, phpMyAdmin) and a PHP control panel.
- Extensions (VS Code-compatible subset, Open VSX), AI providers (Claude, OpenAI-compatible, Gemini, local) — the AI panel
  appears only when a provider is enabled.
- Profiles (Default, Web Development, Python, PHP / Laravel, Systems, Minimal / Low memory), settings and shortcut pages,
  themes.
- The UI follows the PC's language: English, Russian and Bangla are bundled (English for anything else); Settings >
  Display Language chooses another. Nothing is downloaded or translated online.
- Everything stays in the app folder; nothing changes PATH; nothing is fetched at launch.

## Installing

- **Setup EXE** — per-user, no administrator rights. **MSI** — Windows Installer (may ask for administrator rights).
  **Portable ZIP** — unzip and run. Both installers show the Apache 2.0 licence and require acceptance.
- Builds are **unsigned** unless the release report says otherwise; Windows SmartScreen will warn.

## Known limitations

- Windows x64 only. No online marketplace beyond Open VSX, no cloud sync, no accounts.
- No signing certificate yet; only installer files can be signed by `release:collect`.
- Tasks, multi-folder workspaces, Replace in Files, launch.json and conditional breakpoints are not built (their menu
  entries are disabled with a reason). Extension icon themes and webview views are unsupported.
- No tool binaries are bundled (Prettier, language servers ... come from the project, the Runtime Manager or PATH).
- A project-local formatter runs on save by default: turn off `formatter.useProjectLocalTools` for folders you do not trust.
- The Russian and Bangla translations have not been reviewed by native speakers; Monaco's own editor widgets, native
  file dialogs, the installers and some screens (see docs/localization.md) are still English.
- Memory is dominated by WebView2 (about 200-460 MB in total when idle).
