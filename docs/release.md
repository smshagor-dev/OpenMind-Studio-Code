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
| `TIMESTAMP_URL`           | your CA's RFC 3161 time-stamp server (http(s)). **Required for a real certificate**: without a timestamp a signature stops being valid when the certificate expires |
| `SIGNING_NO_TIMESTAMP`    | `1` waives that requirement (an internal build only)                                                                                                     |
| `SIGNING_CERT_KIND`       | set to `test` for a self-signed test certificate (no timestamp needed)                                                                                    |

`tauri build` signs every Windows binary it makes — `OpenMindStudio.exe`, the NSIS installer and uninstaller, the MSI —
through `bundle.windows.signCommand` (`scripts/sign-file.mjs` -> `signtool.exe` from the Windows SDK), _before_ it writes
the updater `.sig` files, so those stay valid. With nothing configured the command does nothing (development builds); a
half-made configuration stops the build. `release.mjs` copies the files with their `.sig`, signs only a file that isn't
signed yet, and states the result in `RELEASE-REPORT.md`:

- **unsigned** — nothing configured (development). Windows SmartScreen will warn. The build log says so.
- **test-signed** — signed with a self-signed test certificate (`SIGNING_CERT_KIND=test`); other computers do not trust it.
- **signed** — signed with the real certificate. Production signing needs a real code-signing certificate (not part of this repo).

**Verification.** After collecting, `release.mjs` asks Windows (`Get-AuthenticodeSignature`) about every installer: a
**signed** build must have a *Valid* signature (trusted chain, file unchanged since signing) with an RFC 3161 timestamp;
a **test-signed** one must be signed and unchanged. Each file's result is listed in `RELEASE-REPORT.md`; any failure
reports the build as **unsigned** and the script exits 1. The same check by hand, on any file:

```powershell
node scripts/verify-signatures.mjs "release\OpenMind-Studio-Setup-1.0.2-x64.exe" "release\OpenMind-Studio-1.0.2-x64.msi"
node scripts/verify-signatures.mjs --mode test-signed <files>   # a test certificate
```

**SmartScreen.** A valid signature is necessary but not sufficient: Microsoft Defender SmartScreen also builds
*reputation* for the publisher and for each file over time and downloads, so a newly signed release (especially from a
new certificate) can still show "Windows protected your PC" at first. Nothing in this project disables or works around
SmartScreen, Smart App Control or Defender. The executable's manifest (`src-tauri/windows-app-manifest.xml`) declares
`asInvoker`, Windows 10/11 support and long paths, and the publisher, product name and version are the same in the
executable, both installers and the uninstall entry, which is what Windows shows to users.

### SignPath (GitHub Actions)

`.github/workflows/release-windows.yml` (started by hand) builds the release on GitHub Actions and, when SignPath is
configured, has SignPath sign the files in the order that keeps everything valid: the program first, then the
installers built around the signed program, then the update signatures (`.sig`) of the signed installers, then
`verify-signatures.mjs` and `release.mjs` (with `SIGNING_EXTERNAL=true`: verify only). Nothing is published; the files
are kept as a workflow artifact.

Setting it up (SignPath Foundation offers free signing to eligible open-source projects; that approval is SignPath's
decision, not something this repository can arrange):

1. In SignPath: a project, a signing policy (e.g. `release-signing`) and two artifact configurations — one for a single
   `OpenMindStudio.exe`, one for a ZIP with the NSIS `.exe` and the `.msi` (Authenticode, SHA-256, with SignPath's
   timestamping).
2. In the GitHub repository: variables `SIGNPATH_ORGANIZATION_ID`, `SIGNPATH_PROJECT_SLUG`, `SIGNPATH_POLICY_SLUG`,
   `SIGNPATH_EXE_CONFIG_SLUG`, `SIGNPATH_INSTALLER_CONFIG_SLUG`; secrets `SIGNPATH_API_TOKEN`, `TAURI_UPDATER_KEY` (the
   minisign private key text) and `TAURI_UPDATER_KEY_PASSWORD`.
3. Without `SIGNPATH_ORGANIZATION_ID` the workflow builds an unsigned release (reported as such).

The workflow has **not been run yet** (no SignPath project exists for this repository at the time of writing); expect
to adjust artifact configuration slugs and file patterns on the first run.

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

## Automatic updates (GitHub Releases)

Every installed or portable copy checks
`https://github.com/smshagor-dev/OpenMind-Studio/releases/latest/download/latest.json` 45 seconds after start-up and
then every 6 hours (after a failure sooner, 1 → 2 → 4 … minutes, at most an hour; offline is just a failed check).
GitHub resolves `releases/latest` to the newest **published, non-pre-release** release, which is the stable channel.

**What a release must contain** — or no copy can update to it:

1. Each installer **with its update signature**: `OpenMind-Studio-Setup-<v>-x64.exe` + `.exe.sig`,
   `OpenMind-Studio-<v>-x64.msi` + `.msi.sig` (and the `x86` ones). `tauri build` makes the `.sig` files when the updater
   key is in the environment (`pnpm release:build` does it through `scripts/tauri-signed.mjs`; CI uses the
   `TAURI_UPDATER_KEY` secret). Each signature carries the version (`version:<v>` in its trusted comment) and the app
   requires that (`plugins.updater.requireSignedVersion`), so a tampered feed can't pair a new number with an old file.
2. The portable archive `OpenMind-Studio-<v>-x64-portable.zip` + `.zip.sig` — `release.mjs` signs it with the same key,
   bound to the version.
3. **`latest.json`**, written by `release.mjs` from exactly those files (`scripts/updateFeed.mjs`): `windows-x86_64`,
   `-nsis`, `-msi` (and `windows-i686…`) with the release's own download addresses, plus an `openmind` section (`channel`,
   the signed portable archives, and `minimumVersion` when set). It is not written when an installer has no `.sig`.

Upload all of them as assets of the release `v<version>`; publish it as a normal (not pre-) release last.

**Mandatory update**: run `release.mjs` with `OPENMIND_MINIMUM_VERSION=<x.y.z>` (CI: the repository variable of that
name). Copies older than it show "Update required" — only once the update is downloaded, verified and can be installed
on that computer; a computer that can't (offline, no permission, a shared installation) keeps working. Leave it unset
for an ordinary release.

**How each copy takes it** (`src-tauri/src/updates/`):

| Copy | Behaviour |
| --- | --- |
| Per-user setup ("For Me") | downloads and verifies in the background; installs when the app is closed, or at once with Restart to Update; no administrator rights |
| MSI (Program Files) | the same; Windows asks for administrator approval when the installer runs (never bypassed) |
| Portable ZIP | downloads the signed portable archive, verifies it, and at Restart to Update replaces only the program's own files (`OpenMindStudio.exe`, `lsp/`, `python-bundle/`, `bin/`, `README.txt`), all or nothing; data, settings, runtimes, tools and extensions stay |
| Shared network installation ("Recommended for All Users") | only shows "Version x is available": it is updated by whoever installed it (run the new setup on that computer with the shared folder, while nobody uses it); no client ever writes the share |

Never automatic: closing the app, stopping a running build or terminal without asking, saving or discarding an editor.
Restart to Update is refused while any window has unsaved editors, and asks before stopping running terminals or Run
Code programs. Settings > Workbench > **Automatic Updates** (`updates.automatic`, on by default) off = only notify.

**Copies of 1.0.2 and older don't update themselves**: they contain no code that checks (only the backend command
existed) and 1.0.0–1.0.2 were published without `latest.json`. Each needs the first release with automatic updates to be
installed once by hand; every later release then arrives automatically.

## Release gate

A release is published only when all of these hold; otherwise it is **PILOT-READY** (everything but the real-hardware
pilot and signing) or **BLOCKED**:

1. No open data-loss or cross-computer corruption defect.
2. Quality gates, all exit code 0: `cargo fmt --all --check`, `cargo clippy --workspace --all-targets -- -D warnings`,
   `cargo test --workspace`, `pnpm lint`, `pnpm exec tsc -b`, `pnpm test`.
3. Installers built: NSIS setup, MSI, portable ZIP (`pnpm release:build`, `pnpm package:portable`).
4. The multi-PC pilot (`docs/pilot/multi-pc-pilot.md`) passed on real computers — a single-computer simulation
   through `\\localhost` does not count.
5. Signed for the channel: a public release needs a CA-issued certificate (or SignPath) with RFC 3161 timestamps and
   `verify-signatures.mjs` passing; a test-signed or unsigned build is for internal testing only.
6. Upgrade from the previous release and the rollback in `docs/release-notes-next.md` checked.

Version bump, commit, tag and publishing need the maintainer's approval.

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
