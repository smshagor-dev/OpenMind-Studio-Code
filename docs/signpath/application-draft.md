# SignPath Foundation application — draft (not submitted)

Submit at [signpath.org/apply](https://signpath.org/apply) only after the source repository is public and the owner has
reviewed this text. Field names on the form may differ; this is the content.

**Project name:** OpenMind Studio

**Project website / home page:** https://github.com/smshagor-dev/OpenMind-Studio-Code

**Source code repository:** https://github.com/smshagor-dev/OpenMind-Studio-Code (GitHub, public; branch `main`)

**Download page:** https://github.com/smshagor-dev/OpenMind-Studio/releases

**Licence:** Apache License 2.0 for the whole project. All bundled third-party components are under OSI-approved
licences (MIT, Apache-2.0, BSD, ISC, Zlib, MPL-2.0, LGPL for unmodified Python wheels); from the next release every
package contains a generated THIRD-PARTY-LICENSES.txt listing each one with its licence text. No proprietary component
is included.

**Description:** OpenMind Studio is a portable desktop code editor for Windows and Linux built with Rust, Tauri 2,
React and Monaco Editor. It runs from its own folder without administrator rights, and includes an integrated
terminal, Run Code for many languages, a Git client, language servers and formatters (bundled for offline use), a
debugger for Python and Node.js, a portable runtime manager (Node.js, Python, PHP, MariaDB and more) and a VS
Code-compatible extension subset. It is aimed at students and developers on restricted or shared computers (school
and university labs, network installations).

**Maintainers:** Md Shahanur Islam Shagor (GitHub @smshagor-dev, smshagor.dev@gmail.com) — author, reviewer and
approver. *(Owner: multi-factor authentication is required for GitHub and SignPath — enable it, then state it here.)*

**Releases so far:** 1.0.0, 1.0.1 and 1.0.2 on the download page: NSIS setup and MSI for Windows x64 and x86 (all
three), portable ZIPs and Linux packages (deb, AppImage, portable) from 1.0.1.

**Build and release process:** GitHub Actions workflow `.github/workflows/release-windows.yml` ("Release"), started by
hand on `main`, all jobs on GitHub-hosted runners, actions pinned by commit, read-only permissions, no build cache:
the CI checks (format, lint, Clippy, Rust and frontend tests) → `OpenMindStudio.exe` for x64 and x86 → signing request
for the program → NSIS setup and MSI built around the signed program → signing request for the installers → updater
signatures (the project's own minisign key, kept as a repository secret) → verification of Authenticode signatures,
checksums and architectures → files kept as a workflow artifact and published by hand.

**What should be signed:** `OpenMindStudio.exe` (x64, x86), the NSIS setup and the MSI for each architecture. Signing
requests per release: four (program and installers, two architectures). Third-party binaries inside the packages
(Node.js, language servers, Python wheels) are left as their publishers ship them.

**Security practices:** dependencies locked (Cargo.lock, pnpm-lock.yaml, npm lockfiles for bundled servers, hashed
Python requirements, SHA-256-pinned downloads); secret scanning of the full history (gitleaks) before publication;
updates verified against the project's signature before installation; private vulnerability reporting (SECURITY.md);
no telemetry (docs/PRIVACY.md).

**Signing certificate:** none yet; this is the first application.
