# Releasing OpenMind Studio (Windows)

OpenMind Studio ships in three forms. None of them needs administrator rights except the MSI (see below), none changes
PATH, and the app keeps all its data next to its own executable.

| Artifact         | How                     | Notes                                               |
| ---------------- | ----------------------- | --------------------------------------------------- |
| Setup EXE (NSIS) | `pnpm release:build`    | per-user install, no administrator rights           |
| MSI (WiX)        | `pnpm release:build`    | Windows Installer; may ask for administrator rights |
| Portable ZIP     | `pnpm package:portable` | unzip and run                                       |

## Build

```powershell
pnpm install
pnpm lsp:bundle               # the offline language servers -> lsp-bundle/ (the only step that downloads; see docs/lsp-bundle.md)
pnpm release:build            # checks lsp-bundle/, then tauri build --bundles nsis,msi  (release profile: slow, LTO)
pnpm package:portable         # optional: OpenMindStudio-<version>-portable-win-x64.zip
pnpm release:collect -- --portable "<path to the portable zip>"   # copies, signs (if configured), checksums, report
```

Per-architecture builds (the Rust target must be installed: `rustup target add i686-pc-windows-msvc`):

```powershell
pnpm release:build:x64        # tauri build --target x86_64-pc-windows-msvc --bundles nsis,msi
pnpm release:build:x86        # tauri build --target i686-pc-windows-msvc --bundles nsis,msi (32-bit; untested)
pnpm release:collect:all      # collects both, named ...-x64 / ...-x86
```

When the build used `CARGO_TARGET_DIR`, pass the same folder to the collector (`--target-dir <folder>`; `package:portable`
reads the variable, `release.mjs` reads only `.cargo/config.toml` or `--target-dir`). Without it the collector picks up
whatever older installer sits in `target/` — this happened once during Milestone 23.1; check the dates in
`RELEASE-REPORT.md`.

Before publishing a build that changes the network layer, run the smoke list in `docs/university-validation.md` on a
fresh unzip of the portable ZIP and save the network diagnostics (they must contain no token or password).

The offline language server bundle is `windows-x64` only: a 32-bit build still carries it, and its servers run only on
64-bit Windows (on 32-bit Windows the bundle is ignored and servers fall back to npm installs).

`release:collect` writes to `release/` (git-ignored):

- `OpenMind-Studio-Setup-<version>-x64.exe`, `OpenMind-Studio-<version>-x64.msi`, `OpenMind-Studio-Portable-<version>-x64.zip`
  — only the files that exist;
- `SHA256SUMS.txt` (`sha256sum` format);
- `RELEASE-REPORT.md` — version, architecture, **build type**, date, and each file's size and SHA256.

The tools needed (NSIS and WiX 3) are downloaded by Tauri's bundler the first time (into `%LOCALAPPDATA%\tauri`); that is
build tooling, not something the app does.

## The Apache-2.0 licence agreement

`src-tauri/tauri.conf.json` sets `bundle.license = "Apache-2.0"` and `bundle.licenseFile = "../LICENSE"`, so **the root
`LICENSE` is packaged and shown by both installers as the licence page**:

1. Welcome
2. **Licence agreement** — the NSIS installer's _Next/Install_ is blocked until the agreement is accepted; the MSI shows
   the licence and its _Next_ is blocked until the "I accept" box is ticked
3. Install location
4. Install
5. Finish, with a **Launch OpenMind Studio** checkbox

`release:collect` refuses to run (and a unit test fails) if `LICENSE` is not the full Apache 2.0 text or the installer
configuration stops referencing it. Never ship an installer that skips the agreement.

## Installer icons

All Windows app surfaces are pinned to `src-tauri/icons/icon.ico`: the installed executable gets it through
`bundle.icon`, the NSIS setup and uninstaller use it through `installerIcon`/`uninstallerIcon`, and the MSI includes
`src-tauri/wix/product-icon.wxs` so Apps & features does not fall back to the generic installer icon.

## Signing

Signing is optional and configured **only through environment variables** (never commit a certificate or a password):

| Variable                | Meaning                                                            |
| ----------------------- | ------------------------------------------------------------------ |
| `SIGNING_CERT_PATH`     | path to the `.pfx` certificate                                     |
| `SIGNING_CERT_PASSWORD` | its password (never printed or written)                            |
| `TIMESTAMP_URL`         | optional http(s) timestamp server, e.g. your CA's RFC 3161 address |
| `SIGNING_CERT_KIND`     | set to `test` for a self-signed test certificate                   |

`signtool.exe` (Windows SDK) signs the installers after they are built. The result is stated in `RELEASE-REPORT.md`:

- **unsigned** — nothing configured (development). Windows SmartScreen will warn. The build log says so.
- **test-signed** — signed with a self-signed test certificate (`SIGNING_CERT_KIND=test`); other computers do not trust it.
- **signed** — signed with the real certificate. Production signing needs a real code-signing certificate (not part of this repo).

A path without a password (or the reverse) is reported as a misconfiguration and the build stays unsigned. A test
certificate for a local check: `New-SelfSignedCertificate -Type CodeSigningCert -Subject "CN=OpenMind Studio Test" -CertStoreLocation Cert:\CurrentUser\My`
then export it to a `.pfx` **outside** the repository.

Limitation: only the installer files are signed; the `OpenMindStudio.exe` inside them is not (Tauri's `signCommand`
could sign it too and is the next step once a real certificate exists).

## Verify an install

1. Run the setup: the licence page appears; _Next_ stays disabled until you accept. Install, tick _Launch_.
2. The app opens to the Welcome page; Help > About shows **Apache-2.0**, no commit or build hash.
3. Apps & features (NSIS: per-user) lists _OpenMind Studio_; uninstall removes it. `data/`, `settings/` and other
   folders live next to the installed executable.
4. Confirm the User and Machine `PATH` are unchanged and no `OpenMindStudio`/`node`/`conhost` process is left after closing.

## SHA256

```powershell
Get-FileHash .\release\OpenMind-Studio-Setup-0.1.0-x64.exe -Algorithm SHA256
```

or read `SHA256SUMS.txt`. Publish the checksums next to the download.
