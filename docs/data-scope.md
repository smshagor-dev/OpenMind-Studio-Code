# Portable data scope: one profile, or one per computer

One OpenMind Studio folder on a USB stick or external SSD can be plugged into many computers (a lab, a university, an
office). If every computer opened the same `data/openmind-studio.db`, their sessions, window layouts, recent folders,
DPAPI-encrypted keys (which only the computer and Windows user that saved them can read), WebView data and MariaDB data
would mix and overwrite each other. So a portable copy chooses where its machine-specific data lives:

| Choice | Where the machine-specific data lives |
| --- | --- |
| **Only for me** (`personal`) | the layout every earlier version used: `data/openmind-studio.db`, `logs/`, `data/webview/`, `data/mariadb/` … |
| **All users / Multi-computer** (`perMachine`, **Recommended**) | `data/machines/<profile id>/` — a separate profile for every computer |

**Either way, the application, runtimes, compilers and Language Tools are shared**: installed once on the drive, they
are available on every computer that runs it. Only the computer's own state is separated.

The choice is kept in `data/data-scope.json` (`{"schemaVersion": 1, "mode": "perMachine", "chosenAt": "…"}`, plus an
`import` request while one is waiting for the next start).

## When the choice is made

- **A portable copy with no choice yet** (a fresh copy, or one from before this feature) opens a setup window *before
  any database is opened*: "Choose how OpenMind Studio will be used", with **All users / Multi-computer** marked
  **Recommended** and preselected. When an earlier profile exists it offers "Use this existing profile on this computer"
  (ticked). After Continue the app restarts; the copy (if any) happens at that start, before the database is opened.
- **A choice is never asked again.** `data/data-scope.json` is read with a few retries (a network share that drops for
  a moment, a scanner holding the file). When it is missing, damaged or can't be read, start-up does not ask: this
  computer's own record of the choice (`install-state.json` in `%LOCALAPPDATA%\OpenMind\Studio\Installations\<install
  key>\`, written at every start of a multi-computer copy and when a choice is saved) decides, then the presence of this
  computer's own profile in `data/machines/`. A missing file is written again with that choice. Only a file that exists
  but can't be read, with nothing on this computer to go on, stops start-up with the reason (the error window) — a
  second choice would overwrite the first one. A one-profile ("Only for me") portable copy still writes nothing outside
  its folder.
- **Run from a temporary folder** (a ZIP opened in Explorer without extracting it: `%TEMP%\Temp1_<name>.zip\`): the
  setup page says so first — Windows deletes that folder, so every choice and the database would be lost and the
  question would come back each time.
- **Installed copies** are set up by their installer (`install.json` next to the program, see `docs/deployment.md`) and
  never show this page: the per-user setup keeps the one-profile layout; the per-machine MSI (Program Files) and a
  network installation keep every computer's and Windows user's data in that user's local folder. A Linux copy that
  keeps its data in `~/.local/share` belongs to one computer and is not asked either.
- **Later**: File > Preferences > Data Scope... (also in the Manage gear menu). It applies at the next start. It is
  refused while the PHP or MySQL server runs.

## Shared vs per computer

Shared on the drive (never duplicated): the program, `runtimes/` (Node, Python, PHP, MariaDB, Go, Rust, JDK, Fortran,
Pascal, assembly … binaries and their shims), `tools/` (+ `tools/installed.json`), `language-servers/`, `lsp/`,
`python-bundle/`, `extensions/` (installed packages and their storage), `themes/`, `settings/` (settings.json,
keybindings.json, profiles: theme, fonts and other portable preferences), `cache/` (verified downloads, pip/npm/Composer
caches, the notebook runner), `data/composer/` (`COMPOSER_HOME`), `shims/`, `htdocs/`.

MariaDB is the clearest case of the split: its **binaries** are a shared Runtime Manager runtime
(`runtimes/mariadb/versions/<v>/`), while its **data** (the databases, `my.ini`, its logs) is per computer
(`state/mariadb/`, `state/mariadb-config/`, `logs/mariadb/`). Every computer that starts MySQL creates its own empty
database there; what one computer stores in MySQL is not seen by another. The same goes for phpMyAdmin: the install is
shared, its generated configuration is per computer (below).

Per computer, `data/machines/<profile id>/`:

```text
machine.json          {"schemaVersion":1,"identityVersion":1,"profileId":"42f693bd91a7","identityHash":"<64 hex>",
                       "platform":"windows","createdAt":"…","lastUsedAt":"…"}   (derived values only)
openmind-studio.db    the SQLite database (WAL, busy_timeout 5 s, foreign_keys on): sessions, recent files and folders,
                      window/explorer state, breakpoints, editor_settings (terminal shell, ports, project folders,
                      chosen tool versions, DPAPI-encrypted keys and passwords), runtime records (see below)
logs/                 openmind-studio.log, lsp/, mariadb/, phpmyadmin/, extensions/extension-host.log, network diagnostics
cache/                phpMyAdmin's generated configuration (phpmyadmin-config.inc.php; the shared install holds only a
                      fixed stub config.inc.php that loads the file named by OPENMIND_PMA_CONFIG), Run Code build
                      output (run-builds/)
state/webview/        the WebView2 profile (cookies, local storage, IndexedDB, cache)
state/search-index/   the workspace search index (paths include this computer's drive letter)
state/ai/             AI provider list and conversation history (keys are in the database)
state/mariadb/        MariaDB's data directory (with its PID file)
state/mariadb-config/ the generated my.ini (absolute paths; rewritten at every MariaDB start)
state/asm-lsp/        asm-lsp's generated .asm-lsp.toml (this computer's NASM path)
temp/                 download staging, update downloads, the per-run npm configuration, Python bundle unpacking
```

`data/profile.lock` (shared) is the lock described under "Start-up". Every one of these paths comes from
`openmind_core::AppPaths` (`AppPaths::per_machine`); nothing in the app builds them from the app folder by hand.

### Runtimes and Language Tools on every computer

The `runtimes/` folder is the truth about what is installed. The install records in a computer's database only say which
installed version is active there. `RuntimeManager::reconcile` (also run before a terminal's, a run's or a language
server's environment is built) adopts every healthy version folder it finds and drops records whose folder is gone, so:
a runtime installed on PC-A is on PC-B's PATH at once with no download; an update or removal on one computer is seen by
the others; a drive-letter change changes nothing. Language Tools are found by their files (`language-servers/`,
`tools/`, `lsp/`); only the *chosen* active tool version is a per-computer preference (it falls back to the newest).
Changing the data scope never reinstalls anything.

## Machine identity

`openmind_core::machine_identity` (+ `machine_signals`). **Only the computer decides**: nothing on the drive (no
`machine.json`, scope file, database, drive serial, volume label or install folder) and not the computer name is an input.

Signals (all read-only, no administrator rights; verified as a standard user):

| Field | Windows | Linux | macOS |
| --- | --- | --- | --- |
| `os_id` | `HKLM\SOFTWARE\Microsoft\Cryptography\MachineGuid` (64-bit view) | `/etc/machine-id` | — |
| `hardware_uuid` | SMBIOS type-1 system UUID (`GetSystemFirmwareTable('RSMB')`) | `/sys/class/dmi/id/product_uuid` if readable | `IOPlatformUUID` |
| `hardware_serial` | SMBIOS type-1 serial number | `/sys/class/dmi/id/product_serial` if readable | `IOPlatformSerialNumber` |

Normalisation: UUIDs/GUIDs become lower-case `8-4-4-4-12` (braces, case and dashes don't matter); serials are trimmed,
inner spaces collapsed, upper case. Rejected as placeholders: empty, malformed, one repeated digit (all `0`, all `F`),
`03000200-0400-0500-0006-000700080009` and other shipped-unchanged UUIDs, `To Be Filled By O.E.M.`, `Default string`,
`System Serial Number`, `Unknown`, `None`, `Not Specified`, `N/A`, `123456789` …. The serial is used **only when there is
no valid hardware UUID** (a serial that a BIOS update turns into a placeholder can't move a UUID machine to a new profile).

```text
tuple = "os_id=<v>\nhardware_uuid=<v>\nhardware_serial=<v>\n"        (fixed order; an absent value is empty)
identityHash = SHA-256("openmind-studio:v1:\n" + tuple)               (64 hex)
profile id   = identityHash[..12]                                      (16, 24, 32, 64 on a prefix collision)
```

Lab PCs cloned from one image share `MachineGuid` but not their SMBIOS UUID (or serial), so they get different profiles.
A renamed computer, a new drive letter and an updated app keep the same profile. A reinstalled Windows (new `MachineGuid`)
or a replaced motherboard (new UUID) is a new profile; the old one stays on the drive.

**Fallback** when neither `os_id`, `hardware_uuid` nor a usable serial exists: a random 128-bit id kept **on this
computer** (`%LOCALAPPDATA%\OpenMind Studio\machine-id`, `~/.local/state/openmind-studio/machine-id`,
`~/Library/Application Support/OpenMind Studio/machine-id`), written once and reused; a file that would be inside the
portable folder is refused, so a fallback can never travel to the next PC. If it can't be saved, the id is used for that
run only (`ephemeral`, shown on the Data Scope page). Limit: `%LOCALAPPDATA%` is per Windows user, so on a computer with no
usable signal two Windows accounts get two profiles; a roaming/mandatory profile that wipes `%LOCALAPPDATA%` at logoff
gives a new profile per logon. The log only says "System machine identifier unavailable. Using OpenMind fallback device
identity."

**Privacy**: raw values and the tuple exist only while they are hashed. They are never logged, stored (not in
`machine.json`, SQLite, the scope file or any path), sent to the window, or put in an error message; `MachineSignals`'
`Debug` prints only which signals were present.

### Which folder: collisions

`machine_paths::select_profile` (under the lock) takes the 12-character id: no folder → create it with `machine.json`
first; a folder whose `machine.json` has the same full `identityHash` → this computer's; a folder with another hash → a
prefix collision, try the next length. A folder without a readable `machine.json` is claimed only if it holds nothing
(a start that stopped right after creating it); otherwise it is left alone. `machine.json` can therefore *reject* a
folder but never *choose* one. Writes go to `<file>.<pid>.tmp`, are flushed and renamed.

### Identity versions

`identityVersion` is in `machine.json` and the hashed prefix (`v1`). A future `v2` must not strand profiles: it would
compute the v1 hash too and, when a v1 profile exists for this computer, keep using it (or rename it under the lock and
record the v1 hash as an alias in `machine.json`). Nothing in v1 prevents that.

## Start-up order

`main` → `data_scope::resolve`, before logging, the database, the WebView or any service:

1. the app folder; this computer's identity;
2. the saved choice (none + portable → setup window);
3. under `data/profile.lock` — an OS lock on an open handle (`File::try_lock`: `LockFileEx`/`flock`), released by the OS
   when the process ends, so a leftover file never blocks a start; a second start on the same computer waits (up to
   2 minutes) and then re-reads everything: select the profile folder, then prepare the database (below);
4. `main` creates the folders, starts logging and opens **only** `AppPaths::db_path`. A failure in 3 shows the
   Milestone 20.0 start-up error window (no database opened); its "Back Up and Start Fresh" only ever acts on this
   profile's own database.

## Migration (copying a profile between scopes)

Choosing a scope with "use the existing profile" records an import request for this computer (`identityHash`, `from`). At
that computer's next start, under the lock, `src-tauri/src/data_scope/migrate.rs` copies the AI history and MariaDB data
folders when the target has none (through `<dir>.partial`, SQLite files via the Backup API, other files flushed and size
checked; a MariaDB data folder in use is refused), then `openmind_db::migration::prepare` brings the database in:

| Case | State | Action |
| --- | --- | --- |
| A/G/H | target exists, `quick_check` ok | use it; a stale `.migrating` is renamed `.migrating-stale-<t>`; the request is cleared (never a second import) |
| E/F | target exists, `quick_check` fails | change nothing (target, `.migrating`, source all kept); the start-up error window explains it; recovery only after the user acts |
| B | no target, `.migrating` passes `quick_check` | rename it into place, check again |
| C | no target, `.migrating` fails | rename it `.migrating-invalid-<t>`, then D |
| D | no target, no `.migrating` | source → `.migrating` (SQLite Backup API) → flush → `quick_check` → rename → `quick_check` |
| — | no request, a leftover `.migrating` | renamed `.migrating-orphan-<t>`, never promoted |

The source is opened with `SQLITE_OPEN_READONLY` (not `immutable=1`) and copied in one Backup API step, i.e. one read
transaction: transactions committed only to its `-wal` are included, nothing half-written is. A read-only connection never
writes, checkpoints or truncates the source and never changes its journal mode (SQLite may update `-shm` bookkeeping).
The request is cleared only after the target exists and passes `quick_check`; the target's existence and validity — not
the request — decide what the next start does. **Nothing is deleted, moved away from the source or overwritten**: the
one-profile `data/openmind-studio.db` stays as it was (it is the rollback), and switching back uses an existing database of
the other scope as it is.

Example — PC-A adopts the old profile, PC-B and PC-C start with new ones, the drive moves from `G:` to `H:`:

```text
H:\OpenMind-Studio\data\openmind-studio.db                       the old one-profile database, untouched
H:\OpenMind-Studio\data\machines\42f693bd91a7\openmind-studio.db PC-A (found again after the letter change)
H:\OpenMind-Studio\data\machines\a591cc273781\openmind-studio.db PC-B
H:\OpenMind-Studio\data\machines\d33ac401128a\openmind-studio.db PC-C
H:\OpenMind-Studio\runtimes\…                                    one copy, used by all three
```

## Testing on one machine

Debug builds read `OPENMIND_SIMULATE_MACHINE=os=<v>;uuid=<v>;serial=<v>` in place of the real signals (release builds
ignore it), so several "computers" can be simulated against one portable folder.

## Limits

- A profile is per computer, not per Windows user: two users of one lab PC share it, and DPAPI-encrypted keys saved by one
  user can't be read by the other (the app says so).
- Two cloned PCs with the same `MachineGuid` *and* no usable SMBIOS UUID *and* no usable serial look like one computer.
- **Every computer's profile takes space on the drive, and it grows when MariaDB is used.** Measured in a two-computer
  simulation: about 15–25 MB per computer (mostly the WebView2 profile, which grows with use to tens or a few hundred
  MB), and about **160 MB** per computer once MySQL has been started there (a new MariaDB data folder is ~140 MB before
  any data is added). Roughly: 1000 computers ≈ 20 GB without MySQL, ≈ 160 GB if every one of them starts MySQL, plus
  whatever the databases hold. Profiles of computers that never come back are not cleaned up automatically (delete their
  folders in `data/machines` by hand); size the drive accordingly.
- After switching to Only for me, other computers' profiles stay in `data/machines` but are not used.
- The OS lock protects starts on one computer; two computers using the drive at the same moment (a network share) each
  have their own profile and database, so they don't need it.
