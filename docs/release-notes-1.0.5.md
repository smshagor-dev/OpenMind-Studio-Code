# OpenMind Studio v1.0.5

**Released:** October 27, 2026  
**Previous version:** v1.0.4  
**Focus:** VS Code extension compatibility, editor recovery, OpenMind AI Cloud settings, and stability.

## New and improved

### VS Code compatibility
- Expanded VS Code settings, profiles, and extension import workflows, including running imported extensions.
- Added native ESM extension support, inline completions, and native dialog integration.
- Improved editor APIs: selections, focus, split views, decorations, snippets, indentation, line numbers, undo/EOL handling, and edit validation.
- Expanded language extension APIs: semantic tokens, inlay hints, language actions, colors, and language configurations.
- Added workspace folder selection through extension quick-pick APIs.
- Expanded task execution, pseudoterminals, debugger source documents, notebook editing, and extension event handling.

### Editor documents and recovery
- Added unnamed and named untitled documents and Save As workflows.
- Added writable provider-backed virtual documents and read-only editors with mutation guards.
- Improved recovery of unsaved local files, virtual documents, and provider buffers.
- Isolated recovery records per window; restored extra windows with close/recovery confirmation.
- Improved flushing editor state before Quit or application updates.

### OpenMind AI Cloud
- Redesigned provider settings.
- Removed desktop-side text and generation caps in supported input flows. Model and provider limits still apply.

### Pascal
- Added PascalABC.NET support beside Free Pascal on supported Windows builds, with Runtime Manager, offline bundle, compiler selection, Run Code, and diagnostics.
- Improved extraction of ZIP filenames encoded with DOS Cyrillic code page 866.

## Fixed
- Extension activation races and filesystem permission escape issues.
- Truncated extension-store implementation and its tests.
- Native extension-host channel allowlist and language-configuration lifecycle handling.
- Provider document ownership on registration failure.
- Stale snippet insertion and misplaced Monaco editor decorations.
- Debugger transport shutdown and virtual Save As identity handling.
- Recovery conflicts involving local on-disk changes and multiple editor windows.
- Oversized extension-host modules refactored for maintainability.

## Packaging
- Version metadata updated to `1.0.5` across package.json, Tauri, the Rust workspace, internal crate constraints, and Cargo.lock.
- Supported build outputs include Windows EXE/MSI/portable ZIP and Linux DEB/AppImage/portable tar.gz. Check the [release assets](https://github.com/smshagor-dev/OpenMind-Studio/releases/tag/v1.0.5) for available downloads.
- Updater signatures require the existing Tauri signing key; they are distinct from Windows Authenticode signing.

## Known limitations
- Not every third-party VS Code extension API is supported or fully smoke-tested.
- PascalABC.NET is Windows-only, without a dedicated language server or debugger.
- Linux distributions need compatible WebKitGTK and glibc; portable Linux tools differ from Windows bundles.
- Desktop AI input cap changes do not bypass model/provider context limits.

## Upgrade
1. Save work and close OpenMind Studio.
2. Download the correct asset for your platform and architecture.
3. Update the existing installation, or replace program files in your portable copy while preserving user data.
4. Reopen and verify your settings, workspace, and extensions.

For build/signing instructions, see [release.md](release.md). For the previous release, see [v1.0.4 notes](release-notes-1.0.4.md).
