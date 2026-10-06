# Assembly language support

OpenMind Studio builds, runs, checks and debugs x86-64 (and optionally x86) assembly on Windows with a portable
toolchain it installs into its own folder. No Visual Studio, MSVC, MASM, Windows SDK, system GCC/NASM, administrator
rights or PATH change is needed or used.

| Part | What it is | Where it comes from |
| --- | --- | --- |
| NASM 2.15.05 | the assembler (Intel syntax, OpenMind's default) | w64devkit 1.19.0 |
| GCC 13.1.0 + GNU ld (MinGW-w64) | links the object into a `.exe`, assembles GNU as `.s` files | w64devkit 1.19.0 |
| GNU binutils 2.40 | `as`, `ld`, `objdump`, `nm`, `objcopy`, `strip`, `ar`, `size`, `strings`, `addr2line` | w64devkit 1.19.0 |
| GDB 13.1 | command-line debugger | w64devkit 1.19.0 |
| x86 (32-bit) toolchain (optional add-on) | i686 GCC/ld for `nasm -f win32` objects, plus a 32-bit GDB | w64devkit-i686 1.19.0 |
| asm-lsp 0.10.1 | language server: hover, completion, symbols, Go to Definition, Find References, NASM problems | conda-forge |

## Installing

- **Runtime Manager > Assembly (NASM)**:
  - The card's **Install** installs the toolchain: NASM, the MinGW-w64 linker, binutils and GDB. When the architecture
    setting is x86, the x86 part is added in the same step.
  - Its setup line lists each part ("Toolchain: installed", "x86 (32-bit): needed for the x86 architecture",
    "asm-lsp (optional): not installed").
  - **Install Assembly Toolchain** completes whatever is missing in one click: a missing toolchain is installed, a damaged
    one repaired, the x86 part added when x86 is chosen, and asm-lsp installed unless the language server is turned off.
    asm-lsp is optional and never makes the setup "incomplete" when it is off.
  - **Verify** (Workloads tab), **Repair**, **Delete** and the x86 add-on's **Remove**/**Add** work like any other runtime.
    Repair keeps installed add-ons: it puts them back after rebuilding the version.
  - "Update" is installing another listed version. Only 2.15.05 is listed today.
  - Assembly is also part of the *Systems development* workload.
- **Language Tools > asm-lsp** installs (or **Remove**s, after a confirmation) the language server on its own.
- **Run Code on a `.asm` file without the toolchain** asks: *Install Assembly Toolchain* (the runtime, then asm-lsp unless
  the language server is turned off) / *Open Runtime Manager* / *Cancel*.
- **Opening a `.asm` file without asm-lsp** shows the bottom-right card: *Install now* / *Open Runtime Manager* / *Dismiss*
  (once per session).

A new OpenMind terminal finds `nasm`, `gcc`, `as`, `ld`, `objdump`, `gdb` ... at once (launchers in
`runtimes/assembly/shims/<v>`, put in front of PATH for that terminal only). w64devkit's other programs (busybox `find`,
`sort`, `tar`, `timeout` ...) are deliberately **not** put on PATH, so Windows' own commands keep working. A terminal
opened before the install follows the existing runtime-refresh behaviour: when it is idle it is restarted in the same
folder with a note, otherwise it is refreshed once its program ends.

C and C++ Run Code finds a compiler the same way. Without LLVM-MinGW, the Assembly runtime's `gcc` launcher builds C
files, as the Fortran runtime's launcher already did.

**Offline**: an install, repair or add-on first looks in `cache/downloads`. An archive whose SHA-256 still matches is
used with no network access. A damaged one is deleted and downloaded again; offline that fails with the reason and a
pointer to *Network: Import Offline Package*, and nothing is half-installed.

### Downloads and checksums

Every archive goes through the Runtime Manager / language-server download path (the user's proxy route, resume,
retries). Its SHA-256 is checked before anything is unpacked. TLS, certificate and host checks are never relaxed.

| File | SHA-256 |
| --- | --- |
| `https://github.com/skeeto/w64devkit/releases/download/v1.19.0/w64devkit-1.19.0.zip` | `2862f388e1720b40026f2fd95c6100a9932e3b14fb13aac4f225a02b11e31ca9` |
| `https://github.com/skeeto/w64devkit/releases/download/v1.19.0/w64devkit-i686-1.19.0.zip` | `dc4f6984f7320b02fc057d19c23c06b2406d8133fb5b149c438dba1ee78a77e6` |
| `https://conda.anaconda.org/conda-forge/win-64/asm-lsp-0.10.1-h487f906_1.conda` | `25cb3ff76526789767d92dd3122b89cd01671391dfeee50b310e6056b7d45562` |
| `https://conda.anaconda.org/conda-forge/win-64/vc14_runtime-14.44.35208-h818238b_41.conda` | `ec706fe9368b837fbd05af4851f5ebef12bef8c471a273f4805f7af788407317` |

Both w64devkit archives were checked against the author's OpenPGP signature (key
`5EEB8C8D5069C4E9B94AA852AFD1503A8C8FF42A`) when they were pinned. **w64devkit 1.23.0 is not used**: Microsoft
Defender flags its archive. The conda packages are read as archives (`ArchiveKind::Conda`: a zip holding one
zstd-compressed tar, decoded in-process by `ruzstd`); only their `Library/bin` folder is kept. asm-lsp loads the Visual
C++ runtime DLLs from its own folder, so nothing is installed system-wide. Archives stay in `cache/downloads` (offline
reinstall/repair) and can be imported with *Network > Offline Packages*.

### Removing

Delete in the Runtime Manager removes `runtimes/assembly/versions/<v>` and its launchers. Removing the x86 add-on
removes exactly the files it added. asm-lsp's folder is `language-servers/asm-lsp/<revision>`. Nothing outside the app
folder is touched, with one exception: asm-lsp itself creates an empty `%APPDATA%\asm-lsp` folder while it looks for a
global configuration (upstream behaviour). OpenMind never writes into it. When the app closes, it removes the folder
again, but only if it didn't exist before asm-lsp first started in that run and it is still empty. If the app is killed
instead of closed, the empty folder can stay behind.

## Run Code

| File | Steps (in a temporary build folder, `cache/run-builds/run-<n>`) |
| --- | --- |
| `.asm`, `.nasm` | `nasm -f win64 -I <source folder>/ <extra assembler args> file.asm -o file.obj`, then `gcc file.obj -o file.exe <entry> <extra linker args>`, then the program |
| `.s`, `.S` | `gcc file.s -o file.exe` (GNU as through gcc), then the program |
| `.inc` | not run: "This is an assembly include file: run the .asm file that %includes it." |

**Entry point:**

- `global main` (32-bit: `_main`) links through the C runtime, so `printf`, `scanf` and the program's arguments in
  `ecx`/`rdx` work.
- `global start` / `_start` / `mainCRTStartup` links without it (`-nostartfiles -Wl,-e,<symbol> -lkernel32 -luser32`): call
  `ExitProcess` yourself.
- A file with neither is refused with the fix in the message.

**Arguments, input and output:**

- Arguments come from *Run Code with Arguments...* (per file, remembered).
- The program runs in the usual Run Code folder (workspace, else the file's folder).
- A file that reads the keyboard (`call scanf/getchar/fgets`, or `GetStdHandle` + `ReadConsole`/`ReadFile`) is offered
  the terminal first.
- Output goes to the **Assembly** Output channel.
- stdout and stderr are both shown. They are read separately, so their order can differ from the program's.
- NASM, GNU as and ld errors (`file.asm:3: error: ...`) land in the **Problems** panel and are clickable. A linker error
  such as an undefined symbol is attributed to the source file, at line 1, marked "(linker)".
- A failed assemble or link never runs anything. Each Run Code run gets a fresh build folder, and Run in Terminal's
  chain stops at the failing step, so an older `.exe` is never run.
- *Run Code in Terminal* types the same assemble → link → run chain. Programs are quoted for the terminal's shell: any
  file name works in PowerShell and Git Bash. cmd.exe refuses a line it can't quote safely (`&`, `$`, quotes, `;` ...)
  with the reason, instead of typing it.
- **Several source files**: `%include` brings in files next to the source (`-I <source folder>/`). Linking several
  `.asm` files into one program is not supported by Run Code: build them in the terminal, or with a task.

**Settings** (Settings > Assembly, user scope):

| Setting | Default | Effect |
| --- | --- | --- |
| `assembly.architecture` | `x86-64` | `x86` builds 32-bit programs with `nasm -f win32` and the x86 add-on (refused with the reason when it isn't installed) |
| `assembly.extraAssemblerArgs` | empty | split like a command line, placed before the source file (`-w+all -D NAME=1`) |
| `assembly.extraLinkerArgs` | empty | appended to the gcc link (`-lgdi32`) |
| `assembly.enableLanguageServer` | on | off: asm-lsp is never started (and not installed by *Install Assembly Toolchain*) |

The settings are read by the backend, never taken from the page that asks for a run. A change re-checks the file in
front at once: the Run button shows a missing x86 toolchain, or invalid extra arguments, with the reason ("the extra
assembler arguments (Settings > Assembly) can't be read: a quote is never closed"). Settings persist across restarts.
The status bar shows the syntax and the architecture next to the language (`NASM · x86-64`); a click opens these
settings.

## Language server (asm-lsp)

asm-lsp serves `.asm` and `.nasm` files. GNU as `.s` files get no server, because asm-lsp's problems come from NASM. A
`.inc` file gets none either, because the name alone can't tell it from PHP.

It gets an `.asm-lsp.toml` written by OpenMind into `settings/asm-lsp/`:

- syntax NASM;
- instruction set matching `assembly.architecture`;
- `compiler` = the absolute path of the installed `nasm.exe`;
- flags `-f win64|win32 -o NUL`.

The folder is passed as `rootPath`, because asm-lsp can't read a Windows `rootUri`. A project's own `.asm-lsp.toml` is
used instead when it exists. Nothing is ever written into the project.

**What asm-lsp gives:**

| Feature | Behaviour |
| --- | --- |
| Hover | Instructions, registers and directives |
| Completion | Yes |
| Document symbols | Yes; local labels may show without a name |
| Go to Definition | Yes |
| Find References | asm-lsp answers with the declaration only. That is the server's answer, shown as it is |
| Workspace symbols (Ctrl+T) | asm-lsp offers none; Ctrl+T reads labels, local labels (`.next` in `main`), `equ`, `%define`/`%assign` and `%macro` from the search index's assembly reader (`.asm`, `.nasm`, `.s`) |

- **Problems** appear each time the file is saved (asm-lsp runs NASM on the saved file), not on open or while typing.
  Auto Save makes them follow edits.
- **Without NASM installed**, asm-lsp still gives hover, completion and symbols, with diagnostics off.
- **Settings changes**: changing the architecture or the language-server switch restarts asm-lsp, or stops it. When it
  is off, the status bar says "The language server is turned off in Settings (Assembly > Enable Language Server)" and no
  install card is shown. After installing the toolchain while asm-lsp runs, use *Restart* in Language Tools to switch
  its diagnostics on.

**Protocol details:**
- asm-lsp refuses a `didChange` without a range, which the protocol allows, and exits. It is the only server flagged
  `ranged_changes`: it gets the whole new text as one change whose range covers the previous text.
- asm-lsp panics on a position past the end of a line. Every request for it is first moved inside the document OpenMind
  holds, to the end of the line or document.

Other servers are unchanged.

## Debugging (GDB baseline)

*Run > Debug in GDB (Terminal)* builds the file and types `gdb --args <program> <arguments>` into a terminal. The GDB is
the Assembly runtime's (the x86 add-on's for 32-bit programs). Programs keep their symbols, so `break main`, `run`,
`stepi`, `info registers`, `x/2i $pc` and `layout asm` work. In a 32-bit program GDB drops the C underscore: the label
`_main` is `break main`.

There is **no source-line debugging**: NASM's win64/win32 objects carry only CodeView debug information (`-g -F cv8`),
which GDB can't read. Breakpoints go on symbols or addresses, and stepping is per instruction. There is no
debugger-view (DAP) integration either: GDB 13.1 has no DAP mode.

## Design notes

- `openmind_runner::assembly` keeps the syntax open (`Syntax::{Nasm, Gas}`). MASM or FASM would be another variant with
  its own tool lookup and argument list, and another Monaco grammar in `src/editor/assemblyGrammars.ts`.
- A two-step build is `BuildStep.link`. The link runs in the run's Job Object only after the assembler succeeded, so a
  failed build never runs anything.

## Limitations

- Windows x64 only; x86 needs the add-on.
- Single-file builds: a file that needs other objects or libraries must name them in the extra arguments.
- No MASM/FASM.
- No source-level debugging.
- asm-lsp: problems only on save (not on open or while typing); References returns only the declaration; no workspace
  symbols of its own (the index supplies Ctrl+T); a toolchain installed while asm-lsp runs needs a Restart for its
  problems.
- cmd.exe terminals refuse Run in Terminal for file names with `&`, `$`, quotes or `;` (PowerShell and Git Bash work).
- A freshly built program can take noticeably longer on its first launch (Windows scans a new executable once).
- `.inc` is NASM only when its text looks like assembly (macros, `equ`, data, `section`/`global`).
- The empty `%APPDATA%\asm-lsp` folder (see Removing).
