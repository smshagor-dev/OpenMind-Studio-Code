# University PC validation (Milestone 23 / 23.1)

The original report: on a university PC, OpenMind's Download Manager installs runtimes, but `pip install`, `npm install`,
`git clone` ... fail in OpenMind's terminal and in a plain PowerShell. Milestones 23 and 23.1 route package tools through
the Download Manager's own route. **This was verified on a developer PC only. The issue counts as resolved only when this
checklist passes on the university PC.** Do not change the PC's proxy, PATH, Registry or any global tool configuration
while testing; OpenMind doesn't either.

## Before you start

1. Copy the portable ZIP (`OpenMind-Studio-Portable-0.1.0-x64.zip`) to the PC, check its SHA-256 against `SHA256SUMS.txt`,
   unzip it into a folder you can write to (a path with spaces is fine). No installer, no administrator rights.
2. Start `OpenMindStudio.exe`. Open a folder (e.g. `Documents\omtest`).
3. Network window (Terminal > Network): leave the proxy mode on **System** unless the university documents a proxy; if it
   does, enter it under Manual (and the credentials if asked). Press **Test Connection** and note the result.
4. Downloads tab: the gateway line must say *Package gateway running on 127.0.0.1*. Note anything under *Left on your own
   settings*.
5. Press **Save Network Diagnostics** and keep `logs/openmind-network-diagnostics.json` (it contains no password or token;
   check it before sending it anywhere).

## Checklist (all in a *new* OpenMind terminal)

| # | Command | Pass when |
| --- | --- | --- |
| 1 | Runtime Manager: install Python and Node.js | both install (this already worked before) |
| 2 | `where.exe python pip` ; `python -V` ; `python -m pip --version` | the first result is `<app>\runtimes\python\...`; pip is the portable one |
| 3 | `python -m venv .venv` ; `.venv\Scripts\python -m pip install requests` | installs; `pip list` in the venv shows only requests and its dependencies |
| 4 | `npm init -y` ; `npm install left-pad` ; delete `node_modules` ; `npm ci` | both succeed; `package-lock.json` names only `registry.npmjs.org` |
| 5 | `git clone https://github.com/octocat/Hello-World.git` ; `git -C Hello-World pull` | clone and pull succeed; `.git\config` shows the `https://github.com/...` address |
| 6 | Private repository you own: `git clone https://github.com/<you>/<private>.git`, commit, `git push` | your credential helper asks for **github.com** (never 127.0.0.1); push succeeds |
| 7 | `composer require psr/log` (in an empty folder; needs PHP) | succeeds; `composer.lock` has no `127.0.0.1` |
| 8 | Optional, if installed: `pnpm add is-odd`, `yarn add is-even`, `go get golang.org/x/text@v0.14.0`, `cargo fetch` | each succeeds |
| 9 | Downloads tab | the operations are listed as complete; a failure shows a category and **Copy Error Details** |
| 10 | Close OpenMind | Task Manager shows no OpenMindStudio / node / python / git left from it; `<app>\temp` is empty apart from a resumable `.part` |
| 11 | In a plain PowerShell (outside OpenMind), `pip download six --no-deps -d x` | unchanged behaviour is expected — OpenMind never changes the system; this is the comparison |

## If something fails

- Save Network Diagnostics again and look at:
  - `hosts[].A_downloadManager.reachable` — if **false** for a host, OpenMind's own route can't reach it either: the
    network blocks it, and no tool setting will help (ask the university IT department);
  - `providerReadiness` — a tool marked `skipped` uses the settings named in `reason` (your own configuration);
  - `B_to_E_throughOpenMind.<tool>` vs `F_externalPowerShellEquivalent.<tool>` — the difference between the two routes;
  - `lastFailure.category` — e.g. `certificate` (the network inspects TLS: the tunnelled tools Cargo/Yarn/Composer need the
    university's root certificate in their own settings), `proxyAuthentication` (enter proxy credentials in the Network
    window), `blocked`, `dns`, `timeout`;
  - `gitSsh` — if port 22 is blocked, use the HTTPS address of the repository.
- Send the diagnostics file and the Copy Error Details text of the failing download.

## Criteria for calling the issue resolved

The university issue is resolved when, **on the university PC**, with no change to the PC's configuration:

1. items 2-5 and 9-10 of the checklist pass (pip into a venv, npm install + npm ci, git clone + pull), and
2. item 6 passes for a user who has a private repository (Git push over HTTPS with the real host's credentials), and
3. item 7 passes when PHP/Composer are part of the course, and
4. the diagnostics file shows `A_downloadManager.reachable: true` and `B_to_E_throughOpenMind.<tool>.ok: true` for pip,
   npm and git.

If the Download Manager's own route (A) cannot reach a host, the cause is the network itself, and OpenMind cannot and
will not bypass it.
