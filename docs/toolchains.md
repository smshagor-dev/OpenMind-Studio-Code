# Bundled toolchain packs

OpenMind Studio can carry small developer tools **inside its own folder** so they work with no download and no
install: Git and Composer versions, the Python debugger (debugpy), language servers, formatters and linters. They are
listed in `tools/toolchains.json` next to `OpenMindStudio.exe` and appear in *Runtime Manager > Language Tools*.

Nothing here is downloaded by the app, ever. The system PATH, the Registry and Program Files are never touched; the
folders of the active tools are put on the PATH of terminals and processes **OpenMind itself starts**, and only there.

## What is bundled in this build

**Nothing is physically bundled yet.** The system (manifest, detection, version choice, Verify, the UI, the packaging
check) is built and tested with fixture folders, but no tool binaries have been added to a release. The Language
Tools tab therefore shows every tool as *Missing* (or *External* for the big SDKs). Do not read "last five versions"
as shipped until real files are in `tools/`.

## Layout

```text
OpenMind Studio/
  OpenMindStudio.exe
  tools/
    toolchains.json
    git/2.47.1/cmd/git.exe
    composer/2.8.4/composer.phar
    python-debuggers/1.8.7/debugpy/adapter/__main__.py
    formatters/prettier/3.3.3/prettier.cmd
    ...
```

## The manifest

```json
{
  "tools": [
    {
      "id": "git",
      "maxBundledVersions": 5,
      "activeVersion": "2.47.1",
      "versions": [
        {
          "version": "2.47.1",
          "platform": "windows-x64",
          "path": "tools/git/2.47.1/cmd/git.exe",
          "bundled": true,
          "license": "GPL-2.0",
          "licenseUrl": "https://git-scm.com/about/free-and-open-source",
          "sizeBytes": 52428800,
          "verifyArgs": ["--version"]
        }
      ]
    }
  ]
}
```

- `id` must be one OpenMind knows (see `crates/toolchains/src/catalog.rs`); unknown ids are reported and ignored.
- `path` is relative to the app folder, never absolute and never `..`. The file **name** must be the command the tool
  provides (`git.exe`, `prettier.cmd`, `composer.phar`), because that is how the language support finds it.
- A version for another `platform`, or with `"bundled": false`, is ignored.
- `verifyArgs` is what *Verify* runs (a click; never at start-up). Without it, Verify only checks the file exists.
- `activeVersion` is the packager's default. The default when it is absent is the newest **stable** version whose
  program exists. The user's choice in the UI wins and is stored in the app's database (`toolchains.active`).

### Special tools

- **Git**: the active bundled `git.exe` is found before the Runtime Manager's MinGit. The system Git is still only used
  when the user allows it.
- **Composer**: a `composer.phar` path is used by the PHP control panel's Composer buttons (on OpenMind's PHP). Add a
  `composer.cmd` next to it if you also want `composer` on a terminal's PATH.
- **debugpy**: the path must be `<version dir>/debugpy/adapter/__main__.py`; the Run and Debug feature then starts the
  adapter from that folder instead of the Runtime Manager's install. Debugger files are never put on a PATH.

## Keeping the last five versions

At most **five** versions of a tool are kept (`maxBundledVersions` may lower it, never raise it). If a manifest lists
more, the oldest are ignored and a warning is shown. To update a tool:

1. Copy the new version under `tools-bundle/<tool>/<version>/`.
2. Add it to `tools-bundle/toolchains.json` with its `license` note.
3. If there are now more than five, delete the oldest folder **and** its manifest entry.
4. Run `pnpm package:portable`.

## Packaging

`pnpm package:portable` copies a git-ignored `tools-bundle/` folder into the zip as `tools/`, but first runs
`validateToolchainManifest` (`scripts/portablePackage.mjs`) and refuses the package if:

- a tool has more than five versions for the platform,
- a listed program is not in the folder,
- a path is absolute or leaves the folder,
- a bundled version has no `license` note.

Populating `tools-bundle/` is a manual, developer-side step. There is no download in the app and no download in the
packaging script.

## License and redistribution

Before a tool goes into `tools-bundle/`, check that its licence allows redistribution and record the licence name (and
a URL) in the manifest. Examples of things to be careful with: proprietary language servers, tools with usage terms,
and anything that needs the user to accept a licence.

## What is not bundled, and why

Large SDKs and toolchains are **external required**: OpenMind detects them and shows how to install them.

| Tool | Reason |
| --- | --- |
| Android SDK, emulators | very large; the user chooses versions |
| Flutter SDK | very large |
| Xcode | macOS only, not redistributable |
| JDK | size, and the choice of distribution is the user's |
| .NET SDK | size |
| C/C++ compiler toolchain, clangd | size |
| Rust toolchain (rustc, cargo, rustfmt, clippy) | installed with rustup |
| Go SDK | size |
| Docker | a service, not a tool |

Node.js, Python, PHP, MariaDB, phpMyAdmin, Composer and MinGit remain available through the Runtime Manager (a user
click downloads them, with checksums) — that is unchanged.
