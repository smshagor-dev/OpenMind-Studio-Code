# Deploying OpenMind Studio: one computer, a lab, or a whole network

OpenMind Studio can be installed four ways. The **installer** decides which, writes it next to the program as
`install.json`, and the app never asks again.

| How | Installed by | Program | Each computer's data (database, settings, logs, WebView, search index, MariaDB data) | Runtimes and tools |
| --- | --- | --- | --- | --- |
| **For me** | the setup (`.exe`), "For Me" | `%LOCALAPPDATA%\OpenMind Studio` or a folder you choose | next to the program | next to the program |
| **For all users of this PC** | the MSI (administrator) | `C:\Program Files\OpenMind Studio` | each Windows user's `%LOCALAPPDATA%\OpenMind\Studio\Installations\<key>\` | per Windows user, same folder |
| **Shared network installation** | the setup (`.exe`), "Recommended for All Users" | a shared folder, e.g. `\\fs01\apps\OpenMind Studio` | each computer's and Windows user's `%LOCALAPPDATA%\OpenMind\Studio\Installations\<key>\` | **shared**, in the shared folder |
| Portable ZIP | nobody (unzip) | anywhere | asked once: one profile, or one per computer (`docs/data-scope.md`) | next to the program |

`<key>` is 16 hex digits derived from the installation folder, so two installations never share a local folder. The
folder is resolved first, so one installation has one key however it is started: from the `\\server\share` shortcut,
from a mapped drive (`Z:\OpenMind Studio`) in Explorer, through `subst` or a junction. (Only different *names* for the
same server — `fs01` and `fs01.uni.local` — still count as different folders; use one name in every shortcut.) A local
folder an earlier version made from the path as it was started stays in use, so nobody's data moves.

## A network installation ("Recommended for All Users")

### What it gives you

- **One program, one set of runtimes.** Python, Node.js, PHP, Java, Go, the C/C++ toolchain … installed once from any
  computer appear on every computer at its next terminal, run or Runtime Manager refresh — nothing is downloaded or
  installed again on the other computers.
- **Independent computers.** Every computer and every Windows user has their own SQLite database, settings, keyboard
  shortcuts, profiles, terminal sessions, logs, WebView data, search index, MariaDB data, temporary files and tool caches
  (Go modules, NuGet, Gradle, pip, npm, Composer), all on that computer's own disk. SQLite never runs over the network,
  and two computers never open the same database.
- **No setup on the computers.** Nothing is installed on them; a shortcut to the shared program is all they need.
  The first start on a computer creates its local folder and opens the editor; every later start opens it directly.

### Requirements

- A file share every computer can **read**. The person who installs **runtimes and tools** (the teacher, IT) needs
  **write** access to it; students need only read access.
- 64-bit Windows 10 or 11 with the WebView2 Runtime (included in Windows 11; on Windows 10 install Microsoft's Evergreen
  WebView2 Runtime through your software distribution).
- Each user needs a normal profile with `%LOCALAPPDATA%` on the local disk (the default; roaming profiles don't roam it).

### Install

1. On a computer that can write to the share, run `OpenMind-Studio_<version>_windows_x64_setup.exe`.
2. **Installation type: Recommended for All Users**, then choose the shared folder as the install folder
   (`\\fs01\apps\OpenMind Studio`; a mapped drive letter works too — shortcuts are always made with the `\\server\share`
   path).
3. Answer the question that follows: give each user a Desktop shortcut at their first start (Yes, the default) or not
   (No — choose it when IT deploys shortcuts, see below).
4. The setup writes `install.json` (`"layout": "network"`), the `deploy\` folder next to the program, and your own
   shortcut from the finish page.
5. Start OpenMind Studio once from there and install the runtimes the class needs (Terminal > Manage Runtimes, or the
   Workloads tab). They land in the shared folder.

Silent: `OpenMind-Studio_<version>_windows_x64_setup.exe /S /NETWORK /D=\\fs01\apps\OpenMind Studio` (`/D=` must be last and
unquoted; add `/NOUSERSHORTCUTS` before it to turn per-user shortcuts off).

Any drive works for the shared folder (`R:\Shagor\OpenMind Studio` on one computer, `Z:\Shagor\OpenMind Studio` on
another, or the UNC path): nothing stores a drive letter. Shortcuts and each user's local data folder are made from the
`\\server\share` path the drive letter stands for, so a user who starts it once from R: and once from Z: has one set of
settings.

To turn an existing **portable copy** on a share into a network installation (keeping each computer's history): run
`"\\fs01\apps\OpenMind Studio\OpenMindStudio.exe" --integration set-layout network` once. At its next start each
computer copies *its own* earlier profile from `data\machines\<id>\` into its local folder (verified, never moved; the
shared copy is only read).

### Shortcuts on the other computers

Pick what your environment allows. All of them use only rights you already have; none bypasses Active Directory,
Group Policy or remote-access controls. The `deploy\` folder next to the program has the files named below and a
`README.txt` for IT with the same steps.

| Method | Needs | Result |
| --- | --- | --- |
| **Nothing — at first start** (default): each Windows user who starts OpenMind Studio from the share on a computer gets `OpenMind Studio.lnk` on their own Desktop, once | read access to the share | skipped when a shortcut to the program is already on their Desktop or the Public Desktop (whatever its name); a deleted one stays deleted; a refusal (a locked Desktop) is logged, never retried. Off: `OpenMindStudio.exe --integration user-desktop-shortcuts off` (or the setup's No / `/NOUSERSHORTCUTS`) |
| **The user, by hand**: double-click `deploy\Create Desktop Shortcut.cmd` in the shared folder (or Shell Integration: Create or Repair Desktop Shortcut in the app) | read access to the share | creates or repairs it; when Windows refuses, prints the manual steps |
| **Group Policy Preferences** (recommended in a domain): User or Computer Configuration > Preferences > Windows Settings > Shortcuts, *Update* action, target `\\fs01\apps\OpenMind Studio\OpenMindStudio.exe`, location *Desktop* (or *All Users Desktop*), start in the same folder | Group Policy rights on the OU | applied at the next logon / policy refresh |
| **Logon script** (GPO or local): `\\fs01\apps\OpenMind Studio\deploy\OpenMindStudio-Logon.cmd` (or `... remove`) | read access to the share | the user's Desktop; creates, repairs an outdated one, otherwise changes nothing; silent, exit code 0, log in `%LOCALAPPDATA%\OpenMind\Studio\logon-shortcut.log` |
| **Push now** with `scripts\deploy\Deploy-OpenMindShortcuts.ps1` | administrator on the targets, PowerShell remoting (WinRM) enabled on them | Public Desktop of each computer, verified, CSV report |
| **Per computer by hand** (an administrator on that computer): `OpenMindStudio.exe --integration desktop-shortcut --all-users` | administrator | Public Desktop |

The push script, for example for one lab OU:

```powershell
.\scripts\deploy\Deploy-OpenMindShortcuts.ps1 `
    -SharedExe "\\fs01\apps\OpenMind Studio\OpenMindStudio.exe" `
    -FromActiveDirectory -SearchBase "OU=Lab1,OU=Computers,DC=uni,DC=local" -WhatIf
```

Drop `-WhatIf` to apply. Each computer is reported as `Created`, `Repaired`, `AlreadyCorrect`, `AccessDenied`,
`Unreachable`, `NoAnswer` or `Failed`, with `Verified` = the shortcut was read back and points at the share; the script
exits 1 unless every computer is verified. `-ComputerName` or `-ComputerListPath` instead of Active Directory; `-Remove`
takes the shortcut away (only one that points at this installation). Domain membership alone does **not** let you
manage a computer: the script reports such computers instead of working around them.

### Restricted computers (standard users, locked-down labs)

- Nothing OpenMind Studio does for a user needs administrator rights or asks for elevation: starting it from the share,
  its local data folder, the per-user shortcut and the `deploy\` launchers all work as a standard user. Only
  `--all-users` (the Public Desktop) and the push script need an administrator, and they say so instead of trying.
- Where Windows or a policy refuses a change (a Desktop that may not be written, a redirected Desktop that is read-only),
  OpenMind Studio does not retry or work around it: the explicit commands explain it and print the manual way, and
  `deploy\Check Installation.cmd` (or `OpenMindStudio.exe --integration check`, or Shell Integration: Check Installation
  and Desktop Shortcut in the app) shows the program and network path, the installation type, the user's data folder
  and whether it is on this computer, administrator or standard rights, whether the share and the Desktop are writable,
  the shortcut's state, and what to do.
- The program is not code-signed yet: SmartScreen may warn when it is first downloaded, and Windows 11 Smart App Control
  (when on) blocks unsigned programs. Allow it with your organisation's application-control process (an AppLocker/WDAC
  path rule for the share, for example); OpenMind Studio never tries to get around these controls.

### When the network drive disconnects

- Each computer's database, settings and logs are on that computer, so a lost connection can't damage them, and two
  computers never share a database.
- Starting needs the share: while it is unreachable Windows says the shortcut's target is unavailable. A drive letter that
  isn't mapped on a computer doesn't matter — shortcuts use the `\\server\share` path.
- A momentary failure to resolve the folder while the program starts no longer gives that start a different, empty local
  profile: a mapped drive is then named by Windows' own record of its `\\server\share` path.
- While OpenMind Studio runs, runtimes, tools and language servers are read from the share; they fail until it is back.
  Close OpenMind Studio and start it again once the share is reachable.

### Runtimes from a shared folder

| Runtime | From the share | Notes |
| --- | --- | --- |
| Python (portable) | yes | `pip install` into the shared Python needs write access and should be done by one person; students use a project `.venv` (on their own disk) — the Dependencies view creates one. Without write access Python simply doesn't write `.pyc` files. |
| Node.js / npm | yes | `npm install` in a project works for everyone (the npm cache is per computer); never `npm -g` into the shared folder. |
| PHP / Composer | yes | Composer's cache is per computer. The built-in web server's default web root (`htdocs`) is in the shared folder: give users a project folder of their own. |
| MariaDB (MySQL) | binaries yes | each computer gets its **own** database server data on its own disk; data is not shared between computers. |
| Java (JDK), Maven, Gradle, Kotlin | yes | Gradle's home and Maven's repository are per computer. |
| Go | yes | `GOPATH` and the build cache are per computer. |
| C/C++ (LLVM-MinGW: clang, lld), CMake, Ninja | yes | builds go to each computer's own folder. Measured: `clang hello.c` from the share builds and runs. |
| Pascal (Free Pascal) | yes | measured: `fpc64 hello.pas` from the share builds and runs. |
| Fortran, Assembly (w64devkit 1.19.0) | **no** | their GNU linker (binutils 2.40) can't open files on a network path, also through a mapped drive letter (measured: `gfortran hello.f90` fails at the link step from the share, works from a local folder). The Runtime Manager refuses them in a network installation; install OpenMind Studio "For Me" on the computers that need them. |
| .NET SDK | yes | NuGet caches and `DOTNET_CLI_HOME` are per computer. |
| Rust (Language Tools) | yes | the toolchain (`RUSTUP_HOME`, the `cargo`/`rustc` programs) is shared and only read; each computer gets its own `CARGO_HOME` (registry, git checkouts, `cargo install` output) in its local tool cache, so building needs no write access to the share. A project builds into its own `target\` folder, as always. A project that asks for another toolchain (`rust-toolchain.toml`) needs that toolchain installed into the share by someone who may write there. |
| Language servers (offline bundle) | yes, once unpacked | the first computer that opens a file of a language unpacks its server into the shared `language-servers\` (needs write access); computers opening the same language at the same moment wait for that one unpack instead of failing, and a server another computer is running is never replaced or deleted. On a share students may only read, open one file of each language once from the installing computer before the class starts. |

Several computers may **use** a runtime at the same time, and one computer may install a different runtime meanwhile.
Changing one runtime version is serialised across computers. When several computers ask for the same missing runtime at
once (three PCs press Install Python), one of them installs it — download, checksum, unpack into a staging folder,
publish by renaming — while the others show "Waiting for another computer that is installing it" and then use that
install: one download, one unpack, no second copy. If the installing computer crashes or loses the network, its lock
ends with its process; a waiting computer takes over and its half-unpacked folder is cleared, never published. A wait
lasts at most an hour. Repair and remove don't wait: another computer trying them is told "being changed by OpenMind
Studio on another computer" and nothing is written twice. Language Tools' tool installs (`tools\`) work the same way:
one computer at a time, the others reuse what it installed.
A runtime that another computer is using (a terminal, a run, a server) can't be removed: nothing is removed and the
Runtime Manager says it is in use. A computer that lost its network in the middle of an install leaves no stale lock
(the lock is the operating system's and ends with the process).

### Updating a network installation

When a new release is published, every computer's OpenMind Studio shows "Version x is available" in the status bar
(it checks GitHub a little after start-up and every few hours). It never downloads into, or changes, the shared folder:
a client may only read the share, and replacing a program that other computers are running would break them.

To update, in a maintenance window — everyone has closed OpenMind Studio first. Run the new setup on any computer whose
user may write to the share and has started that installation once (or pass `/D=\\server\apps\OpenMind Studio`): it
finds the shared folder and shows **OpenMind Studio Update** with the installed and new versions — no installation type,
no folder choice, "Recommended for All Users" is kept. Before it replaces anything it checks that no computer is running
the program from the share; if one is, it stops with "in use — on another computer … Nothing has been changed" (it never
closes programs on other computers), so ask everyone to close it and press Update again. Only one setup can change the
folder at a time (a lock file in the folder). Each computer keeps its local data, and the runtimes in the share stay.
The next start on every computer is the new version.

A release that marks older versions as no longer supported (a mandatory update) does not block the computers of a shared
installation: they can't install it themselves, so they keep working and keep showing that the new version is available.

### What is not shared, and limits

- Data is never synchronised between computers: a project opened on PC 1 is in PC 1's recent list only.
- **One computer per database.** A database that lives in a shared folder (a portable copy set up as "Only for me" and
  started from several computers, or two cloned computers that look identical) is opened by one computer at a time:
  while OpenMind Studio runs on one, a start on another shows "Database open on another computer" and opens nothing
  (two computers writing one SQLite file can damage it). A second start on the *same* computer is allowed as before. A
  crash or a dropped network releases it (it is an operating-system lock).
- A student who may only read the share and tries to install or remove a runtime is told they lack write permission
  (and who manages runtimes), not a file-system error.
- Extensions installed into the shared folder are shared (their per-extension storage is too).
- `data\data-scope.json`, `data\machines\` and the shared `data\openmind-studio.db` of an older portable layout are no
  longer used by a network installation (they are left as they were).
- Tested on one computer with the share reached through `\\localhost` and through separate local folders standing in
  for computers; a real multi-PC lab rollout has not been tested by the developers.

## Finding OpenMind Studio on the network and setting computers up (Network Deployment)

Help > **Network Deployment** (or `OpenMindStudio.exe --deploy ...` in a console) finds OpenMind Studio deployments on
the local network and sets the computer up from one. This is separate from collaboration rooms (its own UDP port
47741, its own packets) and never touches a terminal, a running program or another computer's database.

**What can be found**

- A **shared network installation**: every computer that runs it from the share and has *Offer This Installation on the
  Local Network* turned on (Settings > Network) — or a computer running `--deploy serve` — announces it by its network
  path. Twenty computers announcing one share are one deployment; its identity is the share's network path, never a
  drive letter, an IP address or a user name.
- A **package source**: a computer offering the release's signed `..._setup.exe` / `..._portable.zip`. Copy the release
  files *with their `.sig` files* into `deploy\packages` next to the program (or pass `--packages <folder>` to
  `--deploy serve`). A file whose signature doesn't verify against the release key built into OpenMind Studio is not
  offered (the reason is listed).

**What is sent**: versions, architectures, sizes, SHA-256 checksums, the release signatures and a shared installation's
network path. Never settings, projects, credentials, keys, the database or the computer's or user's name. Nothing is
announced unless the setting is on (or `--deploy serve` runs), and nothing is searched until the user clicks *Search the
Network* or runs the test. A search sends three queries to the network's broadcast addresses (and to any address typed
in, for a source on another subnet); nothing scans address ranges. A query is padded to at least 512 bytes and an answer
is smaller than that, so an announcing computer can't be used to multiply someone else's traffic; it also answers each
address only a few times a second. Discovery is IPv4 only, and broadcasts don't cross routers: for a source on another
subnet type its address.

**Trust.** Anyone on the network can announce a deployment, and the release signature only proves a package is a real
OpenMind Studio release, not that the computer offering it, or the share it names, is the one IT meant. So the first
time a deployment is used on a computer the user is asked to trust it (what it is, the share path, which addresses
answered); nothing is taken from an untrusted deployment, and the backend refuses it too. Trust is per computer, stored
in that computer's data folder (`deploy-trust.json`, at most 64 entries). A shared installation is trusted by its exact
network path (its identity is a hash of that path, checked on every announcement, so another path can't borrow it); a
package source by its identity. `--deploy untrust <id>` withdraws it. Even when trusted, every package is still checked
against the release signature, its size and SHA-256; the file stays open (and can't be replaced) from that check until
the setup or unpacking has finished, and a package older than the running copy is refused.

**Setting a computer up** (one of three, each shown with the reason when it isn't possible):

| Choice | What happens |
| --- | --- |
| Use Shared Installation | The program in the share must be readable from this computer; this user gets a Desktop shortcut to its network path. Nothing is copied; the database and settings are created on this computer at the first start. |
| Install with Setup… | Choose **any folder on any drive** (an `OpenMind Studio` folder is made inside it). The setup is downloaded, its size, SHA-256 and release signature are verified, and it runs silently into that folder. An older copy there is updated in place with its data kept, the same version is repaired, a newer one is never downgraded (refused with the reason), a copy that is in use is left alone. |
| Install Portable Copy… | The same checks; the portable package is unpacked into the folder, or swapped into an existing portable copy item by item (data, settings and runtimes kept). |

One folder is provisioned by one computer at a time (a lock next to the folder when it is on the network, in this
computer's data folder when it is local, so nothing is left beside a local destination), never while OpenMind Studio
runs from it on this computer, and a folder holding other files is never written into. Each provisioning downloads into
its own temporary folder, removed afterwards. A package that fails a check is deleted and nothing is installed; a source
that stops mid-download leaves no partial installation. A setup that needs administrator rights (Windows error 740) is
reported as such; nothing tries to get around it. The firewall: the computer that **offers** must accept inbound UDP 47741 and the package server's
TCP port (Windows asks the first time); a computer that only searches needs nothing. Where policy blocks broadcasts the
search says "The network blocked the search"; ask a source directly by typing its address.

**Network Deployment Test** — twenty checks, each PASS, FAIL, BLOCKED or NOT TESTED with the reason (NOT TESTED = the
check doesn't apply to this copy or was skipped, e.g. the package wasn't downloaded, or a portable copy has no shortcut of
its own; an untrusted deployment makes provisioning readiness BLOCKED "UNTRUSTED DEPLOYMENT"): machine identity, installation,
program path, install folder, local data, database isolation, runtime store, network interface, discovery socket,
deployment discovery ("NO DEPLOYMENT FOUND" / "DISCOVERY UNAVAILABLE" / "NETWORK/BIND BLOCKED" / "PROTOCOL
INCOMPATIBLE" are told apart), discovered source, protocol, platform, architecture, version, package availability,
package integrity (optionally downloads the package, verifies it and deletes it), provisioning readiness, the Desktop
shortcut and runtime reuse. `OpenMindStudio.exe --deploy test --json > report.json` saves it for IT.


## Where a user's data is

- For me / portable: next to the program (`data\`, `settings\`, `logs\` …).
- Per machine and network: `%LOCALAPPDATA%\OpenMind\Studio\Installations\<key>\`
  (`openmind-studio.db`, `settings\`, `logs\`, `state\`, `cache\`, `temp\`, `install-state.json`). Help > About >
  Copy System Info lists the app and logs folders.

Uninstalling removes the program (and `install.json`) but never a user's data folder; delete it by hand to reclaim the
space. The uninstaller removes the installing user's shortcut only: in a network installation remove the other users'
shortcuts first (the Group Policy item with *Delete*, the logon script with `remove`, or the push script with
`-Remove`), because once the program is gone nothing can tell which shortcut started it.

## Command line reference

```text
OpenMindStudio.exe --integration set-layout portable|per-user|per-machine|network
OpenMindStudio.exe --integration layout
OpenMindStudio.exe --integration desktop-shortcut [--all-users]
OpenMindStudio.exe --integration remove-desktop-shortcut [--all-users]
OpenMindStudio.exe --integration user-desktop-shortcuts on|off
OpenMindStudio.exe --integration check
OpenMindStudio.exe --deploy status
OpenMindStudio.exe --deploy discover [--target <host[:port]>]... [--json]
OpenMindStudio.exe --deploy test [--target <host[:port]>]... [--no-download] [--json]
OpenMindStudio.exe --deploy serve [--packages <folder>]
OpenMindStudio.exe --deploy provision <deployment id|first> [--kind share|setup|portable] [--to <folder>] [--target ...] [--no-shortcut] [--trust]
OpenMindStudio.exe --deploy untrust <deployment id>
```

`--trust` trusts the deployment first (the dialog's question); with `first` it is refused when more than one compatible
deployment answered: name the deployment by its id.

Exit code 0 = done, 1 = failed (the reason on standard error; for `--deploy test`: a check failed), 2 = unknown action. Typed into a console, the output
appears in that console; redirect it (`> report.txt`) in scripts.
