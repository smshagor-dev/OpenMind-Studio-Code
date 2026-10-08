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
pnpm lsp:bundle               # the offline language servers -> lsp-bundle/ (downloads; see docs/lsp-bundle.md)
pnpm python:bundle -- --python "<a CPython 3.14 x64 python.exe>"
                              # the offline Python packages -> python-bundle/ (downloads; see python-bundle/README.txt)
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

Portable ZIPs per architecture: `package:portable -- --no-build --exe <target>/<triple>/release/OpenMindStudio.exe --out <folder>`
for each build, then pass them to the collector with `--portable <x64 zip> --portable-x86 <x86 zip>` (the zip's own name
says `win-x64`; the collector renames it to `OpenMind-Studio-<version>-<arch>-portable.zip`).

When the build used `CARGO_TARGET_DIR`, pass the same folder to the collector (`--target-dir <folder>`; `package:portable`
reads the variable, `release.mjs` reads only `.cargo/config.toml` or `--target-dir`). Without it the collector picks up
whatever older installer sits in `target/` — this happened once during Milestone 23.1; check the dates in
`RELEASE-REPORT.md`.

Before publishing a build that changes the network layer, run the smoke list in `docs/university-validation.md` on a
fresh unzip of the portable ZIP and save the network diagnostics (they must contain no token or password).

The offline language server bundle is `windows-x64` only: a 32-bit build still carries it, and its servers run only on
64-bit Windows (on 32-bit Windows the bundle is ignored and servers fall back to npm installs).

`release:collect` writes to `release/` (git-ignored):

- `OpenMind-Studio-Setup-<version>-x64.exe`, `OpenMind-Studio-<version>-x64.msi`, `OpenMind-Studio-<version>-x64-portable.zip`
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

| Variable                  | Meaning                                                                                                                                                   |
| ------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `SIGNING_CERT_THUMBPRINT` | a certificate in the current user's Windows certificate store (SHA-1 thumbprint; no password, the key stays in the store) — used instead of the two below |
| `SIGNING_CERT_PATH`       | path to the `.pfx` certificate                                                                                                                            |
| `SIGNING_CERT_PASSWORD`   | its password (never printed or written)                                                                                                                   |
| `TIMESTAMP_URL`           | optional http(s) timestamp server, e.g. your CA's RFC 3161 address                                                                                        |
| `SIGNING_CERT_KIND`       | set to `test` for a self-signed test certificate                                                                                                          |

`tauri build` signs every Windows binary it makes — `OpenMindStudio.exe`, the NSIS installer and uninstaller, the MSI —
through `bundle.windows.signCommand` (`scripts/sign-file.mjs` -> `signtool.exe` from the Windows SDK), _before_ it writes
the updater `.sig` files, so those stay valid. With nothing configured the command does nothing (development builds); a
half-made configuration stops the build. `release.mjs` copies the files with their `.sig`, signs only a file that isn't
signed yet, and states the result in `RELEASE-REPORT.md`:

- **unsigned** — nothing configured (development). Windows SmartScreen will warn. The build log says so.
- **test-signed** — signed with a self-signed test certificate (`SIGNING_CERT_KIND=test`); other computers do not trust it.
- **signed** — signed with the real certificate. Production signing needs a real code-signing certificate (not part of this repo).

A path without a password (or the reverse) is reported as a misconfiguration and the build stays unsigned. A test
certificate for a local check: `New-SelfSignedCertificate -Type CodeSigningCert -Subject "CN=OpenMind Studio Test" -CertStoreLocation Cert:\CurrentUser\My`
then export it to a `.pfx` **outside** the repository.

The developer machine has a self-signed certificate `CN=OpenMind` (CurrentUser\My, valid to 2031, public part in
`%USERPROFILE%\.openmind-signing\openmind-codesign.cer`); use it with `SIGNING_CERT_KIND=test`. A computer trusts files
signed with it only after that `.cer` is imported into its _Trusted Root Certification Authorities_ and _Trusted
Publishers_ stores, so it is for testing and internal use; public downloads need a certificate from a CA. The portable
ZIP packs `<target>/<triple>/release/OpenMindStudio.exe`, which `tauri build` leaves **unsigned** (it signs a copy while
bundling): sign it first with `node scripts/sign-file.mjs <exe>`, then `package:portable -- --no-build --exe <exe>`.

## Verify an install

1. Run the setup: the licence page appears; _Next_ stays disabled until you accept. Install, tick _Launch_.
2. The app opens to the Welcome page; Help > About shows **Apache-2.0**, no commit or build hash.
3. Apps & features (NSIS: per-user) lists _OpenMind Studio_; uninstall removes it. `data/`, `settings/` and other
   folders live next to the installed executable.
4. Confirm the User and Machine `PATH` are unchanged and no `OpenMindStudio`/`node`/`conhost` process is left after closing.
5. PATH and File Explorer integration (optional, off by default; see `docs/installer.md`):
   - Install once with both Welcome-page boxes unchecked. PATH and `HKCU\Software\Classes\...\OpenMindStudio` must be
     unchanged.
   - Install with both checked, or silently with `/S /ADDTOPATH /EXPLORERMENU`. Then:
     - a **new** terminal runs `openmind <folder>`;
     - right-click on a folder, a folder background and a file shows **Open with OpenMind Studio**, under _Show more
       options_ on Windows 11, and each opens the app.
   - Uninstall: the `...\bin` PATH entry, the three Explorer keys and `HKCU\Software\OpenMind\OpenMind Studio
Integration` are gone. Every other PATH entry is as before.
   - Portable ZIP: launching must change neither PATH nor the Registry. The command-palette _Shell Integration_
     commands add and remove the same entries on request.
   - MSI, only with administrator rights: `msiexec /i ... ADDTOPATH=1 EXPLORERMENU=1`, then uninstall and check the
     machine PATH and `HKLM\Software\Classes`.

## SHA256

```powershell
Get-FileHash .\release\OpenMind-Studio-Setup-0.1.0-x64.exe -Algorithm SHA256
```

or read `SHA256SUMS.txt`. Publish the checksums next to the download.

## Linux (x64 in WSL, x86 in a Debian i386 container)

Linux editions: `.deb`, AppImage and a portable zip, for x64 and x86. Build x64 in a WSL Ubuntu with WebKitGTK 4.1 and from a clone on the Linux file system (the
Windows `node_modules` holds Windows binaries):

```bash
sudo apt install -y build-essential pkg-config libssl-dev libgtk-3-dev librsvg2-dev libwebkit2gtk-4.1-dev \
  libayatana-appindicator3-dev libxdo-dev patchelf squashfs-tools libfuse2t64 xdg-utils
git clone "/mnt/e/Code Editor" ~/openmind-build && cd ~/openmind-build && pnpm install --frozen-lockfile
export OPENMIND_UPDATER_KEY=/mnt/c/Users/<you>/.tauri/openmind-studio.key   # + TAURI_SIGNING_PRIVATE_KEY_PASSWORD
APPIMAGE_EXTRACT_AND_RUN=1 node scripts/tauri-signed.mjs build --bundles deb,appimage
```

`src-tauri/tauri.linux.conf.json` sets the targets and leaves out the Windows-only resources (the offline LSP/formatter
and Python bundles, `openmind.cmd`). The portable archive is a `.tar.gz` of `OpenMind Studio/OpenMindStudio` (mode 755) plus a README (tar keeps the
mode); name the files `OpenMind-Studio-<version>-amd64.deb`, `OpenMind-Studio-<version>-x86_64.AppImage` and
`OpenMind-Studio-<version>-linux-x86_64-portable.tar.gz`, and sign each with `pnpm tauri signer sign` (the updater key)
for its detached `.sig`. A `.deb` installs to `/usr/bin` and an AppImage runs from a
read-only mount, so both keep their data in `$XDG_DATA_HOME/openmind-studio` (`~/.local/share/openmind-studio`); the
portable copy keeps it next to itself when that folder is writable. Not available on Linux: the offline bundles, the
Runtime Manager's downloads (Windows x64 artifacts) and DPAPI-encrypted secrets (stored unencrypted).

**x86 (32-bit)**: Ubuntu has no 32-bit WebKitGTK, but Debian trixie still builds it for i386. Run a `debian:trixie`
container with `--platform linux/386` (Docker Desktop): install the same `-dev` packages with apt, rustup with
`--default-host i686-unknown-linux-gnu`, `cargo install tauri-cli --version <the project's @tauri-apps/cli> --locked`,
clone the repository, copy in the frontend `dist/` built on x64 (Node has no 32-bit Linux build; the bundle doesn't
depend on the CPU), and run `cargo tauri build --bundles deb,appimage --config '{"build":{"beforeBuildCommand":""}}'`
with `TAURI_SIGNING_PRIVATE_KEY` (the key file's content), its password and `APPIMAGE_EXTRACT_AND_RUN=1`. Tauri
downloads the i386 linuxdeploy tools by itself. Name the files `...-i386.deb`, `...-i686.AppImage` and
`OpenMind-Studio-<version>-linux-i686-portable.tar.gz`. Check a build in the same container under `xvfb-run`.
