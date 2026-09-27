# Releasing OpenMind Studio (Windows)

OpenMind Studio ships in three forms. None of them needs administrator rights except the MSI (see below), none changes
PATH, and the app keeps all its data next to its own executable.

| Artifact | How | Notes |
| --- | --- | --- |
| Setup EXE (NSIS) | `pnpm release:build` | per-user install, no administrator rights |
| MSI (WiX) | `pnpm release:build` | Windows Installer; may ask for administrator rights |
| Portable ZIP | `pnpm package:portable` | unzip and run |

## Build

```powershell
pnpm install
pnpm lsp:bundle               # the offline language servers -> lsp-bundle/ (the only step that downloads; see docs/lsp-bundle.md)
pnpm release:build            # checks lsp-bundle/, then tauri build --bundles nsis,msi  (release profile: slow, LTO)
pnpm package:portable         # optional: OpenMindStudio-<version>-portable-win-x64.zip
pnpm release:collect -- --portable "<path to the portable zip>"   # copies, signs (if configured), checksums, report
```

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
2. **Licence agreement** — the NSIS installer's *Next/Install* is blocked until the agreement is accepted; the MSI shows
   the licence and its *Next* is blocked until the "I accept" box is ticked
3. Install location
4. Install
5. Finish, with a **Launch OpenMind Studio** checkbox

`release:collect` refuses to run (and a unit test fails) if `LICENSE` is not the full Apache 2.0 text or the installer
configuration stops referencing it. Never ship an installer that skips the agreement.

## Signing

Signing is optional and configured **only through environment variables** (never commit a certificate or a password):

| Variable | Meaning |
| --- | --- |
| `SIGNING_CERT_PATH` | path to the `.pfx` certificate |
| `SIGNING_CERT_PASSWORD` | its password (never printed or written) |
| `TIMESTAMP_URL` | optional http(s) timestamp server, e.g. your CA's RFC 3161 address |
| `SIGNING_CERT_KIND` | set to `test` for a self-signed test certificate |

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

1. Run the setup: the licence page appears; *Next* stays disabled until you accept. Install, tick *Launch*.
2. The app opens to the Welcome page; Help > About shows **Apache-2.0**, no commit or build hash.
3. Apps & features (NSIS: per-user) lists *OpenMind Studio*; uninstall removes it. `data/`, `settings/` and other
   folders live next to the installed executable.
4. Confirm the User and Machine `PATH` are unchanged and no `OpenMindStudio`/`node`/`conhost` process is left after closing.

## SHA256

```powershell
Get-FileHash .\release\OpenMind-Studio-Setup-0.1.0-x64.exe -Algorithm SHA256
```

or read `SHA256SUMS.txt`. Publish the checksums next to the download.
