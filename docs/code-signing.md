# Windows code signing (Authenticode)

OpenMind Studio's Windows files carry **two independent signatures**:

| | Authenticode | OpenMind updater / LAN signature |
| --- | --- | --- |
| What | A Windows signature inside the `.exe`/`.msi` (and the program inside the portable ZIP) | `<file>.sig` next to each release file (minisign) |
| Made with | A code-signing certificate (CA-issued for a release) | OpenMind's release key `~/.tauri/openmind-studio.key` (public half built into the app) |
| Checked by | Windows (SmartScreen, Smart App Control, the UAC prompt, `Get-AuthenticodeSignature`) | The app: automatic updates and Network Deployment |
| Covers | The file's contents at signing time | The **final bytes** of the release file, bound to the version |

Authenticode is an *additional* layer; it never replaces the updater/LAN signature, and the app's trust model, embedded
public key, file names and update feed don't change. Because Authenticode changes a file's bytes, it always happens
**before** the `.sig` files, `latest.json` and `SHA256SUMS.txt` are made (`scripts/sign-release.mjs` keeps a `.sig` only if
it verifies against the file's current bytes, so a stale one is always replaced).

## Two workflows

1. **Signed build (complete, recommended).** With a certificate configured, `scripts\build-windows.bat` signs while it
   builds: Tauri's `signCommand` (`scripts/sign-file.mjs`) signs `OpenMindStudio.exe`, the NSIS installer and its
   uninstaller and the MSI as they are made; the script signs the built `OpenMindStudio.exe` before it goes into the
   portable ZIP, then verifies every signature with Windows. **Only this signs the program the setup and MSI install.**
2. **Signing an already-built release folder** (`scripts/authenticode-release.mjs`): signs the program inside each
   portable ZIP (extract → sign → rebuild → compare), keeps files already signed with the same certificate, and remakes
   the updater signatures, feed and checksums. An installer that was built unsigned is **refused** by default, because
   signing it afterwards signs only the installer — the `OpenMindStudio.exe` it installs stays unsigned. Rebuild it with
   workflow 1, or accept that limitation explicitly with `--sign-installers-outer`.

The v1.0.4 packages (commit `29a58ae`) were built without a certificate; a fully signed v1.0.4 needs workflow 1 (a rebuild
from the same commit with signing configured). Nothing has been signed with a trusted certificate yet.

## Prerequisites

- Windows 10/11 with the **Windows SDK signing tools** ("Windows SDK Signing Tools for Desktop Apps"; Visual Studio
  Installer or the standalone SDK). Tested with SDK `10.0.26100.0` (`signtool.exe`, x64). The scripts take the newest
  `%ProgramFiles(x86)%\Windows Kits\10\bin\<version>\<x64|x86|arm64>\signtool.exe`, or `SIGNTOOL_PATH`.
- PowerShell 5.1 (built in), Node.js and pnpm (as for any build).
- A code-signing certificate (below) and an RFC 3161 time-stamp server (your CA's, e.g. `http://timestamp.digicert.com`,
  `http://timestamp.sectigo.com`, `http://timestamp.acs.microsoft.com` for Azure Artifact Signing).
- For workflow 2 and every release: the updater key's password (`TAURI_SIGNING_PRIVATE_KEY_PASSWORD` in the shell, or the
  DPAPI file `~/.tauri/openmind-updater.password.dpapi`), because changed files need new `.sig` files.

## Configuration (environment only — never in files)

| Variable | Meaning |
| --- | --- |
| `SIGNING_CERT_THUMBPRINT` | The certificate's 40-digit SHA-1 thumbprint in `CurrentUser\My` (or `LocalMachine\My`). Use this for a hardware token or cloud HSM whose middleware puts the certificate in the Windows store. **Preferred.** |
| `SIGNING_CERT_PATH` + `SIGNING_CERT_PASSWORD` | A `.pfx` file instead. It is imported into `CurrentUser\My` (not exportable) for the run and removed afterwards (unless it was already there); the password reaches PowerShell through an environment variable only. |
| `TIMESTAMP_URL` | The RFC 3161 time-stamp server. Required for a release certificate (otherwise signatures expire with the certificate). `SIGNING_NO_TIMESTAMP=1` waives it for an internal build only. |
| `SIGNING_CERT_KIND=test` | A self-signed test certificate: files are marked *test-signed*, a missing timestamp and an untrusted chain are allowed. |
| `SIGNTOOL_PATH` | `signtool.exe`, when it isn't in the SDK's default folder. |

**Secrets:** SignTool is only ever given a thumbprint (`/sha1`), never `/p <password>`; passwords are never printed, logged,
written or committed (`src/services/release.test.ts` scans the repository). Set them for one console session, from a
password manager or the CI secret store — never in a script, `.env` file or batch file.

## Before anything is signed: the certificate check

`node scripts/authenticode-release.mjs --check` (also run automatically by `build-windows.bat` and before every signing):

- SignTool found;
- the certificate is in the store (or the PFX opens), has its **private key**, is **valid now** (warning 30 days before
  expiry), has the **Code Signing** usage (`1.3.6.1.5.5.7.3.3`) and an **RSA** key (Smart App Control doesn't accept ECC);
- for a release: Windows **trusts its chain** (a CA in the Microsoft Trusted Root Program), checked for Code Signing with an
  online revocation check (an offline revocation check is a warning).

Any problem stops the run before a file is touched.

## Commands

```bat
rem Is everything ready? (SignTool + certificate; touches nothing)
set SIGNING_CERT_THUMBPRINT=<thumbprint>
set TIMESTAMP_URL=http://timestamp.digicert.com
node scripts\authenticode-release.mjs --check

rem Workflow 1: a signed build (also needs the updater key's password for the .sig files)
set TAURI_SIGNING_PRIVATE_KEY_PASSWORD=<from your password manager, typed into this console only>
scripts\build-windows.bat all

rem Workflow 2: an already-built release folder
node scripts\authenticode-release.mjs --dry-run
node scripts\authenticode-release.mjs
```

SignTool runs as `signtool sign /fd SHA256 /sha1 <thumbprint> /s My [/sm] /tr <TIMESTAMP_URL> /td SHA256 /d "OpenMind Studio" <file>`.

`authenticode-release.mjs` options: `--dry-run` (plan only; exit 1 when the real run would stop), `--check`, `--arch x64|x86|all`,
`--version`, `--release <folder>` (another folder — every helper is given that folder), `--sign-installers-outer`,
`--skip-updater-resign` (**test certificate only**: removes the stale `.sig` files and `latest.json` instead of remaking them;
the folder is then not releasable).

### What `authenticode-release.mjs` does, in order

1. Checks SignTool, the certificate, that all six Windows files exist, each file's current signature (signed by another
   certificate, or changed after signing → refused), and — if anything will change — that the updater key is available.
2. `--dry-run` stops here and prints the plan (`KEEP` / `SIGN` / `REPACK` / `REFUSE` per file).
3. Copies every file that will change, its `.sig`, `SHA256SUMS.txt` and `latest.json` to
   `validation/pre-authenticode/<time>/` and verifies the copies.
4. Signs a copy and verifies it before it replaces the original. For a portable ZIP: extract with Windows' `tar.exe`, sign
   `OpenMind Studio/OpenMindStudio.exe`, rebuild with the same `tar -a -c -f <zip> -C <dir> "OpenMind Studio"` the packager
   uses, extract the new ZIP again and compare every entry: only `OpenMindStudio.exe` may differ, and it must carry this
   certificate's signature.
5. Any failure after a file was replaced restores every replaced file and the manifests from the backup.
6. Runs `sign-release.mjs` (new `.sig` files for the final bytes, `latest.json`, `SHA256SUMS.txt`), then verifies the folder
   (`release-checksums --verify`, `verify-updater-signatures --require-all`). A second run finds everything signed and changes
   nothing.

### The portable ZIP

A ZIP can't carry an Authenticode signature; the programs inside it can. Signed: **`OpenMindStudio.exe`** (ours). Not signed by
us, on purpose:

- `lsp/node/node.exe` — already signed by its publisher (OpenJS Foundation); re-signing a vendor's binary would replace their
  signature with ours.
- the language servers and formatters inside `lsp/packs/*.zip` and the wheels in `python-bundle/packages.zip` — vendors' files
  whose SHA-256 the app checks against `bundle.json` before it unpacks them; changing them would break that check.
- `python-bundle/tcltk.msi` — python.org's own signed package.
- the `.cmd`/`.ps1` launchers in `deploy\` — scripts, not programs. (`Deploy-OpenMindShortcuts.ps1` *can* be
  Authenticode-signed for networks that enforce PowerShell's `AllSigned` policy; that isn't done yet.)

## Verifying a signed release

```bat
node scripts\verify-signatures.mjs release\v1.0.4\windows\x64\OpenMind-Studio_1.0.4_windows_x64_setup.exe release\v1.0.4\windows\x64\OpenMind-Studio_1.0.4_windows_x64.msi
signtool verify /pa /v release\v1.0.4\windows\x64\OpenMind-Studio_1.0.4_windows_x64_setup.exe
node scripts\authenticode-release.mjs --dry-run      (every file KEEP: signed with the configured certificate)
pnpm release:verify
node scripts\verify-updater-signatures.mjs --require-all
```

`Get-AuthenticodeSignature` must say `Valid` with a `TimeStamperCertificate`; `signtool verify /pa` must report "Successfully
verified". Also check the program the setup installs (install it in Windows Sandbox or a VM) and the program inside the portable
ZIP.

## Getting a certificate

Since June 2023 the CA/Browser Forum requires the private key of a publicly trusted code-signing certificate to live on a
hardware token or HSM: a CA no longer hands out a `.pfx` file for one. Use the token's or cloud HSM's integration with the Windows
certificate store and sign by thumbprint (`SIGNING_CERT_THUMBPRINT`). PFX files remain useful for test and internal
certificates.

| Option | Who can use it | Notes |
| --- | --- | --- |
| **OV certificate** from a CA (DigiCert, Sectigo, GlobalSign …) | Worldwide | ~US$150–300/year; key on a token/HSM; identity validation takes days. Works with workflow 1 by thumbprint. |
| **EV certificate** | Worldwide | No longer bypasses SmartScreen (since 2024); same reputation process as OV. |
| **Azure Artifact Signing** (formerly Trusted Signing) | See below | ~US$9.99/month; Microsoft-managed short-lived certificates; CI-friendly. |
| **SignPath Foundation** | Open-source projects built from a public repository | Free; the workflow in `.github/workflows/release-windows.yml` is prepared, but the source repository is private, so it isn't eligible today. |
| Self-signed | Testing, or a managed network that deploys the certificate as trusted | Not trusted elsewhere; Smart App Control blocks it. |

### Azure Artifact Signing — eligibility audit (checked 2026-10-14)

- **Individual developers: only in the United States or Canada** (Public Trust). The identity comes from an Azure billing account
  of type *Individual* whose legal name and address match a government ID, verified through AU10TIX and Microsoft Authenticator.
  One Microsoft Q&A thread (March 2026) reported individual onboarding *paused*; confirm with Microsoft before paying.
- **Organizations:** the quickstart (updated 2026-10-08) lists the United States, Canada, the EU, the UK, Australia, New Zealand,
  Japan, South Korea, Singapore, Switzerland, Norway and Israel; Microsoft's Windows code-signing overview (2026-08-29) still says
  US, Canada, EU and UK. Validation takes 1–20 business days and needs current business documents.
- **Roles:** *Artifact Signing Identity Verifier* (to request validation) and *Artifact Signing Certificate Profile Signer* (to
  sign). Private Trust certificates have no geographic limit but aren't publicly trusted (not useful for public downloads).
- **Signing:** SignTool with the Artifact Signing dlib (`/dlib Azure.CodeSigning.Dlib.dll /dmdf metadata.json`, the dlib's
  architecture must match SignTool's; time-stamp `http://timestamp.acs.microsoft.com`), or the `azure/artifact-signing-action` in
  GitHub Actions. Authentication through Azure's credential chain (in CI: a federated OIDC credential or a service principal held
  in the CI secret store — never a key in the repository). It signs EXE, MSI and the PE files inside the portable ZIP the same way
  as any certificate; the ZIP itself is not signable.
- **Fit for this project:** usable only if the developer (or their organization) is in an eligible country. It is not wired into
  the scripts: `scripts/signtool.mjs` signs by store certificate; an Artifact Signing route would be a second signer (dlib +
  metadata) behind the same `sign(path)` step of `authenticodeRelease.mjs`, added when an eligible account exists. No account was
  created and nothing was provisioned.

Sources: [Artifact Signing quickstart](https://learn.microsoft.com/en-us/azure/artifact-signing/quickstart),
[Code signing options for Windows app developers](https://learn.microsoft.com/en-us/windows/apps/package-and-deploy/code-signing-options),
[Signing integrations](https://learn.microsoft.com/en-us/azure/artifact-signing/how-to-signing-integrations),
[Q&A: individual onboarding](https://learn.microsoft.com/en-nz/answers/questions/5810735/cant-create-a-new-trusted-signing-individual-ident).

## SmartScreen and Smart App Control — what signing does and doesn't do

- **SmartScreen** decides by *reputation* of the publisher and the file. A trusted signature lets reputation build across releases
  signed with the same identity; new files from a new publisher can still show "Windows protected your PC" for a while. Since 2024
  even EV certificates get no instant bypass.
- **Smart App Control** (Windows 11, clean installs where it is on) blocks unknown programs unless Microsoft's cloud service
  recognizes them or they are signed by a certificate from a CA in the Microsoft Trusted Root Program; ECC signatures aren't
  accepted. A self-signed or untrusted signature does not help. Users can't add exceptions.
- Signing does not change Defender's verdicts, enterprise policies (AppLocker, App Control for Business), or a network's rules.
- Nothing here disables or works around SmartScreen, Smart App Control, Defender or certificate validation, and no test does.

## Troubleshooting

| Message | Cause and fix |
| --- | --- |
| `signtool.exe was not found` | Install the Windows SDK signing tools, or set `SIGNTOOL_PATH`. |
| `The certificate was not found …` | Wrong thumbprint, or the token isn't plugged in / its middleware isn't running. `Get-ChildItem Cert:\CurrentUser\My -CodeSigningCert`. |
| `… has no usable private key` / `private key couldn't be used` | Token locked or PIN refused; the certificate without its key was imported. |
| `not a code-signing certificate` | The certificate lacks the Code Signing usage: you have a TLS or e-mail certificate. |
| `Windows doesn't trust the certificate's chain` | A self-signed certificate used for a release (set `SIGNING_CERT_KIND=test` for tests), or the CA's intermediate is missing from the store. |
| `The timestamp server could not be reached` | Network, proxy or the server is down. Nothing was released; run again or use another RFC 3161 server of your CA. |
| `The PFX file couldn't be opened: the certificate password is wrong` | Retype it in the console; never store it in a file. |
| `this installer was built without Authenticode` | Rebuild with signing configured (workflow 1), or `--sign-installers-outer` knowingly. |
| `already signed by another certificate` | Files from a different signing run; rebuild, don't mix certificates. |
| `the updater key is not available` | Set `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` (or the DPAPI file); otherwise changed files would keep stale `.sig` files. |
| `The temporarily imported certificate … could not be removed` | Remove it with `certmgr.msc` (Personal > Certificates). |

## Renewal and rotation

- Timestamped signatures stay valid after the certificate expires; files signed earlier never need re-signing.
- Renew before expiry (the check warns 30 days ahead). A new certificate with the same validated name keeps building the same
  publisher reputation; a different name starts over.
- Change `SIGNING_CERT_THUMBPRINT` to the new certificate; never mix two certificates within one release (`authenticode-release`
  refuses a folder signed by another one).
- A revoked or compromised certificate: stop signing, revoke it with the CA, rebuild and re-sign every release still offered for
  download. The updater/LAN key is separate and unaffected.

## Pre-release checklist

1. `main` at the release commit, clean tree; `node scripts/build-info.mjs version` is the release version.
2. `node scripts\authenticode-release.mjs --check` passes with the **release** certificate (not `SIGNING_CERT_KIND=test`).
3. `scripts\build-windows.bat all` (with the updater key's password) finishes; it verifies the Authenticode signatures itself.
4. Linux packages built (`docs/release.md`); then `pnpm release:sign` once more if any file changed.
5. `node scripts\verify-signatures.mjs <setups and MSIs>` all `OK`, timestamped; `signtool verify /pa /v` on each.
6. `node scripts\authenticode-release.mjs --dry-run` → every file `KEEP`.
7. `pnpm release:verify`, `node scripts\verify-architecture.mjs`, `node scripts\verify-updater-signatures.mjs --require-all`,
   and the app's own check (`OPENMIND_RELEASE_DIR=<folder> cargo test -p openmind-studio --bin openmind-studio real_release -- --ignored`).
8. Install the setup and the MSI, and upgrade from the previous version, in Windows Sandbox or a VM
   (`scripts\upgrade-test\New-UpgradeTestSandbox.ps1 -Start`); check the installed `OpenMindStudio.exe` is signed.
9. LAN deployment with the signed packages: offered, found, installed after trust; a changed byte refused.
10. Record in `release/v<version>/validation/reports/`: commit, certificate subject and thumbprint, timestamp server, every
    file's SHA-256 and the results above.
