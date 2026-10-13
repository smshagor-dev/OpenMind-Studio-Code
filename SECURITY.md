# Security policy

## Reporting a vulnerability

Please report security problems **privately**:

- GitHub: [Report a vulnerability](https://github.com/smshagor-dev/OpenMind-Studio-Code/security/advisories/new)
  (private vulnerability reporting), or
- e-mail: smshagor.dev@gmail.com with "OpenMind Studio security" in the subject.

Include the version (Help > About), the operating system, what you did and what happened. Please don't open a public
issue for a vulnerability before it is fixed. You can expect an answer within a week; fixes are released as a new
version and mentioned in its release notes.

## Supported versions

Only the newest release receives security fixes.

## How releases are protected

- The Release workflow builds the packages on GitHub-hosted runners from this repository (actions pinned by commit,
  read-only permissions). Packages for Authenticode signing are always built that way; earlier releases (up to 1.0.3)
  were built on the maintainer's computer.
- Every update package carries a signature made with OpenMind Studio's updater key (minisign/Ed25519); the program
  checks it, and the version inside it, before installing an update. The private key is never in this repository.
- `SHA256SUMS.txt` is published with every release.
- Windows Authenticode signing through SignPath Foundation has been applied for and is **not active yet**
  (see the code signing policy in [README.md](README.md)).

## Scope

Reports about the program and its build and release process are in scope. Extensions you install run with your
rights (the permission guard is not a sandbox — see the extension documentation), and runtimes and tools you install
are their publishers' software.
