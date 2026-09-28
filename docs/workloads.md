# Workloads, runtimes and language packs

*Terminal > Workloads...* (or the **Workloads** tab of *Terminal > Manage Runtimes*) is a Visual Studio-style
installer for optional runtimes, SDKs and tools. The same page appears **once** when OpenMind Studio starts for the
first time; *Skip for now* (or closing it) installs nothing and it doesn't come back.

Installer-time selection (choosing workloads inside the NSIS/MSI setup) is **not** implemented: first-run and Runtime
Manager workload selection are implemented; installer-time selection is future packaging integration.

## Rules

- Nothing downloads until you press **Install** (on a card) or **Install selected**. Opening the page reads local state
  only: the Runtime Manager's list, the offline LSP bundle and files on PATH.
- Everything installs **inside the app folder** (`<app>/runtimes`), without administrator rights. PATH, the Registry,
  the system proxy and tools' global configuration are never changed; runtimes are added to the PATH of processes
  OpenMind starts only.
- Downloads use the Runtime Manager: the proxy from *Network: Proxy Settings* (Milestone 21), retries with backoff,
  resume, mirrors, and the **SHA-256 is checked before anything is kept or extracted**.
- Tools' own caches are app-local: `GOPATH`, `GRADLE_USER_HOME`, `PUB_CACHE`, `NUGET_PACKAGES`, `DOTNET_CLI_HOME`,
  `ANDROID_USER_HOME`, NuGet's HTTP/plugin caches, Helm's folders and Terraform's plugin cache point into `<app>/cache/...`.
  Telemetry/phone-home switches are set for processes OpenMind starts (`DOTNET_CLI_TELEMETRY_OPTOUT=1`, `CHECKPOINT_DISABLE=1`,
  `FLUTTER_SUPPRESS_ANALYTICS`, `DART_SUPPRESS_ANALYTICS`, `GOTOOLCHAIN=local`), and the .NET SDK's first run is told not to
  touch Windows (`DOTNET_ADD_GLOBAL_TOOLS_TO_PATH=false`, `DOTNET_GENERATE_ASPNET_CERTIFICATE=false`). Only switches a tool
  really reads from the environment are set.
- Nothing is marked installable unless OpenMind really installs it. Every other component says why.

## Statuses

| Status | Meaning |
| --- | --- |
| Installed | Installed by OpenMind, built into OpenMind, in the offline LSP bundle, or found on this computer (the path is shown) |
| Available | OpenMind can install it here |
| Heavy SDK | Installable, but 700 MB or more on disk (LLVM-MinGW, .NET SDK, PostgreSQL, Flutter): deselect it if you don't need it |
| External required | Installed outside OpenMind (rustup, Android Studio, the emulator, Redis via WSL/Docker, MAUI, Xcode) |
| Manual install | Added to a project by its package manager (the command is shown, never run), or a language server installed from Language Tools |
| Admin required | Needs its own installer and administrator rights (Docker Desktop, Visual Studio Build Tools, CUDA/ROCm, .NET Framework) |
| Unsupported architecture | No download for this computer's platform |
| Planned | Not available yet (GDB, JDT LS, a C# language server, Phpactor, NuGet offline import) |

## What OpenMind installs (Windows x64)

| Runtime | Version | Download | Installed | Checksum source |
| --- | --- | --- | --- | --- |
| Java JDK (Eclipse Temurin 21 LTS) | 21.0.12.1 | 196 MB | 328 MB | Adoptium API |
| Maven | 3.9.16 | 9 MB | 10 MB | computed; Apache SHA-512 matched |
| Gradle | 9.8.0 | 145 MB | 163 MB | Gradle |
| Kotlin compiler | 2.4.20 | 86 MB | 93 MB | JetBrains release |
| Go | 1.27.1 | 75 MB | 235 MB | go.dev |
| CMake | 4.4.3 | 52 MB | 137 MB | Kitware SHA-256.txt |
| Ninja | 1.13.2 | 0.3 MB | 0.6 MB | GitHub asset digest |
| C/C++ toolchain (LLVM-MinGW, clang + LLD + LLDB) | 20260922 | 182 MB | 715 MB | GitHub asset digest |
| Git LFS | 3.8.0 | 6 MB | 15 MB | GitHub asset digest |
| kubectl | 1.37.1 | 61 MB | 61 MB | dl.k8s.io |
| Helm | 4.3.0 | 20 MB | 64 MB | get.helm.sh |
| Terraform (BSL 1.1) | 1.16.4 | 35 MB | 118 MB | HashiCorp SHA256SUMS |
| .NET SDK (with .NET and ASP.NET Core runtimes) | 10.0.401 | 287 MB | 770 MB | computed; Microsoft SHA-512 matched |
| Dart SDK | 3.13.4 | 210 MB | 588 MB | Google |
| Flutter SDK | 3.47.5 | 1.80 GB | 3.25 GB | Google (releases_windows.json) |
| Android command-line tools | 23.0 | 148 MB | 171 MB | computed; Google SHA-1 matched |
| Android platform tools (adb, fastboot) | 37.0.1 | 8 MB | 17 MB | computed; Google SHA-1 matched |
| SQLite tools | 3.53.4 | 6 MB | 14 MB | computed; SHA3-256 matched |
| PostgreSQL client tools (EDB binaries, includes server + pgAdmin files) | 17.6 | 315 MB | 848 MB | computed (EDB publishes none) |

Plus the runtimes that already existed: Node.js, Python, PHP, Composer, Git, MariaDB, phpMyAdmin, debugpy, js-debug.
Install sizes are measured from each archive's central directory before anything downloads.

Dependencies are added automatically (and listed in the summary): Maven, Gradle, Kotlin and the Android command-line
tools need the JDK; Flutter needs Git; Composer needs PHP. Removing a dependency you selected is allowed and warned
about.

**Licences.** The Android packages require accepting the *Android Software Development Kit License Agreement*: the
page shows a licence dialog (with a link) and the backend refuses the install without it. Accepting it never accepts
anything inside a tool — `sdkmanager` asks for each SDK package's licence itself, and OpenMind never answers for you.

## Notes per SDK

- **Kotlin**: JetBrains' `bin\kotlinc.bat` finds its home through 8.3 short paths and fails when the install path has a
  space on a drive without short names (the default folder is "OpenMind Studio"). OpenMind adds `openmind-bin\kotlinc.cmd`
  and `kotlin.cmd`, first on PATH, which run Java directly with quoted paths (they don't parse `-J` options; use
  `JAVA_OPTS`).
- **C/C++ (LLVM-MinGW)**: builds MinGW (GNU ABI) programs with clang/clang++ without Visual Studio. A dynamically linked
  program needs the toolchain's `bin` on PATH (OpenMind's terminals have it) or `-static`. MSVC projects still need
  Visual Studio Build Tools (external, admin).
- **.NET**: the SDK is used from the app folder via `DOTNET_ROOT`. Without the two first-run switches above, the SDK's
  first `dotnet new` adds its global-tools folder to your **User PATH** and creates an **HTTPS development certificate** in your
  certificate store (found during this milestone's manual test, undone, and prevented since). NuGet itself still creates
  `%APPDATA%\NuGet\NuGet.Config` (a default nuget.org source) and `%LOCALAPPDATA%\NuGet\Migrations` the first time a project is
  restored; OpenMind can't redirect those. `dotnet run` starts compiler servers
  (`VBCSCompiler`) that keep the SDK folder busy for a few minutes: run `dotnet build-server shutdown` (or close the
  terminal) before deleting the SDK. A delete that meets a locked file stops, the install shows as damaged, and a second
  Delete finishes it.
- **Go**: keeps local-only telemetry counters in `%APPDATA%\go\telemetry` (Go's default "local" mode; nothing is uploaded
  unless you run `go telemetry on`). Go ignores an environment switch for this; run `go telemetry off` if you want it off.
- **Flutter**: 1.8 GB download, 3.3 GB on disk. Needs Git. Engine artifacts for a platform are downloaded by Flutter
  itself when you run `flutter precache` or build. Android builds also need the JDK and the Android command-line
  tools; Android Studio and the emulator are external.
- **Android**: `ANDROID_HOME` points at the command-line tools' install; add platforms with
  `sdkmanager --sdk_root=%ANDROID_HOME% "platforms;android-35"`. The newest command-line tools print a deprecation
  notice pointing at Google's new `android` CLI; both work.
- **PostgreSQL**: EDB's binaries ZIP also contains the server and pgAdmin files; OpenMind uses the client tools and never
  starts a server from it.
- **Terraform** is source-available under the Business Source License 1.1.

## Keeping the page current

The Workloads tab reads what is installed from the backend. When a runtime is installed, repaired, deleted or switched anywhere
(the Runtimes tab, the PHP window, another window) or a language server is installed or unpacked (Language Tools), the page
reads it again while it is on screen, so its cards, Install buttons, summary and warnings never show an old state. While the
page isn't shown nothing is read (a read runs version checks); it is read again when the page comes back.

## Downloads

Large downloads are not cut off: the time allowed for a body grows with its expected size (at least 15 minutes, enough
for 200 KB/s). A broken connection keeps the partial file and the next attempt resumes it with an HTTP range request
(logged as `download response ... resumed=true`).

## Offline

Every archive listed above is recognized by its SHA-256 when imported (*Network > Offline Packages* or *Import offline
packages* on the page): it goes where the Runtime Manager looks, and Install then needs no network. See
`docs/network-proxy.md`.

## Proxy failures in terminals

A terminal command that fails because of the proxy (for example pip's `407 Proxy Authentication Required` / `Tunnel
connection failed`, which pip reports as `No matching distribution found`) shows the network card: **Configure
Proxy**, **Retry Command** (runs the same command again in a new terminal that has the current proxy variables),
**Open New Proxy-Ready Terminal**, **Import Package**, **Use Offline Cache**. Terminals opened before a proxy change are
marked (`⚠ Network: ...` in the terminal header) and a notice says to open a new one.
