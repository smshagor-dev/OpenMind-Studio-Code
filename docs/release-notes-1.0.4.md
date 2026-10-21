# OpenMind Studio v1.0.4 (built, not yet published)

Windows (x64, x86) and Linux (x64, x86) packages built from the private source `main` after v1.0.3. Not yet
published, not Authenticode/GPG-signed, and not yet offered as an automatic update (see "Known limitations").

## New

### OpenMindAI Agent — a local coding agent in the editor

- A new activity-bar panel, in the style of Claude Code: a chat that can read, search and edit your project, run
  commands, work with Git, and fetch web pages — with every edit, delete and command confirmed first (Ask by
  default; Accept Edits and Plan modes are also available), a running todo list, and Undo for its last turn.
- Runs on a **local** model by default: NVIDIA's Nemotron, downloaded once and served on this computer by a bundled
  llama.cpp engine. Nothing is sent anywhere unless you turn on Cloud.
- **OpenMindAI Cloud** (optional): three hosted models (OpenMindAI Super/Ultra/Lite) reachable with your own Developer
  API key (DPAPI-encrypted, never shared or hard-coded). A Local/Cloud switch in Agent Settings remembers each side's
  last model; the Cloud address is visible and can be changed; a sign-up link is offered.
  OpenMind runs no model of its own for the local path — it talks to the engine it started.
- A branded setup dialog (model download with a size/RAM estimate, first preload) instead of a bare picker.
  Starting with no folder open now opens Documents for the Agent instead of leaving it with nothing to work in, and
  no project folder is created until the Agent actually needs one.
- Queued tasks: send more than one request and they run in order, with their own execution limits and permissions,
  and resume cleanly if one is interrupted.
  Persistent chat history with attachments, optional media/search tools and GPU controls, and a slash (`/`) command
  center for saved, repeatable workflows.

### Editor right-click menu

A full context menu on the editor (and on historical/compare views): Go to Definition/Declaration/References with
Peek, Rename, Refactor, Format, a Source Control submenu (compare with working/previous revision, file history,
blame, open on the remote, copy as a link/patch/permalink), and — when the Agent is available — quick actions
(Explain, Review, add the file to chat, inline chat, start dictation).

### Languages and formatting

- **PascalABC.NET** support alongside the existing Free Pascal toolchain — install it from the Runtime Manager, run
  `.pas` files with it, choose which compiler a project uses.
- **Assembly (NASM)** support: a bundled NASM/GCC/GDB toolchain, the `asm-lsp` language server, Run Code for `.asm`/
  `.s` files, and step-through debugging with GDB.
- **Bundled offline formatters** for many more languages with nothing to install: Prettier (with PHP, shell,
  Dockerfile, XML, SQL, TOML, Java, Svelte, Astro, Vue plugins), Ruff (Python), gofmt (Go), clang-format (C/C++/
  Objective-C/C#), StyLua (Lua) — on top of the existing built-in JSON formatter and language-server formatting.

### Built-in browser

Running an HTML or JavaScript file now opens it in a browser panel beside the editor (with its console), instead of
only a terminal/Output channel — styles, relative scripts, `fetch` of local files and SCSS/Sass compilation all work,
and saving a served file reloads the page.

### Network deployment and shared installations

- **Network Deployment** (Help > Network Deployment, or `OpenMindStudio.exe --deploy ...`): finds OpenMind Studio
  shared on the local network and lets you use a shared copy, or install from one (setup or portable, any folder/
  drive, every package checked for size/SHA-256/signature first). A deployment must be trusted on each computer
  before anything is taken from it. A 20-point Network Deployment Test can be saved as a report for IT.
- A "Recommended for All Users" shared network installation now gives each Windows user who starts it a Desktop
  shortcut to the share, once, automatically.
- A portable copy can now keep **one profile per computer** (database, settings, logs) when it's used from several
  PCs on a shared drive, chosen once on first run.
- The Windows installer now recognizes an existing installation and offers Update/Repair in place instead of risking
  a second, confusing install; it also refuses to downgrade.
- Automatic update checking (GitHub Releases, a status-bar item, a mandatory-update overlay for required versions)
  is built and tested end to end, but is **not turned on in this build** — it needs a signing key that isn't
  configured yet (see "Known limitations").

### Collaboration (early preview)

A local-first collaborative "Room Code" workspace (`openmind-collab`) for editing together over a network is present
in this build. It has not yet passed physical multi-computer or classroom validation, so treat it as a preview, not
a finished feature.

## Updated

- The Agent's local engine now reports GPU offload and CPU fallback from what llama.cpp actually did, not an
  assumption; its "thinking" (reasoning) token budget is now bounded separately from the response, so it can't use
  up the whole turn thinking; and it now follows the context size you actually selected for the model.
- The Agent is faster in everyday use: independent project reads (e.g. several file lookups in one turn) now run in
  parallel instead of one at a time, and streamed response updates are batched, so the chat stays smooth with fewer
  background writes.
- The Windows/Linux/macOS release layout, legal texts, the installer's licence/privacy agreement page and the
  launcher scripts were reorganized per architecture; macOS build support was added to the release tooling (not yet
  built — needs a Mac to run on).
- An Authenticode code-signing workflow is built and ready (`docs/code-signing.md`), but this build has no
  certificate configured, so the Windows files are unsigned.

## Fixed

- Local inference could get stuck after a cancelled or aborted stream; the engine now recovers and releases the turn
  properly.
- A collaboration room joined over the network could load from a mixed/partial state; it now always loads from one
  consistent database snapshot.
- Windows: a file given by its short (8.3) and its long path spelling were sometimes treated as two different files;
  they're now recognized as the same file.
- Network/multi-computer deployments:
  - A computer that asked for a runtime another computer was already installing into the shared folder used to fail;
    it now waits and reuses that install.
  - Two computers installing the same Language Tools package into a shared folder at the same time could overwrite
    each other's record; installs now take a cross-computer lock.
  - A complete shared runtime whose launchers couldn't be (re)written used to be unpacked again over its own files
    (and deleted on failure); it's now used as it is, or the install stops without touching it.
  - Composer's cache/home, the notebook runner and extension downloads no longer write into the shared network
    folder — each computer keeps its own.
  - A network installation started from a mapped drive could, rarely, start with an empty profile, and the
    installing user's Desktop shortcut kept the drive letter instead of the `\\server\share` path; both are fixed,
    and an update no longer re-adds a shortcut the user had deleted.
- The Linux release build script could abort right after a successful build with a misleading error (a broken-pipe
  signal while reading the build system's glibc version for the portable package's README), wasting a full rebuild;
  it now reads that version without the faulty pipe.

## Security

- A valid release signature proves a package is a genuine release, not that the computer offering it is the one IT
  meant: every deployment must be trusted on each computer first, and a shared installation is trusted only for its
  exact network path.
- Network discovery can't be used to amplify traffic at someone else's expense: an announcement whose identity
  doesn't match its own share path, or that changes an already-found deployment's kind, is ignored.
- The package server gives up on a client that sends its request too slowly, and won't serve a file that was
  replaced by a symbolic link.
- A verified package can't be swapped out between its check and its installation, and a package older than the
  running copy is refused.

## Known limitations

- Physical multi-computer testing on a real network (including a university network) is still pending.
- The Windows programs and installers are not Authenticode-signed: SmartScreen will warn, and Smart App Control
  (where it's on) blocks them outright. The Linux packages are not GPG-signed either.
- This build has no automatic-update signature: it can check for updates once published, but can't self-update yet.
- Network discovery is IPv4 only and doesn't cross routers; type the address of a computer on another subnet.
- The Windows x86 (32-bit) package can't install the Runtime Manager's runtimes (Node.js, Python, Git, PHP ... are
  64-bit downloads), also on 64-bit Windows; its offline language servers and Python packages run only on 64-bit
  Windows. Use the x64 package where you can.
- Linux packages don't include the offline language servers, formatters or Python packages, and the Runtime
  Manager's downloads are for Windows.
- The local-first collaboration feature is an early preview and has not been validated across a real network or in a
  classroom setting.
- macOS packages are not built in this release (no macOS machine available to build on); the build tooling for it
  exists and is ready.

## Upgrade

- Copies of 1.0.3 will update themselves once this release is published with a signed update feed; 1.0.2 and older
  must install it by hand once.
- Shared network folder: everyone closes OpenMind Studio, then run the new setup on one computer with the same
  folder.
