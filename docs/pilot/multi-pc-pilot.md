# Multi-PC pilot: network installation ("Recommended for All Users")

Status: **PENDING** — to be run on real, independent Windows computers. A run on one computer through `\\localhost`
(see the release notes) is a simulation and does not count as this pilot.

## What you need

- 2–3 Windows 11 computers you are allowed to use for testing (PC 1, PC 2, PC 3), on the same network.
- An SMB share they can all reach, e.g. `\\fs01\apps`. The tester on PC 1 may write to it; for case 15 a standard
  user who may only **read** it.
- Two Windows accounts on one of the computers (case 4), at least one of them a standard user (case 15).
- The setup `OpenMind-Studio-Setup-<version>-x64.exe` of the build under test, and the previous release's setup
  (case 14).
- `scripts\pilot\Collect-PilotEvidence.ps1` copied to each computer. After each case, on each computer involved:

  ```powershell
  .\Collect-PilotEvidence.ps1 -SharedExe "\\fs01\apps\OpenMind Studio\OpenMindStudio.exe" -CaseId 05-python
  ```

  It only reads (no admin rights, no database contents, no settings values) and writes one ZIP per computer and case.
  Collect the ZIPs in one folder and fill in the result table at the end.

Before you start: record each computer's Windows version, whether it is domain-joined, and the share's permissions
(`icacls \\fs01\apps\OpenMind Studio` from PC 1).

## Cases

| # | Case | Steps | Pass when |
| --- | --- | --- | --- |
| 1 | Install once | PC 1: run the setup, **Installation type: Recommended for All Users**, install folder `\\fs01\apps\OpenMind Studio`. | `install.json` in the share says `"layout": "network"`; a Desktop shortcut on PC 1 points at the `\\fs01\...` path (not a drive letter). |
| 2 | Every PC starts it | PC 2 and PC 3: start `\\fs01\apps\OpenMind Studio\OpenMindStudio.exe` (shortcut from case 12, or by hand). | The editor opens directly — no "Choose how OpenMind Studio will be used" page, no error window. |
| 3 | Own database per PC | On each PC: File > Preferences > Data Scope... | It shows "network installation" and a local folder under `%LOCALAPPDATA%\OpenMind\Studio\Installations\`; the evidence lists one `openmind-studio.db` per PC, none in the share. |
| 4 | Own state per Windows user | On one PC, sign in as a second user and start it. Open a different folder as each user. | Each user has their own local folder; one user's recent folders don't appear for the other. |
| 5 | Python shared | PC 1: Runtime Manager > install Python. PC 2: open a new terminal, `python --version`; Runtime Manager on PC 2. | PC 2 shows Python installed and active without downloading (no progress bar); `python` runs from the share. |
| 6 | Node.js and Rust | Repeat case 5 with Node.js (Runtime Manager) and the Rust toolchain (Runtime Manager > Language Tools). On PC 2 build a small Cargo project with a dependency. | Detected on PC 2 without a download; the Cargo build works on PC 2 and its crates are in PC 2's local folder (`cache\tools\cargo`), nothing new under the share's `tools\rust-toolchain\...\cargo\registry`. |
| 7 | Terminals at once | PC 1 and PC 2: open a terminal each and run `python -c "import time; time.sleep(120)"`. | Both run; neither PC shows any "in use on another computer" message. |
| 8 | Same language server at once | Delete nothing; on a fresh share where the TypeScript server was never unpacked, open a `.ts` file on PC 1 and PC 2 within a few seconds. | Both get TypeScript diagnostics; no error in either LSP log; one folder under `language-servers\typescript\`. |
| 9 | Restart one PC | While PC 2 keeps OpenMind open, restart PC 1 (the computer) and start OpenMind again. | PC 1 opens directly, with its earlier recent folders; PC 2 is unaffected. |
| 10 | Network drop | PC 2: disconnect the network (unplug / Wi-Fi off) for 30 s with OpenMind open, reconnect, then close and start OpenMind again. | No setup page, no database reset; at worst a clear error while the share is unreachable. |
| 11 | Repair / remove while used | PC 2: keep the Python terminal of case 7 running. PC 1: Runtime Manager > Python > Delete, then Repair. | Delete is refused with "is in use, so it was not removed" and Python still works on PC 2; Repair says nothing needed repairing. After closing PC 2's terminal, Delete works. |
| 12 | Shortcuts | Use what you are allowed to: Group Policy Preferences, the logon script (`OpenMindStudio.exe --integration desktop-shortcut`), or `scripts\deploy\Deploy-OpenMindShortcuts.ps1` from an admin computer. | Each targeted PC has `OpenMind Studio.lnk` pointing at the UNC path; the deploy script's report says `Verified` for each. |
| 13 | Ten restarts | On PC 2: close and start OpenMind ten times. | Opens directly every time; `install-state.json`'s `firstStartedAt` unchanged, `lastStartedAt` updated. |
| 14 | Update keeps data | Install the previous release first (cases 1–3), use it, then run the new setup on PC 1 over the same share folder (everyone closed). | Every PC opens with its own earlier data; runtimes still installed; the setup kept "Recommended for All Users". |
| 15 | Standard user | As a standard (non-admin) user on PC 3 with read-only access to the share: start it, open a folder, run a Python file, build the Cargo project, open a `.ts` file (after case 8 unpacked it). | Everything works without a UAC prompt; nothing is written to the share (compare the share's evidence before/after). |

## Result table

| # | PC 1 | PC 2 | PC 3 | Evidence ZIPs | Notes |
| --- | --- | --- | --- | --- | --- |
| 1 | | | | | |
| … | | | | | |
| 15 | | | | | |

The release gate needs every case passed on real computers (docs/release.md, "Release gate").
