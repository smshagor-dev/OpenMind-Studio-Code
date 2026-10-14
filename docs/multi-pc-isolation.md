# Multi-PC isolation: what is shared, what is each computer's, and how conflicts are prevented

OpenMind Studio may run on many computers at once from one installation (a network share, a lab's portable drive),
with the same Windows user name and identical-looking profile paths everywhere (`C:\Users\Student\...`). The rule:
**shared immutable binaries, isolated mutable state.** Three layers stay apart:

- **Deployment** (`openmind-deploy`, `src-tauri/src/deploy/`): finding installations and packages, provisioning a
  computer. Shares only immutable, signed binaries and read-only facts.
- **Collaboration** (`openmind-collab*`): rooms, peers, documents — deliberately shared document state, its own port.
- **Execution** (terminals, runs, debug sessions, servers): always the computer's own. Nothing about a process — input,
  output, folder, environment, lifetime — crosses to another computer.

A computer is identified by its machine identity (a hash of Windows' MachineGuid and the SMBIOS UUID; see
`docs/data-scope.md`), never by user name, path, drive letter or IP address. A process is identified by that computer,
its app instance, the terminal/run id and the process id.

## Resource audit

| Resource | Owner / lifetime | Class | Lock | Atomic write | Stale recovery | Failure behaviour |
| --- | --- | --- | --- | --- | --- | --- |
| SQLite database (+ `-wal`, `-shm`) | one computer + Windows user, for the app's run | local (`%LOCALAPPDATA%\OpenMind\Studio\Installations\<key>`; portable per-computer scope: `data\machines\<id>\`) | `session.lock` OS lock (`session_guard`): a second *computer* is refused | SQLite WAL | the OS lock ends with the process | "Database open on another computer"; nothing opened |
| Settings, keybindings, profiles | computer + user | local in a network installation | — | temp + rename | — | a broken file is never rewritten |
| Logs, temp, WebView profile, search index, AI history | computer + user | local (`AppPaths`) | — | per file | old temp cleaned at start | — |
| Mutable caches (pip, npm, Go, Gradle, NuGet, Composer home/cache, notebook runner, extension downloads) | computer | local (`machine_cache_dir`, the Runtime Manager's tool cache) | — | tools' own | — | — (classified and moved off the share in this change) |
| Download cache (`cache\downloads`) | shared, content-addressed by SHA-256 | shared, immutable once verified | the runtime version lock while written | `.part` + rename after checksum | a bad file is re-downloaded | a mismatch deletes the file |
| Runtime store `runtimes\<kind>\versions\<v>` | shared, versioned, immutable once published | shared | per-version OS lock `<v>.lock` (different runtimes and versions never wait for each other) | staging `<v>.installing` → rename | lock ends with the process; a waiter takes over, staging is cleared only when nobody holds the lock | an installing computer is **waited for** (≤ 1 h, phase `waiting`) and its install reused; a complete version this computer has no record of is adopted, and if its launchers can't be written the install fails: complete files are never unpacked over again; repair/delete: `BusyElsewhere`; removing a version in use: `InUse`, nothing removed |
| Runtime records | each computer's database | local | — | SQLite | `reconcile` adopts healthy shared versions, drops records whose folder is gone | — |
| Runtime shims | shared, per version | shared | the version lock | written after verify | recreated when missing | install fails rather than half-works |
| Tool packages `tools\<id>\`, `tools\installed.json` | shared | shared | `tools\.install.lock` OS lock (whole install/removal) | staging `.installing` → rename; `installed.json` via a unique temp name + rename | lock ends with the process | a waiting computer reuses what the other installed; removal renames away first (in use → refused) |
| Language servers `language-servers\<pkg>` | shared | shared | per-package OS lock | unique `.unpacking-<pid>-<n>` → rename | leftovers cleared under the lock | a running server is never replaced |
| Extensions `extensions\installed` | shared | shared | — | unique staging (`<pid>-<nanos>`) → rename | — | a second install of one id is refused |
| Terminals / PTYs | the computer and window that opened them | local, in memory | — | — | killed with the window / app (Job Object) | — |
| Processes (runs, servers, debug, LSP, tasks) | the computer that started them | local; each in its own Job Object | — | — | a crash kills the tree | stopping one never stops another |
| stdin / stdout / stderr, Output channels | the session / run | local | — | — | — | routed by session id inside one process |
| IPC (Tauri, LSP stdio, extension host stdio, gateway) | one process | local | — | — | — | loopback ports are random per run and token-protected (gateway) |
| Ports (MariaDB, PHP, phpMyAdmin, gateway, preview) | one process | local | — | — | — | a busy port is refused with the reason or the next free one is used; never attached to another program |
| Deployment discovery UDP 47741 | the offering process | per computer | `SO_REUSEADDR` | — | — | bind failure → "can't answer" (BLOCKED), searching still works; queries under 512 bytes ignored; found deployments/sources capped (256/64); an announcement that changes a deployment's kind is ignored |
| Deployment trust | computer | local (`deploy-trust.json` in the data folder) | — | temp + rename | — | an untrusted deployment is refused before anything is downloaded |
| Package server | the offering process | per computer, random TCP port | — | — | — | GET only; catalog names only, each the regular file canonicalized when offered (a file replaced by a link isn't served); a request head must arrive within 10 s; error answers close gracefully |
| Provisioning a destination | one provisioning | the chosen folder | a lock next to it on the network, in this computer's data folder (`provision-locks\`) for a local folder | own download folder per provisioning; the verified package held open, unreplaceable, until used; portable: staging → rename or the updater's all-or-nothing swap | lock ends with the process; download folder and staging removed | refused while that copy runs here, untrusted, or older than this copy; failing checks delete the package |
| Desktop shortcut | computer + user | local (Known Folders) | — | `IShellLink` save | repaired only when it starts this program through a drive letter | manual steps shown when refused |
| Installation records (HKCU) | Windows user | local | — | registry | — | — |
| Updater staging | the copy | its folder / local temp | install lock | verified before use | stale staging > 1 day removed | — |

## Tests

- `crates/deploy/tests/lan.rs`, `tests/packages.rs` — real UDP/TCP: discovery, broadcast, 8 concurrent searchers,
  restart, duplicate sources, forged/replayed/broken/other-protocol answers, rate limiting, blocked sends, bind failure,
  downloads, tampering, cancel, traversal attempts, 12 concurrent downloads.
- `crates/runtime-manager/src/manager/tests/shared.rs` — three computers asking for one runtime at once (one download,
  one unpack), crash takeover, the wait limit, independent runtimes.
- `src-tauri/tests/multi_pc.rs` + `multi_pc/exec.rs` — three logical "Student" computers on one installation: path
  isolation, three databases written concurrently, the cross-computer database lock, 30 concurrent ConPTY terminals,
  6 processes of one shared binary, a database left by a process killed mid-write (WAL present) reopening with every
  committed row, on its own computer only.
- `src-tauri/src/deploy/exec_tests.rs` — provisioning with the real signature check (throwaway key): any drive present
  on the machine, Unicode/space paths, upgrade keeping data, forged and tampered packages, downgrade, kind mismatch,
  concurrent provisioning of one folder, untrusted and older deployments, the verified setup being unreplaceable while
  it runs, unreachable and unwritable destinations.

What these do not prove: behaviour across physically separate computers, real firewalls and Group Policy, and SMB
locking between machines. That is the physical university test (`docs/pilot/university-network-deployment.md`).
