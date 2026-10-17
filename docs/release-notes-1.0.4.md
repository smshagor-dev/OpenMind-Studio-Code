# OpenMind Studio v1.0.4 (upcoming; built, not published)

Prepared Windows (x64, x86) and Linux (x64, x86) packages. Not yet published. Built from the private source `main` after v1.0.3 (`8a75e2d`).

## New

- **Network Deployment** (Help > Network Deployment, or `OpenMindStudio.exe --deploy ...`). Finds OpenMind Studio
  deployments on the local network — a shared network installation, or a computer offering the release's signed setup
  and portable packages — and sets this computer up from one:
  - **Use Shared Installation**: a Desktop shortcut to the share's program; nothing is copied, and this computer's
    database and settings stay on this computer.
  - **Install with Setup…** / **Install Portable Copy…**: into any folder on any drive. Every package is checked for its
    size, SHA-256 and OpenMind's release signature before it is used. An older copy in that folder is updated with its
    data kept, the same version is repaired, a newer one is never downgraded, and a folder holding other files is never
    written into. Installing packages from the network works on Windows; on Linux install the package by hand.
  - **Trust first.** The first time a deployment is used on a computer you are asked to trust it (what it is, the share
    path, which computers answered). Nothing is taken from an untrusted deployment.
  - **Offering is opt-in**: Settings > Network > *Offer This Installation on the Local Network* (off by default), or
    `--deploy serve`. Nothing is searched or announced at start-up.
  - **Network Deployment Test**: twenty checks, each PASS, FAIL, BLOCKED or NOT TESTED with the reason;
    `--deploy test --json > report.json` saves it for IT.
- **Shared network installations: Desktop shortcuts for every user.** Each Windows user who starts a "Recommended for
  All Users" installation from the share gets an OpenMind Studio shortcut on their own Desktop once (by the
  `\\server\share` path, so any drive letter works; skipped when a shortcut is already there; a deleted one stays
  deleted; IT can turn it off). The installation carries a `deploy\` folder: Create / Remove Desktop Shortcut and Check
  Installation for users (no administrator rights), a silent logon script for Group Policy, the push script and a
  README for IT. `--integration check` reports paths, rights, writability and the shortcut's state with what to do;
  `--integration user-desktop-shortcuts on|off`; setup switch `/NOUSERSHORTCUTS`.

## Fixed

- A computer asking for a runtime another computer was installing into the shared folder failed; it now waits and
  uses that installation.
- Language Tools installed into a shared folder by two computers at once could overwrite each other's record; installs
  now take a lock across computers.
- A complete shared runtime whose launchers couldn't be written was unpacked again over its own files (and deleted on
  failure); it is now used as it is, or the install stops without touching it.
- Network installations wrote Composer's home and cache, the notebook runner and extension downloads into the shared
  folder; they now stay on each computer.
- A network installation started from a mapped drive could start with an empty profile when the folder couldn't be
  resolved for a moment. The installing user's Desktop shortcut kept the drive letter when the setup was installed
  onto a mapped drive (the app now points it at the `\\server\share` path), and updates no longer re-add a shortcut
  the user deleted.

## Security

- A valid release signature proves a package is a real release, not that the computer offering it is the one IT meant:
  deployments must be trusted on each computer first, and a shared installation is trusted only for its exact network
  path.
- Network discovery can't be used to multiply someone else's traffic. An announcement whose identity doesn't match its
  own share path, or that changes the kind of a deployment already found, is ignored.
- The package server gives up on a client that sends its request too slowly and won't serve a file replaced by a link.
- A verified package can't be replaced between its check and its installation; a package older than the running copy
  is refused.

## Known limitations

- Physical multi-computer testing on a real university network is still pending.
- The Windows programs and installers are not Authenticode-signed: SmartScreen warns, and Smart App Control (where it
  is on) blocks them.
- Network discovery is IPv4 only and doesn't cross routers; type the address of a computer on another subnet.
- The Windows x86 (32-bit) package can't install the Runtime Manager's runtimes (Node.js, Python, Git, PHP ... are
  64-bit downloads), also on 64-bit Windows; its offline language servers and Python packages run only on 64-bit
  Windows. Use the x64 package where you can.
- Linux packages don't include the offline language servers, formatters or Python packages, and the Runtime Manager's
  downloads are for Windows.

## Upgrade

- Copies of 1.0.3 update themselves once this release is published with its update feed; 1.0.2 and older must install
  it by hand once.
- Shared network folder: everyone closes OpenMind Studio, then run the new setup on one computer with the same folder.
