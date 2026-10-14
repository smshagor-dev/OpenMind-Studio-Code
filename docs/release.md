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

### Build scripts

The same steps as scripts, one per platform. Each checks the prerequisites and that the version is the same in
`package.json`, `tauri.conf.json` and `Cargo.toml` (`scripts/build-info.mjs version`), stops at the first failing step
with a nonzero exit code and never deletes release files.

| Script | Runs on | Builds |
| --- | --- | --- |
| `scripts\build-windows.bat [x64\|x86\|all] [--skip-checks] [--replace]` | Windows | the checks (lint, types, tests, rustfmt, clippy, Rust tests; `--skip-checks` leaves them out), then per architecture the setup EXE, MSI and portable ZIP, collected into `release\v<version>\windows\<arch>\`, then updater signatures (`pnpm release:sign`, only when the key's password is available: `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` or the DPAPI file), checksums and the architecture check. Refuses when that architecture's folder already has files, unless `--replace`. x86 needs NASM on PATH. |
| `scripts/linux-release.sh` | Linux (x64 in WSL, x86 in a Debian i386 container; below) | the deb, AppImage and portable tar.gz of the machine's architecture, then checks each file: present and not empty, the deb's architecture and version, the AppImage's and the portable program's ELF machine, and the executable bits inside the tarball. |
| `scripts/build-macos.command [arm64\|x64\|all]` | macOS only | `pnpm build`, then `scripts/macos-release.sh` for each architecture, then the checksums. Ad-hoc signed only (not Developer ID, not notarized). |

Per-architecture builds (the Rust target must be installed: `rustup target add i686-pc-windows-msvc`):

```powershell
pnpm release:build:x64        # tauri build --target x86_64-pc-windows-msvc --bundles nsis,msi
pnpm release:build:x86        # tauri build --target i686-pc-windows-msvc --bundles nsis,msi (32-bit; untested)
pnpm release:collect:all      # collects both, named ...-x64 / ...-x86
```

The x86 build needs **NASM on PATH**: `aws-lc-sys` (pulled in by the collaboration crate's DTLS stack, `str0m` →
`dimpl` → `aws-lc-rs`) has prebuilt assembler objects for x64 only. Without NASM the i686 build stops with "NASM command
not found". Take `w64devkit/bin/nasm.exe` from the Runtime Manager's pinned w64devkit 1.19.0 archive (its SHA-256 is in
`crates/runtime-manager/manifests/assembly.json`); the release workflow does the same. The x86 packages carry the same
x64-only offline bundles (`lsp/`, `python-bundle/`); the app uses them only on 64-bit Windows.

Portable ZIPs per architecture: `package:portable -- --no-build --exe <target>/<triple>/release/OpenMindStudio.exe --out release/staging/portable-<arch>`
for each build (the default `--out` is `release/staging/portable`), then pass them to the collector with
`--portable <x64 zip> --portable-x86 <x86 zip>` (the zip's own name says `win-x64`; the collector renames it to
`OpenMind-Studio_<version>_windows_<arch>_portable.zip`).

When the build used `CARGO_TARGET_DIR`, pass the same folder to the collector (`--target-dir <folder>`; `package:portable`
reads the variable, `release.mjs` reads only `.cargo/config.toml` or `--target-dir`). Without it the collector picks up
whatever older installer sits in `target/` — this happened once during Milestone 23.1; check the dates in
`RELEASE-REPORT.md`.

Before publishing a build that changes the network layer, run the smoke list in `docs/university-validation.md` on a
fresh unzip of the portable ZIP and save the network diagnostics (they must contain no token or password).

The offline language server bundle is `windows-x64` only: a 32-bit build still carries it, and its servers run only on
64-bit Windows (on 32-bit Windows the bundle is ignored and servers fall back to npm installs).

### Where release files go

Every release file goes into the project's own release folder, **`<project>/release/v<version>/`** (git-ignored with
`/release/`); nothing is written to another drive or folder, and no clone or copy of the source is made for a release.
Build caches may live elsewhere (`CARGO_TARGET_DIR`, e.g. an external cache when the drive is full); only the
finished files must be in the project.

```text
release/v<version>/
    windows/x64/, windows/x86/   OpenMind-Studio_<version>_windows_<arch>_setup.exe, _<arch>.msi, _<arch>_portable.zip (+ .sig)
    linux/x64/, linux/x86/       OpenMind-Studio_<version>_linux_<arch>.deb, .AppImage, _portable.tar.gz (+ .sig)
    macos/arm64/, macos/x64/     OpenMind-Studio_<version>_macos_<arch>.dmg, .app.zip (+ .sig for the app ZIP)
    launchers/windows|linux|macos/   the launcher scripts (also inside each portable package)
    metadata/
        latest.json              the update feed (only when every installer has its .sig)
        SHA256SUMS.txt           sha256sum format, bare file names (works on a flat download of the GitHub release)
        RELEASE-NOTES.md, PRIVACY-POLICY.md, TERMS-OF-USE.md, EULA.md, LICENSE.txt, THIRD-PARTY-LICENSES.txt
    validation/
        reports/RELEASE-REPORT.md    version, architectures, build type, date, each file's size and SHA256
        upgrade-test/                the Windows Sandbox upgrade test and its results
release/staging/                 intermediate files (portable ZIPs before they are renamed)
```

- `release:collect` / `release:collect:all` copy the Windows files into `windows/<arch>/` (only those that exist) and
  rewrite `metadata/SHA256SUMS.txt` over every platform folder.
- `scripts/linux-release.sh` (below) puts the Linux files into `linux/<arch>/`, `scripts/macos-release.sh <triple>` the
  macOS files into `macos/<arch>/` (on a Mac only).
- `pnpm release:sign` (`scripts/sign-release.mjs`) makes the updater `.sig` of every release file that has no valid one
  (`--force`: all), with `~/.tauri/openmind-studio.key` and its password (`TAURI_SIGNING_PRIVATE_KEY_PASSWORD`, or the
  DPAPI file `~/.tauri/openmind-updater.password.dpapi`), bound to the version, checks each one independently, then
  writes `metadata/latest.json` and `metadata/SHA256SUMS.txt`. Run it on the final bytes, after any Authenticode signing.
  Builds made without the key (`--config '{"bundle":{"createUpdaterArtifacts":false}}'`) are signed this way afterwards.
- `node scripts/release-metadata.mjs` copies the notes (`docs/release-notes-<version>.md`), the legal texts, the licences
  and the launchers into `metadata/` and `launchers/`.
- `pnpm release:checksums` rewrites `metadata/SHA256SUMS.txt` from the files present; `pnpm release:verify` checks every
  listed file, that nothing is missing from the list and that no file sits in the folder of another architecture (exit
  code 1 otherwise). On Linux/macOS: put the files in one folder with `SHA256SUMS.txt` and run `sha256sum -c`.

### Verifying a release folder

| Command | Checks |
| --- | --- |
| `pnpm release:verify` | every file in `SHA256SUMS.txt` exists and matches; no release file is missing from it |
| `node scripts/verify-architecture.mjs` | the program inside each portable ZIP/tar.gz, AppImage and deb is for the architecture in its name (PE/ELF machine; the deb's `Architecture:` too). The NSIS setup (always a 32-bit stub) and the MSI are not inspected — use `msiexec /a <msi> /qn TARGETDIR=<empty folder>` and check `OpenMindStudio.exe` |
| `node scripts/verify-updater-signatures.mjs --require-all` | every file's `.sig` against `plugins.updater.pubkey`, bound to the version; `latest.json` names only files of the folder, each with exactly its `.sig` |
| `OPENMIND_RELEASE_DIR=<folder> cargo test -p openmind-studio --bin openmind-studio real_release -- --ignored` | the app's own update check (`updates::portable::verify`, minisign_verify as in the Tauri updater) accepts each file, refuses a changed byte and another version, and accepts `latest.json` |

The release workflow runs the first three on the collected files before it uploads them.

### Updater feed, Linux and macOS

`latest.json` lists the Windows setups/MSIs (Tauri's `windows-<arch>[-nsis|-msi]`), the portable ZIPs
(`openmind.portable`) and — so Linux and macOS copies hear of a release — the deb and AppImage
(`linux-<arch>[-deb|-appimage]`) and the macOS app ZIP (`darwin-<aarch64|x86_64>`). Linux and macOS copies never update
themselves (`updates::policy::self_update_on`: managed, with a platform-specific message); their entries are read, never
downloaded. Without that rule a Linux copy (no `uninstall.exe`, so "portable") would take the Windows portable archive.

### macOS

`scripts/macos-release.sh aarch64-apple-darwin|x86_64-apple-darwin` builds on a Mac (the Release workflow uses GitHub's
`macos-15` and `macos-15-intel` runners) with `src-tauri/tauri.macos.conf.json`: the app and disk image, **ad-hoc
signed** (`signingIdentity "-"`, needed for Apple silicon to run it at all). That is not Developer ID signing and not
notarization: Gatekeeper asks the user to confirm the first start, and nothing in OpenMind tells the user to disable
it. Trusted macOS distribution needs an Apple Developer Program membership, a Developer ID Application certificate
(`APPLE_SIGNING_IDENTITY`, `APPLE_CERTIFICATE`/`APPLE_CERTIFICATE_PASSWORD` for CI), hardened runtime, and notarization
(`APPLE_ID`/`APPLE_PASSWORD`/`APPLE_TEAM_ID` or an App Store Connect API key), confirmed by `xcrun stapler validate`. A
macOS app keeps its data in `~/Library/Application Support/OpenMind Studio/Data`, never inside the bundle (writing there
would break the signature). Not available on macOS: the offline Windows bundles (`lsp/`, `python-bundle/`), the
Runtime Manager's downloads (Windows artifacts) and DPAPI encryption of secrets.

### CI

`.github/workflows/ci.yml` runs on every push/pull request to `main` (and as the first job of the release workflow):
fmt, clippy `-D warnings`, `cargo test --workspace`, eslint, `tsc`, vitest and the frontend build on Windows, and a Linux
build check. Actions are pinned by commit, Rust (`RUSTUP_TOOLCHAIN`), Node and pnpm by version; permissions are
`contents: read`. `release-windows.yml` (workflow "Release", manual) needs those checks, builds Windows x64/x86 and
Linux x64/x86 (x86 in a `debian:trixie` i386 container), collects and verifies everything and keeps it as one artifact;
it never writes to a repository. Publishing to the public release repository is a separate step with its own
fine-grained token (contents: write on that repository only) — the default `GITHUB_TOKEN` can't.

### Installer upgrade test (Windows Sandbox)

`scripts/upgrade-test/New-UpgradeTestSandbox.ps1 -Start` opens a disposable Windows Sandbox (network off) with the
previous and new release folders mapped read-only and runs `Invoke-UpgradeTest.ps1`: 1.0.2 → 1.0.3 for the x64 and x86
setups (same folder, version, one uninstall entry, database, settings and a runtime marker kept, repair run), a network
installation's layout kept on update, and the MSI 1.0.2 → 1.0.3. Results: `release/v<version>/validation/upgrade-test/results/`.
Windows Sandbox must be enabled once (administrator, then restart):
`Enable-WindowsOptionalFeature -Online -FeatureName Containers-DisposableClientVM -All`. Never run
`Invoke-UpgradeTest.ps1` outside the sandbox.

The tools needed (NSIS and WiX 3) are downloaded by Tauri's bundler the first time (into `%LOCALAPPDATA%\tauri`); that is
build tooling, not something the app does.

## License Agreement and Privacy Policy in the installers

The legal texts are written in `docs/legal/` (`eula.md`, `privacy-policy.md`, `terms-of-use.md`; owner/legal review
points in `REVIEW-NOTES.md`, not shipped). `scripts/legal-texts.mjs` (run by `pnpm build`) generates `licenses/legal/`
(git-ignored): `LICENSE-AGREEMENT.txt` = Part 1 the OpenMind Studio License Agreement (to accept), Part 2 the Privacy
Policy (for information — accepting the agreement turns nothing on), Part 3 the full Apache License 2.0; plus the three
documents and `LICENSE.txt`. `bundle.licenseFile` is that agreement and `bundle.resources` ships the folder as `legal/`
in every package (portable ZIP, tar.gz and macOS app ZIP too). `bundle.license` stays `Apache-2.0`.

1. Welcome (installation type) — or, over an existing installation, the Update/Repair page, which skips the agreement
   (accepted at the first install)
2. **License agreement** — NSIS: an **unchecked** "I accept the OpenMind Studio License Agreement" box
   (`MUI_LICENSEPAGE_CHECKBOX` in `nsis/installer-hooks.nsh`); _Install/Next_ stays disabled until it is ticked, Cancel
   declines. MSI: WiX's license dialog, _Next_ disabled until "I accept" is ticked. Silent/passive installs (`/S`, `/P`,
   `msiexec /qn`) skip the page as before — whoever runs them accepts on the users' behalf.
3. Install location
4. Install
5. Finish, with a **Launch OpenMind Studio** checkbox

Linux and macOS have no custom installer UI (a .deb is installed by the package manager, a disk image by dragging the
app): their packages carry `legal/` and the release page links the documents; no first-run agreement dialog was added
(the program is Apache-2.0 licensed and needs no click-through). The installers are English-only (NSIS `languages:
["English"]`); the legal texts have no Russian translation yet.

`release:collect` refuses to run (and unit tests fail) if the agreement lacks the EULA, the Privacy Policy or the full
Apache 2.0 text, the installer configuration stops referencing it, or the NSIS page loses its check box. Never ship an
installer that skips the agreement.

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
node scripts/verify-signatures.mjs "release\v1.0.3\windows\OpenMind-Studio_1.0.3_windows_x64_setup.exe" "release\v1.0.3\windows\OpenMind-Studio_1.0.3_windows_x64.msi"
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

Eligibility, the requirements with their sources, the SignPath and GitHub settings, the two artifact configurations
and the application draft are in [docs/signpath/](signpath/README.md). SignPath Foundation's approval is SignPath's
decision; it needs the source repository to be public.

The run's `signing` input is `required` by default: the workflow then fails before building unless SignPath is set up
(repository variable `SIGNPATH_ORGANIZATION_ID`), and verifies every Authenticode signature — the setups, the MSIs and
the program inside each portable ZIP — before keeping the files. `test-unsigned` builds without signing and names the
artifact `openmind-studio-release-UNSIGNED-TEST-ONLY`. The SignPath action is `v3.0` (pinned by commit); the release
jobs use no build cache (SignPath's origin verification wants builds fully determined by the repository).

The workflow has **not been run yet** (no SignPath project exists at the time of writing); expect to adjust slugs and
file patterns on the first run.

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

1. Each installer **with its update signature**: `OpenMind-Studio_<v>_windows_x64_setup.exe` + `.exe.sig`,
   `OpenMind-Studio_<v>_windows_x64.msi` + `.msi.sig` (and the `x86` ones). `tauri build` makes the `.sig` files when the updater
   key is in the environment (`pnpm release:build` does it through `scripts/tauri-signed.mjs`; CI uses the
   `TAURI_UPDATER_KEY` secret). Each signature carries the version (`version:<v>` in its trusted comment) and the app
   requires that (`plugins.updater.requireSignedVersion`), so a tampered feed can't pair a new number with an old file.
2. The portable archive `OpenMind-Studio_<v>_windows_x64_portable.zip` + `.zip.sig` — `release.mjs` signs it with the same key,
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
| Portable ZIP | downloads the signed portable archive, verifies it, and at Restart to Update replaces only the program's own files (`OpenMindStudio.exe`, `lsp/`, `python-bundle/`, `bin/`, `README.txt`, `LICENSE.txt`, `THIRD-PARTY-LICENSES.txt`, `legal/`, the launcher), all or nothing; data, settings, runtimes, tools and extensions stay |
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
Get-FileHash .\release\v1.0.3\windows\x64\OpenMind-Studio_1.0.3_windows_x64_setup.exe -Algorithm SHA256
pnpm release:verify    # every file listed in release\v<version>\metadata\SHA256SUMS.txt
```

or read `SHA256SUMS.txt`. Publish the checksums next to the download.

## Linux (x64 in WSL, x86 in a Debian i386 container)

Linux editions: `.deb`, AppImage and a portable `.tar.gz`, for x64 and x86. `scripts/linux-release.sh` builds them **from
this project folder itself** — no clone or copy of the source — and writes them to `release/v<version>/linux/<arch>/`. The
cargo target folder is an external cache (`CARGO_TARGET_DIR`, default `~/.cache/openmind-studio/target-linux-<arch>`),
`--locked` leaves `Cargo.lock` untouched, and the frontend comes from the `dist/` built on Windows (`pnpm build`), so the
Windows `node_modules` is never replaced. Then rewrite the manifest on Windows with `pnpm release:checksums`.

x64, in a WSL Ubuntu with WebKitGTK 4.1:

```bash
sudo apt install -y build-essential pkg-config libssl-dev libgtk-3-dev librsvg2-dev libwebkit2gtk-4.1-dev \
  libayatana-appindicator3-dev libxdo-dev patchelf squashfs-tools libfuse2t64 xdg-utils
cargo install tauri-cli --version <the project's @tauri-apps/cli> --locked
cd "/mnt/e/Code Editor"
export TAURI_SIGNING_PRIVATE_KEY="$(cat /mnt/c/Users/<you>/.tauri/openmind-studio.key)"   # + TAURI_SIGNING_PRIVATE_KEY_PASSWORD
bash scripts/linux-release.sh
```

`src-tauri/tauri.linux.conf.json` sets the targets and leaves out the Windows-only resources (the offline LSP/formatter
and Python bundles, `openmind.cmd`). The portable archive is a `.tar.gz` of `OpenMind Studio/OpenMindStudio` (mode 755)
plus a README (tar keeps the mode). Without `TAURI_SIGNING_PRIVATE_KEY` the script makes no updater `.sig` files and
says so. A `.deb` installs to `/usr/bin` and an AppImage runs from a
read-only mount, so both keep their data in `$XDG_DATA_HOME/openmind-studio` (`~/.local/share/openmind-studio`); the
portable copy keeps it next to itself when that folder is writable. Not available on Linux: the offline bundles, the
Runtime Manager's downloads (Windows x64 artifacts) and DPAPI-encrypted secrets (stored unencrypted).

**x86 (32-bit)**: Ubuntu has no 32-bit WebKitGTK, but Debian trixie still builds it for i386. Run a `debian:trixie`
container with `--platform linux/386` (Docker Desktop) with **the project mounted** (not cloned) and the caches in a
Docker volume:

```powershell
docker run --platform linux/386 --name openmind-linux-x86 -v "E:\Code Editor:/src" -v openmind-linux-x86-cache:/cache `
  -e CARGO_TARGET_DIR=/cache/target -e CARGO_HOME=/cache/cargo -e RUSTUP_HOME=/cache/rustup debian:trixie bash
```

Inside it: install the same `-dev` packages with apt (plus `curl git file xvfb xauth`), rustup with
`--default-host i686-unknown-linux-gnu`, `cargo install tauri-cli --version <the project's @tauri-apps/cli> --locked`,
then `bash /src/scripts/linux-release.sh` (the `dist/` built on Windows is used: Node has no 32-bit Linux build and the
bundle doesn't depend on the CPU). Tauri downloads the i386 linuxdeploy tools into `~/.cache/tauri` by itself; if Docker
stops during that download the cached file stays empty and the next AppImage step fails with "Exec format error" —
delete `~/.cache/tauri` and run the script again. Check a build in the same container under `xvfb-run`. With 16 GB of RAM
run the container build alone (not next to `cargo test` or vitest): running them together exhausted memory once, crashed
Docker Desktop and left corrupt build artifacts.
