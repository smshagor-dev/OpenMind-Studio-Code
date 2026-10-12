# OpenMind Studio 1.0.3 (DRAFT, not released)

Version: **1.0.3** (new installation modes and automatic updates; no breaking change for existing installations). The
repository is at 1.0.3; nothing has been tagged or published yet.

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
- **Automatic updates** — OpenMind Studio checks GitHub Releases a little after start-up and every few hours, downloads a
  new stable version in the background, verifies OpenMind's signature, and installs it when you close the app (or now
  with Restart to Update, which never runs while an editor is unsaved). Portable copies replace only their program
  files; shared network installations just say a new version exists. A release can require older versions to update.
  Settings > Workbench > Automatic Updates turns the download off. **Install this version by hand once**: 1.0.2 and
  older can't update themselves.
- **Running a newer setup updates the installation you have.** When OpenMind Studio is already installed the setup's
  first page is **OpenMind Studio Update** — installed version, new version, installation type and location — with one
  button, *Update OpenMind Studio* (*Repair OpenMind Studio* for the same version). It replaces the program files in
  place: no installation type or folder questions, no uninstall first, shortcuts and choices kept, data untouched. A
  shared network folder someone else installed is found too, once this computer has started it. The setup never
  closes OpenMind Studio for you, refuses while it runs on another computer from the shared folder, and only one setup
  can change a folder at a time.

## Fixed

- Running a newer setup over an existing installation showed the first-install questions again and, by default,
  uninstalled the old version first; choosing another installation type or folder there made a second installation
  with its own, empty data. A setup also replaced an MSI installation with a new per-user one (new data location), and
  an older setup replaced a newer installation.

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

This release **adds database migrations** (`0004_collaboration.sql`, `0005_collab_doc_baselines.sql`, from the
collaborative workspace). Once 1.0.3 has opened a database, 1.0.2 refuses it at start-up ("migration from a newer
build"; nothing is deleted). Keep a copy of the data folder from before the upgrade to roll back with your data, or use
*Back Up and Start Fresh* in the older version's error window.

1. Close OpenMind Studio everywhere.
2. Reinstall the previous setup (same folder) or unzip the previous portable copy over this one. A setup from this
   version on refuses to replace a newer installation; to go back with such a setup, run it with `/ALLOWDOWNGRADE`
   (setups of 1.0.2 and older don't check).
3. Previous versions don't read `install.json`:
   - **For Me** and portable copies behave exactly as before.
   - **MSI** and **network** installations go back to the previous behaviour (data next to the program), so their users'
     data from this version stays in `%LOCALAPPDATA%\OpenMind\Studio\Installations\<key>\` and is not seen by the old
     version. Nothing is deleted; reinstalling this version finds it again.
4. Runtimes installed by this version are ordinary runtime folders and remain usable.

The earlier validation of steps 1–3 (an old build reopening the new database) predates the collaboration migrations and
no longer holds; a database opened by 1.0.3 needs the pre-upgrade copy.

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
