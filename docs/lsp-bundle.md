# Offline language server bundle

OpenMind Studio's release builds carry their language servers with them, so completion, hover, diagnostics,
go to definition, rename and formatting work right after installation, with no download and no internet
connection. This page is for whoever builds a release.

## What ships

| Server | Languages | Package / version | Runs on | Licence |
| --- | --- | --- | --- | --- |
| TypeScript Language Server | TypeScript, TSX, JavaScript, JSX | typescript-language-server 5.1.3 + typescript 5.9.3 | bundled Node.js | Apache-2.0 |
| Pyright | Python | pyright 1.1.414 | bundled Node.js | MIT |
| JSON / CSS / HTML servers | JSON, JSONC, CSS, SCSS, Less, HTML | vscode-langservers-extracted 4.10.0 | bundled Node.js | MIT |
| YAML Language Server | YAML (incl. Docker Compose) | yaml-language-server 1.24.0 | bundled Node.js | MIT |
| Bash Language Server | `.sh`, `.bash` | bash-language-server 5.8.1 | bundled Node.js | MIT |
| Dockerfile Language Server | `Dockerfile`, `Dockerfile.*`, `Containerfile`, `*.dockerfile` | dockerfile-language-server-nodejs 0.15.0 | bundled Node.js | MIT |
| rust-analyzer | Rust | release 2026-09-21 | its own program | MIT OR Apache-2.0 |
| clangd | C, C++ | 22.1.6 | its own program | Apache-2.0 WITH LLVM-exception |
| Node.js | — (runs the servers above) | 24.21.0 (`node.exe` only, no npm) | — | MIT |

Every dependency and its licence is listed in `lsp/THIRD-PARTY-NOTICES.txt` (generated); the licence texts are
inside each pack (`node_modules/<package>/LICENSE*`) and next to `node.exe`.

**Not bundled: Intelephense (PHP).** Its licence forbids redistribution ("You are NOT permitted to … reproduce,
copy, distribute … the whole or any part of the Software"). The registry marks it `redistributable: false`; the
build script skips it, the check refuses a bundle that contains it, and the app never takes it from a bundle.
PHP language features stay a user-initiated install from npm in Language Tools.

Not bundled because they need a toolchain OpenMind doesn't ship: gopls (Go), Eclipse JDT LS (Java),
OmniSharp/csharp-ls (.NET), Kotlin, Dart. They are still reported as "found / can't start yet".

## Sizes (Windows x64)

- `lsp/` in the app: 167 MB (packs are compressed zips, 106 MB; `node.exe` 89 MB).
- Installers with the bundle: NSIS setup 104 MB, MSI 121 MB, portable ZIP 120 MB.
- On disk after every server has been used once: `language-servers/` about 317 MB more.

## Layout and runtime behaviour

```text
<app folder>/
  lsp/bundle.json            format, platform, Node.js entry and one entry per pack (file, SHA256, size, licence)
  lsp/node/node.exe          the Node.js the Node-based servers run on
  lsp/packs/<id>-<rev>.zip   one archive per package
  lsp/THIRD-PARTY-NOTICES.txt
  language-servers/<id>/<rev>/   a pack, unpacked on first use (with a .openmind-bundle marker naming its SHA256)
```

- **Nothing starts at launch.** A server's pack is unpacked the first time a file of its language is opened inside
  the open folder (or when Language Tools' *Unpack Now* is pressed), then the server starts. The archive's SHA256 is
  checked before anything is written; entry names can't leave the target folder, links are refused, size and entry
  count are capped; files go to a staging folder that is renamed into place only when every server's entry file is
  there. A rebuilt bundle (different SHA256, same revision) is unpacked again the next time the server starts.
- **Node-based servers run on `lsp/node/node.exe`** first, then OpenMind's portable Node, then a system Node as a
  labelled fallback. rust-analyzer and clangd are started directly.
- **No network.** The app never downloads a server from the bundle's sources. Servers that would reach out on their
  own are configured not to: TypeScript's automatic type acquisition is off (`disableAutomaticTypingAcquisition`),
  the JSON server loads only `file:` schemas (`handledSchemaProtocols`), the YAML server doesn't fetch the SchemaStore
  catalogue and asks the client for remote schemas (`yaml/registerContentRequest`), which OpenMind refuses with
  "remote schemas are not downloaded (OpenMind Studio's language servers work offline)", and rust-analyzer's cargo
  runs with `CARGO_NET_OFFLINE=true`. clangd runs without a background index (it would write `.cache/clangd` into the
  project).
- **No PATH, Registry or admin.** The bundle's folders are only ever on the PATH of the server process itself.
- rust-analyzer still runs the machine's `cargo` for project metadata and `cargo check` (as in VS Code), which
  creates `target/` and `Cargo.lock` in a Rust project; without the Rust toolchain it keeps syntax-level features
  only. clangd works best with a `compile_commands.json`; system headers need a C/C++ toolchain.

## Building the bundle

```text
pnpm lsp:bundle                         # everything
pnpm lsp:bundle -- --only yaml,rust     # rebuild some packs, keep the others (node = the Node.js entry)
pnpm lsp:bundle -- --check              # verify sizes and SHA256 without changing anything
```

`scripts/prepare-lsp-bundle.mjs` is the only code that downloads for the bundle:

- npm packages: `npm ci --ignore-scripts` from the lockfiles pinned in `crates/lsp/servers/<id>/` (every file
  checked against its integrity hash), npm's cache in `.lsp-bundle-cache/downloads/npm`;
- Node.js and the native servers: the URLs pinned with SHA256 in `crates/lsp/servers/bundle-sources.json` (Node.js
  is the same version and checksum as the Runtime Manager's manifest; a test keeps them equal); a mismatch stops the
  build and nothing is used;
- each pack is built by `cargo run -p openmind-lsp --example bundle_tool -- pack …`, which refuses a folder missing
  any server's entry file; archives are extracted with the app's own checked extractor.

`lsp-bundle/` then holds only what ships (only its `README.txt` is committed); downloads and work folders live in
`.lsp-bundle-cache/` (git-ignored). `tauri.conf.json` copies `../lsp-bundle/` to `lsp/` in both installers (and next
to the exe of any `tauri build`/`tauri dev`), `pnpm package:portable` copies it into the ZIP after `--check`, and
`pnpm release:build` / `pnpm package:installer` refuse to run until `--check` passes.

## Updating a server

1. Change the pin: `crates/lsp/servers/<id>/package.json` + `npm install --package-lock-only --ignore-scripts`, or the
   URL/SHA256 in `bundle-sources.json` for Node.js or a native server.
2. Bump the package's `revision` in `crates/lsp/src/registry.rs` (and in `bundle-sources.json` for a native one) so
   existing installs unpack the new pack instead of trusting the old folder; update `contents`.
3. Check the new version's licence still allows redistribution.
4. `pnpm lsp:bundle`, then run every bundled server for real:

   ```text
   set OPENMIND_LSP_BUNDLE=<repo>\lsp-bundle
   cargo test -p openmind-lsp --test bundled_servers -- --ignored
   ```

   Each test unpacks its pack into a fresh folder, runs the server with a PATH of only `System32` (no system Node,
   npm, Python, Rust or C++ toolchain) and needs a real answer (a diagnostic, hover or document symbols).

## Limits

- Windows x64 only. The bundle is accepted on 64-bit Windows, also by a 32-bit build of the app and on ARM64 (x64
  emulation) — both untested; only x64 was verified. Other platforms fall back to installing from npm.
- The NSIS uninstaller keeps the app's data folders, including the unpacked `language-servers/`; delete that folder
  by hand to reclaim the space.
- The MSI installs per machine into Program Files, where the app can't write `language-servers/` without
  administrator rights (the same limit as every other app-local folder in that edition); use the per-user setup or the
  portable ZIP.
- No automatic updates of the servers: a new version arrives with a new app build.
