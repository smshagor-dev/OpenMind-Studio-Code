# OpenMind Studio v1.0.3

Windows (x64, x86), Linux (x64, x86) and — new — macOS (Apple silicon, Intel).

## New

- **Installation types.** The setup's first page offers **For Me** (one Windows user, no administrator rights) or
  **Recommended for All Users** (one installation in a shared network folder used by several computers; silent: `/NETWORK`).
  The MSI installs into Program Files and keeps each Windows user's data in their own local folder.
- **Per-PC database isolation.** In a network installation every computer and Windows user keeps their own database,
  settings, logs and caches on their own disk; a database already open on another computer is refused with a clear
  start-up message instead of being shared.
- **Shared runtime coordination.** Runtimes, tools and language servers in a shared folder are installed, repaired,
  removed and unpacked under per-version operating-system locks, so computers no longer disturb each other.
- **Automatic updates from GitHub Releases.** Checks a little after start-up and every few hours, downloads stable
  versions in the background, verifies OpenMind's update signature, and installs on close (or Restart to Update, never
  with unsaved editors). Portable copies replace only their program files; shared network installations only notify.
  Settings > Workbench > Automatic Updates turns downloading off.
- **Update in place.** Running a newer setup over an existing installation shows an *Update OpenMind Studio* page
  (installed version, new version, type, location) and replaces the program files in place — no uninstall, same folder,
  data kept. The same version shows *Repair*; an older setup refuses to downgrade.
- **Built-in browser.** Run Code on an `.html`/`.htm` file opens the page beside the editor with its console; SCSS/Sass is
  compiled on request and saved files reload the page.
- **Collaborative workspace (preview).** Rooms with a Room Code, shared editing, presence and voice. Its multi-computer
  and cross-network validation is still pending; treat it as a preview.
- Desktop-shortcut deployment for labs (`--integration desktop-shortcut`, `scripts\deploy\Deploy-OpenMindShortcuts.ps1`).
- **macOS editions.** A disk image (`.dmg`) and an app ZIP for Apple silicon (arm64) and Intel (x64). Data is kept in
  `~/Library/Application Support/OpenMind Studio`, never inside the app. macOS copies tell you about new versions but
  don't update themselves.
- **License Agreement and Privacy Policy.** The Windows installers show the OpenMind Studio License Agreement and Privacy
  Policy; installing requires ticking "I accept" (it starts unticked). Every package carries them in `legal/`, with the
  Terms of Use.
- **Launchers.** `Start OpenMind Studio.bat` (Windows portable), `openmind-studio.sh` (Linux portable; checks the
  architecture and missing system libraries) and `Start OpenMind Studio.command` (macOS).

## Fixed

- The "Choose how OpenMind Studio will be used" setup could reappear after it had been answered (a saved file briefly
  unreadable on a share or by a scanner).
- Cross-PC runtime locking: one computer's refresh removed another's half-finished install; an install or repair could
  delete a runtime another computer was using.
- Shared installation paths: the `\\server\share` shortcut and a mapped drive (or `subst`/junction) now reach the same
  local profile instead of two.
- Two computers opening a language for the first time could make one language server fail to start (extraction race).
- Database ownership: two computers could open one database through a share.
- Starting an MSI (Program Files) installation as a standard user stopped before any window appeared.
- A per-user setup placed in a network folder made every computer open one database.
- Installer state: a failed `--integration set-layout` is now reported; the installation type is kept on update.
- A newer setup showed first-install questions again and uninstalled the old version first by default; it also replaced
  an MSI installation with a per-user one.
- Network installations wrote Cargo, Go, NuGet, Gradle, pip, npm and Composer caches into the shared folder.
- Built-in browser: typed page state survives switching to Output; a save right before Run Code no longer loads twice.
- Opening a saved file with no folder open now opens that file's folder.

## Improved

- Windows 11 compatibility: the program carries an application manifest (`asInvoker`, Windows 10/11, long paths).
- Update signature verification: version-bound signatures are required (`requireSignedVersion`).
- Portable reliability: all-or-nothing program-file swap with rollback for portable updates.
- Release packaging: Authenticode verification of every signed file and SignPath workflow preparation.
- Installation, network-deployment and pilot documentation.

## Upgrade

- **Install this version by hand once:** 1.0.2 and older cannot update themselves.
- For Me / portable: install or unzip over the old copy; data stays where it is.
- Shared network folder: everyone closes OpenMind Studio, then run the new setup on one computer with the same folder.

## Rollback — read before upgrading

This release **adds database migrations** (`0004_collaboration`, `0005_collab_doc_baselines`). Once v1.0.3 has opened
a database, v1.0.2 refuses to start on it ("database from a newer build"; nothing is deleted). To go back, keep a copy of
`data\` from before the upgrade, or use *Back Up and Start Fresh* in the older version's error window.

## Linux and macOS

- macOS copies are told when a new version exists; download the new disk image or app ZIP.
- Linux copies (.deb, AppImage, tar.gz) are told when a new version exists, but don't update themselves: install the
  new package from the releases page (a .deb also through your package manager).

## Code signing

- **Windows:** the installers and programs are **not Authenticode-signed**. SmartScreen will warn ("Windows protected your
  PC"), and Smart App Control, where it is turned on, blocks them. Check each file against `SHA256SUMS.txt`.
- **macOS:** the app is **ad-hoc signed only** — not signed with an Apple Developer ID and **not notarized**. macOS asks you
  to confirm the first start (Control-click the app > Open, or System Settings > Privacy & Security > Open Anyway).
- **Updates** are always signed with OpenMind Studio's own update key, and the app verifies that signature before it
  installs anything.

## Known limitations

- Multi-PC behaviour was tested on one computer with simulated computers, not yet on several real computers.
- A valid code signature does not make SmartScreen trust a new release at once; reputation builds over time.
- Fortran and Assembly can't link from a network share (refused in a network installation).
