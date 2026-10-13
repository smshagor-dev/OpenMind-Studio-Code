# Windows code signing through SignPath Foundation

Status (October 2026): **not applied for, not approved.** Windows packages are not Authenticode-signed. Nothing in
this folder makes signing active; it is what the project needs to apply and to sign once approved.

## Requirements and how the project meets them

Sources: [signpath.org/terms](https://signpath.org/terms) (conditions for free OSS signing),
[docs.signpath.io/trusted-build-systems/github](https://docs.signpath.io/trusted-build-systems/github),
[docs.signpath.io/origin-verification](https://docs.signpath.io/origin-verification),
[docs.signpath.io/artifact-configuration/syntax](https://docs.signpath.io/artifact-configuration/syntax). Read
2026-10-13; check them again when applying.

| Requirement | State |
| --- | --- |
| OSI-approved licence for all components, no commercial dual licensing, no proprietary component | Apache-2.0 (LICENSE). Audit of every bundled component: all OSI open source ([THIRD_PARTY_NOTICES.md](../../THIRD_PARTY_NOTICES.md)); Intelephense, the only proprietary candidate, is not shipped. **Owner to confirm**: no code or asset of unclear origin in the repository. |
| Binaries built from the source in the stated repository, automated and verifiable | Release workflow on GitHub-hosted runners from `smshagor-dev/OpenMind-Studio-Code` — **requires that repository to be public** (owner decision). Build scripts and CI configuration are in the repository; no build cache is reused. |
| Origin verification (repository URL, branch, commit, build URL from GitHub) | SignPath project linked to the GitHub.com trusted build system; signing policy restricted to `main` ("Allowed branch names"). |
| All jobs before the signing request on GitHub-hosted runners | Yes (`windows-latest`, `ubuntu-22.04`); turn on `runners.required_github_hosted` and `disallow_reruns`. |
| Team roles: authors, reviewers (non-committer changes reviewed), approvers (every signing request) | One maintainer holds every role (listed in README "Code signing policy"). Pull requests from others are reviewed before merge. |
| MFA for every team member on GitHub and SignPath | **Owner to enable/confirm** (GitHub 2FA; SignPath account MFA). |
| Every release approved by hand | SignPath signing policy with manual approval; the workflow waits (`wait-for-completion`). |
| Already released in the form to be signed | Releases 1.0.0–1.0.2 are public on `smshagor-dev/OpenMind-Studio` (setup, MSI, portable). |
| Functionality documented on the download page | Owner to keep the release page/README of `OpenMind-Studio` describing the program (README "What it does" can be reused). |
| Product name and version metadata | `OpenMindStudio.exe` ProductName "OpenMind Studio", version = the release (checked by the release scripts). |
| "Code signing policy" on the home and download pages: SignPath.io / SignPath Foundation wording, roles, privacy policy | In this repository's README (marked pending). **Owner to add the same section to the public release repository's README** — text: [code-signing-policy.md](code-signing-policy.md). |
| Privacy policy; data transfers disclosed | [docs/legal/privacy-policy.md](../legal/privacy-policy.md): no telemetry; two automatic requests (update check to GitHub, Open VSX list while the Extensions view is shown — the latter can be turned off). |
| No malware/PUP, no security circumvention; system changes announced, uninstall provided | Installers show their options (PATH, Explorer menu: off by default) and uninstall what they added. |
| Upstream binaries | Unsigned upstream OSS binaries may be included (node.exe, language servers, Python wheels' DLLs, tcltk.msi); only OpenMind Studio's own files are submitted for signing. |

Open questions to ask SignPath (not answered by the documents):

1. Publishing from a **separate public release repository** (`OpenMind-Studio`) while building from the source
   repository — the terms only name the source repository and the download page; confirm this is fine.
2. The NSIS **uninstaller** is generated while the setup is built and can't be submitted separately; is a signed setup
   containing an unsigned uninstaller acceptable, or should signing move into Tauri's `signCommand` (SignPath CLI)?
3. Whether the CDLA-Permissive-2.0 data in `webpki-roots` (Mozilla CA list) counts as a component that needs an OSI
   licence.

## Setting it up after approval

1. SignPath: project with the repository URL `https://github.com/smshagor-dev/OpenMind-Studio-Code`, trusted build
   system **GitHub.com** linked to it (install the SignPath GitHub App for audit logs), signing policy `release-signing`
   (allowed branch `main`, manual approval, origin verification on, `runners.required_github_hosted: true`,
   `disallow_reruns: true`), artifact configurations `openmind-exe` ([artifact-configuration-exe.xml](artifact-configuration-exe.xml))
   and `openmind-installers` ([artifact-configuration-installers.xml](artifact-configuration-installers.xml)), a CI user
   with submitter permission and its API token.
2. GitHub repository `OpenMind-Studio-Code`: a branch ruleset on `main` (require a pull request, block force pushes and
   deletion); variables `SIGNPATH_ORGANIZATION_ID`, `SIGNPATH_PROJECT_SLUG`, `SIGNPATH_POLICY_SLUG=release-signing`,
   `SIGNPATH_EXE_CONFIG_SLUG=openmind-exe`, `SIGNPATH_INSTALLER_CONFIG_SLUG=openmind-installers`; secrets
   `SIGNPATH_API_TOKEN`, `TAURI_UPDATER_KEY`, `TAURI_UPDATER_KEY_PASSWORD` (the existing updater key — never a new one).
3. Run **Actions > Release** with `signing: required`. It fails before building if SignPath isn't configured; it signs
   `OpenMindStudio.exe` first (so the setup, MSI and portable ZIP contain the signed program), then the setup and the
   MSI, then makes the updater signatures of the *signed* files, and verifies every Authenticode signature (trusted
   chain, unchanged, RFC 3161 timestamp), checksums, architectures and updater signatures before keeping the files.
4. Download the `openmind-studio-release` artifact, check it (`pnpm release:verify`,
   `node scripts/verify-updater-signatures.mjs --require-all`, `node scripts/verify-signatures.mjs --mode external
   <files>`), then publish by hand to the release repository.

Authenticode signing changes the installers' bytes: the updater `.sig` files and `latest.json` made for the unsigned
1.0.3 files in `release/v1.0.3/` don't match signed files. The signed run makes new ones from the same updater key.
A valid signature doesn't make SmartScreen trust a new release at once; reputation builds over time.
