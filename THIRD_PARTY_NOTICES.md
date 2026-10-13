# Third-party notices

OpenMind Studio's own code is licensed under the Apache License 2.0 ([LICENSE](LICENSE)). It is built from, and its
packages contain, third-party open-source components that keep their own licences — adopting Apache-2.0 for OpenMind
Studio does not relicense any of them.

## The complete list: `THIRD-PARTY-LICENSES.txt`

`pnpm licenses:generate` (also run by `pnpm build`, so by every package build) writes
`licenses/THIRD-PARTY-LICENSES.txt` with every component's name, version, declared licence and licence text:

- the Rust crates compiled into the program for the release targets (normal and build dependencies, not dev-only
  ones), with the licence files from each crate's source;
- the JavaScript packages bundled into the user interface (production dependencies);
- the Python wheels of the offline Python bundle and Tcl/Tk, when that bundle is built;
- the offline language-server bundle's component list.

When a package declares a licence but ships no licence file, the standard text of that licence from the
[SPDX License List](https://spdx.org/licenses/) is used and marked as such (`licenses/spdx/`). The generator fails
(`--check`) if any component has neither. Every package (setup, MSI, portable ZIP, deb, AppImage, tar.gz) carries the
file as `THIRD-PARTY-LICENSES.txt` next to the program, with `LICENSE`.

## Licences in use (audit of 1.0.3)

| Component group | Licences |
| --- | --- |
| Rust crates (641 for the release targets) | MIT, Apache-2.0 (incl. WITH LLVM-exception), BSD-2/3-Clause, ISC, Zlib, Unicode-3.0, BSL-1.0, 0BSD, CC0-1.0, Unlicense, MPL-2.0 (cssparser, selectors, dtoa-short, option-ext — used unmodified), CDLA-Permissive-2.0 (webpki-roots: the Mozilla CA certificate data) |
| User interface (npm, 37 production packages) | MIT (React, Monaco Editor, xterm.js, Yjs, marked, material-icon-theme …), Apache-2.0 (pdf.js, livekit-client, rxjs), BSD-3-Clause, 0BSD, MPL-2.0 OR Apache-2.0 (DOMPurify) |
| Offline Python bundle (37 wheels) | BSD, MIT, Apache-2.0, PSF, MIT-CMU (Pillow), MPL-2.0 (certifi), LGPL-3.0-only (python-telegram-bot), opencv-python (Apache-2.0; its wheel contains FFmpeg and Qt under the LGPL) — all unmodified wheels from PyPI |
| Tcl/Tk | Tcl/Tk licence (BSD-style) |
| Offline language servers | typescript-language-server and TypeScript (Apache-2.0), Pyright, vscode-langservers-extracted, yaml-language-server, bash-language-server, dockerfile-language-server-nodejs, Prettier and plugins (MIT; prettier-plugin-java Apache-2.0), Ruff (MIT), rust-analyzer (MIT OR Apache-2.0), clangd and clang-format (Apache-2.0 WITH LLVM-exception), gofmt (BSD-3-Clause), StyLua (MPL-2.0), Node.js (MIT, with its bundled libraries' licences in `lsp/node/LICENSE`) |

Not redistributed: Intelephense (its licence doesn't allow it; installed only on request from npm). Everything the
Runtime Manager or Language Tools installs on request (Node.js, Python, Git, PHP, MariaDB, JDK, …) is downloaded from
its publisher under that publisher's licence and is not part of OpenMind Studio's packages.

## Assets

- **File icons**: SVGs from [Material Icon Theme](https://github.com/material-extensions/vscode-material-icon-theme),
  MIT, Copyright (c) 2025 Material Extensions (the full text is in `THIRD-PARTY-LICENSES.txt`).
- **Application icon and installer artwork** (`src-tauri/icons/`): OpenMind Studio's own.
- **Author picture** in the About window (`src/assets/about/author.png`): the author's own photo, supplied by the author.
