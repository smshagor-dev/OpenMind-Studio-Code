# OpenMind Studio — next release (DRAFT, not released)

Proposed version: **1.1.0** (new installation modes; no breaking change for existing installations). The version
number in the repository is still 1.0.2: it is changed only when the release is approved.

Release status: **PILOT-READY, release BLOCKED** until the multi-PC pilot (`docs/pilot/multi-pc-pilot.md`) has passed on
real computers and the installers are signed for the intended channel (see "Release gate" in `docs/release.md`).

## What's new

- **Choose how to install.** The setup's first page asks for the installation type:
  - **For Me** — as before: one Windows user's copy, no administrator rights.
  - **Recommended for All Users** — one installation in a shared network folder that several computers run. Runtimes and
    tools installed there are shared; every computer and Windows user keeps their own database, settings, logs and
    caches on their own disk. Silent: `/NETWORK`.
  - The MSI installs into Program Files for every user of a computer; each Windows user keeps their own data, runtimes
    and tools in their own folder.
- **Desktop shortcuts for a lab** — `OpenMindStudio.exe --integration desktop-shortcut [--all-users]` (create or repair,
  always the `\\server\share` path) and `scripts\deploy\Deploy-OpenMindShortcuts.ps1` for administrators (verified,
  with a CSV report). They use only the rights you have; nothing bypasses Windows or Active Directory permissions.
- **Signature checks** — release builds verify every installer's Authenticode signature and RFC 3161 timestamp.

## Fixed

- The "Choose how OpenMind Studio will be used" page could come back after it had been answered when its saved file
  could not be read for a moment (a network share, a scanner). A choice is now never asked again.
- Starting an MSI (Program Files) installation as a standard user stopped before any window appeared.
- A per-user setup placed in a network folder made every computer open one database.
- Several computers sharing one installation could disturb each other's runtime installs: one computer's refresh
  removed another's half-finished install, and an install or repair could delete a runtime another computer was using.
- Two computers opening the same language for the first time could make one language server fail to start.
- In a network installation, Cargo (Rust), Go, NuGet, Gradle, pip, npm and Composer caches were written into the shared
  folder; each computer now keeps its own.
- The Network window could leave an unhandled error when download progress could not be followed.
- The program now carries a Windows manifest (`asInvoker`, Windows 10/11, long paths).

## Known limitations

- The multi-PC behaviour has been tested on one computer with simulated computers (separate profiles through
  `\\localhost`), not yet on several real computers.
- Data is not synchronised between computers; each keeps its own history.
- A shared language server must be unpacked once by someone who may write to the share before users who may only
  read it can use it.
- Installing or removing runtimes in a shared installation needs write access to the share; using them doesn't.
- A Rust project that asks for another toolchain (`rust-toolchain.toml`) needs that toolchain installed into the share.
- Fortran and Assembly (w64devkit 1.19.0, GNU binutils 2.40) can't link from a network share; the Runtime Manager
  refuses them in a network installation. Use a "For Me" installation on the computers that need them.
- Rust is not part of the Runtime Manager matrix; it is a Language Tools package (rustup, GNU host).
- A valid code signature does not make SmartScreen trust a new release at once; reputation builds over time.

## Upgrade

- **For Me / portable**: install or unzip over the old one. Data stays where it was; nothing is re-initialised.
- **MSI**: the new MSI replaces the old one. Each user's data moves to their own folder on first start (copied once,
  verified; the old copy is left in place).
- **Shared network folder**: everyone closes OpenMind Studio; run the new setup on one computer with the same folder.
  Runtimes stay; each computer keeps its local data.
- A portable copy that was already used in the multi-computer data scope on a share can become a network installation
  with `OpenMindStudio.exe --integration set-layout network`; each computer then copies its own earlier profile once.

## Rollback

Nothing in this release changes the database schema (no new migration), so the previous version opens the same
databases.

1. Close OpenMind Studio everywhere.
2. Reinstall the previous setup (same folder) or unzip the previous portable copy over this one.
3. Previous versions don't read `install.json`:
   - **For Me** and portable copies behave exactly as before.
   - **MSI** and **network** installations go back to the previous behaviour (data next to the program), so their users'
     data from this version stays in `%LOCALAPPDATA%\OpenMind\Studio\Installations\<key>\` and is not seen by the old
     version. Nothing is deleted; reinstalling this version finds it again.
4. Runtimes installed by this version are ordinary runtime folders and remain usable.

Validated: steps 1–3 for a portable copy (old build reopened the new database). The MSI and network rollbacks follow from
the above but were not run on installed copies.

## Release artifact checklist

- [ ] `pnpm release:build` (or the `Release (Windows)` workflow) finished without errors: NSIS setup, MSI, portable ZIP.
- [ ] `RELEASE-REPORT.md` says **signed**, every installer "verified", "timestamped".
- [ ] `node scripts/verify-signatures.mjs release\*.exe release\*.msi` exits 0.
- [ ] `SHA256SUMS.txt` matches the files (`Get-FileHash -Algorithm SHA256`).
- [ ] Update signatures (`.sig`) present for the setup and the MSI; `latest.json` points at this version.
- [ ] Setup's first page shows **For Me** / **Recommended for All Users**; a silent `/NETWORK` install writes
      `install.json` with `"layout": "network"`.
- [ ] The MSI contains `install.json` with `"layout": "perMachine"` (`msiexec /a` extract).
- [ ] Multi-PC pilot result table complete and all passed.
- [ ] Upgrade from 1.0.2 tested for For Me, MSI and network.
