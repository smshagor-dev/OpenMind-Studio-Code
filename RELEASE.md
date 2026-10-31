# OpenMind Studio — Release History and Zenodo Provenance

**Creator and maintainer:** Md Shahanur Islam Shagor  
**Software:** OpenMind Studio  
**Source repository:** [smshagor-dev/OpenMind-Studio-Code](https://github.com/smshagor-dev/OpenMind-Studio-Code)  
**Distribution repository:** [smshagor-dev/OpenMind-Studio](https://github.com/smshagor-dev/OpenMind-Studio/releases)  
**Source license:** Apache-2.0 (third-party components retain their own licenses)  
**Release catalog checked:** 2026-10-31  
**Verified coverage:** 6 published releases (v1.0.0–v1.0.5), 57 attached assets  
**Latest public binary release:** v1.0.5 (2026-10-27)  
**Zenodo DOI:** Not yet specified; insert only the DOI actually issued to this software archive.

> This Markdown file records historical releases and links. It is not a deposit of those binaries in Zenodo, a binary-to-commit attestation, a claim of completed field tests, or a generated DOI.

## 1. Source, distribution, and archive boundaries

- **`OpenMind-Studio-Code`** is the program's source-code repository (Rust/Tauri backend, React/TypeScript/Monaco frontend, tests, documents, runtime manager, agent and collaboration modules). Its README directs downloads to the distribution repository.
- **`OpenMind-Studio`** publishes the end-user installers, portable packages, and release notes. These assets are distinct from the source snapshot.
- The source repository was checked at [`c27a0dc`](https://github.com/smshagor-dev/OpenMind-Studio-Code/commit/c27a0dc3360cf380fbac10279a7bf9fbd6b29ab8) (2026-10-27); do not assume all historical binaries were built from that one commit.
- An individual software/archive citation should identify the exact tagged **source revision**, and separately identify any **binary distribution** needed for reproduction. Runtime-installed third-party programs and separately downloaded GGUF weights are not automatically part of the packaged software.

## 2. Complete published release timeline

| Version | GitHub publication (UTC) | Published assets | Main focus | Official notes |
|---|---|---:|---|---|
| v1.0.0 | 2026-09-30 | 4 | Initial portable Windows IDE for managed/restricted computers; EXE and MSI packages. | [Release](https://github.com/smshagor-dev/OpenMind-Studio/releases/tag/v1.0.0) |
| v1.0.1 | 2026-10-07 | 12 | Canonical live state sync, Run Code/toolchains, offline LSP and formatters, restricted-PC workflow improvements. | [Release](https://github.com/smshagor-dev/OpenMind-Studio/releases/tag/v1.0.1) |
| v1.0.2 | 2026-10-08 | 12 | Machine-specific portable data profiles, shared runtimes and language tools, SQLite migration and multi-PC isolation. | [Release](https://github.com/smshagor-dev/OpenMind-Studio/releases/tag/v1.0.2) |
| v1.0.3 | 2026-10-13 | 14 | Collaboration preview, integrated browser, update infrastructure, multi-PC and installation reliability. | [Release](https://github.com/smshagor-dev/OpenMind-Studio/releases/tag/v1.0.3) |
| v1.0.4 | 2026-10-21 | 9 | Workspace-aware coding agent, local llama.cpp inference, optional AI Cloud, network deployment and tool improvements. | [Release](https://github.com/smshagor-dev/OpenMind-Studio/releases/tag/v1.0.4) |
| v1.0.5 | 2026-10-27 | 6 | VS Code extension subset, editor/document recovery, optional PascalABC.NET, AI Cloud settings, stability. | [Release](https://github.com/smshagor-dev/OpenMind-Studio/releases/tag/v1.0.5) |

## 3. Technical progression by release

### v1.0.0 — 2026-09-30

- First Windows-focused release for developer workstations, labs and limited-permission environments.
- Only Windows install packages were attached to this release.
- [Official GitHub release notes](https://github.com/smshagor-dev/OpenMind-Studio/releases/tag/v1.0.0)

### v1.0.1 — 2026-10-07

- Extended portable runtimes and languages, Run Code, LSP, debugging/formatting workflow, and multi-window canonical state synchronization.
- The optional PHP/MySQL controls do not constitute OpenMind Studio's core database; its internal persistence uses SQLite.
- [Official GitHub release notes](https://github.com/smshagor-dev/OpenMind-Studio/releases/tag/v1.0.1)

### v1.0.2 — 2026-10-08

- Added multi-computer/per-machine data scope so shared installations can use separate application databases and mutable state.
- Enhanced shared runtime discovery, toolchain coordination, database migration and drive relocation.
- [Official GitHub release notes](https://github.com/smshagor-dev/OpenMind-Studio/releases/tag/v1.0.2)

### v1.0.3 — 2026-10-13

- Released early room-based collaborative editing, built-in browser, updater and installation improvements.
- Release notes explicitly describe real multi-PC collaboration testing as pending; the coding agent was a future feature, not part of v1.0.3.
- [Official GitHub release notes](https://github.com/smshagor-dev/OpenMind-Studio/releases/tag/v1.0.3)

### v1.0.4 — 2026-10-21

- Introduced the OpenMindAI coding agent with permission-controlled operations, local inference through llama.cpp, and optional cloud providers.
- Strengthened network deployment, tool caches and shared installations; autonomous execution and collaboration must not be represented as universally verified.
- [Official GitHub release notes](https://github.com/smshagor-dev/OpenMind-Studio/releases/tag/v1.0.4)

### v1.0.5 — 2026-10-27

- Expanded VS Code settings/extension import and selected APIs; full extension compatibility is not guaranteed.
- Improved editing/recovery, virtual documents, optional Windows PascalABC.NET, and AI Cloud provider settings.
- The actual published assets are Windows x64 and Linux x64 formats, not every possible build target.
- [Official GitHub release notes](https://github.com/smshagor-dev/OpenMind-Studio/releases/tag/v1.0.5)

## 4. Every official release asset

The items below are links to **actual assets listed on the distribution repository's published GitHub releases**. Sizes come from GitHub metadata and are rounded to MiB. Files are **not embedded** in this `RELEASE.md` and are not automatically archived merely by these links.

### v1.0.0 — 4 assets

| Filename and GitHub download | Size (MiB) |
|---|---:|
| [`OpenMind.Studio_x64_en-US.msi`](https://github.com/smshagor-dev/OpenMind-Studio/releases/download/v1.0.0/OpenMind.Studio_x64_en-US.msi) | 212.9 |
| [`OpenMind.Studio_x64.exe`](https://github.com/smshagor-dev/OpenMind-Studio/releases/download/v1.0.0/OpenMind.Studio_x64.exe) | 196.8 |
| [`OpenMind.Studio_x86_en-US.msi`](https://github.com/smshagor-dev/OpenMind-Studio/releases/download/v1.0.0/OpenMind.Studio_x86_en-US.msi) | 212.2 |
| [`OpenMind.Studio_x86.exe`](https://github.com/smshagor-dev/OpenMind-Studio/releases/download/v1.0.0/OpenMind.Studio_x86.exe) | 196.4 |

### v1.0.1 — 12 assets

| Filename and GitHub download | Size (MiB) |
|---|---:|
| [`OpenMind-Studio-Portable-linux-x64.zip`](https://github.com/smshagor-dev/OpenMind-Studio/releases/download/v1.0.1/OpenMind-Studio-Portable-linux-x64.zip) | 15.4 |
| [`OpenMind-Studio-Portable-linux-x86.zip`](https://github.com/smshagor-dev/OpenMind-Studio/releases/download/v1.0.1/OpenMind-Studio-Portable-linux-x86.zip) | 15.4 |
| [`OpenMind-Studio-Portable-x64.zip`](https://github.com/smshagor-dev/OpenMind-Studio/releases/download/v1.0.1/OpenMind-Studio-Portable-x64.zip) | 252.9 |
| [`OpenMind-Studio-Portable-x86.zip`](https://github.com/smshagor-dev/OpenMind-Studio/releases/download/v1.0.1/OpenMind-Studio-Portable-x86.zip) | 252.2 |
| [`OpenMind-Studio-Setup-x64.exe`](https://github.com/smshagor-dev/OpenMind-Studio/releases/download/v1.0.1/OpenMind-Studio-Setup-x64.exe) | 237.1 |
| [`OpenMind-Studio-Setup-x86.exe`](https://github.com/smshagor-dev/OpenMind-Studio/releases/download/v1.0.1/OpenMind-Studio-Setup-x86.exe) | 236.7 |
| [`OpenMind-Studio-x64.AppImage`](https://github.com/smshagor-dev/OpenMind-Studio/releases/download/v1.0.1/OpenMind-Studio-x64.AppImage) | 91.1 |
| [`OpenMind-Studio-x64.deb`](https://github.com/smshagor-dev/OpenMind-Studio/releases/download/v1.0.1/OpenMind-Studio-x64.deb) | 15.7 |
| [`OpenMind-Studio-x64.msi`](https://github.com/smshagor-dev/OpenMind-Studio/releases/download/v1.0.1/OpenMind-Studio-x64.msi) | 253.7 |
| [`OpenMind-Studio-x86.AppImage`](https://github.com/smshagor-dev/OpenMind-Studio/releases/download/v1.0.1/OpenMind-Studio-x86.AppImage) | 108.2 |
| [`OpenMind-Studio-x86.deb`](https://github.com/smshagor-dev/OpenMind-Studio/releases/download/v1.0.1/OpenMind-Studio-x86.deb) | 15.7 |
| [`OpenMind-Studio-x86.msi`](https://github.com/smshagor-dev/OpenMind-Studio/releases/download/v1.0.1/OpenMind-Studio-x86.msi) | 253.1 |

### v1.0.2 — 12 assets

| Filename and GitHub download | Size (MiB) |
|---|---:|
| [`OpenMind-Studio-1.0.2-i386.deb`](https://github.com/smshagor-dev/OpenMind-Studio/releases/download/v1.0.2/OpenMind-Studio-1.0.2-i386.deb) | 15.8 |
| [`OpenMind-Studio-1.0.2-i686.AppImage`](https://github.com/smshagor-dev/OpenMind-Studio/releases/download/v1.0.2/OpenMind-Studio-1.0.2-i686.AppImage) | 108.3 |
| [`OpenMind-Studio-1.0.2-linux-i686-portable.tar.gz`](https://github.com/smshagor-dev/OpenMind-Studio/releases/download/v1.0.2/OpenMind-Studio-1.0.2-linux-i686-portable.tar.gz) | 15.5 |
| [`OpenMind-Studio-1.0.2-linux-x86_64-portable.tar.gz`](https://github.com/smshagor-dev/OpenMind-Studio/releases/download/v1.0.2/OpenMind-Studio-1.0.2-linux-x86_64-portable.tar.gz) | 15.5 |
| [`OpenMind-Studio-1.0.2-x64-portable.zip`](https://github.com/smshagor-dev/OpenMind-Studio/releases/download/v1.0.2/OpenMind-Studio-1.0.2-x64-portable.zip) | 253.0 |
| [`OpenMind-Studio-1.0.2-x64.msi`](https://github.com/smshagor-dev/OpenMind-Studio/releases/download/v1.0.2/OpenMind-Studio-1.0.2-x64.msi) | 253.8 |
| [`OpenMind-Studio-1.0.2-x86_64.AppImage`](https://github.com/smshagor-dev/OpenMind-Studio/releases/download/v1.0.2/OpenMind-Studio-1.0.2-x86_64.AppImage) | 91.2 |
| [`OpenMind-Studio-1.0.2-x86-portable.zip`](https://github.com/smshagor-dev/OpenMind-Studio/releases/download/v1.0.2/OpenMind-Studio-1.0.2-x86-portable.zip) | 252.3 |
| [`OpenMind-Studio-1.0.2-x86.msi`](https://github.com/smshagor-dev/OpenMind-Studio/releases/download/v1.0.2/OpenMind-Studio-1.0.2-x86.msi) | 253.2 |
| [`OpenMind-Studio-Setup-1.0.2-x64.exe`](https://github.com/smshagor-dev/OpenMind-Studio/releases/download/v1.0.2/OpenMind-Studio-Setup-1.0.2-x64.exe) | 237.2 |
| [`OpenMind-Studio-Setup-1.0.2-x86.exe`](https://github.com/smshagor-dev/OpenMind-Studio/releases/download/v1.0.2/OpenMind-Studio-Setup-1.0.2-x86.exe) | 236.8 |
| [`SHA256SUMS.txt`](https://github.com/smshagor-dev/OpenMind-Studio/releases/download/v1.0.2/SHA256SUMS.txt) | 0.0 |

### v1.0.3 — 14 assets

| Filename and GitHub download | Size (MiB) |
|---|---:|
| [`OpenMind-Studio_1.0.3_linux_x64_portable.tar.gz`](https://github.com/smshagor-dev/OpenMind-Studio/releases/download/v1.0.3/OpenMind-Studio_1.0.3_linux_x64_portable.tar.gz) | 21.4 |
| [`OpenMind-Studio_1.0.3_linux_x64.AppImage`](https://github.com/smshagor-dev/OpenMind-Studio/releases/download/v1.0.3/OpenMind-Studio_1.0.3_linux_x64.AppImage) | 96.6 |
| [`OpenMind-Studio_1.0.3_linux_x64.deb`](https://github.com/smshagor-dev/OpenMind-Studio/releases/download/v1.0.3/OpenMind-Studio_1.0.3_linux_x64.deb) | 21.8 |
| [`OpenMind-Studio_1.0.3_linux_x86_portable.tar.gz`](https://github.com/smshagor-dev/OpenMind-Studio/releases/download/v1.0.3/OpenMind-Studio_1.0.3_linux_x86_portable.tar.gz) | 21.2 |
| [`OpenMind-Studio_1.0.3_linux_x86.AppImage`](https://github.com/smshagor-dev/OpenMind-Studio/releases/download/v1.0.3/OpenMind-Studio_1.0.3_linux_x86.AppImage) | 113.5 |
| [`OpenMind-Studio_1.0.3_linux_x86.deb`](https://github.com/smshagor-dev/OpenMind-Studio/releases/download/v1.0.3/OpenMind-Studio_1.0.3_linux_x86.deb) | 21.6 |
| [`OpenMind-Studio_1.0.3_windows_x64_portable.zip`](https://github.com/smshagor-dev/OpenMind-Studio/releases/download/v1.0.3/OpenMind-Studio_1.0.3_windows_x64_portable.zip) | 258.2 |
| [`OpenMind-Studio_1.0.3_windows_x64_setup.exe`](https://github.com/smshagor-dev/OpenMind-Studio/releases/download/v1.0.3/OpenMind-Studio_1.0.3_windows_x64_setup.exe) | 240.7 |
| [`OpenMind-Studio_1.0.3_windows_x64.msi`](https://github.com/smshagor-dev/OpenMind-Studio/releases/download/v1.0.3/OpenMind-Studio_1.0.3_windows_x64.msi) | 259.0 |
| [`OpenMind-Studio_1.0.3_windows_x86_portable.zip`](https://github.com/smshagor-dev/OpenMind-Studio/releases/download/v1.0.3/OpenMind-Studio_1.0.3_windows_x86_portable.zip) | 257.2 |
| [`OpenMind-Studio_1.0.3_windows_x86.msi`](https://github.com/smshagor-dev/OpenMind-Studio/releases/download/v1.0.3/OpenMind-Studio_1.0.3_windows_x86.msi) | 258.1 |
| [`openmind-studio.sh`](https://github.com/smshagor-dev/OpenMind-Studio/releases/download/v1.0.3/openmind-studio.sh) | 0.0 |
| [`Start.OpenMind.Studio.bat`](https://github.com/smshagor-dev/OpenMind-Studio/releases/download/v1.0.3/Start.OpenMind.Studio.bat) | 0.0 |
| [`Start.OpenMind.Studio.command`](https://github.com/smshagor-dev/OpenMind-Studio/releases/download/v1.0.3/Start.OpenMind.Studio.command) | 0.0 |

### v1.0.4 — 9 assets

| Filename and GitHub download | Size (MiB) |
|---|---:|
| [`OpenMind-Studio_1.0.4_linux_x64_portable.tar.gz`](https://github.com/smshagor-dev/OpenMind-Studio/releases/download/v1.0.4/OpenMind-Studio_1.0.4_linux_x64_portable.tar.gz) | 22.8 |
| [`OpenMind-Studio_1.0.4_linux_x64.AppImage`](https://github.com/smshagor-dev/OpenMind-Studio/releases/download/v1.0.4/OpenMind-Studio_1.0.4_linux_x64.AppImage) | 119.0 |
| [`OpenMind-Studio_1.0.4_linux_x64.deb`](https://github.com/smshagor-dev/OpenMind-Studio/releases/download/v1.0.4/OpenMind-Studio_1.0.4_linux_x64.deb) | 23.3 |
| [`OpenMind-Studio_1.0.4_windows_x64_portable.zip`](https://github.com/smshagor-dev/OpenMind-Studio/releases/download/v1.0.4/OpenMind-Studio_1.0.4_windows_x64_portable.zip) | 186.5 |
| [`OpenMind-Studio_1.0.4_windows_x64_setup.exe`](https://github.com/smshagor-dev/OpenMind-Studio/releases/download/v1.0.4/OpenMind-Studio_1.0.4_windows_x64_setup.exe) | 168.0 |
| [`OpenMind-Studio_1.0.4_windows_x64.msi`](https://github.com/smshagor-dev/OpenMind-Studio/releases/download/v1.0.4/OpenMind-Studio_1.0.4_windows_x64.msi) | 187.3 |
| [`openmind-studio.sh`](https://github.com/smshagor-dev/OpenMind-Studio/releases/download/v1.0.4/openmind-studio.sh) | 0.0 |
| [`Start.OpenMind.Studio.bat`](https://github.com/smshagor-dev/OpenMind-Studio/releases/download/v1.0.4/Start.OpenMind.Studio.bat) | 0.0 |
| [`Start.OpenMind.Studio.command`](https://github.com/smshagor-dev/OpenMind-Studio/releases/download/v1.0.4/Start.OpenMind.Studio.command) | 0.0 |

### v1.0.5 — 6 assets

| Filename and GitHub download | Size (MiB) |
|---|---:|
| [`OpenMind-Studio_1.0.5_linux_x64_portable.tar.gz`](https://github.com/smshagor-dev/OpenMind-Studio/releases/download/v1.0.5/OpenMind-Studio_1.0.5_linux_x64_portable.tar.gz) | 23.2 |
| [`OpenMind-Studio_1.0.5_linux_x64.AppImage`](https://github.com/smshagor-dev/OpenMind-Studio/releases/download/v1.0.5/OpenMind-Studio_1.0.5_linux_x64.AppImage) | 98.2 |
| [`OpenMind-Studio_1.0.5_linux_x64.deb`](https://github.com/smshagor-dev/OpenMind-Studio/releases/download/v1.0.5/OpenMind-Studio_1.0.5_linux_x64.deb) | 23.6 |
| [`OpenMind.Studio_1.0.5_x64_en-US.msi`](https://github.com/smshagor-dev/OpenMind-Studio/releases/download/v1.0.5/OpenMind.Studio_1.0.5_x64_en-US.msi) | 187.6 |
| [`OpenMind.Studio_1.0.5_x64-setup.exe`](https://github.com/smshagor-dev/OpenMind-Studio/releases/download/v1.0.5/OpenMind.Studio_1.0.5_x64-setup.exe) | 168.2 |
| [`OpenMindStudio-1.0.5-portable-win-x64.zip`](https://github.com/smshagor-dev/OpenMind-Studio/releases/download/v1.0.5/OpenMindStudio-1.0.5-portable-win-x64.zip) | 186.8 |

## 5. Source-code traceability for the research paper

| Component or claim | Source/documentation | Boundary |
|---|---|---|
| Portable editor and UI | [`README.md`](README.md), [`src/`](src/), [`src-tauri/`](src-tauri/) | Tauri/Rust, React/TypeScript and Monaco-based workbench |
| Shared installation | [`docs/deployment.md`](docs/deployment.md) | Program/runtime assets on a network share where configured |
| Local mutable state | [`docs/multi-pc-isolation.md`](docs/multi-pc-isolation.md), [`crates/db/`](crates/db/) | Per-machine/user SQLite, logs and caches in network mode |
| Language tools | [`crates/runtime-manager/`](crates/runtime-manager/), [`docs/toolchains.md`](docs/toolchains.md) | Supported runtime versions shared; some toolchains require local fallbacks |
| Local AI and coding agent | [`crates/llm/`](crates/llm/), [`crates/agent/`](crates/agent/), [`docs/agent-safety.md`](docs/agent-safety.md) | Locally executed inference and permissions; shell actions are not an OS sandbox |
| Collaboration | [`docs/multi-pc-isolation.md`](docs/multi-pc-isolation.md) | Deliberately shared editing state; host-local execution sessions |
| Optional PHP/MySQL service | [`src/services/phpStackWiring.ts`](src/services/phpStackWiring.ts) | MariaDB/phpMyAdmin optional developer tools, **not** core app database |
| Hardware pilot protocol | [`docs/pilot/multi-pc-pilot.md`](docs/pilot/multi-pc-pilot.md) | Repository test protocol is marked pending; independent evidence is required for field-validation claims |

## 6. Zenodo deposit and citation workflow

1. **Choose the exact archival object.** Archive the tagged public `OpenMind-Studio-Code` source when citing implementation, or deposit verified binaries from the `OpenMind-Studio` release if the executable files themselves need long-term preservation.
2. **Link the intended repository in Zenodo.** Enable GitHub integration, then publish a *new GitHub release* for the version/commit to be archived. This generates its own Zenodo archive/DOI when processed; historical links in this document do not copy past releases into that archive.
3. **Verify version identity.** Check that package/application version metadata, tag, source commit, build procedure and referenced asset actually correspond. Do not attach all historical packages to one source snapshot as if they were built from it.
4. **Metadata suggestion.** Title: *OpenMind Studio: A Portable AI-Assisted Development Environment*; creator: *Md Shahanur Islam Shagor*; type: **Software**; license: **Apache-2.0 for the covered source contents** (observe third-party redistribution notices); keywords: `portable IDE`, `shared development environments`, `machine isolation`, `AI coding agent`, `software engineering`.
5. **Binary integrity.** For any binaries actually deposited, compute and record the SHA-256 of downloaded bytes along with exact filename, version, size, original URL and evidence of source/build correspondence. The metadata in this file does **not** pretend that SHA-256 checks were performed.
6. **After the DOI is issued,** add the exact DOI and citation to the research manuscript, `CITATION.cff` or `.zenodo.json` if desired. Do not invent a DOI or reuse another project's DOI.
7. **Research evaluation.** The author's report of 100+ daily student users is a deployment description, not a verified benchmark dataset. Archive anonymized host logs and measurement artifacts separately, with necessary institutional permissions.

Official instructions: [Zenodo GitHub setup](https://help.zenodo.org/docs/github/enable-repository/) · [Archiving a release](https://help.zenodo.org/docs/github/archive-software/github-upload/) · [GitHub DOI guidance](https://docs.github.com/en/repositories/archiving-a-github-repository/referencing-and-citing-content)

## 7. Provenance and maintenance

- Official inventory source: `GET https://api.github.com/repos/smshagor-dev/OpenMind-Studio/releases?per_page=100`, inspected 2026-10-31.
- Enumerates all published non-draft versions `v1.0.0` through `v1.0.5` returned by that endpoint on the inspection date.
- Update this catalog when later releases appear; GitHub asset presence does not prove CI completion, a code-signing status, or independent deployment validation.
- This source-repository documentation change does not download, embed, re-upload or redistribute any historical binary asset.
