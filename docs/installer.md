# Installers, PATH and File Explorer integration

OpenMind Studio ships three Windows x64 editions. None of them changes PATH, the Registry or File Explorer unless the
user asks. Both options below are **off by default**, can be undone, and remove only what OpenMind added.

| Edition | Installs to | Admin rights | PATH option | "Open with OpenMind Studio" option |
| --- | --- | --- | --- | --- |
| NSIS setup (`OpenMind-Studio-Setup-<v>-x64.exe`) | `%LOCALAPPDATA%\Programs\OpenMind Studio` (per user) | no | check box on the Welcome page, or `/ADDTOPATH` | check box on the Welcome page, or `/EXPLORERMENU` |
| MSI (`OpenMind-Studio-<v>-x64.msi`) | `Program Files\OpenMind Studio` (per machine) | **yes** | `ADDTOPATH=1` (machine PATH) | `EXPLORERMENU=1` (all users) |
| Portable ZIP | wherever you unzip it | no | command palette (per user) | command palette (per user) |

## What the options do

**Add OpenMind Studio to PATH** puts `<install folder>\bin` on PATH. It never adds the install folder itself, so
`uninstall.exe` and the language-server bundle stay off PATH. `bin` holds two launchers:

- `openmind.cmd`, for PowerShell and Command Prompt: `start "" "%~dp0..\OpenMindStudio.exe" %*`;
- `openmind`, for Git Bash.

After that, a **new terminal** can run:

```powershell
openmind .                       # the current folder as the workspace
openmind "C:\Projects\My Site"   # a folder (paths with spaces are fine when quoted)
openmind notes.md src\main.rs    # files as tabs
```

Terminals that were already open keep their old PATH until you open a new one; Windows can't change a running process's
environment. The installer broadcasts the change, so a new terminal from Explorer, the Start menu or Windows Terminal
sees it without signing out.

**Add "Open with OpenMind Studio" to File Explorer** adds a right-click entry, with the app icon, for:

| Right-click on | Key (per user: under `HKCU\Software\Classes`; MSI: `HKLM\Software\Classes`) | Command |
| --- | --- | --- |
| a folder | `Directory\shell\OpenMindStudio` | `"<install>\OpenMindStudio.exe" "%V"` |
| the background of an open folder | `Directory\Background\shell\OpenMindStudio` | `"<install>\OpenMindStudio.exe" "%V"` |
| any file | `*\shell\OpenMindStudio` | `"<install>\OpenMindStudio.exe" "%1"` |

On Windows 11 these appear under **Show more options** (the classic menu). The new compact menu needs a packaged
(MSIX) app extension, which OpenMind doesn't have.

## Command-line behaviour (`OpenMindStudio.exe <paths>`)

- A folder opens as the workspace. A file opens in a tab. Relative paths are resolved against the current folder.
- Several paths: the first folder becomes the workspace (one window has one folder). Later folders are not opened, and a
  notice names them. Every file opens.
- A path that doesn't exist gives an error message naming it; the app still starts.
- Arguments starting with `-` are ignored.
- The arguments are applied after the previous session is restored, so the folder you named replaces the one that was
  open.
- Each launch is its own OpenMind Studio process. There is no single-instance hand-over, so two portable copies in
  different folders can run side by side. Running `openmind <folder>` while OpenMind is open therefore opens a second
  window process.

## NSIS (per user)

**Installation type.** The Welcome page asks first (the labels are presentation only; the stored values are `per-user` and `network`):

- **For Me** — the default: this Windows user on this computer. No administrator rights. The data lives next to the program
  (`%LOCALAPPDATA%\OpenMind Studio` or the folder chosen on the next page).
- **Recommended for All Users** — one installation in a shared network folder that several computers run: install into a shared folder such as `\\server\apps\OpenMind Studio`
  (you need permission to write there). Runtimes and tools installed into that folder are shared by every computer;
  each computer and Windows user keeps their own database, settings and logs on their own disk. See
  `docs/deployment.md` for shortcuts on the other computers.

After copying the files the installer runs `OpenMindStudio.exe --integration set-layout per-user` or `... network`,
which writes `install.json` next to the program; the app reads it at every start and never shows the data-scope setup.
A network install also runs `--integration desktop-shortcut` (the installing user's Desktop, pointing at the UNC path).
Silent: `/NETWORK`. An update keeps the earlier choice (read from `install.json`); the uninstaller removes
`install.json` with the program (each computer's local data is kept).

Then two check boxes, both unchecked on a first install. On a reinstall or update they start with the earlier choice.

- **Checked:** after copying the files, the installer runs `OpenMindStudio.exe --integration add-path` and/or
  `add-explorer`.
- **Unchecked:** the installer runs `remove-path` / `remove-explorer`, which remove only what an earlier install
  recorded.

Silent installs choose with switches:

```powershell
"OpenMind-Studio-Setup-0.1.0-x64.exe" /S /ADDTOPATH /EXPLORERMENU
```

**How it is done.** The app itself does the work, not the NSIS script. NSIS would truncate a long PATH at its
1024-character string limit, so it never touches PATH.

- PATH: `HKCU\Environment\Path` keeps its value type (`REG_EXPAND_SZ`). The entry is appended once: an existing entry in
  any spelling (other case, trailing `\`, quotes, `%LOCALAPPDATA%`) counts as present.
- Record: what was added goes under `HKCU\Software\OpenMind\OpenMind Studio Integration`. This is deliberately outside
  the product key that the uninstaller deletes.
- **PATH entry that was already there:** it is not recorded and is never removed.
- **Explorer entries of another copy:** they are removed only if their command runs this copy.

**Uninstall** runs `--integration remove-all` before deleting the files. This removes this copy's PATH entry, if
OpenMind added it, and this copy's Explorer entries. Your other PATH entries and other keys are untouched. An update
(`/UPDATE`) skips this step, so your choice survives it.

## Updating an existing installation

Running a newer setup never makes a second installation and never asks the first-install questions again
(`src-tauri/nsis/installer-hooks.nsh`).

**How the setup finds the installation** (nothing on the network is searched):

1. the folder given with `/D=`;
2. the folder this Windows user installed before (`HKCU\Software\OpenMind\OpenMind Studio`, written by the setup);
3. the folders installed copies note when they start (`HKCU\Software\OpenMind\OpenMind Studio Installations`: one value
   per folder, its network path when it runs from a mapped drive, and the default value = the folder started last).

The third is how a shared network folder that someone else installed is found on another computer. A folder counts only
when it holds `OpenMindStudio.exe` together with its `install.json` or `uninstall.exe`. A folder chosen by hand on the
Directory page of a first install is checked the same way before anything is written. The versions compared are the
version resources of the installed `OpenMindStudio.exe` and of the setup itself. Portable copies record nothing; the
uninstaller removes its folder's value.

| Found | Welcome page | Button | What happens |
| --- | --- | --- | --- |
| nothing | Installation type, PATH, Explorer | Next | the first-install pages (licence, folder, Start Menu) |
| an older version | **OpenMind Studio Update**: installed version, new version, installation type, location | **Update OpenMind Studio** | straight to Installing |
| the same version | **Repair OpenMind Studio** (same facts) | **Repair OpenMind Studio** | straight to Installing |
| a newer version | "A newer version is installed"; nothing is changed | disabled | — (`/ALLOWDOWNGRADE` allows it on purpose) |
| an MSI installation | "Update it with the new .msi package" | disabled | — |

An update or repair replaces the program files **in place**: the old version is not uninstalled first, the licence,
folder and Start Menu pages are skipped, existing shortcuts are kept (the template's update mode), and the earlier
installation type, PATH and Explorer choices are kept. The data next to the program (`data/`, `settings/`, `runtimes/`,
`tools/`, `language-servers/`, `extensions/`, `cache/`, `logs/`) and every computer's local profile are never touched;
database migrations run at the next start as always. The Finish page offers *Run OpenMind Studio*.

**Before any file is replaced** (the Update button, and the same rules for silent and passive installs):

- **OpenMind Studio must be closed.** The interactive setup never closes it for you (unsaved work); it says so and
  stays on the page. A silent or passive setup — the app's own updater, after the app has quit — closes this user's
  copy as Tauri's template does.
- **The program must not be in use elsewhere.** `OpenMindStudio.exe` and `lsp\node\node.exe` are opened for writing
  without changing them: a program that runs on another computer from the shared folder, or for another Windows user,
  keeps them locked, and the setup stops with "OpenMind Studio in … is in use — on another computer … Nothing has been
  changed." It never closes programs on other computers. Silent installs wait up to 15 seconds for a program that is
  closing.
- **One setup at a time.** The setup holds `.openmind-setup.lock` in the folder, opened without sharing and deleted by
  Windows when the setup ends (also after a crash). A second setup on any computer stops with "Another OpenMind Studio
  setup is already changing …". The same check reports a folder the user may not write to.

Silent installs that are refused exit with code 3 and print the reason to the console (`/S /ALLOWDOWNGRADE` to
downgrade). `bundle.windows.allowDowngrades` is `false`, which also makes the MSI refuse to replace a newer MSI.

**NSIS and MSI.** They are separate installations (per user / per machine). The NSIS setup refuses to install next to
an MSI installation (it used to uninstall the MSI and install a new per-user copy with a new data location), and the
MSI refuses to install for a user who has the NSIS installation (`OM_NSIS_INSTALL` launch condition in
`wix/integration.wxs`). Each is updated with its own kind of package; switching means uninstalling one first (the data
next to an NSIS install is kept by its uninstaller).

## MSI (per machine, administrator)

The MSI installs into Program Files and needs administrator rights (UAC). Its options are Windows Installer properties,
off unless given:

```powershell
msiexec /i OpenMind-Studio-0.1.0-x64.msi ADDTOPATH=1 EXPLORERMENU=1
```

- `ADDTOPATH=1` appends `[INSTALLDIR]bin` to the **machine** PATH: WiX `Environment`, `Part="last"`,
  `Permanent="no"`.
- `EXPLORERMENU=1` writes the three Explorer keys under `HKLM\Software\Classes`, for **all users**.

Both are components of `src-tauri/wix/integration.wxs`. Windows Installer removes exactly these on uninstall. The MSI's
wizard has no check boxes for them; they are command-line properties.

The MSI always installs `install.json` with the layout `perMachine` (component `OmInstallLayout`). The program folder is
read-only for users, so every Windows user keeps their whole layout — database, settings, logs, runtimes, tools,
language servers, extensions — in `%LOCALAPPDATA%\OpenMind\Studio\Installations\<install key>\`; the offline language
server and Python bundles are read from the program folder. A database an earlier version left next to the program
(possible only when it ran as administrator) is copied into the first user's folder once and left where it was. Before
this, a standard user's first start of an MSI install stopped before any window appeared, because the app tried to
create `data\` inside Program Files.

**Not tested:** the MSI install/uninstall. It needs administrator rights, which the development machine's session
doesn't have. The MSI build and the WiX source checks (`release.mjs`) run on every release build.

## Portable ZIP

A portable copy registers nothing by itself: no PATH, no Registry, no Explorer entries. If you want them, run these from
the command palette (F1). Each one asks first, then works per user exactly like the NSIS options:

- **Shell Integration: Add OpenMind Studio to PATH (this user)** and **... Remove OpenMind Studio from PATH**;
- **Shell Integration: Add "Open with OpenMind Studio" to File Explorer** and **... Remove ...**.

The entries point at *this* folder. If you move or delete the portable folder, remove them first; otherwise the PATH
entry and the Explorer entries point at a folder that is gone.

The same actions are available on any copy from a terminal:

```powershell
OpenMindStudio.exe --integration add-path|remove-path|add-explorer|remove-explorer|remove-all|status
```

This form opens no window and writes no data folder. It exits with 0 on success, 1 on failure, 2 for an unknown action.

## Undo by hand

If a copy's folder was deleted before its entries were removed:

- delete the `...\bin` entry from **Settings > System > About > Advanced system settings > Environment Variables >
  User variables > Path**;
- delete the keys `HKCU\Software\Classes\Directory\shell\OpenMindStudio`,
  `HKCU\Software\Classes\Directory\Background\shell\OpenMindStudio` and `HKCU\Software\Classes\*\shell\OpenMindStudio`;
- delete `HKCU\Software\OpenMind\OpenMind Studio Integration`.

These are the only things OpenMind writes for this feature.
