# OpenMind Studio — v1.0.5 development notes (historical)

These development notes were written after v1.0.4 and before the v1.0.5 release. For the consolidated published release summary, see [v1.0.5 release notes](release-notes-1.0.5.md). The v1.0.4 packages do not contain the post-v1.0.4 changes.

## New

- **PascalABC.NET** as a second, independent Pascal compiler beside Free Pascal (see `docs/pascal.md`).
  - Runtime Manager > **PascalABC.NET**: the official console compiler `PABCNETC.zip` (PascalABC.NET 4.0.0.3883),
    pinned by SHA-256. OpenMind Studio for Windows ships that archive unchanged and installs it without a download —
    once by itself after a new installation or an update (not again after you remove it), and on Install/Repair. A
    `PABCNETC.zip` you downloaded yourself can be imported with *Network > Import Offline Package*.
  - The card shows whether **.NET Framework 4.7.2 or later** is present (part of Windows 10 1803+ and Windows 11;
    OpenMind never installs it) and offers **Use for Pascal Files**.
  - **Settings > Pascal > Compiler** (user or workspace): Free Pascal (default — nothing changes unless you choose) or
    PascalABC.NET. The chosen compiler is shown in the status bar for Pascal files. A missing compiler is reported; the
    other one is never used instead.
  - Run Code builds into a temporary folder (nothing next to the source), streams output, passes arguments, offers
    *Run in Terminal* for programs that read input, puts the compiler's error in Problems at its line and column, and
    Stop ends the build or the program.

## Fixed

- ZIP archives whose file names are stored in the DOS Cyrillic code page (866) without the UTF-8 flag can be unpacked
  under their real names (a manifest names the encoding).

## Known limitations

- PascalABC.NET: Windows only; no language server (no completion, hover or navigation) and no debugger; only the first
  compile error is reported (the compiler prints one); non-Latin text typed into a running program needs `chcp 65001` in
  the terminal; the .NET 10 console build of PascalABC.NET is not integrated.
- pascalabc.net refuses connections from some networks; the download address always serves the newest build, so an
  install by download fails its checksum after pascalabc.net publishes a new build until OpenMind is updated. The copy
  shipped with OpenMind is not affected.
- Free Pascal: the snapshot OpenMind pins was replaced upstream on 2026-10-13, so installing Free Pascal by download
  currently fails its checksum (an existing problem, not changed here).
- The 32-bit (x86) Windows build has no Runtime Manager platform, so it can't install either Pascal compiler.
