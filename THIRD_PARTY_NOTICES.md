# Third-party notices

OpenMind Studio bundles the following third-party material.

## Material Icon Theme (file type icons)

The file type icons (`src/components/fileIcons.tsx`) are SVGs from the `material-icon-theme` package,
https://github.com/material-extensions/vscode-material-icon-theme

```text
The MIT License (MIT)
Copyright (c) 2025 Material Extensions

Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated documentation files (the "Software"), to deal in the Software without restriction, including without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
```

## Offline language server bundle (release builds)

Release builds ship language servers and Node.js in `lsp/` (see `docs/lsp-bundle.md`): typescript-language-server and
TypeScript (Apache-2.0), Pyright (MIT), vscode-langservers-extracted (MIT), yaml-language-server (MIT), bash-language-server
(MIT), dockerfile-language-server-nodejs (MIT), rust-analyzer (MIT OR Apache-2.0), clangd (Apache-2.0 WITH LLVM-exception) and
Node.js (MIT), with their dependencies. The complete list of components and licences is generated into
`lsp/THIRD-PARTY-NOTICES.txt`; each component's licence text travels inside its pack and next to `node.exe`. Intelephense is
not redistributed (its licence doesn't allow it).
