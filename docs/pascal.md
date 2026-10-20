# Pascal: Free Pascal and PascalABC.NET

OpenMind Studio runs Pascal files (`.pas`, `.pp`) with one of two **independent** compilers. Choose which one in
**Settings > Pascal > Compiler** (`pascal.compiler`), per user or per workspace folder:

| | Free Pascal (default) | PascalABC.NET |
| --- | --- | --- |
| Runtime Manager item | **Pascal (Free Pascal)** — `pascal` | **PascalABC.NET** — `pascalabc` |
| Compiler | `fpc64` (a launcher over `ppcrossx64.exe`), else `fpc` | `pabcnetcclear` (the official console compiler) |
| Language | Free Pascal / Object Pascal dialects | PascalABC.NET (modern Pascal: classes, lambdas, sequences, .NET) |
| Programs it builds | native Windows x64 `.exe` | .NET Framework `.exe` (Windows) |
| Needs | nothing else | **.NET Framework 4.7.2 or later** (part of Windows 10 1803+ and Windows 11) |
| Platforms | Windows x64 | Windows x64 |

Nothing changes for anyone who doesn't choose: the setting's default is Free Pascal. When the chosen compiler is missing,
Run Code says so (with an install offer) and **never falls back to the other one**. The status bar shows the compiler of
the Pascal file in front ("Free Pascal" / "PascalABC.NET"); a click opens the Pascal settings. The PascalABC.NET card in
the Runtime Manager has **Use for Pascal Files**, which sets the user setting.

## PascalABC.NET

### Where it comes from

The official console compiler `PABCNETC.zip` from <https://pascalabc.net/downloads/PABCNETC.zip> — PascalABC.NET
**4.0.0.3883** (built 2026-10-07), 10 631 071 bytes, SHA-256
`256eb56fa904e4ac99a1d4c867594a945dcfce8bcb7680e623c20477f3c5754f`. The manifest is
`crates/runtime-manager/manifests/pascalabc.json`.

- **Shipped with OpenMind Studio for Windows**, unchanged, in `pascalabc-bundle/` next to the program (with its licence
  texts and `bundle.json`). The Runtime Manager installs it from there with no download. That copy is installed **once by
  itself** about 20 seconds after start-up — on a new installation, and after an update that ships a newer version —
  unless you removed PascalABC.NET in the Runtime Manager (that choice is remembered: `editor_settings`
  `pascalabc.bundled.removed`). Installing copies and unpacks files; nothing is started.
- **Download**: without the bundle (a development build), Install downloads the official address. That address always
  serves pascalabc.net's newest build; when it is replaced, its SHA-256 no longer matches and the download is refused
  (nothing is installed) until OpenMind's manifest is updated. pascalabc.net refuses connections from some networks.
- **Manual import**: a `PABCNETC.zip` you downloaded yourself can be imported with *Network > Import Offline Package*
  (Runtime Manager > Workloads > Import package); it is recognised by its SHA-256 and then installs offline.

The install checks the SHA-256 before anything is unpacked, unpacks with the Runtime Manager's safe extractor (no `..`,
absolute paths, drive letters, links; size and entry limits) into `runtimes/pascalabc/.installing`, then renames it to
`runtimes/pascalabc/versions/4.0.0.3883/`. A failed or interrupted install leaves no version behind (start-up reconcile
removes stale staging). Install, Repair, Delete and Set Active work like every runtime; another computer's install of the
same shared folder is waited for, not repeated. The system PATH, the Registry and the .NET Framework are never changed;
`pabcnetc` and `pabcnetcclear` are on the PATH of OpenMind terminals only.

The archive stores one file name, `Lib/Мозаика.pcu`, in code page 866 without the ZIP UTF-8 flag. The manifest says so
(`"nameEncoding": "cp866"`), so it is unpacked under its real name (`crates/runtime-manager/src/entry_names.rs`).

### The .NET Framework

The compiler and the programs it builds target **.NET Framework 4.7.2**. OpenMind reads
`HKLM\SOFTWARE\Microsoft\NET Framework Setup\NDP\v4\Full` `Release` (read-only) and shows the result on the card
(".NET Framework 4.8.1: found", or what is missing). Without 4.7.2+ Run Code refuses with the reason; OpenMind never
installs Windows components. Mono and the modern .NET (`dotnet`) runtime are **not** used: PascalABC.NET's .NET 10
console build (`PascalABCNET-Console-net10.zip`) is not integrated.

### Run Code

```
pabcnetcclear "/Output:<app>\cache\run-builds\run-N\hello.exe" "<workspace>\hello.pas"
<app>\cache\run-builds\run-N\hello.exe
```

- The command line is the one in the compiler's own source (`pabcnetc_clear/ConsoleCompiler.cs` in
  github.com/pascalabcnet/pascalabcnet): a rooted `/Output:` sets the output file and folder, so **nothing is written
  next to the source**. The compiler prints `OK`, or `Compile errors:` and the first error, and exits 0 or 1; it never
  waits for a key (`pabcnetc`, the interactive compiler, does — it is not used by Run Code).
- The build runs in the source file's folder, the program in the workspace folder, both in the run's Job Object (Stop
  kills both). The build folder is removed when the run ends, also after Stop.
- Output streams to the Output panel; program arguments (Run Code with Arguments) are passed to the program.
- A unit (`unit X;`) or library is refused before anything starts.
- **Input**: a file that reads input (`ReadLn` ...) is offered *Run in Terminal* (the existing interactive-input check);
  there the build and the program run in the integrated terminal. With Run Code's closed input, a `ReadLn` ends the
  program with "reading past the end of the input stream" instead of hanging.
- **Errors**: `[line,col] file.pas: message` becomes a Problems entry on that file (1-based line and column); a click opens
  it there. Only the first error is reported — that is what `pabcnetcclear` prints.
- A PascalABC.NET installed by its own setup (`Program Files (x86)\PascalABC.NET`) is used when OpenMind's isn't installed,
  labelled "System PascalABC.NET (...)".

### Unicode

Source files and paths may be Unicode and contain spaces. Program **output** is UTF-8 and shows correctly. Program
**input** typed in a terminal is decoded with the console's code page (850 or 437 on a Western Windows), so Cyrillic or
other non-Latin text typed into a running program arrives garbled; run `chcp 65001` in that terminal first. OpenMind does
not change a terminal's code page by itself.

### Editor support

Syntax colouring is Monaco's Pascal grammar (shared with Free Pascal). There is **no** PascalABC.NET language server:
no completion, hover, Go to Definition or references, and no debugger. Compiler errors appear in Problems after a run.

### Licence

PascalABC.NET: Copyright (C) 2005-2026 Ivan Bondarev, Stanislav Mikhalkovich; GNU LGPL v3 with the authors'
clarifications (`licenses/pascalabc/License_en.txt`, with the GNU LGPL and GPL v3 texts). The archive also holds the
interface units of M. Abramyan's Programming Taskbook (`Lib/PT4*.pcu`), whose licence allows distribution only unmodified
and free of charge: OpenMind ships the archive byte for byte and free of charge. The texts ship in `pascalabc-bundle/` and
the third-party notices. Source: <https://github.com/pascalabcnet/pascalabcnet>.

### Building the bundle

```
pnpm pascalabc:bundle -- --zip C:\path\to\PABCNETC.zip   # or without --zip: download the manifest's address
pnpm pascalabc:bundle -- --check                         # run by release:build / package:installer / build-windows.bat
```

The archive must match the manifest's SHA-256 and size; a newer build is refused until the manifest is updated (new
version, SHA-256, size, `installBytes`).

### Tests

- Always: planner arguments and compiler choice (`crates/runner/src/pascal_tests.rs`), manifest
  (`crates/runtime-manager/tests/builtin_manifests.rs`), cp866 names (`entry_names.rs`), corrupted and offline installs
  (`tests/pascalabc_install.rs`), bundle rules (`src-tauri/src/commands/pascalabc_tests.rs`, `pascalabcBundle.test.ts`),
  error parsing (`buildProblems.test.ts`), UI (`pascalModel.test.ts`, `pascalComponents.test.tsx`).
- With the real compiler: `OPENMIND_TEST_PASCALABC=<folder with pabcnetcclear.exe>` runs `crates/runner/src/tests/pascalabc.rs`
  (hello with Unicode output, arrays, classes, PascalABC.NET features, a compile error, arguments, input, end of input,
  Stop); `OPENMIND_TEST_PASCALABC_ZIP=<PABCNETC.zip>` installs the real archive offline, moves the app folder and compiles
  again, and runs two installs at once. Without the variables these tests print "skipped" and check nothing.

## Free Pascal

Unchanged: see the `pascal` manifest. Note (2026-10-19): the pinned Free Pascal snapshot
(`fpc-3.2.3.x86_64-win64.zip` from `downloads.freepascal.org/fpc/snapshot/fixes_3_2/`) was replaced upstream on 2026-10-13;
the pinned SHA-256 no longer matches, so a Free Pascal install by download currently fails its checksum. Free Pascal
execution itself was re-tested with the current snapshot.
