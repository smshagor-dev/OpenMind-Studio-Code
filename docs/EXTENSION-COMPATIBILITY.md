# VS Code extensions and local settings migration

OpenMind Studio can load VSIX packages through its own Node.js extension host. It does **not** run the full Microsoft VS Code extension host, and an installed VSIX is not a promise of full compatibility.

## Supported integration points

The extension host implements a subset of `vscode` APIs: commands and text-editor commands, workspace documents and selected filesystem operations, language providers, diagnostics, terminal and task bridges, tree views, webview panels/views, status bar items, snippets, themes, selected editor events, output channels, and extension secret storage. Unsupported API calls are reported in the extension's activity and host log.

The extension manifest's `engines.vscode` requirement is checked against the currently advertised API version (1.85.0). Matching that range means the version requirement passes; it **does not** guarantee that every API used by the extension is implemented.

Extensions are activated only if enabled and their required dependencies are installed, enabled and compatible. Dependencies activate before dependants; circular dependencies fail clearly. An extension with only a web entry is not executed as a Node extension.

## Install and migration

Use **Extensions → Install from VSIX** to inspect a package and review requested permissions.

To migrate from VS Code, open **Settings → Import from VS Code**, choose a local profile and preview the changes. Installed VS Code, Insiders, VSCodium and Code - OSS profiles are detected on supported operating systems.

- Compatible user settings are merged into OpenMind's user settings. Credentials and unsupported preferences are not imported.
- Unconditional, supported shortcuts can be imported. Conditional shortcuts and unsupported key chords are listed as skipped.
- A VS Code profile can be saved as a separate OpenMind profile without replacing the active profile.
- User snippet files can be imported and registered as language completions. Global `.code-snippets` files require a specific `scope` to be registered.
- Installed VS Code extension folders are listed for review. Each may be imported individually. Imported code is kept **disabled** until the user reviews compatibility and permissions and explicitly enables it. This is not an automatic bulk execution of extensions.

Current settings and keybindings have timestamped backups before modification. VS Code sources are read-only. If shortcut import fails after modifying the settings file, it attempts to restore the original settings.

## Extension host recovery

The host runs as a separate process and restarts after unexpected termination at most twice automatically; another restart must be requested by the user. Errors in extension activation clean up partially registered API contributions. Uncaught errors attributed to an extension quarantine it for the current host session, while other extensions continue running. Restarting the extension host clears that in-memory quarantine.

A malicious extension or unsupported native binary can still hang or terminate the shared host. This isolation is not a security sandbox guaranteeing uninterrupted execution.

## Verification

The source repository includes repeatable tests for VSIX parsing, install, enable/disable, uninstall, permission checks, dependency activation, JSONC migration parsing, and Node extension-host command/recovery behavior.

To run the cross-platform host integration tests:

```sh
node --test scripts/test-extension-host.mjs
```

For Windows compilation and frontend integration:

```sh
cargo fmt --all -- --check
cargo clippy --workspace --all-targets -- -D warnings
cargo test --workspace
pnpm install --frozen-lockfile
pnpm exec tsc --noEmit -p .
pnpm test
pnpm build
```

Real third-party extensions need separate installation and interactive testing on Windows, including extension activation, API calls, themes, terminals, reload, update, and uninstall. Until those checks pass, do not describe compatibility as universal.
